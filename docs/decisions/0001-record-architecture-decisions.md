# 1. Record architecture decisions

## Status
Accepted

## Context
SignalForge combines several unfamiliar technologies (OpenTelemetry, Redpanda,
ClickHouse, Temporal, a Go correlation service, a Python agent, a Next.js dashboard).
Section 19.1 of `SignalForge_Project_Plan.docx` calls for short architecture decision
records for major choices and tradeoffs.

## Decision
Use lightweight ADRs under `docs/decisions/`, numbered sequentially, one file per
decision. Each new ADR links back to the project plan section it implements or
deviates from.

## Consequences
Future readers (including interviewers) can see why a choice was made without
re-reading the whole plan. ADRs are written when a decision is made, not
retroactively.
