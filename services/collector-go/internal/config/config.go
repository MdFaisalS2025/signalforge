// Package config reads the environment settings for collector-go. It is pure: all values come
// through the lookup function it is given, so it has no process, network, or Docker side effects.
package config

import (
	"errors"
	"strconv"
	"strings"
)

const defaultClickHousePort = 9000

type Config struct {
	KafkaBrokers       []string
	ClickHouseHost     string
	ClickHousePort     int
	ClickHouseDatabase string
	ClickHouseUser     string
	ClickHousePassword string

	// Acceptance-only hooks. Both default off; see the README.
	IncidentPublishFailAttempts int
	IncidentCrashAfterProduce   bool
}

// Load validates the settings in the order the plan defines. An unset variable and an empty
// variable are treated the same way.
func Load(lookup func(string) (string, bool)) (Config, error) {
	get := func(key string) string {
		value, _ := lookup(key)
		return value
	}

	brokers := splitBrokers(get("KAFKA_BROKERS"))
	if len(brokers) == 0 {
		return Config{}, errors.New("KAFKA_BROKERS is required")
	}

	host := get("CLICKHOUSE_HOST")
	if host == "" {
		return Config{}, errors.New("CLICKHOUSE_HOST is required")
	}

	database := get("CLICKHOUSE_DB")
	if database == "" {
		return Config{}, errors.New("CLICKHOUSE_DB is required")
	}

	user := get("CLICKHOUSE_USER")
	if user == "" {
		return Config{}, errors.New("CLICKHOUSE_USER is required")
	}

	password := get("CLICKHOUSE_PASSWORD")
	if password == "" {
		return Config{}, errors.New("CLICKHOUSE_PASSWORD is required")
	}

	port := defaultClickHousePort
	if raw := get("CLICKHOUSE_PORT"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 65535 {
			return Config{}, errors.New("CLICKHOUSE_PORT must be an integer between 1 and 65535")
		}
		port = parsed
	}

	failAttempts := 0
	if raw := get("INCIDENT_PUBLISH_FAIL_ATTEMPTS"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			return Config{}, errors.New("INCIDENT_PUBLISH_FAIL_ATTEMPTS must be a non-negative integer")
		}
		failAttempts = parsed
	}

	crashAfterProduce := false
	switch raw := get("INCIDENT_CRASH_AFTER_PRODUCE"); raw {
	case "", "0":
	case "1":
		crashAfterProduce = true
	default:
		return Config{}, errors.New("INCIDENT_CRASH_AFTER_PRODUCE must be 0 or 1")
	}

	return Config{
		KafkaBrokers:                brokers,
		ClickHouseHost:              host,
		ClickHousePort:              port,
		ClickHouseDatabase:          database,
		ClickHouseUser:              user,
		ClickHousePassword:          password,
		IncidentPublishFailAttempts: failAttempts,
		IncidentCrashAfterProduce:   crashAfterProduce,
	}, nil
}

func splitBrokers(raw string) []string {
	var brokers []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			brokers = append(brokers, trimmed)
		}
	}
	return brokers
}
