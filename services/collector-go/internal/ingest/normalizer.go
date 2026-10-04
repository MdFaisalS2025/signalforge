package ingest

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

const (
	rawTopic        = "telemetry.raw.v1"
	deploymentTopic = "deployments.v1"
	deadLetterTopic = "telemetry.dead-letter.v1"
)

// Normalizer maps one batch of source records to canonical rows and dead letters, persists them, and
// commits the batch. It never commits an offset before its records are persisted or dead-lettered.
type Normalizer struct {
	Consumer Consumer
	Producer Producer
	Store    store.Store
	Now      func() time.Time
	Backoff  *Backoff // template; each operation retries on its own copy
}

// pendingDeadLetter is one dead letter ready to produce, keyed by its source offset.
type pendingDeadLetter struct {
	key   string
	value []byte
}

// ProcessBatch runs, in order: map each record by topic; dead-letter unexpected or invalid records;
// persist every valid event and deployment with retry; produce every dead letter with retry; commit
// the whole batch. Any failure after retry exhaustion returns an error and leaves the batch uncommitted.
func (n *Normalizer) ProcessBatch(ctx context.Context, records []Record) error {
	var events []canonical.Event
	var deployments []canonical.Deployment
	var deadLetters []pendingDeadLetter

	for _, rec := range records {
		var reason string
		switch rec.Topic {
		case rawTopic:
			var evs []canonical.Event
			evs, reason = canonical.MapTelemetryMessage(rec.Value)
			events = append(events, evs...)
		case deploymentTopic:
			var d canonical.Deployment
			d, reason = canonical.MapDeploymentMessage(rec.Value)
			if reason == "" {
				deployments = append(deployments, d)
			}
		default:
			reason = "unexpected source topic " + rec.Topic
		}
		if reason == "" {
			continue
		}
		dl, err := n.deadLetter(rec, reason)
		if err != nil {
			return err
		}
		deadLetters = append(deadLetters, dl)
	}

	if len(events) > 0 {
		if err := n.retry(ctx, func() error { return n.Store.InsertEvents(ctx, events) }); err != nil {
			return fmt.Errorf("write events: %w", err)
		}
	}
	if len(deployments) > 0 {
		if err := n.retry(ctx, func() error { return n.Store.InsertDeployments(ctx, deployments) }); err != nil {
			return fmt.Errorf("write deployments: %w", err)
		}
	}
	for _, dl := range deadLetters {
		if err := n.retry(ctx, func() error { return n.Producer.Produce(ctx, deadLetterTopic, dl.key, dl.value) }); err != nil {
			return fmt.Errorf("produce dead letter %s: %w", dl.key, err)
		}
	}
	return n.Consumer.Commit(ctx, records)
}

// deadLetter builds the dead-letter record for one rejected source record. Its key is the decimal
// source offset.
func (n *Normalizer) deadLetter(rec Record, reason string) (pendingDeadLetter, error) {
	value, err := canonical.EncodeDeadLetter(canonical.DeadLetter{
		Reason:          reason,
		SourceTopic:     rec.Topic,
		SourcePartition: rec.Partition,
		SourceOffset:    rec.Offset,
		ReceivedAt:      n.Now(),
		RawPayload:      string(rec.Value),
	})
	if err != nil {
		return pendingDeadLetter{}, fmt.Errorf("encode dead letter for offset %d: %w", rec.Offset, err)
	}
	return pendingDeadLetter{key: strconv.FormatInt(rec.Offset, 10), value: value}, nil
}

// retry runs op, retrying on the schedule from a copy of the backoff template, until op succeeds or
// the schedule gives up. The last error is returned on give-up.
func (n *Normalizer) retry(ctx context.Context, op func() error) error {
	schedule := *n.Backoff
	for {
		err := op()
		if err == nil {
			return nil
		}
		delay, ok := schedule.Next()
		if !ok {
			return err
		}
		if err := wait(ctx, delay); err != nil {
			return err
		}
	}
}

// wait sleeps for delay or until ctx is done. A zero delay returns at once, so tests never wait.
func wait(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
