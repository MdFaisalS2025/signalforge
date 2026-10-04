// Package correlate detects payment failure bursts after a deployment and records them as pending
// incidents with their evidence. It never publishes; publication belongs to package publish.
package correlate

import (
	"sort"
	"time"

	"signalforge/collector-go/internal/canonical"
	"signalforge/collector-go/internal/store"
)

// TriggerRule identifies the detection rule that creates incidents.
const TriggerRule = "payments-5xx-burst-after-deployment"

const (
	burstCount        = 3
	burstWindow       = 30 * time.Second
	deploymentWindow  = 5 * time.Minute
	failingService    = "demo-payments"
	succeededDeployed = "succeeded"
)

// Candidate is one burst linked to one deployment. Triggers are the three distinct traces, in order.
type Candidate struct {
	Deployment canonical.Deployment
	Triggers   [burstCount]store.FailureRow
	StartedAt  time.Time // == Triggers[0].Timestamp
}

// DetectBurst applies spec 10.1 to each succeeded demo-payments deployment. Failures are restricted to
// the deployment, sorted by time, and reduced to the earliest record per trace. The first window of
// three traces within 30 seconds is the trigger. The deployment must not be after the trigger and must
// be at most five minutes before it. A deployment yields at most one candidate.
func DetectBurst(failures []store.FailureRow, deployments []canonical.Deployment) []Candidate {
	var out []Candidate
	for _, d := range deployments {
		if d.Service != failingService || d.Status != succeededDeployed {
			continue
		}
		f := distinctTraces(failures, d.DeploymentID)
		for i := 0; i+burstCount-1 < len(f); i++ {
			if f[i+burstCount-1].Timestamp.Sub(f[i].Timestamp) > burstWindow {
				continue
			}
			trigger := f[i].Timestamp
			if d.Timestamp.After(trigger) || trigger.Sub(d.Timestamp) > deploymentWindow {
				break
			}
			var c Candidate
			c.Deployment = d
			copy(c.Triggers[:], f[i:i+burstCount])
			c.StartedAt = trigger
			out = append(out, c)
			break
		}
	}
	return out
}

// distinctTraces returns the failures of one deployment, sorted by time, keeping only the earliest
// record for each trace ID.
func distinctTraces(failures []store.FailureRow, deploymentID string) []store.FailureRow {
	var mine []store.FailureRow
	for _, r := range failures {
		if r.DeploymentID == deploymentID {
			mine = append(mine, r)
		}
	}
	sort.SliceStable(mine, func(i, j int) bool { return mine[i].Timestamp.Before(mine[j].Timestamp) })
	seen := map[string]bool{}
	var out []store.FailureRow
	for _, r := range mine {
		if seen[r.TraceID] {
			continue
		}
		seen[r.TraceID] = true
		out = append(out, r)
	}
	return out
}
