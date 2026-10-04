// Package publish sends pending incidents to incidents.created.v1 and records the publication. Delivery
// is at-least-once: a produce that succeeds followed by a failed state write is sent again on the next
// cycle, and the deterministic incident and evidence IDs prevent duplicate persisted rows.
package publish

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"time"

	"signalforge/collector-go/internal/ingest"
	"signalforge/collector-go/internal/store"
)

// Topic is the incident topic. Its message key is the incident_id.
const Topic = "incidents.created.v1"

// requiredEvidence is the number of evidence rows an incident must have before it is published:
// one deployment row and the three trigger traces.
const requiredEvidence = 4

// Publisher runs one publication cycle at a time. The fields FailProduceAttempts and CrashAfterProduce
// are test hooks and default off.
type Publisher struct {
	Store    store.Store
	Producer ingest.Producer
	Now      func() time.Time
	Exit     func(code int) // os.Exit when nil; recorded in tests

	FailProduceAttempts int  // test hook: the first N attempted produces fail without calling the producer
	CrashAfterProduce   bool // test hook: exit(1) after a successful produce, before the state write

	Log *slog.Logger // optional
}

// RunCycle publishes every pending incident that has all of its evidence. It returns only store read
// errors. Produce and state-write errors are logged, and the incident stays pending for the next cycle.
func (p *Publisher) RunCycle(ctx context.Context) error {
	pending, err := p.Store.PendingIncidents(ctx)
	if err != nil {
		return fmt.Errorf("read pending incidents: %w", err)
	}
	for _, inc := range pending {
		evidence, err := p.Store.EvidenceCount(ctx, inc.IncidentID)
		if err != nil {
			return fmt.Errorf("count evidence for %s: %w", inc.IncidentID, err)
		}
		if evidence != requiredEvidence {
			p.logger().Info("incident waits for evidence", "incident_id", inc.IncidentID, "evidence", evidence)
			continue
		}
		payload, err := IncidentPayload(inc)
		if err != nil {
			return fmt.Errorf("build payload for %s: %w", inc.IncidentID, err)
		}
		if err := p.produce(ctx, inc.IncidentID, payload); err != nil {
			p.logger().Error("publish failed", "incident_id", inc.IncidentID, "error", err)
			continue
		}
		if p.CrashAfterProduce {
			p.exit(1)
			return nil
		}
		if err := p.Store.MarkIncidentPublished(ctx, inc, p.Now()); err != nil {
			p.logger().Error("publish state write failed", "incident_id", inc.IncidentID, "error", err)
			continue
		}
		p.logger().Info("incident published", "incident_id", inc.IncidentID)
	}
	return nil
}

// produce sends one payload. While FailProduceAttempts has budget, the call fails without touching the
// producer.
func (p *Publisher) produce(ctx context.Context, incidentID string, payload []byte) error {
	if p.FailProduceAttempts > 0 {
		p.FailProduceAttempts--
		return fmt.Errorf("injected produce failure (%d more to inject)", p.FailProduceAttempts)
	}
	return p.Producer.Produce(ctx, Topic, incidentID, payload)
}

func (p *Publisher) exit(code int) {
	if p.Exit != nil {
		p.Exit(code)
		return
	}
	os.Exit(code)
}

func (p *Publisher) logger() *slog.Logger {
	if p.Log != nil {
		return p.Log
	}
	return slog.Default()
}

// incidentPayload is the incidents.created.v1 object (contracts/events/incident.schema.json). It has
// exactly these fields; dedup_key, revisions, and publication state are not part of it.
type incidentPayload struct {
	SchemaVersion string   `json:"schema_version"`
	IncidentID    string   `json:"incident_id"`
	Title         string   `json:"title"`
	Status        string   `json:"status"`
	Severity      string   `json:"severity"`
	StartedAt     string   `json:"started_at"`
	DetectedAt    string   `json:"detected_at"`
	Services      []string `json:"services"`
	TriggerRule   string   `json:"trigger_rule"`
}

// utcNanos formats a time as UTC RFC 3339 with nine fractional digits, as spec 8.5 shows.
func utcNanos(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000000000Z")
}

// IncidentPayload builds the incident object for one revision.
func IncidentPayload(inc store.IncidentRow) ([]byte, error) {
	return json.Marshal(incidentPayload{
		SchemaVersion: "1.0",
		IncidentID:    inc.IncidentID,
		Title:         inc.Title,
		Status:        inc.Status,
		Severity:      inc.Severity,
		StartedAt:     utcNanos(inc.StartedAt),
		DetectedAt:    utcNanos(inc.DetectedAt),
		Services:      inc.Services,
		TriggerRule:   inc.TriggerRule,
	})
}
