# WA-ERA5-03 runtime

Durable outbound sends run as three native processes:

1. Next.js persists commands and outbox rows.
2. `npm run worker:outbox` publishes committed outbox records to BullMQ.
3. `npm run worker:outbound` consumes BullMQ jobs, calls Meta, stores attempts and updates messages.

Systemd examples live in `deploy/systemd/`. Copy them to `/etc/systemd/system/`, set `WorkingDirectory`, keep secrets only in the `EnvironmentFile`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now whatsapp-outbox-dispatcher.service whatsapp-outbound-worker.service
sudo systemctl enable --now whatsapp-diagnostic-retention.timer
systemctl status whatsapp-outbox-dispatcher whatsapp-outbound-worker whatsapp-diagnostic-retention.timer
```

Stop/rollback without dropping pending work:

```bash
sudo systemctl stop whatsapp-outbox-dispatcher whatsapp-outbound-worker
# keep Redis/PostgreSQL data intact; unset WHATSAPP_OUTBOUND_ASYNC_ENABLED for API rollback if needed.
```

Readiness is functional, not just process-based: `enqueueOutboundMessage` checks PostgreSQL and requires a registered BullMQ consumer before writing a new outbound message/outbox event.

Diagnostics reuse `ApiLog`, `WebhookEvent` and `OutboundSendAttempt`. Payloads are redacted, capped at 64 KiB and expire after 30 days. Manual cleanup:

```bash
npm run maintenance:diagnostics
```

Provider-live certification is intentionally not automatic. Dual-WABA live certification remains pending until the second real WABA is registered.
