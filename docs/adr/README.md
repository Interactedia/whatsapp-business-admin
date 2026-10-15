# Architecture Decision Records

ADRs record **decisions** and their consequences, not an implementation checklist. Status meanings:

- **Accepted:** architectural direction approved; execution still requires a scoped task.
- **Proposed:** design under review; do not implement yet.
- **Recorded:** observed description of supplied analysis, **not independently verified**.
- **Superseded:** replaced by another ADR with explicit linkage.

Update an ADR by recording a new one or an explicit amendment; do not rewrite historical rationale silently. Each ADR should include context, decision, consequences, constraints, and verification/open questions.

| ADR | Status | Topic |
| --- | --- | --- |
| [0001](0001-existing-baseline.md) | Recorded | Current baseline / known unknowns |
| [0002](0002-product-boundaries.md) | Accepted | Scope and external systems |
| [0003](0003-native-deployment.md) | Accepted | Native Linux, no Docker |
| [0004](0004-tenant-aware-domain.md) | Accepted | Tenant-aware domain, no complete SaaS |
| [0005](0005-durable-queues.md) | Proposed | Redis/BullMQ and outbox |
| [0006](0006-webhook-relay.md) | Proposed | Canonical events and relay |
| [0007](0007-change-control.md) | Accepted | Agent change control |
| [0008](0008-centralized-tenant-authorization.md) | Accepted | Centralized tenant authorization |
| [0009](0009-copilot-control-handoff-followup.md) | Accepted | Copilot control, human handoff, automated follow-up (`ADR-WA-COPILOT-001`; approved by `ADR-WA-COPILOT-002`, follow-up implementation deferred) |
