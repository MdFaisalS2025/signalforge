package store

import (
	"context"
	"errors"
	"sort"
	"testing"
	"time"

	"signalforge/collector-go/internal/canonical"
)

// Fake is an in-memory Store with ReplacingMergeTree-equivalent behavior: every incident revision is
// kept and reads return the highest revision per incident_id; evidence keeps one row per evidence_id;
// telemetry keeps one row per event_id. FailRead and FailWrite inject errors into the matching calls.
type Fake struct {
	incidents   map[string][]IncidentRow        // incident_id -> every revision inserted
	evidence    map[string]EvidenceRow          // evidence_id -> row
	events      map[string]canonical.Event      // event_id -> canonical event
	deployments map[string]canonical.Deployment // deployment_id -> canonical deployment
	failures    []FailureRow                    // seeded by SeedFailureTraces
	runs        []CorrelationRun
	failRead    bool
	failWrite   bool
	rowsWritten int
}

var errInjected = errors.New("injected store failure")

func NewFake() *Fake {
	return &Fake{
		incidents:   map[string][]IncidentRow{},
		evidence:    map[string]EvidenceRow{},
		events:      map[string]canonical.Event{},
		deployments: map[string]canonical.Deployment{},
	}
}

func (f *Fake) FailRead(on bool)  { f.failRead = on }
func (f *Fake) FailWrite(on bool) { f.failWrite = on }

// RowsWritten counts every row the fake accepted, across all tables.
func (f *Fake) RowsWritten() int { return f.rowsWritten }

// EventsWritten returns the number of distinct canonical events held (one row per event_id).
func (f *Fake) EventsWritten() int { return len(f.events) }

// DeploymentsWritten returns the number of distinct deployments held (one row per deployment_id).
func (f *Fake) DeploymentsWritten() int { return len(f.deployments) }

// SeedFailureTraces sets the failure rows FailureTraces returns.
func (f *Fake) SeedFailureTraces(rows []FailureRow) { f.failures = append(f.failures, rows...) }

// InsertEvents keeps one row per event_id. A repeated deterministic ID replaces the earlier row.
func (f *Fake) InsertEvents(ctx context.Context, events []canonical.Event) error {
	if f.failWrite {
		return errInjected
	}
	for _, e := range events {
		f.events[e.EventID] = e
		f.rowsWritten++
	}
	return nil
}

// InsertDeployments keeps one row per deployment_id.
func (f *Fake) InsertDeployments(ctx context.Context, deployments []canonical.Deployment) error {
	if f.failWrite {
		return errInjected
	}
	for _, d := range deployments {
		f.deployments[d.DeploymentID] = d
		f.rowsWritten++
	}
	return nil
}

// SucceededDeployments returns demo-payments deployments with status succeeded and Timestamp >= since,
// ordered by Timestamp.
func (f *Fake) SucceededDeployments(ctx context.Context, since, until time.Time) ([]canonical.Deployment, error) {
	if f.failRead {
		return nil, errInjected
	}
	var out []canonical.Deployment
	for _, d := range f.deployments {
		if d.Service == "demo-payments" && d.Status == "succeeded" && !d.Timestamp.Before(since) && !d.Timestamp.After(until) {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp.Before(out[j].Timestamp) })
	return out, nil
}

// latestRevisions returns the highest-revision row for each incident_id, ordered by incident_id.
func (f *Fake) latestRevisions() []IncidentRow {
	var out []IncidentRow
	for _, revs := range f.incidents {
		best := revs[0]
		for _, r := range revs[1:] {
			if r.Revision > best.Revision {
				best = r
			}
		}
		out = append(out, best)
	}
	return out
}

func (f *Fake) MigrateUp(ctx context.Context) error {
	if f.failWrite {
		return errInjected
	}
	return nil
}

func (f *Fake) FailureTraces(ctx context.Context, since, until time.Time) ([]FailureRow, error) {
	if f.failRead {
		return nil, errInjected
	}
	var out []FailureRow
	for _, r := range f.failures {
		if !r.Timestamp.Before(since) && !r.Timestamp.After(until) {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Timestamp.Before(out[j].Timestamp) })
	return out, nil
}

func (f *Fake) IncidentsByKey(ctx context.Context, dedupKey string) ([]IncidentRow, error) {
	if f.failRead {
		return nil, errInjected
	}
	var out []IncidentRow
	for _, r := range f.latestRevisions() {
		if r.DedupKey == dedupKey {
			out = append(out, r)
		}
	}
	return out, nil
}

func (f *Fake) InsertIncidentWithEvidence(ctx context.Context, inc IncidentRow, ev []EvidenceRow) error {
	if f.failWrite {
		return errInjected
	}
	f.incidents[inc.IncidentID] = append(f.incidents[inc.IncidentID], inc)
	f.rowsWritten++
	return f.InsertEvidence(ctx, ev)
}

func (f *Fake) InsertEvidence(ctx context.Context, ev []EvidenceRow) error {
	if f.failWrite {
		return errInjected
	}
	for _, row := range ev {
		f.evidence[row.EvidenceID] = row
		f.rowsWritten++
	}
	return nil
}

func (f *Fake) EvidenceCount(ctx context.Context, incidentID string) (int, error) {
	if f.failRead {
		return 0, errInjected
	}
	n := 0
	for _, row := range f.evidence {
		if row.IncidentID == incidentID {
			n++
		}
	}
	return n, nil
}

// PendingIncidents returns the latest revision that is pending with a NULL published_at.
func (f *Fake) PendingIncidents(ctx context.Context) ([]IncidentRow, error) {
	if f.failRead {
		return nil, errInjected
	}
	var out []IncidentRow
	for _, r := range f.latestRevisions() {
		if r.PublicationState == "pending" && r.PublishedAt == nil {
			out = append(out, r)
		}
	}
	return out, nil
}

func (f *Fake) MarkIncidentPublished(ctx context.Context, inc IncidentRow, publishedAt time.Time) error {
	if f.failWrite {
		return errInjected
	}
	next := inc
	next.Revision = inc.Revision + 1
	next.PublicationState = "published"
	at := publishedAt.UTC()
	next.PublishedAt = &at
	f.incidents[inc.IncidentID] = append(f.incidents[inc.IncidentID], next)
	f.rowsWritten++
	return nil
}

func (f *Fake) InsertCorrelationRun(ctx context.Context, run CorrelationRun) error {
	if f.failWrite {
		return errInjected
	}
	f.runs = append(f.runs, run)
	f.rowsWritten++
	return nil
}

func (f *Fake) LatestEvaluatedUntil(ctx context.Context) (time.Time, error) {
	if f.failRead {
		return time.Time{}, errInjected
	}
	var latest time.Time
	for _, run := range f.runs {
		if run.EvaluatedUntil.After(latest) {
			latest = run.EvaluatedUntil
		}
	}
	return latest, nil
}

func TestFakeEventsDedupeByEventID(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	t0 := time.Unix(1000, 0).UTC()
	ev := canonical.Event{EventID: "e1", SchemaVersion: "1.0", Timestamp: t0, Type: "trace", Service: "demo-payments", Severity: "info", Attributes: map[string]any{}}
	_ = f.InsertEvents(ctx, []canonical.Event{ev, ev})
	_ = f.InsertEvents(ctx, []canonical.Event{ev})
	if f.EventsWritten() != 1 {
		t.Fatalf("%d events, want 1", f.EventsWritten())
	}
}

func TestSucceededDeploymentsFilter(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	since := time.Unix(1000, 0).UTC()
	_ = f.InsertDeployments(ctx, []canonical.Deployment{
		{DeploymentID: "late-ok", Timestamp: since.Add(5 * time.Second), Service: "demo-payments", Status: "succeeded"},
		{DeploymentID: "ok", Timestamp: since.Add(1 * time.Second), Service: "demo-payments", Status: "succeeded"},
		{DeploymentID: "before", Timestamp: since.Add(-time.Second), Service: "demo-payments", Status: "succeeded"},
		{DeploymentID: "failed", Timestamp: since.Add(2 * time.Second), Service: "demo-payments", Status: "failed"},
		{DeploymentID: "other", Timestamp: since.Add(3 * time.Second), Service: "demo-orders", Status: "succeeded"},
	})
	got, err := f.SucceededDeployments(ctx, since, since.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].DeploymentID != "ok" || got[1].DeploymentID != "late-ok" {
		t.Fatalf("%+v", got)
	}
	if f.DeploymentsWritten() != 5 {
		t.Fatalf("%d deployments written, want 5", f.DeploymentsWritten())
	}
}

func TestFakeWriteFailureRejectsCanonicalWrites(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	f.FailWrite(true)
	if err := f.InsertEvents(ctx, []canonical.Event{{EventID: "e2"}}); err == nil {
		t.Fatal("expected error")
	}
	if err := f.InsertDeployments(ctx, []canonical.Deployment{{DeploymentID: "d2"}}); err == nil {
		t.Fatal("expected error")
	}
	if f.EventsWritten() != 0 || f.DeploymentsWritten() != 0 {
		t.Fatal("rows written despite failure")
	}
}

var _ Store = (*Fake)(nil)

func TestFakeIncidentRevisionsReplace(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	inc := IncidentRow{IncidentID: "I", DedupKey: "k", Revision: 1, PublicationState: "pending", PublishedAt: nil}
	if err := f.InsertIncidentWithEvidence(ctx, inc, nil); err != nil {
		t.Fatal(err)
	}
	// MarkIncidentPublished takes the current (pending, revision 1) row and writes revision 2.
	if err := f.MarkIncidentPublished(ctx, inc, time.Unix(100, 0).UTC()); err != nil {
		t.Fatal(err)
	}
	rows, err := f.IncidentsByKey(ctx, "k")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Revision != 2 || rows[0].PublicationState != "published" || rows[0].PublishedAt == nil {
		t.Fatalf("%+v", rows)
	}
}

func TestFakePendingNullReplacedByPublishedWithoutDuplicateLogicalRow(t *testing.T) {
	ctx := context.Background()
	f := NewFake()
	pending := IncidentRow{IncidentID: "I", DedupKey: "k", Revision: 1, PublicationState: "pending"}
	if err := f.InsertIncidentWithEvidence(ctx, pending, nil); err != nil {
		t.Fatal(err)
	}

	before, err := f.PendingIncidents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 1 || before[0].PublishedAt != nil {
		t.Fatalf("pending revision must have nil PublishedAt: %+v", before)
	}

	at := time.Unix(200, 0).UTC()
	if err := f.MarkIncidentPublished(ctx, pending, at); err != nil {
		t.Fatal(err)
	}

	rows, err := f.IncidentsByKey(ctx, "k")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("logical incident duplicated: %+v", rows)
	}
	if rows[0].Revision != 2 || rows[0].PublicationState != "published" || rows[0].PublishedAt == nil || !rows[0].PublishedAt.Equal(at) {
		t.Fatalf("published revision not current: %+v", rows[0])
	}

	after, err := f.PendingIncidents(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 0 {
		t.Fatalf("published incident still pending: %+v", after)
	}
}
