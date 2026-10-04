package store

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"sort"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"signalforge/collector-go/internal/canonical"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

// ClickHouse is the production Store backed by the native protocol connection.
type ClickHouse struct {
	conn driver.Conn
}

// OpenClickHouse connects to the native port. Settings come from the caller, which reads the
// environment through internal/config.
func OpenClickHouse(addr, database, username, password string) (*ClickHouse, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{addr},
		Auth: clickhouse.Auth{Database: database, Username: username, Password: password},
	})
	if err != nil {
		return nil, fmt.Errorf("open clickhouse: %w", err)
	}
	return &ClickHouse{conn: conn}, nil
}

func (c *ClickHouse) Close() error { return c.conn.Close() }

// loadMigrations lists the embedded migration files in filename order.
func loadMigrations() ([]migration, error) {
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return nil, err
	}
	var all []migration
	for _, entry := range entries {
		version, err := versionFromFilename(entry.Name())
		if err != nil {
			return nil, err
		}
		all = append(all, migration{Version: version, Name: entry.Name()})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })
	return all, nil
}

// MigrateUp applies every embedded migration whose version is above the highest recorded version.
// Each migration's statements run first; its schema_migrations row is written only after they all
// succeed, so a failed migration is retried on the next start.
func (c *ClickHouse) MigrateUp(ctx context.Context) error {
	all, err := loadMigrations()
	if err != nil {
		return err
	}
	applied, err := c.appliedVersion(ctx)
	if err != nil {
		return err
	}
	for _, m := range pending(all, applied) {
		body, err := migrationFiles.ReadFile("migrations/" + m.Name)
		if err != nil {
			return err
		}
		for _, stmt := range splitStatements(string(body)) {
			if err := c.conn.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("migration %s: %w", m.Name, err)
			}
		}
		if err := c.conn.Exec(ctx,
			"INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
			uint32(m.Version), m.Name, time.Now().UTC(),
		); err != nil {
			return fmt.Errorf("record migration %s: %w", m.Name, err)
		}
	}
	return nil
}

// appliedVersion returns the highest recorded migration version, or 0 before the first migration
// has created schema_migrations.
func (c *ClickHouse) appliedVersion(ctx context.Context) (int, error) {
	var exists uint64
	if err := c.conn.QueryRow(ctx,
		"SELECT count() FROM system.tables WHERE database = currentDatabase() AND name = 'schema_migrations'",
	).Scan(&exists); err != nil {
		return 0, err
	}
	if exists == 0 {
		return 0, nil
	}
	var max uint32
	if err := c.conn.QueryRow(ctx, "SELECT max(version) FROM schema_migrations").Scan(&max); err != nil {
		return 0, err
	}
	return int(max), nil
}

const failureTracesSQL = `SELECT trace_id, deployment_id, service, min(timestamp) AS ts
FROM telemetry_events FINAL
WHERE type = 'trace' AND service = 'demo-payments'
  AND JSONExtractString(attributes, 'span.kind') = 'server'
  AND deployment_id != '' AND timestamp >= ?
  AND JSONExtractInt(attributes, 'http.response.status_code') = 500
GROUP BY trace_id, deployment_id, service
ORDER BY ts`

func (c *ClickHouse) FailureTraces(ctx context.Context, since time.Time) ([]FailureRow, error) {
	rows, err := c.conn.Query(ctx, failureTracesSQL, since.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FailureRow
	for rows.Next() {
		var r FailureRow
		if err := rows.Scan(&r.TraceID, &r.DeploymentID, &r.Service, &r.Timestamp); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

const incidentColumns = `incident_id, revision, dedup_key, environment, service, deployment_id, trigger_rule, title,
       status, severity, started_at, detected_at, services, publication_state, published_at`

func (c *ClickHouse) IncidentsByKey(ctx context.Context, dedupKey string) ([]IncidentRow, error) {
	return c.queryIncidents(ctx,
		"SELECT "+incidentColumns+" FROM incidents FINAL WHERE dedup_key = ?", dedupKey)
}

// PendingIncidents selects only revisions that are pending and have no publish timestamp.
func (c *ClickHouse) PendingIncidents(ctx context.Context) ([]IncidentRow, error) {
	return c.queryIncidents(ctx,
		"SELECT "+incidentColumns+" FROM incidents FINAL WHERE publication_state = 'pending' AND published_at IS NULL")
}

func (c *ClickHouse) queryIncidents(ctx context.Context, sql string, args ...any) ([]IncidentRow, error) {
	rows, err := c.conn.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []IncidentRow
	for rows.Next() {
		var r IncidentRow
		var publishedAt *time.Time
		if err := rows.Scan(
			&r.IncidentID, &r.Revision, &r.DedupKey, &r.Environment, &r.Service, &r.DeploymentID,
			&r.TriggerRule, &r.Title, &r.Status, &r.Severity, &r.StartedAt, &r.DetectedAt,
			&r.Services, &r.PublicationState, &publishedAt,
		); err != nil {
			return nil, err
		}
		r.PublishedAt = publishedAt
		out = append(out, r)
	}
	return out, rows.Err()
}

// InsertIncidentWithEvidence writes the revision-1 pending incident, then its evidence, as two batches.
func (c *ClickHouse) InsertIncidentWithEvidence(ctx context.Context, inc IncidentRow, ev []EvidenceRow) error {
	if err := c.insertIncidentRow(ctx, inc); err != nil {
		return err
	}
	return c.InsertEvidence(ctx, ev)
}

// InsertEvidence writes evidence rows. The evidence_id is deterministic, so repeats are harmless.
func (c *ClickHouse) InsertEvidence(ctx context.Context, ev []EvidenceRow) error {
	if len(ev) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		"INSERT INTO evidence_items (evidence_id, incident_id, source_type, source_ref, timestamp, service, summary, reliability, ingested_at)")
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, row := range ev {
		if err := batch.Append(
			row.EvidenceID, row.IncidentID, row.SourceType, row.SourceRef, row.Timestamp.UTC(),
			row.Service, row.Summary, row.Reliability, now,
		); err != nil {
			return err
		}
	}
	return batch.Send()
}

func (c *ClickHouse) EvidenceCount(ctx context.Context, incidentID string) (int, error) {
	var n uint64
	if err := c.conn.QueryRow(ctx,
		"SELECT count() FROM evidence_items FINAL WHERE incident_id = ?", incidentID,
	).Scan(&n); err != nil {
		return 0, err
	}
	return int(n), nil
}

// MarkIncidentPublished appends revision inc.Revision+1 in the published state with a non-null
// UTC timestamp. Every other field is copied from inc, including detected_at.
func (c *ClickHouse) MarkIncidentPublished(ctx context.Context, inc IncidentRow, publishedAt time.Time) error {
	next := inc
	next.Revision = inc.Revision + 1
	next.PublicationState = "published"
	at := publishedAt.UTC()
	next.PublishedAt = &at
	return c.insertIncidentRow(ctx, next)
}

// insertIncidentRow writes one incident revision exactly as given. PublishedAt nil becomes SQL NULL.
func (c *ClickHouse) insertIncidentRow(ctx context.Context, inc IncidentRow) error {
	batch, err := c.conn.PrepareBatch(ctx, "INSERT INTO incidents ("+incidentColumns+")")
	if err != nil {
		return err
	}
	if err := batch.Append(
		inc.IncidentID, inc.Revision, inc.DedupKey, inc.Environment, inc.Service, inc.DeploymentID,
		inc.TriggerRule, inc.Title, inc.Status, inc.Severity, inc.StartedAt.UTC(), inc.DetectedAt.UTC(),
		inc.Services, inc.PublicationState, inc.PublishedAt,
	); err != nil {
		return err
	}
	return batch.Send()
}

func (c *ClickHouse) InsertCorrelationRun(ctx context.Context, run CorrelationRun) error {
	batch, err := c.conn.PrepareBatch(ctx,
		"INSERT INTO correlation_runs (run_id, evaluated_until, created_at)")
	if err != nil {
		return err
	}
	if err := batch.Append(run.RunID, run.EvaluatedUntil.UTC(), run.CreatedAt.UTC()); err != nil {
		return err
	}
	return batch.Send()
}

func (c *ClickHouse) LatestEvaluatedUntil(ctx context.Context) (time.Time, error) {
	var latest time.Time
	if err := c.conn.QueryRow(ctx, "SELECT max(evaluated_until) FROM correlation_runs").Scan(&latest); err != nil {
		return time.Time{}, err
	}
	return latest, nil
}

// InsertEvents writes canonical events with an explicit column list and one prepared batch.
// attributes is stored as a JSON object; ingested_at is the write time, the ReplacingMergeTree version.
func (c *ClickHouse) InsertEvents(ctx context.Context, events []canonical.Event) error {
	if len(events) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		"INSERT INTO telemetry_events (event_id, schema_version, timestamp, ingested_at, type, service, service_version, environment, deployment_id, trace_id, span_id, severity, attributes)")
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, e := range events {
		attrs := e.Attributes
		if attrs == nil {
			attrs = map[string]any{}
		}
		raw, err := json.Marshal(attrs)
		if err != nil {
			return fmt.Errorf("encode attributes for %s: %w", e.EventID, err)
		}
		if err := batch.Append(
			e.EventID, e.SchemaVersion, e.Timestamp.UTC(), now, e.Type, e.Service, e.ServiceVersion,
			e.Environment, e.DeploymentID, e.TraceID, e.SpanID, e.Severity, string(raw),
		); err != nil {
			return err
		}
	}
	return batch.Send()
}

// InsertDeployments writes canonical deployments with an explicit column list and one prepared batch.
func (c *ClickHouse) InsertDeployments(ctx context.Context, deployments []canonical.Deployment) error {
	if len(deployments) == 0 {
		return nil
	}
	batch, err := c.conn.PrepareBatch(ctx,
		"INSERT INTO deployments (deployment_id, timestamp, service, environment, new_version, previous_version, initiated_by, status, ingested_at)")
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	for _, d := range deployments {
		if err := batch.Append(
			d.DeploymentID, d.Timestamp.UTC(), d.Service, d.Environment, d.NewVersion,
			d.PreviousVersion, d.InitiatedBy, d.Status, now,
		); err != nil {
			return err
		}
	}
	return batch.Send()
}

const succeededDeploymentsSQL = `SELECT deployment_id, timestamp, service, environment, new_version, previous_version, initiated_by, status
FROM deployments FINAL
WHERE service = 'demo-payments' AND status = 'succeeded' AND timestamp >= ?
ORDER BY timestamp`

// SucceededDeployments reads demo-payments deployments with status succeeded, deduplicated with FINAL.
func (c *ClickHouse) SucceededDeployments(ctx context.Context, since time.Time) ([]canonical.Deployment, error) {
	rows, err := c.conn.Query(ctx, succeededDeploymentsSQL, since.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []canonical.Deployment
	for rows.Next() {
		var d canonical.Deployment
		if err := rows.Scan(&d.DeploymentID, &d.Timestamp, &d.Service, &d.Environment, &d.NewVersion,
			&d.PreviousVersion, &d.InitiatedBy, &d.Status); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

var _ Store = (*ClickHouse)(nil)
