# ADR-0006 — Canonical event envelope and outbound webhook relay

- Status: **Proposed — do not implement without approval**
- Date: 2026-10-09

## Context

WhatsApp channel activity must be consumable by external CRM, automation and agents without giving them authority over the core channel engine. Raw Meta callbacks are transport artifacts, not a stable public contract.

## Proposal

Normalize inbound and outbound state transitions into versioned, tenant-scoped events (e.g., `message.received`, `message.status_changed`, `conversation.assigned`). Define a stable envelope: event ID, schema version, type, occurredAt, recordedAt, tenant ID, WABA/phone references, aggregate reference and minimal payload. Persist event/outbox atomically with domain state before asynchronous publication. Allow authorized subscribers to register HTTPS endpoints with a signing secret and event filters. Worker delivers HMAC-signed requests with at-least-once semantics, bounded retries and visible failures; subscribers must deduplicate on event ID. Use SSRF defenses (public endpoint restrictions/DNS rebinding protections), timeouts, payload minimization and signing key rotation.

## Boundaries

No embedded n8n, Frappe workflows, or agent logic. Outbound relay is not the same as inbound Meta webhook acknowledgement. Avoid exposing raw PII or access tokens by default. Contract/versioning and retention policy must be decided before implementation.

## Open questions

Canonical event catalog, ordering keys, replay window, subscription lifecycle, retention, tenant controls, webhook secret rotation, feedback endpoints and message status taxonomy.
