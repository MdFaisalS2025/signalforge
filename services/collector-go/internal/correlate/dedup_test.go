package correlate

import (
	"testing"
	"time"

	"signalforge/collector-go/internal/store"
)

func TestDedupKeyFormat(t *testing.T) {
	if got := DedupKey("local", "demo-payments", "D1", "payments-5xx-burst-after-deployment"); got != "local|demo-payments|D1|payments-5xx-burst-after-deployment" {
		t.Fatal(got)
	}
}

func TestSuppressesWithinFiveMinutesBeforeCandidate(t *testing.T) {
	if !Suppressed([]store.IncidentRow{{StartedAt: t0}}, t0.Add(4*time.Minute)) {
		t.Fatal("not suppressed")
	}
}

// The window is [candidate - 5m, candidate): the lower bound is inclusive, the candidate start is not.
func TestSuppressionWindowBoundaries(t *testing.T) {
	if !Suppressed([]store.IncidentRow{{StartedAt: t0}}, t0.Add(5*time.Minute)) {
		t.Fatal("lower bound must be inclusive")
	}
	if Suppressed([]store.IncidentRow{{StartedAt: t0}}, t0) {
		t.Fatal("an incident starting at the candidate time is not an earlier duplicate")
	}
}

func TestNotSuppressedAfterFiveMinutes(t *testing.T) {
	if Suppressed([]store.IncidentRow{{StartedAt: t0}}, t0.Add(5*time.Minute+time.Second)) {
		t.Fatal("suppressed")
	}
}

func TestIncidentIDIsStable(t *testing.T) {
	if IncidentID("k", t0) != IncidentID("k", t0) {
		t.Fatal("unstable")
	}
}

func TestIncidentIDDependsOnKeyAndNanoseconds(t *testing.T) {
	if IncidentID("k", t0) == IncidentID("k", t0.Add(time.Nanosecond)) {
		t.Fatal("nanosecond change must change the identity")
	}
	if IncidentID("k", t0) == IncidentID("other", t0) {
		t.Fatal("key change must change the identity")
	}
}

func TestEvidenceIDIsStableAndSourceSpecific(t *testing.T) {
	inc := IncidentID("k", t0)
	if EvidenceID(inc, "trace-a") != EvidenceID(inc, "trace-a") {
		t.Fatal("evidence identity unstable")
	}
	if EvidenceID(inc, "trace-a") == EvidenceID(inc, "trace-b") {
		t.Fatal("different sources must have different evidence identities")
	}
}
