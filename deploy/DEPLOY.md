# Deployment: inhouse-003

## Target

| Item | Value | Status |
| --- | --- | --- |
| Host | `inhouse-003` | Verified |
| Application IP | `10.208.216.22` | Verified |
| SSH user | `yrios` | Verified, key authentication |
| Operating system | Ubuntu 22.04.3 LTS, x86-64 | Verified |
| Public URL | `https://inbox.ihct.mx` | Defined |
| Current public DNS | `66.175.108.198` | Verify routing/NAT to `10.208.216.22` |
| Database host | `10.208.216.6:5432` | TCP reachable from application host |
| Application path | `/opt/whatsapp-business-admin` | Proposed |
| Service account | `wa-admin` | Proposed |
| Internal application port | `3000` | Proposed; currently occupied on loopback |
| Reverse proxy | Nginx 1.18.0 | Installed and active |
| TLS | Not verified | Required before production |

Do not store passwords, private keys, Meta tokens, database credentials, or application secrets in this file or Git.

## Architecture constraints

This deployment follows ADR-0003:

- Native Linux services only; no Docker or Compose.
- Node.js 24 for the application and workers.
- PostgreSQL is the durable system of record.
- systemd manages long-running processes.
- Nginx terminates HTTPS and proxies HTTP/WebSocket traffic.
- Secrets live in a root-owned environment file outside the repository.

## Observed host capacity

Inventory taken on 2026-10-23:

- 1 vCPU
- 957 MiB RAM and 1.9 GiB swap
- 16 GiB root filesystem, 8.3 GiB available
- Redis 6.0.16 installed, active, bound to loopback
- Nginx active on port 80
- An unidentified process listens on `127.0.0.1:3000`
- Node.js, npm, and the PostgreSQL client are not installed
- Outbound TCP 443 to `graph.facebook.com` is reachable

The host is small. Confirm expected traffic and observe memory during build and runtime before production acceptance. Build artifacts may be produced elsewhere only if they remain compatible with Node.js 24 and the target host.

## Required configuration

Create `/etc/whatsapp-business-admin/production.env`, owned by `root:wa-admin` with mode `0640`:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
APP_URL=https://inbox.ihct.mx
AUTH_SECRET=<generate-with-openssl-rand-base64-32>
AUTH_TRUST_HOST=true
DATABASE_URL=postgresql://<user>:<password>@10.208.216.6:5432/<database>?schema=public
ENCRYPTION_KEY=<generate-with-openssl-rand-hex-32>
MEDIA_DIR=/var/lib/whatsapp-business-admin/media
GRAPH_API_VERSION=v21.0
REDIS_URL=redis://127.0.0.1:6379
```

Confirm before deployment:

- Database name, user, password, ownership, and `pg_hba.conf` authorization for `10.208.216.22`.
- Whether Redis-backed queue workers are part of this release.
- Meta app credentials and per-WABA configuration through the approved application flow.
- Backup location and retention for PostgreSQL and `/var/lib/whatsapp-business-admin`.

## Host requirements

1. Install Node.js `>=24 <25`, npm, Git, and PostgreSQL client tools using an approved native installer.
2. Create the locked service account `wa-admin`.
3. Create and assign:
   - `/opt/whatsapp-business-admin` to `wa-admin:wa-admin`
   - `/var/lib/whatsapp-business-admin/media` to `wa-admin:wa-admin`
   - `/etc/whatsapp-business-admin` to `root:wa-admin`
4. Identify or relocate the current listener on `127.0.0.1:3000` before assigning the port.
5. Ensure the database firewall allows `10.208.216.22` to reach `10.208.216.6:5432`.
6. Keep Redis bound to loopback; do not expose port 6379 publicly.
7. Configure Nginx for HTTP-to-HTTPS redirect, TLS, WebSocket upgrade headers, request-size limits for media, and proxying to `127.0.0.1:3000`.
8. Ensure the public edge routes `66.175.108.198` ports 80/443 to this host, or document the actual proxy path.
9. Obtain a trusted certificate for `inbox.ihct.mx` only after DNS/routing is confirmed.

## Application deployment sequence

Do not execute until all readiness items are approved.

1. Record the release commit and current deployed commit.
2. Back up the PostgreSQL database and media directory.
3. Deploy the selected Git revision to `/opt/whatsapp-business-admin`.
4. Run `npm ci` with Node.js 24.
5. Run `npm run build`.
6. Review pending Prisma migrations and run `npm run db:migrate:deploy` only with an approved backup and rollback plan.
7. Install an application systemd unit plus only the approved worker/timer units from `deploy/systemd/`.
8. Run `systemctl daemon-reload`, enable, and start the approved units.
9. Validate locally through `127.0.0.1:3000`, then through Nginx and the public HTTPS URL.

The existing worker units reference `/etc/whatsapp-business-admin/era5.env`; normalize them to `production.env` in a separately reviewed deployment change before installation.

## Readiness checklist

- [x] SSH key access works for `yrios`.
- [x] Limited passwordless `systemctl` is available.
- [x] Nginx is installed and active.
- [x] Redis is installed, active, and loopback-only.
- [x] Database TCP port is reachable.
- [x] Meta HTTPS endpoint is reachable.
- [ ] Identify the process on `127.0.0.1:3000`.
- [ ] Install and verify Node.js 24 and npm.
- [ ] Install PostgreSQL client tools.
- [ ] Confirm database credentials and PostgreSQL 16 server version.
- [ ] Confirm database backup and restore procedure.
- [ ] Confirm DNS/NAT path from `66.175.108.198` to `10.208.216.22`.
- [ ] Configure and verify TLS for `inbox.ihct.mx`.
- [ ] Create service account, directories, and restricted environment file.
- [ ] Decide which Redis-backed workers are approved for this release.
- [ ] Review Prisma migrations against the target database.
- [ ] Add the main application systemd unit.
- [ ] Verify HTTP, WebSocket, authentication, webhook signature handling, media persistence, and restart recovery.

## Verification commands

Run without printing environment values or credentials:

```bash
node --version
npm --version
psql --version
systemctl --no-pager --full status nginx redis-server
ss -lnt
pg_isready -h 10.208.216.6 -p 5432
curl -fsS http://127.0.0.1:3000/
curl -fsS https://inbox.ihct.mx/
journalctl -u whatsapp-business-admin --since "15 minutes ago" --no-pager
```

Production acceptance also requires login, tenant authorization, inbound webhook, outbound message, status reconciliation, WebSocket reconnect, worker restart, and database restore checks.

## Rollback

1. Stop the application and worker units.
2. Restore the previous application revision.
3. Restore the database backup if a migration is not backward-compatible.
4. Restore media only when required and coordinate it with the database restore point.
5. Start the previous units and repeat health checks.

A Git rollback alone is insufficient after a non-backward-compatible database migration.
