package ingest

import (
	"testing"
	"time"
)

func TestBackoffSequence(t *testing.T) {
	b := NewBackoff()
	for i, w := range []int{1, 2, 4, 8, 16, 16} {
		got, ok := b.Next()
		if !ok || got != time.Duration(w)*time.Second {
			t.Fatalf("step %d: %v %v", i, got, ok)
		}
	}
}

func TestBackoffGivesUpAfterTwoMinutes(t *testing.T) {
	b := NewBackoff()
	var total time.Duration
	for {
		d, ok := b.Next()
		if !ok {
			break
		}
		total += d
	}
	if total != 2*time.Minute {
		t.Fatalf("total %v", total)
	}
}

// instantBackoff returns a backoff whose delays are zero and which gives up after attempts retries,
// so retry tests never wait in real time.
func instantBackoff(attempts int) *Backoff {
	return &Backoff{initial: 0, cap: 0, giveUp: time.Hour, maxAttempts: attempts}
}
