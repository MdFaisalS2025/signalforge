package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Fake is an in-memory Store with ReplacingMergeTree-equivalent behavior: every incident revision is
// kept and reads return the highest revision per incident_id; evidence keeps one row per evidence_id;
// telemetry keeps one row per event_id. FailRead and FailWrite inject errors into the matching calls.
type Fake struct {
	incidents   map[string][]IncidentRow // incident_id -> every revision inserted
	evidence    map[string]EvidenceRow   // evidence_id -> row
	telemetry   map[string]string        // event_id -> attributes (test-only payload)
	runs        []CorrelationRun
	failRead    bool
	failWrite   bool
	rowsWritten int
}

var errInjected = errors.New("injected store failure")

func NewFake() *Fake {
	return &Fake{
		incidents: map[string][]IncidentRow{},
		evidence:  map[string]EvidenceRow{},
		telemetry: map[string]string{},
	}
}

func (f *Fake) FailRead(on bool)  { f.failRead = on }
func (f *Fake) FailWrite(on bool) { f.failWrite = on }

// RowsWritten counts every row the fake accepted, across all tables.
func (f *Fake) RowsWritten() int { return f.rowsWritten }

// PutTelemetry stores one telemetry row by event ID; a second put replaces the first.
func (f *Fake) PutTelemetry(eventID, attributes string) {
	f.telemetry[eventID] = attributes
	f.rowsWritten++
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

func (f *Fake) FailureTraces(ctx context.Context, since time.Time) ([]FailureRow, error) {
	if f.failRead {
		return nil, errInjected
	}
	return nil, nil
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
