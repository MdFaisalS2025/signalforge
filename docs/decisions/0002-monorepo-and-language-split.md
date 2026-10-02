# 2. Monorepo, and Go/Python/TypeScript language split

## Status
Accepted

## Context
Section 24.1 of `SignalForge_Project_Plan.docx` (Immediate Decision Log) sets defaults:
a single monorepo, Go for the correlation service, Python for the AI agent, and
TypeScript for the web dashboard and API.

## Decision
Keep all defaults as specified: one repository (this one), with service boundaries
as directories under `services/` and `apps/`, not separate repositories. Go owns
`services/collector-go`; Python owns `services/agent-python`; TypeScript owns
`apps/web` and `services/api`.

## Consequences
Three toolchains must be installed for local development (Go, Python, Node). This
is accepted as a deliberate portfolio signal (per section 8) rather than an
accident of scope creep. Revisit only if "complexity outweighs learning value"
(per the Immediate Decision Log), e.g. if cross-language debugging materially
slows progress during Weeks 2-3.
