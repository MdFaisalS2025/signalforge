package correlate

import (
	"testing"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

var t0 = time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)

var dep = canonical.Deployment{DeploymentID: "D1", Timestamp: t0.Add(-1 * time.Minute), Service: "demo-payments", Environment: "local", Status: "succeeded"}

func fail(traceID string, at time.Time) store.FailureRow {
	return store.FailureRow{TraceID: traceID, DeploymentID: "D1", Service: "demo-payments", Timestamp: at}
}

func TestThreeFailuresWithin30sCreateCandidate(t *testing.T) {
	f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(10*time.Second)), fail("c", t0.Add(29*time.Second))}
	c := DetectBurst(f, []canonical.Deployment{dep})
	if len(c) != 1 || !c[0].StartedAt.Equal(t0) {
		t.Fatalf("%+v", c)
	}
}

func TestThirtyOneSecondsDoesNotTrigger(t *testing.T) {
	f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(10*time.Second)), fail("c", t0.Add(31*time.Second))}
	if c := DetectBurst(f, []canonical.Deployment{dep}); len(c) != 0 {
		t.Fatalf("%+v", c)
	}
}

func TestDuplicateTraceDoesNotCount(t *testing.T) {
	f := []store.FailureRow{fail("a", t0), fail("a", t0.Add(time.Second)), fail("b", t0.Add(2*time.Second))}
	if c := DetectBurst(f, []canonical.Deployment{dep}); len(c) != 0 {
		t.Fatal("same trace counted twice")
	}
}

// A repeated trace keeps its earliest timestamp, so the window starts at the first occurrence.
func TestRepeatedTraceKeepsEarliestTimestamp(t *testing.T) {
	f := []store.FailureRow{fail("a", t0.Add(5*time.Second)), fail("a", t0), fail("b", t0.Add(10*time.Second)), fail("c", t0.Add(20*time.Second))}
	c := DetectBurst(f, []canonical.Deployment{dep})
	if len(c) != 1 || !c[0].StartedAt.Equal(t0) {
		t.Fatalf("%+v", c)
	}
}

func TestDeploymentOlderThanFiveMinutesIsNotLinked(t *testing.T) {
	old := dep
	old.Timestamp = t0.Add(-5*time.Minute - time.Second)
	f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(time.Second)), fail("c", t0.Add(2*time.Second))}
	if c := DetectBurst(f, []canonical.Deployment{old}); len(c) != 0 {
		t.Fatal("linked to old deployment")
	}
}

func TestDeploymentAfterFirstFailureIsNotLinked(t *testing.T) {
	late := dep
	late.Timestamp = t0.Add(time.Second)
	f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(time.Second)), fail("c", t0.Add(2*time.Second))}
	if c := DetectBurst(f, []canonical.Deployment{late}); len(c) != 0 {
		t.Fatal("failure preceded deployment")
	}
}

func TestFailureRowsFromAnotherDeploymentAreIgnored(t *testing.T) {
	f := []store.FailureRow{
		fail("a", t0),
		fail("b", t0.Add(time.Second)),
		{TraceID: "c", DeploymentID: "OTHER", Timestamp: t0.Add(2 * time.Second), Service: "demo-payments"},
	}
	if c := DetectBurst(f, []canonical.Deployment{dep}); len(c) != 0 {
		t.Fatal("mixed deployments")
	}
}

func TestOnlySucceededPaymentsDeploymentsCreateCandidates(t *testing.T) {
	f := []store.FailureRow{fail("a", t0), fail("b", t0.Add(time.Second)), fail("c", t0.Add(2*time.Second))}
	failed := dep
	failed.Status = "failed"
	orders := dep
	orders.Service = "demo-orders"
	if c := DetectBurst(f, []canonical.Deployment{failed, orders}); len(c) != 0 {
		t.Fatalf("%+v", c)
	}
}
