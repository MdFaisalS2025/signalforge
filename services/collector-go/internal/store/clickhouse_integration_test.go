package store

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	"signalforge/collector-go/internal/canonical"
)

// integrationStore opens the live ClickHouse at CLICKHOUSE_HOST. The test is skipped when the
// variable is unset, so the default unit run needs no stack.
func integrationStore(t *testing.T) *ClickHouse {
	t.Helper()
	host := os.Getenv("CLICKHOUSE_HOST")
	if host == "" {
		t.Skip("CLICKHOUSE_HOST not set; live ClickHouse contract skipped")
	}
	addr := host + ":9000"
	c, err := OpenClickHouse(addr, envOr("CLICKHOUSE_DB", "signalforge"), envOr("CLICKHOUSE_USER", "default"), os.Getenv("CLICKHOUSE_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func TestIntegrationClickHouseMigrationsApplyOnlyOnce(t *testing.T) {
	ctx := context.Background()
	c := integrationStore(t)
	// The stack may already have applied the migrations at startup, so the first call may report 0.
	// The contract is that the schema_migrations rows equal the embedded files, and a repeat applies 0.
	if _, err := c.MigrateUpWithCount(ctx); err != nil {
		t.Fatal(err)
	}
	var before uint64
	if err := c.conn.QueryRow(ctx, "SELECT count() FROM schema_migrations").Scan(&before); err != nil {
		t.Fatal(err)
	}
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if before != uint64(len(all)) {
		t.Fatalf("schema_migrations has %d rows, want %d", before, len(all))
	}
	applied, err := c.MigrateUpWithCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if applied != 0 {
		t.Fatalf("second run reported applied=%d, want 0", applied)
	}
	var after uint64
	if err := c.conn.QueryRow(ctx, "SELECT count() FROM schema_migrations").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("second run added %d schema_migrations rows", after-before)
	}
}

// A fresh database applies every migration exactly once and reports the actual count. The test can
// only observe that count when it runs against an empty database, so it is skipped otherwise.
func TestIntegrationClickHouseFreshDatabaseReportsAppliedCount(t *testing.T) {
	if os.Getenv("CLICKHOUSE_FRESH_DATABASE") != "1" {
		t.Skip("set CLICKHOUSE_FRESH_DATABASE=1 on a database with no schema_migrations table")
	}
	ctx := context.Background()
	c := integrationStore(t)
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	applied, err := c.MigrateUpWithCount(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if applied != len(all) {
		t.Fatalf("applied=%d, want %d", applied, len(all))
	}
}

func TestIntegrationClickHouseNanosecondTimestampsRoundTripUnderFinal(t *testing.T) {
	ctx := context.Background()
	c := integrationStore(t)
	if err := c.MigrateUp(ctx); err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2026, 10, 3, 12, 0, 0, 123456789, time.UTC)
	const eventID = "00000000-0000-4000-8000-00000000e001"
	// Insert through the production batch path. A scalar Exec parameter loses sub-second precision in
	// the driver, which would test the wrong thing.
	event := canonical.Event{
		EventID: eventID, SchemaVersion: "1.0", Timestamp: ts, Type: "trace", Service: "demo-payments",
		Environment: "local", TraceID: "0af7651916cd43dd8448eb211c80319c", SpanID: "b7ad6b7169203331",
		Severity: "info", Attributes: map[string]any{},
	}
	if err := c.InsertEvents(ctx, []canonical.Event{event}); err != nil {
		t.Fatal(err)
	}
	var got time.Time
	if err := c.conn.QueryRow(ctx,
		"SELECT timestamp FROM telemetry_events FINAL WHERE event_id = ?", eventID,
	).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Equal(ts) {
		t.Fatalf("timestamp %s, want %s", got.Format(time.RFC3339Nano), ts.Format(time.RFC3339Nano))
	}
}

func TestIntegrationClickHousePendingPublishedAtReadsNil(t *testing.T) {
	ctx := context.Background()
	c := integrationStore(t)
	if err := c.MigrateUp(ctx); err != nil {
		t.Fatal(err)
	}
	// Each run gets its own incident and key, so earlier runs' revisions cannot affect the assertions.
	run := strconv.FormatInt(time.Now().UnixNano(), 10)
	incidentID := canonical.EventID("integration-incident|" + run)
	key := "integration|demo-payments|" + run + "|payments-5xx-burst-after-deployment"
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	pending := IncidentRow{
		IncidentID: incidentID, DedupKey: key, Environment: "local", Service: "demo-payments",
		DeploymentID: "D-int", TriggerRule: "payments-5xx-burst-after-deployment",
		Title: "integration", Status: "open", Severity: "high",
		StartedAt: now, DetectedAt: now, Services: []string{"demo-payments"},
		Revision: 1, PublicationState: "pending", PublishedAt: nil,
	}
	if err := c.InsertIncidentWithEvidence(ctx, pending, nil); err != nil {
		t.Fatal(err)
	}
	rows, err := c.IncidentsByKey(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].PublicationState != "pending" || rows[0].PublishedAt != nil {
		t.Fatalf("pending row must read PublishedAt nil: %+v", rows)
	}

	if err := c.MarkIncidentPublished(ctx, rows[0], now.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	rows, err = c.IncidentsByKey(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Revision != 2 || rows[0].PublishedAt == nil {
		t.Fatalf("published revision must read non-nil PublishedAt: %+v", rows)
	}
}

// Canonical writes and reads: one event round-trips with its nanosecond timestamp and attributes, and
// one succeeded deployment is returned by SucceededDeployments.
func TestIntegrationClickHouseCanonicalEventAndSucceededDeployment(t *testing.T) {
	ctx := context.Background()
	c := integrationStore(t)
	if err := c.MigrateUp(ctx); err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2026, 10, 3, 12, 0, 0, 987654321, time.UTC)

	ev := canonical.Event{
		EventID: "00000000-0000-4000-8000-00000000e002", SchemaVersion: "1.0", Timestamp: ts,
		Type: "trace", Service: "demo-payments", ServiceVersion: "0.2.0-faulty", Environment: "local",
		DeploymentID: "00000000-0000-4000-8000-00000000d002", TraceID: "0af7651916cd43dd8448eb211c80319c",
		SpanID: "b7ad6b7169203331", Severity: "info",
		Attributes: map[string]any{"span.kind": "server", "http.response.status_code": float64(500)},
	}
	if err := c.InsertEvents(ctx, []canonical.Event{ev}); err != nil {
		t.Fatal(err)
	}
	var gotTS time.Time
	var gotAttrs string
	if err := c.conn.QueryRow(ctx,
		"SELECT timestamp, attributes FROM telemetry_events FINAL WHERE event_id = ?", ev.EventID,
	).Scan(&gotTS, &gotAttrs); err != nil {
		t.Fatal(err)
	}
	if !gotTS.Equal(ts) {
		t.Fatalf("event timestamp %s, want %s", gotTS.Format(time.RFC3339Nano), ts.Format(time.RFC3339Nano))
	}
	var attrs map[string]any
	if err := json.Unmarshal([]byte(gotAttrs), &attrs); err != nil {
		t.Fatal(err)
	}
	if attrs["span.kind"] != "server" || attrs["http.response.status_code"] != float64(500) {
		t.Fatalf("attributes did not round-trip: %v", attrs)
	}

	dep := canonical.Deployment{
		DeploymentID: "00000000-0000-4000-8000-00000000d002", Timestamp: ts, Service: "demo-payments",
		Environment: "local", NewVersion: "0.2.0-faulty", PreviousVersion: "0.1.0",
		InitiatedBy: "integration", Status: "succeeded",
	}
	if err := c.InsertDeployments(ctx, []canonical.Deployment{dep}); err != nil {
		t.Fatal(err)
	}
	got, err := c.SucceededDeployments(ctx, ts.Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, d := range got {
		if d.DeploymentID == dep.DeploymentID {
			found = true
			if !d.Timestamp.Equal(ts) || d.Status != "succeeded" {
				t.Fatalf("deployment did not round-trip: %+v", d)
			}
		}
	}
	if !found {
		t.Fatalf("succeeded deployment %s not returned: %+v", dep.DeploymentID, got)
	}
}
