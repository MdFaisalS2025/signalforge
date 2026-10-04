package store

import (
	"context"
	"os"
	"testing"
	"time"
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

func TestClickHouseMigrationsApplyOnlyOnce(t *testing.T) {
	ctx := context.Background()
	c := integrationStore(t)
	if err := c.MigrateUp(ctx); err != nil {
		t.Fatal(err)
	}
	var before uint64
	if err := c.conn.QueryRow(ctx, "SELECT count() FROM schema_migrations").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := c.MigrateUp(ctx); err != nil {
		t.Fatal(err)
	}
	var after uint64
	if err := c.conn.QueryRow(ctx, "SELECT count() FROM schema_migrations").Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != before {
		t.Fatalf("second run applied %d migrations, want 0", after-before)
	}
}

func TestClickHouseNanosecondTimestampsRoundTripUnderFinal(t *testing.T) {
	ctx := context.Background()
	c := integrationStore(t)
	if err := c.MigrateUp(ctx); err != nil {
		t.Fatal(err)
	}
	ts := time.Date(2026, 10, 3, 12, 0, 0, 123456789, time.UTC)
	const eventID = "00000000-0000-4000-8000-00000000e001"
	if err := c.conn.Exec(ctx,
		`INSERT INTO telemetry_events (event_id, schema_version, timestamp, ingested_at, type, service, service_version,
		 environment, deployment_id, trace_id, span_id, severity, attributes)
		 VALUES (?, '1', ?, now64(3), 'trace', 'demo-payments', '', 'local', '', '', '', '', '{}')`,
		eventID, ts,
	); err != nil {
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

func TestClickHousePendingPublishedAtReadsNil(t *testing.T) {
	ctx := context.Background()
	c := integrationStore(t)
	if err := c.MigrateUp(ctx); err != nil {
		t.Fatal(err)
	}
	const incidentID = "00000000-0000-4000-8000-000000001001"
	key := "integration|demo-payments|D-int|payments-5xx-burst-after-deployment"
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
