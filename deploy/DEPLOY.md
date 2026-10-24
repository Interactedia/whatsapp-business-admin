# Deployment runbook: inhouse-003

## Purpose

This document records the current production-like deployment and the repeatable procedure for publishing a new reviewed Git commit. It follows ADR-0003: native Linux services, systemd, PostgreSQL, Redis and Nginx; no Docker.

Never store passwords, private keys, Meta tokens, database credentials or application secrets in this repository.

## Current topology

| Component | Value | Verified |
| --- | --- | --- |
| Public URL | `https://inbox.ihct.mx` | Yes |
| Public IP | `66.175.108.198` | Yes |
| Application host | `inhouse-003` / `10.208.216.22` | Yes |
| SSH user | `yrios` with key authentication | Yes |
| Operating system | Ubuntu 22.04.3 LTS, x86-64 | Yes |
| Runtime | Node.js 24.22.0, npm 11.19.1 | Yes |
| Application path | `/opt/whatsapp-business-admin` | Yes |
| Service account | `wa-admin` | Yes |
| Application listener | `127.0.0.1:3000` | Yes |
| Reverse proxy | Nginx `:80` to `127.0.0.1:3000` | Yes |
| Public TLS | Terminated before/local to the private listener | Yes |
| PostgreSQL application endpoint | `10.208.216.14:5433`, database/role `wa_admin` | Yes |
| PostgreSQL virtual endpoint | `10.208.216.6:5432` | Do not use for app deployment; authentication was inconsistent during setup |
| PostgreSQL replica on SSH host | `10.208.216.8:5433`, read-only | Do not migrate |
| Redis | `127.0.0.1:6379` | Yes |
| Environment file | `/etc/whatsapp-business-admin/production.env` | `root:wa-admin`, mode `0640` |
| Media | `/var/lib/whatsapp-business-admin/media` | Yes |

The VM was expanded from 1 GiB to approximately 4 GiB RAM because the Next.js production build could not complete with 1 GiB.

## Active services

- `nginx.service`
- `redis-server.service`
- `whatsapp-business-admin.service`
- `whatsapp-outbox-dispatcher.service`
- `whatsapp-outbound-worker.service`
- `whatsapp-outbound-retry-scheduler.service`

The old placeholder service `pm2-usr_dev.service` is disabled and must remain disabled because it conflicts with port `3000`.

## Deployment configuration

`/etc/whatsapp-business-admin/production.env` must contain these keys without exposing their values:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_URL=https://inbox.ihct.mx
AUTH_URL=https://inbox.ihct.mx
AUTH_SECRET=<secret>
AUTH_TRUST_HOST=true
DATABASE_URL=postgresql://wa_admin:<secret>@10.208.216.14:5433/wa_admin?schema=public
ENCRYPTION_KEY=<64-hex-character-secret>
MEDIA_DIR=/var/lib/whatsapp-business-admin/media
GRAPH_API_VERSION=v21.0
REDIS_URL=redis://127.0.0.1:6379
```

Do not regenerate `AUTH_SECRET` or `ENCRYPTION_KEY` during routine deployments. Changing `ENCRYPTION_KEY` makes existing encrypted WhatsApp credentials unreadable.

## First deployment completed

The initial deployment performed these actions:

1. Created the locked `wa-admin` service account and deployment directories.
2. Installed/exposed Node.js 24.22.0 and npm 11.19.1.
3. Created PostgreSQL database and role `wa_admin` on the writable primary.
4. Generated secrets directly on the hosts and stored them outside Git.
5. Deployed commit `2d46805` to `/opt/whatsapp-business-admin`.
6. Installed dependencies with development dependencies included for the Next.js build.
7. Built the application and applied all 23 Prisma migrations.
8. Installed and enabled the application and three worker systemd units.
9. Disabled the PM2 placeholder previously occupying port `3000`.
10. Configured Nginx to proxy HTTP and WebSocket traffic to `127.0.0.1:3000`.
11. Verified service restart recovery and public HTTP/HTTPS routing.

## Clean update procedure

Use this procedure whenever a new development version is ready.

### 1. Prepare a release commit locally

Do not deploy an uncommitted working tree.

```bash
git status --short
git diff --check
npm run lint
npx tsc --noEmit
npm test
npm run build
git log --oneline -5
```

Requirements:

- Review every changed and untracked source file.
- Exclude screenshots, local secrets, `.env` files and generated artifacts.
- Resolve all relevant lint, typecheck, test and build failures.
- Record failures that are demonstrably unrelated; do not silently call them PASS.
- Create a traceable commit only after review.

### 2. Pre-deployment checks

Record the release and currently deployed commits. Confirm host capacity, database connectivity and service health:

```bash
ssh yrios@10.208.216.22 '
  free -h
  df -h /
  /usr/local/bin/node --version
  /usr/local/bin/npm --version
  systemctl is-active nginx redis-server
  ss -lnt
'
```

Check that:

- Port `3000` belongs to `whatsapp-business-admin`, not PM2.
- `10.208.216.14:5433` is reachable from the app host.
- The environment file exists and still has mode `0640`.
- PostgreSQL and media backups are available before migrations.

### 3. Back up before changing anything

Database backup must run against the writable application endpoint:

```bash
pg_dump -Fc -h 10.208.216.14 -p 5433 -U wa_admin -d wa_admin > wa_admin-YYYYMMDDHHMM.dump
```

Also back up:

- `/var/lib/whatsapp-business-admin/media`
- `/etc/whatsapp-business-admin/production.env`
- `/etc/nginx/sites-available/inbox.ihct.mx.conf`
- Current systemd units under `/etc/systemd/system/`

Store backups outside the release directory and verify that the dump can be listed with `pg_restore --list`.

### 4. Stage the exact Git commit

Export the reviewed commit, not the working directory:

```bash
git archive --format=tar.gz -o /tmp/whatsapp-business-admin.tar.gz <COMMIT>
scp /tmp/whatsapp-business-admin.tar.gz yrios@10.208.216.22:/tmp/
```

On the host, extract into a staging directory first. Preserve `production.env` because it is outside the repository. Do not overwrite media.

Recommended release layout for future updates:

```text
/opt/whatsapp-business-admin/releases/<COMMIT>/
/opt/whatsapp-business-admin/current -> releases/<COMMIT>/
```

The current first deployment uses `/opt/whatsapp-business-admin` directly. Introduce the release symlink only during an explicitly reviewed update; do not partially mix both layouts.

### 5. Install and build

The lockfile must be present. Include development dependencies because Tailwind/PostCSS and the Next.js build require them:

```bash
npm ci --include=dev
npm run build
```

Do not run `npm audit fix` during deployment. Dependency changes require their own reviewed commit.

### 6. Review and apply migrations

Before execution:

```bash
npm run db:migrate:deploy
```

Prisma reports pending migrations before applying them. Confirm the backup and migration rollback strategy first. Schema rollback may require restoring the database; reverting Git alone is not sufficient.

### 7. Restart services

```bash
sudo systemctl daemon-reload
sudo systemctl restart \
  whatsapp-business-admin.service \
  whatsapp-outbox-dispatcher.service \
  whatsapp-outbound-worker.service \
  whatsapp-outbound-retry-scheduler.service
```

Nginx normally does not change during an application update. If it does:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Never reload Nginx if `nginx -t` fails.

### 8. Verify the release

```bash
systemctl is-active \
  nginx \
  redis-server \
  whatsapp-business-admin \
  whatsapp-outbox-dispatcher \
  whatsapp-outbound-worker \
  whatsapp-outbound-retry-scheduler

ss -lnt
curl -I -H 'Host: inbox.ihct.mx' http://127.0.0.1/
curl -I https://inbox.ihct.mx/
npm run db:migrate:deploy
```

Expected results:

- All services report `active`.
- The app listens only on `127.0.0.1:3000`.
- Nginx listens on port `80`.
- Local and public requests redirect to `https://inbox.ihct.mx/login` when unauthenticated.
- Prisma reports no pending migrations.
- No new errors appear in service journals.

Review logs without printing environment variables:

```bash
journalctl -u whatsapp-business-admin --since '15 minutes ago' --no-pager
journalctl -u whatsapp-outbound-worker --since '15 minutes ago' --no-pager
journalctl -u whatsapp-outbound-retry-scheduler --since '15 minutes ago' --no-pager
journalctl -u whatsapp-outbox-dispatcher --since '15 minutes ago' --no-pager
```

Manual acceptance must cover login, tenant authorization, inbound webhook, outbound message, status reconciliation, media persistence and WebSocket reconnect. A compile-only check is not production acceptance.

## Rollback

If the schema remains backward-compatible:

1. Stop the application and workers.
2. Restore the previous reviewed application commit/release.
3. Restart all units.
4. Repeat local and public health checks.

If the migration is not backward-compatible:

1. Stop the application and workers.
2. Restore the PostgreSQL backup from the same release point.
3. Restore media only when required and keep it consistent with the database restore point.
4. Restore the previous application release.
5. Restart and verify all services.

Nginx rollback uses the timestamped backup in `/etc/nginx/sites-available/`. Validate with `nginx -t` before reloading.

## Required completion report

Every deployment must end with:

```text
TASK_ID:
STATUS: PASS | FAIL | BLOCKED
BASELINE_COMMIT:
DEPLOYED_COMMIT:
FILES_CHANGED:
DECISIONS_REFERENCED: ADR-0003, ADR-0007
SUMMARY:
TESTS_RUN_AND_RESULTS:
SERVICES_AND_HEALTH:
SECURITY_AND_TENANT_CHECKS:
MIGRATION_AND_ROLLBACK:
OPEN_RISKS:
OUT_OF_SCOPE_CHANGES: NONE | details
```
