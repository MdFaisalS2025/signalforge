package store

import (
	"strings"
	"testing"
)

func TestSplitStatements(t *testing.T) {
	got := splitStatements("CREATE A;\n-- statement-break\nCREATE B;\n")
	if len(got) != 2 || got[0] != "CREATE A;" || got[1] != "CREATE B;" {
		t.Fatalf("%q", got)
	}
}

func TestPendingSkipsApplied(t *testing.T) {
	all := []migration{{1, "a"}, {2, "b"}, {3, "c"}}
	got := pending(all, 2)
	if len(got) != 1 || got[0].Version != 3 {
		t.Fatalf("%+v", got)
	}
}

func TestVersionFromFilename(t *testing.T) {
	v, err := versionFromFilename("0001_correlation_schema.sql")
	if err != nil || v != 1 {
		t.Fatalf("%d %v", v, err)
	}
	if _, err := versionFromFilename("schema.sql"); err == nil {
		t.Fatal("expected error")
	}
}

// The diagnoses table is created by migration 2 (docs/specs/2026-10-07-evidence-cited-diagnosis.md, section 8.1). The
// agent runs no DDL, so the schema owner, collector-go, must create it, exactly as specified and nothing more.
func TestEmbeddedMigrationsIncludeDiagnoses(t *testing.T) {
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	var found *migration
	for i := range all {
		if all[i].Version == 2 {
			found = &all[i]
		}
	}
	if found == nil {
		t.Fatalf("expected migration version 2, got %+v", all)
	}
	if found.Name != "0002_diagnoses.sql" {
		t.Fatalf("migration 2 is %q, want 0002_diagnoses.sql", found.Name)
	}

	body, err := migrationFiles.ReadFile("migrations/" + found.Name)
	if err != nil {
		t.Fatal(err)
	}
	statements := splitStatements(string(body))
	if len(statements) != 1 {
		t.Fatalf("migration 2 must be exactly one statement, got %d", len(statements))
	}
	sql := statements[0]
	if !strings.Contains(sql, "CREATE TABLE IF NOT EXISTS diagnoses") {
		t.Fatalf("missing CREATE TABLE IF NOT EXISTS diagnoses:\n%s", sql)
	}
	columns := []string{
		"diagnosis_id UUID",
		"incident_id UUID",
		"diagnosis_version UInt32",
		"status LowCardinality(String)",
		"confidence LowCardinality(String)",
		"failure_code LowCardinality(String)",
		"provider LowCardinality(String)",
		"model_version String",
		"prompt_version String",
		"analyzer_id String",
		"input_digest String",
		"document String",
		"created_at DateTime64(3, 'UTC')",
	}
	last := -1
	for _, column := range columns {
		at := strings.Index(sql, column)
		if at < 0 {
			t.Fatalf("missing column %q in:\n%s", column, sql)
		}
		if at < last {
			t.Fatalf("column %q is out of order", column)
		}
		last = at
	}
	if !strings.Contains(sql, "ENGINE = ReplacingMergeTree(created_at)") {
		t.Fatalf("engine must be ReplacingMergeTree(created_at):\n%s", sql)
	}
	if !strings.Contains(sql, "ORDER BY (incident_id, diagnosis_version)") {
		t.Fatalf("order key must be (incident_id, diagnosis_version):\n%s", sql)
	}
	for _, forbidden := range []string{"GRANT", "ALTER", "DROP", "INSERT", "INDEX", "TTL", "PARTITION", "DELETE"} {
		if strings.Contains(strings.ToUpper(sql), forbidden) {
			t.Fatalf("migration 2 must not contain %s:\n%s", forbidden, sql)
		}
	}
}

// Migration 1 is not touched, and versions stay contiguous so the runner applies them in order.
func TestEmbeddedMigrationVersionsAreContiguousFromOne(t *testing.T) {
	all, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	for i, m := range all {
		if m.Version != i+1 {
			t.Fatalf("migration %d has version %d: %+v", i, m.Version, all)
		}
	}
	if len(all) < 1 || all[0].Name != "0001_correlation_schema.sql" {
		t.Fatalf("migration 1 must stay 0001_correlation_schema.sql: %+v", all)
	}
}
