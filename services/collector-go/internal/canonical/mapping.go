package canonical

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Event is one canonical telemetry record (spec 7.2). EventID is the UUIDv5 identity from section 7.5.
type Event struct {
	EventID        string
	SchemaVersion  string
	Timestamp      time.Time
	Type           string
	Service        string
	ServiceVersion string
	Environment    string
	DeploymentID   string
	TraceID        string
	SpanID         string
	Severity       string
	Attributes     map[string]any
}

// Deployment is one canonical deployment record from deployments.v1.
type Deployment struct {
	DeploymentID    string
	Timestamp       time.Time
	Service         string
	Environment     string
	NewVersion      string
	PreviousVersion string
	InitiatedBy     string
	Status          string
}

// MapTelemetryMessage maps one telemetry.raw.v1 OTLP/JSON message to canonical events. A non-empty
// reason means the whole message is rejected and must be dead-lettered.
func MapTelemetryMessage(payload []byte) ([]Event, string) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(payload, &top); err != nil {
		return nil, ReasonInvalidJSON
	}
	if len(top) != 1 {
		return nil, ReasonPayloadShape
	}
	for key, raw := range top {
		switch key {
		case "resourceSpans":
			return mapSpans(raw)
		case "resourceLogs":
			return mapLogs(raw)
		case "resourceMetrics":
			return mapMetrics(raw)
		}
	}
	return nil, ReasonPayloadShape
}

// resource holds the common fields every record takes from its resource (spec 7.4).
type resource struct {
	service, serviceVersion, environment, deploymentID string
}

// resourceOf reads the resource attributes and rejects a resource without service.name.
func resourceOf(r otlpResource) (resource, string) {
	attrs, err := flattenAttributes(r.Attributes)
	if err != nil {
		return resource{}, ReasonInvalidJSON
	}
	service := resourceServiceName(attrs)
	if service == "" {
		return resource{}, ReasonServiceNameRequired
	}
	return resource{
		service:        service,
		serviceVersion: textOf(attrs["service.version"]),
		environment:    textOf(attrs["deployment.environment.name"]),
		deploymentID:   textOf(attrs["deployment.id"]),
	}, ""
}

func (r resource) event(typ string, ts time.Time, traceID, spanID, severity, key string, attrs map[string]any) Event {
	return Event{
		EventID:        EventID(key),
		SchemaVersion:  "1.0",
		Timestamp:      ts,
		Type:           typ,
		Service:        r.service,
		ServiceVersion: r.serviceVersion,
		Environment:    r.environment,
		DeploymentID:   r.deploymentID,
		TraceID:        traceID,
		SpanID:         spanID,
		Severity:       severity,
		Attributes:     attrs,
	}
}

func mapSpans(raw json.RawMessage) ([]Event, string) {
	var blocks []struct {
		Resource   otlpResource `json:"resource"`
		ScopeSpans []struct {
			Spans []otlpSpan `json:"spans"`
		} `json:"scopeSpans"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, ReasonInvalidJSON
	}
	var events []Event
	for _, block := range blocks {
		res, reason := resourceOf(block.Resource)
		if reason != "" {
			return nil, reason
		}
		for _, scope := range block.ScopeSpans {
			for _, span := range scope.Spans {
				if span.TraceID == "" || span.SpanID == "" {
					return nil, ReasonTraceSpanIDsRequired
				}
				start, err := parseUnixNano(span.StartTimeUnixNano)
				if err != nil {
					return nil, ReasonInvalidJSON
				}
				attrs, err := flattenAttributes(span.Attributes)
				if err != nil {
					return nil, ReasonInvalidJSON
				}
				attrs["span.name"] = span.Name
				attrs["span.kind"] = spanKindName(span.Kind)
				attrs["status.code"] = statusCodeName(span.Status.Code)
				attrs["parent_span_id"] = span.ParentSpanID
				key := "trace|" + span.TraceID + "|" + span.SpanID
				events = append(events, res.event("trace", time.Unix(0, start).UTC(), span.TraceID, span.SpanID, "info", key, attrs))
			}
		}
	}
	return events, ""
}

func mapLogs(raw json.RawMessage) ([]Event, string) {
	var blocks []struct {
		Resource  otlpResource `json:"resource"`
		ScopeLogs []struct {
			LogRecords []otlpLogRecord `json:"logRecords"`
		} `json:"scopeLogs"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, ReasonInvalidJSON
	}
	var events []Event
	for _, block := range blocks {
		res, reason := resourceOf(block.Resource)
		if reason != "" {
			return nil, reason
		}
		for _, scope := range block.ScopeLogs {
			for _, record := range scope.LogRecords {
				if record.TraceID == "" {
					return nil, ReasonLogTraceIDRequired
				}
				nanos := record.TimeUnixNano
				if nanos == "" || nanos == "0" {
					nanos = record.ObservedTimeUnixNano
				}
				ns, err := parseUnixNano(nanos)
				if err != nil {
					return nil, ReasonInvalidJSON
				}
				attrs, err := flattenAttributes(record.Attributes)
				if err != nil {
					return nil, ReasonInvalidJSON
				}
				body, err := convertAnyValue(record.Body)
				if err != nil {
					return nil, ReasonInvalidJSON
				}
				attrs["log.body"] = body
				sum := sha256.Sum256([]byte(textOf(body)))
				key := "log|" + record.TraceID + "|" + record.SpanID + "|" + strconv.FormatInt(ns, 10) + "|" + hex.EncodeToString(sum[:])
				events = append(events, res.event("log", time.Unix(0, ns).UTC(), record.TraceID, record.SpanID, logSeverity(record.SeverityText), key, attrs))
			}
		}
	}
	return events, ""
}

var metricMetaKeys = map[string]bool{"name": true, "description": true, "unit": true, "metadata": true}

func mapMetrics(raw json.RawMessage) ([]Event, string) {
	var blocks []struct {
		Resource     otlpResource `json:"resource"`
		ScopeMetrics []struct {
			Metrics []json.RawMessage `json:"metrics"`
		} `json:"scopeMetrics"`
	}
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return nil, ReasonInvalidJSON
	}
	var events []Event
	for _, block := range blocks {
		res, reason := resourceOf(block.Resource)
		if reason != "" {
			return nil, reason
		}
		for _, scope := range block.ScopeMetrics {
			for _, metric := range scope.Metrics {
				points, reason := mapMetric(res, metric)
				if reason != "" {
					return nil, reason
				}
				events = append(events, points...)
			}
		}
	}
	return events, ""
}

// mapMetric maps one data point per entry of a sum, gauge, or histogram. Any other metric type is
// rejected with the unsupported type named.
func mapMetric(res resource, raw json.RawMessage) ([]Event, string) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, ReasonInvalidJSON
	}
	var name string
	if err := json.Unmarshal(fields["name"], &name); err != nil {
		return nil, ReasonInvalidJSON
	}
	kind := ""
	for _, candidate := range []string{"sum", "gauge", "histogram"} {
		if _, ok := fields[candidate]; ok {
			kind = candidate
			break
		}
	}
	if kind == "" {
		return nil, reasonUnsupportedMetricPrefix + unsupportedMetricName(fields)
	}

	var body otlpDataPoints
	if err := json.Unmarshal(fields[kind], &body); err != nil {
		return nil, ReasonInvalidJSON
	}
	var events []Event
	for _, dp := range body.DataPoints {
		ns, err := parseUnixNano(dp.TimeUnixNano)
		if err != nil {
			return nil, ReasonInvalidJSON
		}
		attrs, err := flattenAttributes(dp.Attributes)
		if err != nil {
			return nil, ReasonInvalidJSON
		}
		key := "metric|" + res.service + "|" + name + "|" + sortedKeyValues(attrs) + "|" + strconv.FormatInt(ns, 10)

		attrs["metric.name"] = name
		attrs["metric.kind"] = kind
		if kind == "histogram" {
			count, err := strconv.ParseInt(dp.Count, 10, 64)
			if err != nil || dp.Sum == nil {
				return nil, ReasonInvalidJSON
			}
			attrs["metric.count"] = float64(count)
			attrs["metric.sum"] = *dp.Sum
		} else {
			switch {
			case dp.AsInt != nil:
				n, err := strconv.ParseInt(*dp.AsInt, 10, 64)
				if err != nil {
					return nil, ReasonInvalidJSON
				}
				attrs["metric.value"] = float64(n)
			case dp.AsDouble != nil:
				attrs["metric.value"] = *dp.AsDouble
			default:
				return nil, ReasonInvalidJSON
			}
		}
		events = append(events, res.event("metric", time.Unix(0, ns).UTC(), "", "", "info", key, attrs))
	}
	return events, ""
}

// unsupportedMetricName names the first non-metadata key of a metric that is not a supported type.
func unsupportedMetricName(fields map[string]json.RawMessage) string {
	var others []string
	for k := range fields {
		if !metricMetaKeys[k] {
			others = append(others, k)
		}
	}
	if len(others) == 0 {
		return "none"
	}
	sort.Strings(others)
	return others[0]
}

// MapDeploymentMessage maps one deployments.v1 message to a Deployment, or returns a reason.
func MapDeploymentMessage(payload []byte) (Deployment, string) {
	var m struct {
		DeploymentID    string `json:"deployment_id"`
		Timestamp       string `json:"timestamp"`
		Service         string `json:"service"`
		Environment     string `json:"environment"`
		PreviousVersion string `json:"previous_version"`
		NewVersion      string `json:"new_version"`
		InitiatedBy     string `json:"initiated_by"`
		Status          string `json:"status"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		return Deployment{}, ReasonInvalidJSON
	}
	required := []struct{ field, value string }{
		{"deployment_id", m.DeploymentID},
		{"timestamp", m.Timestamp},
		{"service", m.Service},
		{"new_version", m.NewVersion},
		{"status", m.Status},
	}
	for _, f := range required {
		if f.value == "" {
			return Deployment{}, reasonDeploymentMissingPrefix + f.field
		}
	}
	ts, err := time.Parse(time.RFC3339Nano, m.Timestamp)
	if err != nil {
		return Deployment{}, ReasonDeploymentTimestampBad
	}
	if m.Status != "succeeded" {
		return Deployment{}, ReasonDeploymentStatus
	}
	return Deployment{
		DeploymentID:    m.DeploymentID,
		Timestamp:       ts.UTC(),
		Service:         m.Service,
		Environment:     m.Environment,
		NewVersion:      m.NewVersion,
		PreviousVersion: m.PreviousVersion,
		InitiatedBy:     m.InitiatedBy,
		Status:          m.Status,
	}, ""
}

// parseUnixNano reads an OTLP JSON nanosecond string. An empty string is zero.
func parseUnixNano(s string) (int64, error) {
	if s == "" {
		return 0, nil
	}
	return strconv.ParseInt(s, 10, 64)
}

func spanKindName(kind int) string {
	switch kind {
	case 2:
		return "server"
	case 3:
		return "client"
	default:
		return "unspecified"
	}
}

func statusCodeName(code int) string {
	switch code {
	case 1:
		return "ok"
	case 2:
		return "error"
	default:
		return "unset"
	}
}

var severities = map[string]string{
	"DEBUG": "debug",
	"INFO":  "info",
	"WARN":  "warn",
	"ERROR": "error",
	"FATAL": "fatal",
}

// logSeverity maps the OTLP severity text to the canonical set. Anything else is "info".
func logSeverity(text string) string {
	if s, ok := severities[strings.ToUpper(text)]; ok {
		return s
	}
	return "info"
}

// sortedKeyValues renders attributes as sorted key=value pairs joined by commas (spec 7.5).
func sortedKeyValues(attrs map[string]any) string {
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + textOf(attrs[k])
	}
	return strings.Join(parts, ",")
}

// textOf renders a scalar for keys and digests. Strings are returned unchanged.
func textOf(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	default:
		return fmt.Sprint(t)
	}
}
