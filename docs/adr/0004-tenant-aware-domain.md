# ADR-0004 — Tenant-aware design without a complete SaaS

- Status: **Accepted (principle only; schema pending)**
- Date: 2026-10-09

## Context

Reported existing `WabaSettings` is a singleton (one WABA/deployment). Building more features directly atop that assumption increases conversion cost later.

## Decision

Future model must support a tenant boundary and explicit ownership of WABA accounts and phone numbers, with a route to multiple WABAs/phones per tenant. Preserve the option of single-tenant deployment as a supported mode. Do **not** build self-service onboarding, billing, subscriptions, tenant provisioning SaaS UI or cross-tenant analytics now.

## Constraints

Tenant context must come from authenticated/authorized identity, never trusted solely from a client-provided tenant ID. Require tenant-scoped DB queries and authorization for IDs, API keys and websocket rooms. Define ownership for contact, conversation, message, template, broadcast, Flow, media, logs and outbound jobs. Plan legacy data backfill with a default tenant, dual-read/write or phased rollout as necessary, and explicit rollback. Do not declare specific Prisma migrations or constraints approved before actual schema inspection.

## Open design questions

Membership roles and cross-tenant users; WABA-to-tenant cardinality and transfer rules; canonical phone-number identity; per-tenant key scoping; existing API compatibility; migration of singleton WABA settings and preexisting records; whether DB RLS adds value in this stack. These need evidence and a separate design/implementation packet.
