package canonical

import (
	"encoding/json"
	"strconv"
)

// OTLP/JSON structs for the fields the mapper reads. OTLP JSON encodes 64-bit integers as strings
// and enums as integers. Fields the mapper does not read are left out, so nothing is invented.

type otlpKeyValue struct {
	Key   string          `json:"key"`
	Value json.RawMessage `json:"value"`
}

type otlpResource struct {
	Attributes []otlpKeyValue `json:"attributes"`
}

type otlpSpan struct {
	TraceID           string         `json:"traceId"`
	SpanID            string         `json:"spanId"`
	ParentSpanID      string         `json:"parentSpanId"`
	Name              string         `json:"name"`
	Kind              int            `json:"kind"`
	StartTimeUnixNano string         `json:"startTimeUnixNano"`
	Attributes        []otlpKeyValue `json:"attributes"`
	Status            struct {
		Code int `json:"code"`
	} `json:"status"`
}

type otlpLogRecord struct {
	TimeUnixNano         string          `json:"timeUnixNano"`
	ObservedTimeUnixNano string          `json:"observedTimeUnixNano"`
	SeverityText         string          `json:"severityText"`
	Body                 json.RawMessage `json:"body"`
	Attributes           []otlpKeyValue  `json:"attributes"`
	TraceID              string          `json:"traceId"`
	SpanID               string          `json:"spanId"`
}

// otlpDataPoint serves sum and gauge points (AsInt or AsDouble) and histogram points (Count and Sum).
type otlpDataPoint struct {
	Attributes   []otlpKeyValue `json:"attributes"`
	TimeUnixNano string         `json:"timeUnixNano"`
	AsInt        *string        `json:"asInt"`
	AsDouble     *float64       `json:"asDouble"`
	Count        string         `json:"count"`
	Sum          *float64       `json:"sum"`
}

type otlpDataPoints struct {
	DataPoints []otlpDataPoint `json:"dataPoints"`
}

// convertAnyValue turns one OTLP AnyValue into a scalar. A string stays a string, an int becomes
// float64, bool and double keep their type, and any other kind keeps its raw JSON text.
func convertAnyValue(raw json.RawMessage) (any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	if v, ok := fields["stringValue"]; ok {
		var s string
		return s, json.Unmarshal(v, &s)
	}
	if v, ok := fields["intValue"]; ok {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			return nil, err
		}
		n, err := strconv.ParseInt(s, 10, 64)
		return float64(n), err
	}
	if v, ok := fields["boolValue"]; ok {
		var b bool
		return b, json.Unmarshal(v, &b)
	}
	if v, ok := fields["doubleValue"]; ok {
		var f float64
		return f, json.Unmarshal(v, &f)
	}
	for _, v := range fields {
		return string(v), nil
	}
	return string(raw), nil
}

// flattenAttributes converts every key/value pair into a map of scalars.
func flattenAttributes(kvs []otlpKeyValue) (map[string]any, error) {
	out := make(map[string]any, len(kvs))
	for _, kv := range kvs {
		v, err := convertAnyValue(kv.Value)
		if err != nil {
			return nil, err
		}
		out[kv.Key] = v
	}
	return out, nil
}

// resourceServiceName returns the service.name string, or "" when it is absent or not a string.
func resourceServiceName(attrs map[string]any) string {
	s, _ := attrs["service.name"].(string)
	return s
}
