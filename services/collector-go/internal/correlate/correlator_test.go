package correlate

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"testing"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

var ctx = context.Background()

// fakeStore is a package-local store.Store test double. It mirrors the ReplacingMergeTree ... FINAL
// behavior the correlator depends on: one latest incident revision per incident_id, one evidence row
// per evidence_id, and pending/published transitions. FailRead and FailWrite inject errors.
type fakeStore struct {
	failures    []store.FailureRow
	deployments []canonical.Deployment
	incidents   map[string][]store.IncidentRow // incident_id -> every revision
	evidence    map[string]store.EvidenceRow   // evidence_id -> row
	runs        []store.CorrelationRun
	failRead    bool
	failWrite   bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{incidents: map[string][]store.IncidentRow{}, evidence: map[string]store.EvidenceRow{}}
}

func (s *fakeStore) FailRead(on bool)  { s.failRead = on }
func (s *fakeStore) FailWrite(on bool) { s.failWrite = on }

// IncidentRevisionCount counts every revision row across all incidents.
func (s *fakeStore) IncidentRevisionCount() int {
	n := 0
	for _, revs := range s.incidents {
		n += len(revs)
	}
	return n
}

func (s *fakeStore) EvidenceRowCount() int { return len(s.evidence) }

// DropEvidenceAfterFirst removes every evidence row except the first by evidence_id, simulating a
// partially failed evidence insert.
func (s *fakeStore) DropEvidenceAfterFirst() {
	ids := make([]string, 0, len(s.evidence))
	for id := range s.evidence {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids[1:] {
		delete(s.evidence, id)
	}
}

// latest returns the highest revision of each incident, ordered by incident_id.
func (s *fakeStore) latest() []store.IncidentRow {
	var out []store.IncidentRow
	for _, revs := range s.incidents {
		best := revs[0]
		for _, r := range revs[1:] {
			if r.Revision > best.Revision {
				best = r
			}
		}
		out = append(out, best)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].IncidentID < out[j].IncidentID })
	return out
}

var errRead = errors.New("injected read failure")
var errWrite = errors.New("injected write failure")

func (s *fakeStore) MigrateUp(ctx context.Context) error                              { return nil }
func (s *fakeStore) InsertEvents(ctx context.Context, events []canonical.Event) error { return nil }
func (s *fakeStore) InsertDeployments(ctx context.Context, d []canonical.Deployment) error {
	return nil
}

func (s *fakeStore) SucceededDeployments(ctx context.Context, since time.Time) ([]canonical.Deployment, error) {
	if s.failRead {
		return nil, errRead
	}
	var out []canonical.Deployment
	for _, d := range s.deployments {
		if d.Service == "demo-payments" && d.Status == "succeeded" && !d.Timestamp.Before(since) {
			out = append(out, d)
		}
	}
	return out, nil
}

func (s *fakeStore) FailureTraces(ctx context.Context, since time.Time) ([]store.FailureRow, error) {
	if s.failRead {
		return nil, errRead
	}
	var out []store.FailureRow
	for _, r := range s.failures {
		if !r.Timestamp.Before(since) {
			out = append(out, r)
		}
	}
	return out, nil
}

func (s *fakeStore) IncidentsByKey(ctx context.Context, dedupKey string) ([]store.IncidentRow, error) {
	if s.failRead {
		return nil, errRead
	}
	var out []store.IncidentRow
	for _, r := range s.latest() {
		if r.DedupKey == dedupKey {
			out = append(out, r)
		}
	}
	return out, nil
}

func (s *fakeStore) InsertIncidentWithEvidence(ctx context.Context, inc store.IncidentRow, ev []store.EvidenceRow) error {
	if s.failWrite {
		return errWrite
	}
	s.incidents[inc.IncidentID] = append(s.incidents[inc.IncidentID], inc)
	return s.InsertEvidence(ctx, ev)
}

func (s *fakeStore) InsertEvidence(ctx context.Context, ev []store.EvidenceRow) error {
	if s.failWrite {
		return errWrite
	}
	for _, row := range ev {
		s.evidence[row.EvidenceID] = row
	}
	return nil
}

func (s *fakeStore) EvidenceCount(ctx context.Context, incidentID string) (int, error) {
	if s.failRead {
		return 0, errRead
	}
	n := 0
	for _, row := range s.evidence {
		if row.IncidentID == incidentID {
			n++
		}
	}
	return n, nil
}

func (s *fakeStore) PendingIncidents(ctx context.Context) ([]store.IncidentRow, error) {
	if s.failRead {
		return nil, errRead
	}
	var out []store.IncidentRow
	for _, r := range s.latest() {
		if r.PublicationState == "pending" && r.PublishedAt == nil {
			out = append(out, r)
		}
	}
	return out, nil
}

func (s *fakeStore) MarkIncidentPublished(ctx context.Context, inc store.IncidentRow, publishedAt time.Time) error {
	if s.failWrite {
		return errWrite
	}
	next := inc
	next.Revision = inc.Revision + 1
	next.PublicationState = "published"
	at := publishedAt.UTC()
	next.PublishedAt = &at
	s.incidents[inc.IncidentID] = append(s.incidents[inc.IncidentID], next)
	return nil
}

func (s *fakeStore) InsertCorrelationRun(ctx context.Context, run store.CorrelationRun) error {
	if s.failWrite {
		return errWrite
	}
	s.runs = append(s.runs, run)
	return nil
}

func (s *fakeStore) LatestEvaluatedUntil(ctx context.Context) (time.Time, error) {
	var latest time.Time
	for _, r := range s.runs {
		if r.EvaluatedUntil.After(latest) {
			latest = r.EvaluatedUntil
		}
	}
	return latest, nil
}

var _ store.Store = (*fakeStore)(nil)

func fixed(at time.Time) func() time.Time { return func() time.Time { return at } }

// seedBurst adds three distinct failing traces for dep and the deployment itself.
func seedBurst(s *fakeStore, start time.Time, d canonical.Deployment) {
	s.deployments = append(s.deployments, d)
	s.failures = append(s.failures,
		fail("a", start),
		fail("b", start.Add(10*time.Second)),
		fail("c", start.Add(20*time.Second)),
	)
}

var burstKey = DedupKey("local", "demo-payments", "D1", TriggerRule)

func TestCycleCreatesPendingIncidentWithFourEvidenceRows(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
	if err := c.RunCycle(ctx, c.Now()); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.IncidentsByKey(ctx, burstKey)
	if len(rows) != 1 {
		t.Fatalf("incidents: %d", len(rows))
	}
	inc := rows[0]
	if inc.Revision != 1 || inc.PublicationState != "pending" || inc.Severity != "high" || inc.Status != "open" {
		t.Fatalf("%+v", inc)
	}
	if inc.PublishedAt != nil {
		t.Fatalf("pending incident must have nil PublishedAt: %v", *inc.PublishedAt)
	}
	if !inc.StartedAt.Equal(t0) || len(inc.Services) != 1 || inc.Services[0] != "demo-payments" {
		t.Fatalf("%+v", inc)
	}
	if !inc.DetectedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("detected_at %v", inc.DetectedAt)
	}
	if n, _ := s.EvidenceCount(ctx, inc.IncidentID); n != 4 {
		t.Fatalf("evidence: %d", n)
	}
	if s.failRead || s.IncidentRevisionCount() != 1 {
		t.Fatal("expected exactly one revision")
	}
}

func TestEvidenceIsDeploymentPlusThreeTriggerTraces(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
	_ = c.RunCycle(ctx, c.Now())
	rows, _ := s.IncidentsByKey(ctx, burstKey)
	id := rows[0].IncidentID
	refs := map[string]string{}
	for _, row := range s.evidence {
		if row.IncidentID != id {
			t.Fatalf("evidence for another incident: %+v", row)
		}
		refs[row.SourceRef] = row.SourceType
	}
	want := map[string]string{"D1": "deployment", "a": "trace", "b": "trace", "c": "trace"}
	if len(refs) != len(want) {
		t.Fatalf("refs %v, want %v", refs, want)
	}
	for ref, typ := range want {
		if refs[ref] != typ {
			t.Fatalf("ref %q type %q, want %q", ref, refs[ref], typ)
		}
	}
}

func TestSecondCycleIsIdempotent(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
	_ = c.RunCycle(ctx, c.Now())
	_ = c.RunCycle(ctx, c.Now())
	if s.IncidentRevisionCount() != 1 || s.EvidenceRowCount() != 4 {
		t.Fatal("not idempotent")
	}
}

func TestRepairsMissingEvidenceForExistingIncident(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
	_ = c.RunCycle(ctx, c.Now())
	s.DropEvidenceAfterFirst() // simulate a failed evidence insert
	_ = c.RunCycle(ctx, c.Now())
	if s.EvidenceRowCount() != 4 {
		t.Fatalf("not repaired: %d", s.EvidenceRowCount())
	}
	if s.IncidentRevisionCount() != 1 {
		t.Fatal("repair must not create an incident revision")
	}
}

func TestReadFailureReturnsErrorWithoutWriting(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	s.FailRead(true)
	c := &Correlator{Store: s, Now: fixed(t0)}
	if err := c.RunCycle(ctx, c.Now()); err == nil {
		t.Fatal("expected error")
	}
	if s.IncidentRevisionCount() != 0 || s.EvidenceRowCount() != 0 || len(s.runs) != 0 {
		t.Fatal("wrote after read failure")
	}
}

func TestCorrelationRunUsesMaximumFailureTimestamp(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
	_ = c.RunCycle(ctx, c.Now())
	u, _ := s.LatestEvaluatedUntil(ctx)
	if !u.Equal(t0.Add(20 * time.Second)) {
		t.Fatalf("evaluated_until %v, want the latest failure %v", u, t0.Add(20*time.Second))
	}
}

func TestCorrelationRunUsesNowWithoutFailures(t *testing.T) {
	s := newFakeStore()
	now := t0.Add(time.Minute)
	c := &Correlator{Store: s, Now: fixed(now)}
	if err := c.RunCycle(ctx, now); err != nil {
		t.Fatal(err)
	}
	if u, _ := s.LatestEvaluatedUntil(ctx); !u.Equal(now) {
		t.Fatalf("evaluated_until %v, want %v", u, now)
	}
}

// captureLog returns a JSON logger whose output can be searched for exact event names.
func captureLog() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, nil)), &buf
}

func TestCorrelatorLogsCreatedRepairedAndSuppressedEvents(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	created, createdBuf := captureLog()
	c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute)), Log: created}
	if err := c.RunCycle(ctx, c.Now()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(createdBuf.String(), `"msg":"incident created"`) {
		t.Fatalf("missing created event: %s", createdBuf.String())
	}

	s.DropEvidenceAfterFirst()
	repaired, repairedBuf := captureLog()
	c.Log = repaired
	if err := c.RunCycle(ctx, c.Now()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(repairedBuf.String(), `"msg":"incident evidence repaired"`) ||
		strings.Contains(repairedBuf.String(), `"msg":"incident created"`) {
		t.Fatalf("repair event wrong: %s", repairedBuf.String())
	}

	s.FailWrite(true)
	failed, failedBuf := captureLog()
	c.Log = failed
	s.DropEvidenceAfterFirst()
	if err := c.RunCycle(ctx, c.Now()); err == nil {
		t.Fatal("expected repair error")
	}
	if strings.Contains(failedBuf.String(), "incident evidence repaired") {
		t.Fatalf("logged repair before a successful write: %s", failedBuf.String())
	}
	s.FailWrite(false)

	s2 := newFakeStore()
	seedBurst(s2, t0, dep)
	s2.incidents["prior"] = []store.IncidentRow{{
		IncidentID: "prior", DedupKey: burstKey, Environment: "local", Service: "demo-payments",
		DeploymentID: "D1", TriggerRule: TriggerRule, Status: "open", Severity: "high",
		StartedAt: t0.Add(-2 * time.Minute), DetectedAt: t0.Add(-2 * time.Minute),
		Services: []string{"demo-payments"}, Revision: 1, PublicationState: "pending",
	}}
	suppressed, suppressedBuf := captureLog()
	c2 := &Correlator{Store: s2, Now: fixed(t0.Add(time.Minute)), Log: suppressed}
	if err := c2.RunCycle(ctx, c2.Now()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(suppressedBuf.String(), `"msg":"incident suppressed"`) ||
		strings.Contains(suppressedBuf.String(), `"msg":"incident created"`) {
		t.Fatalf("suppression event wrong: %s", suppressedBuf.String())
	}
}

func TestCandidateWithinDedupWindowIsSuppressed(t *testing.T) {
	s := newFakeStore()
	seedBurst(s, t0, dep)
	prior := store.IncidentRow{
		IncidentID: "prior-incident", DedupKey: burstKey, Environment: "local", Service: "demo-payments",
		DeploymentID: "D1", TriggerRule: TriggerRule, Status: "open", Severity: "high",
		StartedAt: t0.Add(-3 * time.Minute), DetectedAt: t0.Add(-3 * time.Minute),
		Services: []string{"demo-payments"}, Revision: 1, PublicationState: "pending",
	}
	if err := s.InsertIncidentWithEvidence(ctx, prior, nil); err != nil {
		t.Fatal(err)
	}
	c := &Correlator{Store: s, Now: fixed(t0.Add(time.Minute))}
	if err := c.RunCycle(ctx, c.Now()); err != nil {
		t.Fatal(err)
	}
	if s.IncidentRevisionCount() != 1 {
		t.Fatalf("candidate inside the dedup window created an incident: %d revisions", s.IncidentRevisionCount())
	}
}
