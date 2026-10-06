package store

import (
	"context"
	"time"

	"signalforge/collector-go/internal/canonical"
)

// Store is the persistence boundary for ingestion, correlation, and publication.
type Store interface {
	MigrateUp(ctx context.Context) error
	InsertEvents(ctx context.Context, events []canonical.Event) error                  // idempotent by event_id
	InsertDeployments(ctx context.Context, deployments []canonical.Deployment) error   // idempotent by deployment_id
	SucceededDeployments(ctx context.Context, since, until time.Time) ([]canonical.Deployment, error) // status succeeded, demo-payments, FINAL
	FailureTraces(ctx context.Context, since, until time.Time) ([]FailureRow, error)
	IncidentsByKey(ctx context.Context, dedupKey string) ([]IncidentRow, error)           // latest revision per incident_id
	InsertIncidentWithEvidence(ctx context.Context, inc IncidentRow, ev []EvidenceRow) error // inc.Revision == 1, state pending, PublishedAt nil
	InsertEvidence(ctx context.Context, ev []EvidenceRow) error                          // idempotent by evidence_id
	EvidenceCount(ctx context.Context, incidentID string) (int, error)
	PendingIncidents(ctx context.Context) ([]IncidentRow, error)                         // latest revision: publication_state = pending AND published_at IS NULL
	MarkIncidentPublished(ctx context.Context, inc IncidentRow, publishedAt time.Time) error // inserts revision inc.Revision+1, state published, non-null published_at
	InsertCorrelationRun(ctx context.Context, run CorrelationRun) error
	LatestEvaluatedUntil(ctx context.Context) (time.Time, error)
}

// FailureRow is one failing Payments trace, collapsed to its earliest span start.
type FailureRow struct {
	TraceID, DeploymentID, Service string
	Timestamp                      time.Time
}

// IncidentRow is one revision of an incident. PublishedAt is nil while the revision is pending and
// holds a UTC timestamp once it is published. It is never a sentinel time.
type IncidentRow struct {
	IncidentID, DedupKey, Environment, Service, DeploymentID, TriggerRule, Title string
	Status, Severity                                                             string
	StartedAt, DetectedAt                                                        time.Time
	Services                                                                     []string
	Revision                                                                     uint64
	PublicationState                                                             string     // "pending" | "published"
	PublishedAt                                                                  *time.Time // nil while pending; non-nil UTC time once published
}

// EvidenceRow is one evidence item for an incident. Its ID is deterministic.
type EvidenceRow struct {
	EvidenceID, IncidentID, SourceType, SourceRef, Service, Summary, Reliability string
	Timestamp                                                                    time.Time
}

// CorrelationRun records one correlator cycle.
type CorrelationRun struct {
	RunID          string
	EvaluatedUntil time.Time
	CreatedAt      time.Time
}
