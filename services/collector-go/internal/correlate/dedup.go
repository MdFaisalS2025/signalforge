package correlate

import (
	"strconv"
	"strings"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

// dedupWindow is the event-time window in which a candidate is suppressed by an earlier incident.
const dedupWindow = 5 * time.Minute

// DedupKey is environment|service|deployment_id|trigger_rule (spec 11).
func DedupKey(environment, service, deploymentID, triggerRule string) string {
	return strings.Join([]string{environment, service, deploymentID, triggerRule}, "|")
}

// Suppressed reports whether an existing incident for the same key began in
// [candidateStart - 5m, candidateStart). The window is measured from the start of the earlier incident,
// so the decision depends only on event time.
func Suppressed(existing []store.IncidentRow, candidateStart time.Time) bool {
	lower := candidateStart.Add(-dedupWindow)
	for _, row := range existing {
		if !row.StartedAt.Before(lower) && row.StartedAt.Before(candidateStart) {
			return true
		}
	}
	return false
}

// IncidentID is the deterministic incident identity: UUIDv5 of the key and the start in nanoseconds.
// The same burst always yields the same ID, so a re-run finds the existing row.
func IncidentID(dedupKey string, startedAt time.Time) string {
	return canonical.EventID(dedupKey + "|" + strconv.FormatInt(startedAt.UnixNano(), 10))
}

// EvidenceID is the deterministic evidence identity: UUIDv5 of the incident and the source reference.
func EvidenceID(incidentID, sourceRef string) string {
	return canonical.EventID(incidentID + "|" + sourceRef)
}
