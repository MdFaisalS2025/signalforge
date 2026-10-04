// Package ingest consumes raw telemetry and deployment records, persists the valid ones, and
// dead-letters the rest. Offsets are committed only after every required write has succeeded.
package ingest

import "time"

// Backoff is the retry schedule for a store write or a dead-letter produce. The production schedule
// is 1 s, 2 s, 4 s, 8 s, 16 s, then 16 s, until the cumulative delay reaches giveUp (2 minutes); the
// last delay is truncated so the total is exactly giveUp. maxAttempts limits retries for tests and is
// zero (unlimited) in production.
//
// A Backoff is a template: a retry loop works on a copy, so one schedule serves every operation.
type Backoff struct {
	initial     time.Duration
	cap         time.Duration
	giveUp      time.Duration
	maxAttempts int

	delay time.Duration // next delay before truncation; zero means "use initial"
	total time.Duration
	tries int
}

// NewBackoff returns the production schedule.
func NewBackoff() *Backoff {
	return &Backoff{initial: time.Second, cap: 16 * time.Second, giveUp: 2 * time.Minute}
}

// Next returns the delay before the next retry, or ok=false when retries are exhausted.
func (b *Backoff) Next() (time.Duration, bool) {
	if b.maxAttempts > 0 && b.tries >= b.maxAttempts {
		return 0, false
	}
	if b.total >= b.giveUp {
		return 0, false
	}
	d := b.delay
	if d == 0 {
		d = b.initial
	}
	if remaining := b.giveUp - b.total; d > remaining {
		d = remaining
	}
	b.total += d
	b.tries++
	next := d * 2
	if next > b.cap {
		next = b.cap
	}
	b.delay = next
	return d, true
}
