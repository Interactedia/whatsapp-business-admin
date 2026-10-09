# ADR-0001 — Record existing baseline

- Status: **Recorded (unverified)**
- Date: 2026-10-09
- Sources: user-supplied static analysis report, `Pasted text.txt`, 346 lines. No source repository was supplied to inspect directly.

## Context

The starting point is an existing `whatsapp-business-admin` v0.1.1 project, not greenfield. The report describes Next.js 16, React 19, TypeScript 6, Node >=24 <25, PostgreSQL 16, Prisma 7, NextAuth v5, `ws` custom server, `p-queue` for broadcasts, and one WABA singleton. Reported modules include inbox, contacts, templates, broadcasts, Meta Flows, API keys, logs, media and users. Report lists 11 Vitest test files, not evidence of test pass/fail or total test cases.

## Decision

Adopt the existing implementation as **candidate baseline** and prioritize incremental, compatibility-preserving evolution. Do not claim production readiness or cleanliness based solely on the report. Verify actual paths, versions, migration history, auth boundaries and runtime before changes.

## Evidence / uncertainties

- In-process `p-queue` is described for broadcasts; it is not a durable distributed queue.
- WebSocket rooms `global` and `conversation:{id}` are described; multi-process propagation is not proven.
- Incoming raw webhook and signature validation are described; retry/replay semantics and transactional atomicity are not proven.
- `Contact.tags` appears in model; conversation-specific tags and quick replies are not proven.
- Report says one WABA per deployment with singleton `WabaSettings`.
- Report mentions `docker-compose.yml`; this is legacy upstream artifact, **not** an approved deployment choice.

## Baseline verification checklist (must be completed in live repository)

Record: upstream URL, license, fork owner, main branch and commit SHA; package lockfile and engines; real schema/migrations; WABA/account assumptions; API surfaces; startup implementation; test counts/results; webhook receipt and send transaction boundaries; file/media storage; security vulnerabilities; current host and service layout. Mark discrepancies explicitly before selecting WA-01 implementation.
