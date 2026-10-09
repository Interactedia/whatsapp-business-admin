# ADR-0007 — Controlled AI coding workflow

- Status: **Accepted**
- Date: 2026-10-09

## Decision

`AGENTS.md` is the required navigation and guardrails document for coding agents. ADRs carry architectural decisions and statuses. A roadmap is **not** approval to implement. For any unit, require a scoped task with baseline evidence, allowed files, explicit exclusions, acceptance tests, rollback and a completion report. No silent architectural revisions or opportunistic changes. Surface unknowns instead of inventing details. For conflicts between instructions and ADRs, report conflict and seek explicit authorization before changing architectural constraints.

## First gate

Verify real fork and baseline commit, reconcile this document package with repo facts, inspect database and deployment reality, and only then prepare the implementation unit for tenant foundations. Writing documentation is separate from deploying it.
