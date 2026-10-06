package publish

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

var ctx = context.Background()

var t0 = time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)

const testKey = "local|demo-payments|D1|payments-5xx-burst-after-deployment"

var testIncidentID = canonical.EventID("publish-test|incident-1")

func fixed(at time.Time) func() time.Time { return func() time.Time { return at } }

func noExit(int) {}

func discardLog() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// fakeStore is a package-local store.Store test double. It keeps every incident revision (latest wins,
// as with ReplacingMergeTree ... FINAL) and one evidence row per evidence_id. FailRead and FailWrite
// inject errors.
type fakeStore struct {
	incidents map[string][]store.IncidentRow
	evidence  map[string]store.EvidenceRow
	failRead  bool
	failWrite bool
}

func newFakeStore() *fakeStore {
	return &fakeStore{incidents: map[string][]store.IncidentRow{}, evidence: map[string]store.EvidenceRow{}}
}

func (s *fakeStore) FailRead(on bool)  { s.failRead = on }
func (s *fakeStore) FailWrite(on bool) { s.failWrite = on }

func (s *fakeStore) IncidentRevisionCount() int {
	n := 0
	for _, revs := range s.incidents {
		n += len(revs)
	}
	return n
}

func (s *fakeStore) EvidenceRowCount() int { return len(s.evidence) }

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
func (s *fakeStore) SucceededDeployments(ctx context.Context, since, until time.Time) ([]canonical.Deployment, error) {
	return nil, nil
}
func (s *fakeStore) FailureTraces(ctx context.Context, since, until time.Time) ([]store.FailureRow, error) {
	return nil, nil
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
	return nil
}
func (s *fakeStore) LatestEvaluatedUntil(ctx context.Context) (time.Time, error) {
	return time.Time{}, nil
}

var _ store.Store = (*fakeStore)(nil)

// seedPendingIncident inserts the revision-1 pending incident with n of its evidence rows.
func seedPendingIncident(s *fakeStore, n int) {
	inc := store.IncidentRow{
		IncidentID: testIncidentID, DedupKey: testKey, Environment: "local", Service: "demo-payments",
		DeploymentID: "D1", TriggerRule: "payments-5xx-burst-after-deployment",
		Title: "Payments 5xx burst after deployment D1", Status: "open", Severity: "high",
		StartedAt: t0, DetectedAt: t0, Services: []string{"demo-payments"},
		Revision: 1, PublicationState: "pending", PublishedAt: nil,
	}
	var ev []store.EvidenceRow
	for i := 0; i < n; i++ {
		ev = append(ev, store.EvidenceRow{
			EvidenceID: canonical.EventID(testIncidentID + "|" + string(rune('a'+i))),
			IncidentID: testIncidentID, SourceType: "trace", SourceRef: string(rune('a' + i)),
			Service: "demo-payments", Summary: "row", Reliability: "high", Timestamp: t0,
		})
	}
	if err := s.InsertIncidentWithEvidence(ctx, inc, ev); err != nil {
		panic(err)
	}
}

type sentMessage struct {
	Topic string
	Key   string
	Value []byte
}

// fakeProducer records acknowledged produces. FailNext makes the next n produce calls fail without
// recording anything.
type fakeProducer struct {
	sent     []sentMessage
	failNext int
}

func (p *fakeProducer) FailNext(n int) { p.failNext = n }

func (p *fakeProducer) Produce(ctx context.Context, topic, key string, value []byte) error {
	if p.failNext > 0 {
		p.failNext--
		return errors.New("injected produce failure")
	}
	p.sent = append(p.sent, sentMessage{Topic: topic, Key: key, Value: value})
	return nil
}

func (p *fakeProducer) Sent() []sentMessage { return p.sent }

func TestPublishesPendingIncidentWithFourEvidenceAndMarksPublished(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	p := &fakeProducer{}
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0.Add(time.Minute)), Exit: noExit, Log: discardLog()}
	if err := pub.RunCycle(ctx); err != nil {
		t.Fatal(err)
	}
	if len(p.Sent()) != 1 || p.Sent()[0].Topic != "incidents.created.v1" || p.Sent()[0].Key != testIncidentID {
		t.Fatalf("%+v", p.Sent())
	}
	rows, _ := s.IncidentsByKey(ctx, testKey)
	if len(rows) != 1 || rows[0].Revision != 2 || rows[0].PublicationState != "published" {
		t.Fatalf("%+v", rows)
	}
	if rows[0].PublishedAt == nil || !rows[0].PublishedAt.Equal(t0.Add(time.Minute)) {
		t.Fatalf("published_at %v", rows[0].PublishedAt)
	}
	if s.IncidentRevisionCount() != 2 || s.EvidenceRowCount() != 4 {
		t.Fatal("duplicate rows")
	}
}

func TestPayloadMatchesIncidentContract(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	p := &fakeProducer{}
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0.Add(time.Minute)), Exit: noExit, Log: discardLog()}
	if err := pub.RunCycle(ctx); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(p.Sent()[0].Value, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"schema_version": "1.0",
		"incident_id":    testIncidentID,
		"title":          "Payments 5xx burst after deployment D1",
		"status":         "open",
		"severity":       "high",
		"started_at":     "2026-10-03T12:00:00.000000000Z",
		"detected_at":    "2026-10-03T12:00:00.000000000Z",
		"services":       []any{"demo-payments"},
		"trigger_rule":   "payments-5xx-burst-after-deployment",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("payload %v\nwant    %v", got, want)
	}
}

func TestSkipsPendingIncidentWithIncompleteEvidence(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 2)
	p := &fakeProducer{}
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
	_ = pub.RunCycle(ctx)
	if len(p.Sent()) != 0 {
		t.Fatal("published before four evidence rows")
	}
}

func TestProduceFailureLeavesPendingAndRetriesNextCycle(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	p := &fakeProducer{}
	p.FailNext(1)
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
	_ = pub.RunCycle(ctx)
	if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "pending" {
		t.Fatal("state changed after failed produce")
	}
	_ = pub.RunCycle(ctx)
	if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "published" || len(p.Sent()) != 1 {
		t.Fatalf("%+v", rows)
	}
}

// A state-write failure after a successful produce allows a second publish. Persisted rows do not
// change: still one incident, two revisions, four evidence rows.
func TestMarkFailureRetriesWithoutDuplicateIncident(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	s.FailWrite(true)
	p := &fakeProducer{}
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
	_ = pub.RunCycle(ctx) // produced, state write fails
	s.FailWrite(false)
	_ = pub.RunCycle(ctx) // produced again (allowed), state written
	if len(p.Sent()) != 2 {
		t.Fatalf("produces: %d", len(p.Sent()))
	}
	if s.IncidentRevisionCount() != 2 || s.EvidenceRowCount() != 4 {
		t.Fatal("duplicate incident or evidence rows")
	}
	if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "published" {
		t.Fatalf("%+v", rows)
	}
}

func TestCrashAfterProduceRecoversOnRestartWithoutDuplicateRows(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	p := &fakeProducer{}
	exitCode := -1
	crashing := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: func(c int) { exitCode = c }, CrashAfterProduce: true, Log: discardLog()}
	_ = crashing.RunCycle(ctx)
	if exitCode != 1 || len(p.Sent()) != 1 {
		t.Fatalf("exit %d, produces %d", exitCode, len(p.Sent()))
	}
	if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "pending" {
		t.Fatal("state written before exit")
	}
	restarted := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
	_ = restarted.RunCycle(ctx)
	if len(p.Sent()) != 2 {
		t.Fatalf("produces after restart: %d", len(p.Sent()))
	}
	if rows, _ := s.IncidentsByKey(ctx, testKey); rows[0].PublicationState != "published" {
		t.Fatal("not published after restart")
	}
	if s.IncidentRevisionCount() != 2 || s.EvidenceRowCount() != 4 {
		t.Fatal("duplicate incident or evidence rows")
	}
	if p.Sent()[0].Key != p.Sent()[1].Key {
		t.Fatal("redelivery must reuse the incident_id key")
	}
}

// FailProduceAttempts fails the first two attempted cycles before the producer is called.
func TestPublishFailHookFailsFirstNAttempts(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	p := &fakeProducer{}
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, FailProduceAttempts: 2, Log: discardLog()}
	_ = pub.RunCycle(ctx)
	_ = pub.RunCycle(ctx)
	_ = pub.RunCycle(ctx)
	if len(p.Sent()) != 1 {
		t.Fatalf("produces: %d", len(p.Sent()))
	}
}

// captureLog returns a JSON logger whose output can be searched for exact event names.
func captureLog() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, nil)), &buf
}

func TestIncidentPublishedIsLoggedOnlyAfterMarkSucceeds(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	p := &fakeProducer{}
	log, buf := captureLog()
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: log}
	if err := pub.RunCycle(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `"msg":"incident published"`) {
		t.Fatalf("missing published event: %s", buf.String())
	}

	s2 := newFakeStore()
	seedPendingIncident(s2, 4)
	s2.FailWrite(true)
	failLog, failBuf := captureLog()
	pub2 := &Publisher{Store: s2, Producer: &fakeProducer{}, Now: fixed(t0), Exit: noExit, Log: failLog}
	if err := pub2.RunCycle(ctx); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(failBuf.String(), "incident published") {
		t.Fatalf("logged published after a failed state write: %s", failBuf.String())
	}
	if !strings.Contains(failBuf.String(), "publish state write failed") {
		t.Fatalf("existing state-write failure event missing: %s", failBuf.String())
	}
}

func TestStoreReadFailureProducesNothing(t *testing.T) {
	s := newFakeStore()
	seedPendingIncident(s, 4)
	s.FailRead(true)
	p := &fakeProducer{}
	pub := &Publisher{Store: s, Producer: p, Now: fixed(t0), Exit: noExit, Log: discardLog()}
	if err := pub.RunCycle(ctx); err == nil {
		t.Fatal("expected error")
	}
	if len(p.Sent()) != 0 {
		t.Fatal("produced after read failure")
	}
}
