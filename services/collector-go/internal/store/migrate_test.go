package store

import "testing"

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
