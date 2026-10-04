package main

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func captureLog() (*slog.Logger, *bytes.Buffer) {
	var buf bytes.Buffer
	return slog.New(slog.NewJSONHandler(&buf, nil)), &buf
}

// A failing cycle logs "cycle failed" with its stage, and the loop keeps running for later ticks.
func TestRunCyclesLogsFailureAndContinues(t *testing.T) {
	ticks := make(chan time.Time, 3)
	ticks <- time.Time{}
	ticks <- time.Time{}
	ticks <- time.Time{}
	close(ticks)

	log, buf := captureLog()
	calls := 0
	outcomes := []error{errors.New("injected"), nil, errors.New("again")}
	runCycles(context.Background(), ticks, "correlator", log, func(ctx context.Context) error {
		err := outcomes[calls]
		calls++
		return err
	})

	if calls != 3 {
		t.Fatalf("cycles run %d, want 3 (the loop must continue after a failure)", calls)
	}
	if n := strings.Count(buf.String(), `"msg":"cycle failed"`); n != 2 {
		t.Fatalf("cycle failed events %d, want 2: %s", n, buf.String())
	}
	if !strings.Contains(buf.String(), `"stage":"correlator"`) {
		t.Fatalf("stage missing: %s", buf.String())
	}
}

// A cycle interrupted by shutdown is not a failure, so it must not log "cycle failed".
func TestRunCyclesDoesNotLogInterruptedCycleAsFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time, 1)
	ticks <- time.Time{}
	log, buf := captureLog()
	runCycles(ctx, ticks, "correlator", log, func(context.Context) error {
		cancel()
		return context.Canceled
	})
	if strings.Contains(buf.String(), "cycle failed") {
		t.Fatalf("shutdown logged as a failure: %s", buf.String())
	}
}

func TestRunCyclesStopsWhenContextIsDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ticks := make(chan time.Time)
	calls := 0
	runCycles(ctx, ticks, "publisher", slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), func(context.Context) error {
		calls++
		return nil
	})
	if calls != 0 {
		t.Fatalf("ran %d cycles after cancellation", calls)
	}
}
