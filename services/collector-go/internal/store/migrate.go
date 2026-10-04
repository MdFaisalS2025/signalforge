// Package store owns the ClickHouse schema, the migration runner, and the revisioned Store
// boundary used by the correlator and publisher.
package store

import (
	"fmt"
	"strconv"
	"strings"
)

const statementBreak = "-- statement-break"

// migration is one embedded schema file. Its SQL is loaded separately by name.
type migration struct {
	Version int
	Name    string
}

// splitStatements divides a migration file on statementBreak lines and drops empty pieces.
func splitStatements(sql string) []string {
	var out []string
	for _, part := range strings.Split(sql, statementBreak) {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// pending returns the migrations whose version is greater than the highest applied version.
// The input order is preserved.
func pending(all []migration, applied int) []migration {
	var out []migration
	for _, m := range all {
		if m.Version > applied {
			out = append(out, m)
		}
	}
	return out
}

// versionFromFilename parses the leading four digits of a migration filename.
func versionFromFilename(name string) (int, error) {
	if len(name) < 4 {
		return 0, fmt.Errorf("migration %q has no four-digit version prefix", name)
	}
	v, err := strconv.Atoi(name[:4])
	if err != nil {
		return 0, fmt.Errorf("migration %q has no four-digit version prefix", name)
	}
	return v, nil
}
