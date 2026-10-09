# ADR-0002 — WhatsApp channel control plane, not a CRM or agent

- Status: **Accepted**
- Date: 2026-10-09

## Context

This project must own connectivity and operational control for official WhatsApp Business Cloud API while interoperating with distinct downstream systems, including Frappe CRM and agent runtimes.

## Decision

In scope: WABA/phone configuration, verified webhook ingress, messages and attachments, durable status history, operator inbox, contacts as **channel identities**, templates, supported Meta Flows, broadcasts already in the product, auditability, API and controlled external event delivery. Out of scope: business CRM record authority, sales pipeline, autonomous selling, generic AI orchestration, n8n/Mastra business workflows, replacing Meta API. Existing Flow features are Meta WhatsApp Flows, not a license to introduce a generic flow engine.

## Consequences

Integrate with CRM/agents only via versioned APIs/events with authentication, authorization, retries and stable identifiers. Do not embed Frappe schema/business rules or AI model calls in the messaging core. CRM retains CRM source-of-truth; this app retains channel-side communication evidence. Mappings between identities need deliberate contracts.

## Verification

Review every new domain entity for channel ownership; reject tasks that drift into CRM/AI automation without a separate ADR and authorization.
