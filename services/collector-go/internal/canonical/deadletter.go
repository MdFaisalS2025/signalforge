package canonical

import (
	"encoding/json"
	"time"
)

// Exact rejection reasons (spec 8.1). Fixture tests assert these strings.
const (
	ReasonInvalidJSON             = "invalid JSON payload"
	ReasonOTLPTimestampInvalid    = "OTLP timestamp must be an integer nanosecond value"
	ReasonPayloadShape            = "payload must contain exactly one of resourceSpans, resourceLogs, resourceMetrics"
	ReasonServiceNameRequired     = "service.name resource attribute is required"
	ReasonTraceSpanIDsRequired    = "trace_id and span_id are required for trace events"
	ReasonLogTraceIDRequired      = "trace_id is required for log events"
	ReasonDeploymentStatus        = "deployment event status must be succeeded"
	ReasonDeploymentTimestampBad  = "deployment event timestamp must be RFC 3339"
	reasonDeploymentMissingPrefix = "deployment event is missing "
	reasonUnsupportedMetricPrefix = "unsupported metric type: "
)

// DeadLetter is the telemetry.dead-letter.v1 record (contracts/events/dead_letter.schema.json).
type DeadLetter struct {
	SchemaVersion   string    `json:"schema_version"`
	Reason          string    `json:"reason"`
	SourceTopic     string    `json:"source_topic"`
	SourcePartition int32     `json:"source_partition"`
	SourceOffset    int64     `json:"source_offset"`
	ReceivedAt      time.Time `json:"received_at"`
	RawPayload      string    `json:"raw_payload"`
}

// EncodeDeadLetter serializes a dead-letter record with the field names the schema requires.
func EncodeDeadLetter(dl DeadLetter) ([]byte, error) {
	dl.SchemaVersion = "1.0"
	dl.ReceivedAt = dl.ReceivedAt.UTC()
	return json.Marshal(dl)
}
