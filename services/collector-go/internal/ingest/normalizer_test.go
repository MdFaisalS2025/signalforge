package ingest

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

var ctx = context.Background()

func fixedNow() time.Time { return time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC) }

const validTraceJSON = `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"demo-payments"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","name":"POST /charge","kind":2,"startTimeUnixNano":"1790000000719000123"}]}]}]}`

const noTraceIDJSON = `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"demo-orders"}}]},"scopeSpans":[{"spans":[{"spanId":"b7ad6b7169203331","name":"POST /orders","kind":2,"startTimeUnixNano":"1790000000719000123"}]}]}]}`

const deploymentJSON = `{"schema_version":"1.0","deployment_id":"d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f","timestamp":"2026-10-03T12:00:00Z","service":"demo-payments","environment":"local","new_version":"0.2.0-faulty","status":"succeeded"}`

func validTraceRecord(offset int64) Record {
	return Record{Topic: "telemetry.raw.v1", Offset: offset, Value: []byte(validTraceJSON)}
}

func invalidTraceRecordNoTraceID(offset int64) Record {
	return Record{Topic: "telemetry.raw.v1", Offset: offset, Value: []byte(noTraceIDJSON)}
}

func deploymentRecord(offset int64) Record {
	return Record{Topic: "deployments.v1", Offset: offset, Value: []byte(deploymentJSON)}
}

// fakeStore implements store.Store in memory. Only the canonical writes matter to the normalizer; the
// other methods are inert. It lives here because store's own fake is in a _test.go file.
type fakeStore struct {
	events      map[string]canonical.Event
	deployments map[string]canonical.Deployment
	failWrite   bool
	failFirst   int // the first failFirst write calls fail, then writes succeed
	writeCalls  int
	log         *[]string
}

func (s *fakeStore) FailWrite(on bool)    { s.failWrite = on }
func (s *fakeStore) FailFirstWrites(n int) { s.failFirst = n }
func (s *fakeStore) EventsWritten() int    { return len(s.events) }
func (s *fakeStore) DeploymentsWritten() int {
	return len(s.deployments)
}

func (s *fakeStore) writeFault() error {
	s.writeCalls++
	if s.failWrite || s.writeCalls <= s.failFirst {
		return errors.New("injected write failure")
	}
	return nil
}

func (s *fakeStore) MigrateUp(ctx context.Context) error { return nil }

func (s *fakeStore) InsertEvents(ctx context.Context, events []canonical.Event) error {
	if err := s.writeFault(); err != nil {
		return err
	}
	for _, e := range events {
		s.events[e.EventID] = e
	}
	*s.log = append(*s.log, "write-events")
	return nil
}

func (s *fakeStore) InsertDeployments(ctx context.Context, deployments []canonical.Deployment) error {
	if err := s.writeFault(); err != nil {
		return err
	}
	for _, d := range deployments {
		s.deployments[d.DeploymentID] = d
	}
	*s.log = append(*s.log, "write-deployments")
	return nil
}

func (s *fakeStore) SucceededDeployments(ctx context.Context, since time.Time) ([]canonical.Deployment, error) {
	return nil, nil
}
func (s *fakeStore) FailureTraces(ctx context.Context, since time.Time) ([]store.FailureRow, error) {
	return nil, nil
}
func (s *fakeStore) IncidentsByKey(ctx context.Context, dedupKey string) ([]store.IncidentRow, error) {
	return nil, nil
}
func (s *fakeStore) InsertIncidentWithEvidence(ctx context.Context, inc store.IncidentRow, ev []store.EvidenceRow) error {
	return nil
}
func (s *fakeStore) InsertEvidence(ctx context.Context, ev []store.EvidenceRow) error { return nil }
func (s *fakeStore) EvidenceCount(ctx context.Context, incidentID string) (int, error) {
	return 0, nil
}
func (s *fakeStore) PendingIncidents(ctx context.Context) ([]store.IncidentRow, error) {
	return nil, nil
}
func (s *fakeStore) MarkIncidentPublished(ctx context.Context, inc store.IncidentRow, publishedAt time.Time) error {
	return nil
}
func (s *fakeStore) InsertCorrelationRun(ctx context.Context, run store.CorrelationRun) error {
	return nil
}
func (s *fakeStore) LatestEvaluatedUntil(ctx context.Context) (time.Time, error) {
	return time.Time{}, nil
}

type fakeConsumer struct {
	committed []int64
	pending   []Record // returned by the next Poll, then cleared
	log       *[]string
}

func (c *fakeConsumer) Poll(ctx context.Context) ([]Record, error) {
	records := c.pending
	c.pending = nil
	return records, nil
}

func (c *fakeConsumer) Commit(ctx context.Context, records []Record) error {
	for _, r := range records {
		c.committed = append(c.committed, r.Offset)
	}
	*c.log = append(*c.log, "commit")
	return nil
}

func (c *fakeConsumer) Committed() []int64 { return c.committed }

type sentMessage struct {
	Topic string
	Key   string
	Value []byte
}

type fakeProducer struct {
	sent    []sentMessage
	failing bool
	calls   int
	log     *[]string
}

func (p *fakeProducer) Fail(on bool) { p.failing = on }

func (p *fakeProducer) Produce(ctx context.Context, topic, key string, value []byte) error {
	p.calls++
	if p.failing {
		return errors.New("injected produce failure")
	}
	p.sent = append(p.sent, sentMessage{Topic: topic, Key: key, Value: value})
	*p.log = append(*p.log, "produce")
	return nil
}

func (p *fakeProducer) Sent() []sentMessage { return p.sent }

type fakes struct {
	consumer *fakeConsumer
	producer *fakeProducer
	store    *fakeStore
	log      *[]string
}

func newFakes() fakes {
	log := &[]string{}
	return fakes{
		consumer: &fakeConsumer{log: log},
		producer: &fakeProducer{log: log},
		store: &fakeStore{
			events:      map[string]canonical.Event{},
			deployments: map[string]canonical.Deployment{},
			log:         log,
		},
		log: log,
	}
}

func newNormalizer(f fakes, b *Backoff) *Normalizer {
	return &Normalizer{Consumer: f.consumer, Producer: f.producer, Store: f.store, Now: fixedNow, Backoff: b}
}

// captureLog returns a JSON logger whose output can be searched for exact message names.
func captureLog() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, nil)), &buf
}

func TestDeadLetterProducedIsLoggedOnlyAfterProduceSucceeds(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	log, buf := captureLog()
	n.Log = log
	if err := n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(50)}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buf.String(), `"msg":"dead letter produced"`) {
		t.Fatalf("missing event: %s", buf.String())
	}

	failing := newFakes()
	failing.producer.Fail(true)
	m := newNormalizer(failing, instantBackoff(1))
	failLog, failBuf := captureLog()
	m.Log = failLog
	if err := m.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(51)}); err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(failBuf.String(), "dead letter produced") {
		t.Fatalf("logged before a successful produce: %s", failBuf.String())
	}
}

func TestBatchProcessedIsLoggedOnlyForNonEmptySuccessfulPolls(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	log, buf := captureLog()
	n.Log = log

	if err := n.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "batch processed") {
		t.Fatalf("empty poll logged a batch: %s", buf.String())
	}

	f.consumer.pending = []Record{validTraceRecord(60)}
	if err := n.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if strings.Count(buf.String(), `"msg":"batch processed"`) != 1 {
		t.Fatalf("expected one batch event: %s", buf.String())
	}

	failing := newFakes()
	failing.store.FailWrite(true)
	m := newNormalizer(failing, instantBackoff(1))
	failLog, failBuf := captureLog()
	m.Log = failLog
	failing.consumer.pending = []Record{validTraceRecord(61)}
	if err := m.PollOnce(ctx); err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(failBuf.String(), "batch processed") {
		t.Fatalf("logged a failed batch: %s", failBuf.String())
	}
}

func decodeDeadLetter(t *testing.T, value []byte) canonical.DeadLetter {
	t.Helper()
	var dl canonical.DeadLetter
	if err := json.Unmarshal(value, &dl); err != nil {
		t.Fatal(err)
	}
	return dl
}

func TestValidBatchIsWrittenThenCommitted(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	if err := n.ProcessBatch(ctx, []Record{validTraceRecord(7)}); err != nil {
		t.Fatal(err)
	}
	if f.store.EventsWritten() != 1 || f.consumer.Committed()[0] != 7 {
		t.Fatalf("%+v %+v", f.store, f.consumer)
	}
	if len(f.producer.Sent()) != 0 {
		t.Fatal("valid record must not be dead-lettered")
	}
}

func TestInvalidRecordGoesToDeadLetterWithExactReason(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	_ = n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(9)})
	sent := f.producer.Sent()
	if len(sent) != 1 || sent[0].Topic != "telemetry.dead-letter.v1" {
		t.Fatalf("%+v", sent)
	}
	dl := decodeDeadLetter(t, sent[0].Value)
	if dl.Reason != "trace_id and span_id are required for trace events" || dl.SourceOffset != 9 {
		t.Fatalf("%+v", dl)
	}
	if f.store.EventsWritten() != 0 {
		t.Fatal("invalid record must not be stored")
	}
	if f.consumer.Committed()[0] != 9 {
		t.Fatal("dead-lettered offset must be committed")
	}
}

func TestWriteFailureDoesNotCommit(t *testing.T) {
	f := newFakes()
	f.store.FailWrite(true)
	n := newNormalizer(f, instantBackoff(3))
	if err := n.ProcessBatch(ctx, []Record{validTraceRecord(11)}); err == nil {
		t.Fatal("expected failure after give-up")
	}
	if len(f.consumer.Committed()) != 0 {
		t.Fatal("offset committed despite failed write")
	}
}

func TestDeadLetterProduceFailureDoesNotCommit(t *testing.T) {
	f := newFakes()
	f.producer.Fail(true)
	n := newNormalizer(f, instantBackoff(1))
	if err := n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(12)}); err == nil {
		t.Fatal("expected error")
	}
	if len(f.consumer.Committed()) != 0 {
		t.Fatal("offset committed without dead letter")
	}
}

func TestDeploymentRecordIsStored(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	if err := n.ProcessBatch(ctx, []Record{deploymentRecord(13)}); err != nil {
		t.Fatal(err)
	}
	if f.store.DeploymentsWritten() != 1 {
		t.Fatal("deployment not written")
	}
	if f.consumer.Committed()[0] != 13 {
		t.Fatal("deployment offset not committed")
	}
}

func TestUnexpectedTopicIsDeadLettered(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	if err := n.ProcessBatch(ctx, []Record{{Topic: "other.v1", Offset: 14, Value: []byte("{}")}}); err != nil {
		t.Fatal(err)
	}
	dl := decodeDeadLetter(t, f.producer.Sent()[0].Value)
	if dl.Reason != "unexpected source topic other.v1" {
		t.Fatalf("%+v", dl)
	}
	if f.consumer.Committed()[0] != 14 {
		t.Fatal("unexpected-topic offset must be committed after dead-lettering")
	}
}

// Persistence and dead-letter produce happen before the commit, in that order.
func TestPersistenceAndDeadLettersPrecedeCommit(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	batch := []Record{validTraceRecord(1), invalidTraceRecordNoTraceID(2), deploymentRecord(3)}
	if err := n.ProcessBatch(ctx, batch); err != nil {
		t.Fatal(err)
	}
	want := []string{"write-events", "write-deployments", "produce", "commit"}
	if !reflect.DeepEqual(*f.log, want) {
		t.Fatalf("order %v, want %v", *f.log, want)
	}
	if !reflect.DeepEqual(f.consumer.Committed(), []int64{1, 2, 3}) {
		t.Fatalf("committed %v", f.consumer.Committed())
	}
}

func TestDeadLetterKeyIsDecimalSourceOffset(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	_ = n.ProcessBatch(ctx, []Record{invalidTraceRecordNoTraceID(4097)})
	sent := f.producer.Sent()
	if len(sent) != 1 || sent[0].Key != "4097" {
		t.Fatalf("%+v", sent)
	}
	dl := decodeDeadLetter(t, sent[0].Value)
	if dl.SourceTopic != "telemetry.raw.v1" || dl.SourceOffset != 4097 || dl.RawPayload != noTraceIDJSON {
		t.Fatalf("%+v", dl)
	}
}

// A transient write failure is retried; the batch commits only after the retry succeeds.
func TestTransientWriteFailureIsRetriedThenCommitted(t *testing.T) {
	f := newFakes()
	f.store.FailFirstWrites(2)
	n := newNormalizer(f, instantBackoff(3))
	if err := n.ProcessBatch(ctx, []Record{validTraceRecord(20)}); err != nil {
		t.Fatal(err)
	}
	if f.store.writeCalls != 3 || f.store.EventsWritten() != 1 {
		t.Fatalf("writes %d, events %d", f.store.writeCalls, f.store.EventsWritten())
	}
	if !reflect.DeepEqual(f.consumer.Committed(), []int64{20}) {
		t.Fatalf("committed %v", f.consumer.Committed())
	}
}

// The retry budget belongs to each operation. A shared template must not be consumed by earlier calls.
func TestRetryBudgetIsPerOperation(t *testing.T) {
	f := newFakes()
	f.store.FailWrite(true)
	n := newNormalizer(f, instantBackoff(1))
	for i := 0; i < 2; i++ {
		if err := n.ProcessBatch(ctx, []Record{validTraceRecord(int64(30 + i))}); err == nil {
			t.Fatalf("call %d: expected failure", i)
		}
	}
	if f.store.writeCalls != 4 {
		t.Fatalf("write attempts %d, want 4 (two per call)", f.store.writeCalls)
	}
}

func TestMixedBatchCommitsEveryOffset(t *testing.T) {
	f := newFakes()
	n := newNormalizer(f, NewBackoff())
	batch := []Record{validTraceRecord(40), invalidTraceRecordNoTraceID(41), deploymentRecord(42)}
	if err := n.ProcessBatch(ctx, batch); err != nil {
		t.Fatal(err)
	}
	if f.store.EventsWritten() != 1 || f.store.DeploymentsWritten() != 1 || len(f.producer.Sent()) != 1 {
		t.Fatalf("events %d deployments %d dead letters %d",
			f.store.EventsWritten(), f.store.DeploymentsWritten(), len(f.producer.Sent()))
	}
	if !reflect.DeepEqual(f.consumer.Committed(), []int64{40, 41, 42}) {
		t.Fatalf("committed %v", f.consumer.Committed())
	}
}
