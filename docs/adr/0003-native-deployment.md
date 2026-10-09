# ADR-0003 — Native services only; no Docker

- Status: **Accepted**
- Date: 2026-10-09

## Context

The fork contains a Docker Compose example but the intended operating model is direct installation and service control on Linux.

## Decision

Production and documented development runtime will be **native**, not container-based: Node.js 24 for the application and later approved workers, PostgreSQL 16 as a native daemon, and Redis as a native daemon **only when its implementation is approved**. Manage persistent Node processes with systemd on the target Linux host. Separate app, worker and scheduled outbox publisher units if/when introduced. Keep secrets in restricted environment files or approved secret facilities, outside Git. Use explicit user/service accounts, data directories, firewall binding, backups, logs and graceful restarts.

**Not approved:** Docker/Compose, Kubernetes, container-only environments, container registry, managed cloud services as hidden dependencies. Existing Docker files may stay untouched for compatibility/upstream history; never make them the official run path.

## Consequences

Deployment documentation must include native install, upgrade, rollback, DB migrations/backup, systemd unit dependencies, permissions, log rotation, Redis persistence requirements if adopted, and restart behavior. No installing/modifying host services without permission. OS distribution, reverse proxy, TLS termination, rootless strategy and production topology require an implementation-specific decision after observing the host.

## Verification

Acceptance requires a clean native boot, service health checks and restart recovery tests; no Docker runtime required.
