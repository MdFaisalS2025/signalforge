package config

import (
	"reflect"
	"testing"
)

func env(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := values[key]
		return value, ok
	}
}

func validEnv() map[string]string {
	return map[string]string{
		"KAFKA_BROKERS":       "redpanda:9092",
		"CLICKHOUSE_HOST":     "clickhouse",
		"CLICKHOUSE_DB":       "signalforge",
		"CLICKHOUSE_USER":     "default",
		"CLICKHOUSE_PASSWORD": "changeme-local-only",
	}
}

func without(values map[string]string, key string) map[string]string {
	copied := map[string]string{}
	for k, v := range values {
		if k != key {
			copied[k] = v
		}
	}
	return copied
}

func with(values map[string]string, key, value string) map[string]string {
	copied := map[string]string{}
	for k, v := range values {
		copied[k] = v
	}
	copied[key] = value
	return copied
}

func TestLoadRequiresEachField(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		message string
	}{
		{"brokers", without(validEnv(), "KAFKA_BROKERS"), "KAFKA_BROKERS is required"},
		{"empty brokers", with(validEnv(), "KAFKA_BROKERS", ""), "KAFKA_BROKERS is required"},
		{"host", without(validEnv(), "CLICKHOUSE_HOST"), "CLICKHOUSE_HOST is required"},
		{"database", without(validEnv(), "CLICKHOUSE_DB"), "CLICKHOUSE_DB is required"},
		{"user", without(validEnv(), "CLICKHOUSE_USER"), "CLICKHOUSE_USER is required"},
		{"password", without(validEnv(), "CLICKHOUSE_PASSWORD"), "CLICKHOUSE_PASSWORD is required"},
		{"empty password", with(validEnv(), "CLICKHOUSE_PASSWORD", ""), "CLICKHOUSE_PASSWORD is required"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(env(tc.env))
			if err == nil || err.Error() != tc.message {
				t.Fatalf("got %v, want %q", err, tc.message)
			}
		})
	}
}

func TestLoadDefaultsPortToNativeProtocolPort(t *testing.T) {
	cfg, err := Load(env(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClickHousePort != 9000 {
		t.Fatalf("port %d, want 9000", cfg.ClickHousePort)
	}
}

func TestLoadSplitsCommaSeparatedBrokersAndTrimsThem(t *testing.T) {
	values := with(validEnv(), "KAFKA_BROKERS", " a:9092, b:9092 ,c:9092")
	cfg, err := Load(env(values))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"a:9092", "b:9092", "c:9092"}
	if !reflect.DeepEqual(cfg.KafkaBrokers, want) {
		t.Fatalf("brokers %v, want %v", cfg.KafkaBrokers, want)
	}
}

func TestLoadReadsEveryValue(t *testing.T) {
	values := with(validEnv(), "CLICKHOUSE_PORT", "9440")
	cfg, err := Load(env(values))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClickHouseHost != "clickhouse" || cfg.ClickHouseDatabase != "signalforge" ||
		cfg.ClickHouseUser != "default" || cfg.ClickHousePassword != "changeme-local-only" ||
		cfg.ClickHousePort != 9440 {
		t.Fatalf("%+v", cfg)
	}
}

func TestLoadRejectsInvalidPorts(t *testing.T) {
	for _, value := range []string{"x", "0", "-1", "65536", "9000.5"} {
		_, err := Load(env(with(validEnv(), "CLICKHOUSE_PORT", value)))
		if err == nil || err.Error() != "CLICKHOUSE_PORT must be an integer between 1 and 65535" {
			t.Fatalf("port %q: got %v", value, err)
		}
	}
}

func TestLoadTreatsEmptyPortAsUnsetAndDefaults(t *testing.T) {
	cfg, err := Load(env(with(validEnv(), "CLICKHOUSE_PORT", "")))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ClickHousePort != 9000 {
		t.Fatalf("port %d, want 9000", cfg.ClickHousePort)
	}
}

func TestIncidentHooksDefaultToOff(t *testing.T) {
	cfg, err := Load(env(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.IncidentPublishFailAttempts != 0 || cfg.IncidentCrashAfterProduce {
		t.Fatalf("hooks not off by default: %+v", cfg)
	}
}

func TestPublishFailAttemptsEmptyDefaultsZero(t *testing.T) {
	cfg, err := Load(env(with(validEnv(), "INCIDENT_PUBLISH_FAIL_ATTEMPTS", "")))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.IncidentPublishFailAttempts != 0 {
		t.Fatalf("got %d, want 0", cfg.IncidentPublishFailAttempts)
	}
}

func TestPublishFailAttemptsAcceptsNonNegativeIntegers(t *testing.T) {
	for value, want := range map[string]int{"0": 0, "2": 2, "150": 150} {
		cfg, err := Load(env(with(validEnv(), "INCIDENT_PUBLISH_FAIL_ATTEMPTS", value)))
		if err != nil {
			t.Fatalf("%q: %v", value, err)
		}
		if cfg.IncidentPublishFailAttempts != want {
			t.Fatalf("%q: got %d, want %d", value, cfg.IncidentPublishFailAttempts, want)
		}
	}
}

func TestPublishFailAttemptsRejectsNegativeAndNonInteger(t *testing.T) {
	const want = "INCIDENT_PUBLISH_FAIL_ATTEMPTS must be a non-negative integer"
	for _, value := range []string{"-1", "x", "1.5", " 2"} {
		_, err := Load(env(with(validEnv(), "INCIDENT_PUBLISH_FAIL_ATTEMPTS", value)))
		if err == nil || err.Error() != want {
			t.Fatalf("%q: got %v, want %q", value, err, want)
		}
	}
}

func TestCrashAfterProduceEmptyDefaultsFalse(t *testing.T) {
	cfg, err := Load(env(with(validEnv(), "INCIDENT_CRASH_AFTER_PRODUCE", "")))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.IncidentCrashAfterProduce {
		t.Fatal("empty must default to off")
	}
}

func TestCrashAfterProduceAcceptsZeroAndOneOnly(t *testing.T) {
	for value, want := range map[string]bool{"0": false, "1": true} {
		cfg, err := Load(env(with(validEnv(), "INCIDENT_CRASH_AFTER_PRODUCE", value)))
		if err != nil {
			t.Fatalf("%q: %v", value, err)
		}
		if cfg.IncidentCrashAfterProduce != want {
			t.Fatalf("%q: got %v", value, cfg.IncidentCrashAfterProduce)
		}
	}
}

func TestCrashAfterProduceRejectsOtherValues(t *testing.T) {
	const want = "INCIDENT_CRASH_AFTER_PRODUCE must be 0 or 1"
	for _, value := range []string{"true", "false", "yes", "2", " 1"} {
		_, err := Load(env(with(validEnv(), "INCIDENT_CRASH_AFTER_PRODUCE", value)))
		if err == nil || err.Error() != want {
			t.Fatalf("%q: got %v, want %q", value, err, want)
		}
	}
}

func TestLoadAcceptsPortBoundaries(t *testing.T) {
	for _, value := range []string{"1", "65535"} {
		if _, err := Load(env(with(validEnv(), "CLICKHOUSE_PORT", value))); err != nil {
			t.Fatalf("port %q: %v", value, err)
		}
	}
}
