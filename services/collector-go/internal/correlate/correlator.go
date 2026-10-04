package correlate

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

// lookbackWindow is the wall-clock window of records each cycle reads.
const lookbackWindow = 10 * time.Minute

// Correlator runs one detection cycle at a time. It has no producer: it never publishes.
type Correlator struct {
	Store store.Store
	Now   func() time.Time
	Log   *slog.Logger // optional; suppressed candidates are logged when set
}

// RunCycle reads failures and succeeded deployments from the lookback window. A read error returns at
// once, before any write. Otherwise it creates, or repairs the evidence of, each detected incident and
// records the cycle. Creation inserts revision 1 in the pending state with no published timestamp.
func (c *Correlator) RunCycle(ctx context.Context, now time.Time) error {
	since := now.Add(-lookbackWindow)
	failures, err := c.Store.FailureTraces(ctx, since)
	if err != nil {
		return fmt.Errorf("read failure traces: %w", err)
	}
	deployments, err := c.Store.SucceededDeployments(ctx, since)
	if err != nil {
		return fmt.Errorf("read succeeded deployments: %w", err)
	}
	for _, cand := range DetectBurst(failures, deployments) {
		if err := c.handle(ctx, cand, now); err != nil {
			return err
		}
	}
	run := store.CorrelationRun{
		RunID:          canonical.EventID("correlation_run|" + now.UTC().Format(time.RFC3339Nano)),
		EvaluatedUntil: evaluatedUntil(failures, now),
		CreatedAt:      now.UTC(),
	}
	if err := c.Store.InsertCorrelationRun(ctx, run); err != nil {
		return fmt.Errorf("record correlation run: %w", err)
	}
	return nil
}

// handle processes one candidate: repair evidence for an existing incident, skip a suppressed
// candidate, or create a new pending incident with its evidence.
func (c *Correlator) handle(ctx context.Context, cand Candidate, now time.Time) error {
	dep := cand.Deployment
	key := DedupKey(dep.Environment, dep.Service, dep.DeploymentID, TriggerRule)
	id := IncidentID(key, cand.StartedAt)
	evidence := evidenceFor(id, cand)

	existing, err := c.Store.IncidentsByKey(ctx, key)
	if err != nil {
		return fmt.Errorf("read incidents for %s: %w", key, err)
	}
	if hasIncident(existing, id) {
		if err := c.Store.InsertEvidence(ctx, evidence); err != nil {
			return fmt.Errorf("repair evidence for %s: %w", id, err)
		}
		c.logger().Info("incident evidence repaired", "incident_id", id)
		return nil
	}
	if Suppressed(existing, cand.StartedAt) {
		c.logger().Info("incident suppressed", "dedup_key", key, "started_at", cand.StartedAt)
		return nil
	}

	inc := store.IncidentRow{
		IncidentID:       id,
		Revision:         1,
		DedupKey:         key,
		Environment:      dep.Environment,
		Service:          dep.Service,
		DeploymentID:     dep.DeploymentID,
		TriggerRule:      TriggerRule,
		Title:            "Payments 5xx burst after deployment " + dep.DeploymentID,
		Status:           "open",
		Severity:         "high",
		StartedAt:        cand.StartedAt.UTC(),
		DetectedAt:       now.UTC(),
		Services:         []string{dep.Service},
		PublicationState: "pending",
		PublishedAt:      nil,
	}
	if err := c.Store.InsertIncidentWithEvidence(ctx, inc, evidence); err != nil {
		return fmt.Errorf("create incident %s: %w", id, err)
	}
	c.logger().Info("incident created", "incident_id", id, "dedup_key", key, "started_at", cand.StartedAt)
	return nil
}

func (c *Correlator) logger() *slog.Logger {
	if c.Log != nil {
		return c.Log
	}
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// evidenceFor builds the four evidence rows of a candidate: the deployment and the three trigger traces.
// Every evidence ID is deterministic, so repeating the insert is harmless.
func evidenceFor(incidentID string, cand Candidate) []store.EvidenceRow {
	dep := cand.Deployment
	rows := []store.EvidenceRow{{
		EvidenceID:  EvidenceID(incidentID, dep.DeploymentID),
		IncidentID:  incidentID,
		SourceType:  "deployment",
		SourceRef:   dep.DeploymentID,
		Service:     dep.Service,
		Summary:     fmt.Sprintf("%s version %s deployed", dep.Service, dep.NewVersion),
		Reliability: "high",
		Timestamp:   dep.Timestamp.UTC(),
	}}
	for _, trigger := range cand.Triggers {
		rows = append(rows, store.EvidenceRow{
			EvidenceID:  EvidenceID(incidentID, trigger.TraceID),
			IncidentID:  incidentID,
			SourceType:  "trace",
			SourceRef:   trigger.TraceID,
			Service:     dep.Service,
			Summary:     fmt.Sprintf("%s returned HTTP 500 for trace %s", dep.Service, trigger.TraceID),
			Reliability: "high",
			Timestamp:   trigger.Timestamp.UTC(),
		})
	}
	return rows
}

func hasIncident(rows []store.IncidentRow, id string) bool {
	for _, r := range rows {
		if r.IncidentID == id {
			return true
		}
	}
	return false
}

// evaluatedUntil is the latest failure timestamp read in the cycle, or now when none were read.
func evaluatedUntil(failures []store.FailureRow, now time.Time) time.Time {
	if len(failures) == 0 {
		return now.UTC()
	}
	latest := failures[0].Timestamp
	for _, f := range failures[1:] {
		if f.Timestamp.After(latest) {
			latest = f.Timestamp
		}
	}
	return latest.UTC()
}
