package canonical

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func load(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func find(events []Event, match func(Event) bool) Event {
	for _, e := range events {
		if match(e) {
			return e
		}
	}
	return Event{}
}

func TestTraceMappingCopiesIDsFromPayload(t *testing.T) {
	events, reason := MapTelemetryMessage(load(t, "traces.json"))
	if reason != "" {
		t.Fatal(reason)
	}
	got := find(events, func(e Event) bool { return e.SpanID == "b7ad6b7169203331" })
	if got.TraceID != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("trace id not copied: %q", got.TraceID)
	}
	if got.Type != "trace" || got.Service != "demo-payments" || got.DeploymentID != "d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f" {
		t.Fatalf("%+v", got)
	}
	if got.Timestamp.Nanosecond() != 719000123 {
		t.Fatalf("ns lost: %d", got.Timestamp.Nanosecond())
	}
	if got.Attributes["http.response.status_code"] != float64(500) {
		t.Fatalf("status attr: %v", got.Attributes)
	}
	if got.Attributes["span.kind"] != "server" {
		t.Fatalf("kind: %v", got.Attributes)
	}
}

func TestLogAttributesArePreserved(t *testing.T) {
	events, reason := MapTelemetryMessage(load(t, "logs.json"))
	if reason != "" {
		t.Fatal(reason)
	}
	got := events[0]
	if got.Attributes["order_id"] != "11111111-1111-1111-1111-111111111111" {
		t.Fatalf("order_id lost: %v", got.Attributes)
	}
	if got.TraceID != "0af7651916cd43dd8448eb211c80319c" || got.Severity != "error" {
		t.Fatalf("%+v", got)
	}
}

func TestTraceWithoutTraceIDIsRejected(t *testing.T) {
	_, reason := MapTelemetryMessage(load(t, "trace_missing_trace_id.json"))
	if reason != "trace_id and span_id are required for trace events" {
		t.Fatalf("got %q", reason)
	}
}

func TestLogWithoutTraceIDIsRejected(t *testing.T) {
	_, reason := MapTelemetryMessage(load(t, "log_missing_trace_id.json"))
	if reason != "trace_id is required for log events" {
		t.Fatalf("got %q", reason)
	}
}

func TestMetricHasNoTraceID(t *testing.T) {
	events, reason := MapTelemetryMessage(load(t, "metrics.json"))
	if reason != "" {
		t.Fatal(reason)
	}
	for _, e := range events {
		if e.Type == "metric" && e.TraceID != "" {
			t.Fatalf("fabricated trace id: %q", e.TraceID)
		}
	}
}

func TestMissingServiceNameIsRejected(t *testing.T) {
	_, reason := MapTelemetryMessage(load(t, "traces_no_service.json"))
	if reason != "service.name resource attribute is required" {
		t.Fatalf("got %q", reason)
	}
}

func TestInvalidJSONIsRejected(t *testing.T) {
	_, reason := MapTelemetryMessage([]byte("{not json"))
	if reason != "invalid JSON payload" {
		t.Fatalf("got %q", reason)
	}
}

func TestExactlyOneTopLevelKey(t *testing.T) {
	_, reason := MapTelemetryMessage([]byte(`{}`))
	if reason != "payload must contain exactly one of resourceSpans, resourceLogs, resourceMetrics" {
		t.Fatalf("got %q", reason)
	}
}

func TestDeploymentMappingAndStatus(t *testing.T) {
	d, reason := MapDeploymentMessage(load(t, "deployment.json"))
	if reason != "" || d.DeploymentID != "d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f" {
		t.Fatalf("%+v %q", d, reason)
	}
	_, reason = MapDeploymentMessage([]byte(`{"schema_version":"1.0","deployment_id":"d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f","timestamp":"2026-10-03T12:00:00Z","service":"demo-payments","new_version":"v","status":"failed"}`))
	if reason != "deployment event status must be succeeded" {
		t.Fatalf("got %q", reason)
	}
}

// Deployment payloads are validated against deployment_event.schema.json before they can reach ClickHouse.
const validDeploymentFields = `"schema_version":"1.0","deployment_id":"d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f","timestamp":"2026-10-03T12:00:00Z","service":"demo-payments","new_version":"0.2.0","status":"succeeded"`

func TestDeploymentRejectsUnsupportedSchemaVersion(t *testing.T) {
	_, reason := MapDeploymentMessage([]byte(`{"schema_version":"2.0","deployment_id":"d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f","timestamp":"2026-10-03T12:00:00Z","service":"demo-payments","new_version":"0.2.0","status":"succeeded"}`))
	if reason != "deployment event schema_version must be 1.0" {
		t.Fatalf("got %q", reason)
	}
}

func TestDeploymentRejectsMalformedDeploymentID(t *testing.T) {
	_, reason := MapDeploymentMessage([]byte(`{"schema_version":"1.0","deployment_id":"not-a-uuid","timestamp":"2026-10-03T12:00:00Z","service":"demo-payments","new_version":"0.2.0","status":"succeeded"}`))
	if reason != "deployment event deployment_id must be a valid UUID" {
		t.Fatalf("got %q", reason)
	}
}

func TestDeploymentRejectsUnexpectedField(t *testing.T) {
	_, reason := MapDeploymentMessage([]byte(`{` + validDeploymentFields + `,"color":"red"}`))
	if reason != "deployment event has unexpected field color" {
		t.Fatalf("got %q", reason)
	}
}

func TestDeploymentRejectsNonStringField(t *testing.T) {
	_, reason := MapDeploymentMessage([]byte(`{"schema_version":"1.0","deployment_id":"d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f","timestamp":"2026-10-03T12:00:00Z","service":5,"new_version":"0.2.0","status":"succeeded"}`))
	if reason != "deployment event service must be a string" {
		t.Fatalf("got %q", reason)
	}
}

func TestDeploymentAcceptsValidFields(t *testing.T) {
	d, reason := MapDeploymentMessage([]byte(`{` + validDeploymentFields + `}`))
	if reason != "" || d.NewVersion != "0.2.0" {
		t.Fatalf("%+v %q", d, reason)
	}
}

// Identity keys (spec 7.5). Each event_id must equal EventID over the planned key.
func TestSpanEventIDUsesPlannedKey(t *testing.T) {
	events, _ := MapTelemetryMessage(load(t, "traces.json"))
	want := EventID("trace|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331")
	if events[0].EventID != want {
		t.Fatalf("got %s, want %s", events[0].EventID, want)
	}
}

func TestLogEventIDUsesPlannedKey(t *testing.T) {
	events, _ := MapTelemetryMessage(load(t, "logs.json"))
	sum := sha256.Sum256([]byte("charge failed"))
	want := EventID("log|0af7651916cd43dd8448eb211c80319c|b7ad6b7169203331|1790000000719000123|" + hex.EncodeToString(sum[:]))
	if events[0].EventID != want {
		t.Fatalf("got %s, want %s", events[0].EventID, want)
	}
}

func TestMetricEventIDUsesPlannedKey(t *testing.T) {
	events, _ := MapTelemetryMessage(load(t, "metrics.json"))
	got := find(events, func(e Event) bool { return e.Attributes["metric.name"] == "payments.charges" })
	want := EventID("metric|demo-payments|payments.charges|outcome=failed|1790000000719000123")
	if got.EventID != want {
		t.Fatalf("got %s, want %s", got.EventID, want)
	}
}

// Syntactically valid OTLP JSON whose timestamp field is not an integer nanosecond string is a
// semantic error, not a JSON syntax error.
func TestNonIntegerOTLPTimestampsUseTimestampReason(t *testing.T) {
	const want = "OTLP timestamp must be an integer nanosecond value"
	const resource = `"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"demo-payments"}}]}`
	const ids = `"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331"`
	cases := []struct {
		name    string
		payload string
	}{
		{"span startTimeUnixNano", `{"resourceSpans":[{` + resource + `,"scopeSpans":[{"spans":[{` + ids + `,"startTimeUnixNano":"not-a-number"}]}]}]}`},
		{"log timeUnixNano", `{"resourceLogs":[{` + resource + `,"scopeLogs":[{"logRecords":[{` + ids + `,"timeUnixNano":"1.5"}]}]}]}`},
		{"log observedTimeUnixNano", `{"resourceLogs":[{` + resource + `,"scopeLogs":[{"logRecords":[{` + ids + `,"timeUnixNano":"","observedTimeUnixNano":"xyz"}]}]}]}`},
		{"metric timeUnixNano", `{"resourceMetrics":[{` + resource + `,"scopeMetrics":[{"metrics":[{"name":"m","gauge":{"dataPoints":[{"timeUnixNano":"soon","asDouble":1}]}}]}]}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, reason := MapTelemetryMessage([]byte(tc.payload))
			if reason != want {
				t.Fatalf("got %q, want %q", reason, want)
			}
		})
	}
}

// Syntactically valid OTLP JSON whose metric integer field (asInt or histogram count) is not an
// integer string is a semantic error, not a JSON syntax error.
func TestNonIntegerMetricIntegersUseMetricIntegerReason(t *testing.T) {
	const want = "OTLP metric integer field must be an integer"
	const resource = `"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"demo-payments"}}]}`
	cases := []struct {
		name    string
		payload string
	}{
		{"sum asInt", `{"resourceMetrics":[{` + resource + `,"scopeMetrics":[{"metrics":[{"name":"m","sum":{"dataPoints":[{"timeUnixNano":"1790000000719000123","asInt":"three"}]}}]}]}]}`},
		{"histogram count", `{"resourceMetrics":[{` + resource + `,"scopeMetrics":[{"metrics":[{"name":"m","histogram":{"dataPoints":[{"timeUnixNano":"1790000000719000123","count":"many","sum":1.5}]}}]}]}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, reason := MapTelemetryMessage([]byte(tc.payload))
			if reason != want {
				t.Fatalf("got %q, want %q", reason, want)
			}
		})
	}
}

func TestDeploymentBadTimestampUsesRatifiedReason(t *testing.T) {
	_, reason := MapDeploymentMessage([]byte(`{"schema_version":"1.0","deployment_id":"d3b07384-d9a0-4a3e-8f4c-1a2b3c4d5e6f","timestamp":"yesterday","service":"demo-payments","new_version":"v","status":"succeeded"}`))
	if reason != "deployment event timestamp must be RFC 3339" {
		t.Fatalf("got %q", reason)
	}
}

func TestMetricValuesAndKinds(t *testing.T) {
	events, _ := MapTelemetryMessage(load(t, "metrics.json"))
	sum := find(events, func(e Event) bool { return e.Attributes["metric.name"] == "payments.charges" })
	if sum.Attributes["metric.kind"] != "sum" || sum.Attributes["metric.value"] != float64(3) || sum.Attributes["outcome"] != "failed" {
		t.Fatalf("%+v", sum.Attributes)
	}
	gauge := find(events, func(e Event) bool { return e.Attributes["metric.name"] == "payments.queue_depth" })
	if gauge.Attributes["metric.kind"] != "gauge" || gauge.Attributes["metric.value"] != 7.5 {
		t.Fatalf("%+v", gauge.Attributes)
	}
}
