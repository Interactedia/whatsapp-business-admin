# ERA 3 canonical event HTTP delivery worker

Task: WA-ERA3-04.

## Purpose

The canonical delivery worker is an independently invocable application service for submitting already-persisted `ExternalEvent` v1 envelopes from `CanonicalEventOutbox` to explicitly supplied webhook destinations.

It does not schedule itself, register destinations, retry failures, persist delivery attempts, or claim exactly-once/at-most-once delivery.

## Inputs

`runCanonicalDeliveryWorker(db, options)` requires:

- `tenantId`: the tenant whose canonical outbox rows may be scanned;
- `destination`: trusted internal descriptor `{ id, tenantId, url }`;
- optional `batchSize`, capped by `MAX_DELIVERY_BATCH_SIZE`;
- optional `concurrency`, capped by `MAX_DELIVERY_CONCURRENCY`;
- optional `timeoutMs`;
- optional `afterCreatedAt` cursor;
- optional `allowLoopbackForTests`, intended for isolated local tests only.

The worker rejects a destination whose tenant differs from the worker tenant before querying the outbox.

## Outbox retrieval

The worker uses `listCanonicalEvents()` from `src/lib/events/outbox.ts`, which requires `tenantId` and performs bounded reads. `CanonicalEventOutbox` remains the durable source of truth. Successful HTTP delivery never deletes or mutates canonical outbox events.

## HTTP request

The default transport sends:

- method: `POST`;
- body: exact validated `ExternalEvent` v1 JSON envelope;
- `Content-Type: application/json`;
- `X-Canonical-Event-Id`: canonical event id;
- `X-Canonical-Tenant-Id`: tenant id.

Headers are additional transport metadata only; they do not redefine event identity.

## Result classification

Each delivery returns one structured result:

- `accepted`: HTTP 2xx transport acceptance;
- `rejected`: HTTP non-2xx, non-redirect response;
- `network_error`: fetch/connectivity failure;
- `timeout`: request exceeded the configured timeout;
- `invalid_destination`: malformed URL, unsupported scheme, unsafe network target, redirect, or tenant mismatch.

HTTP 2xx means the receiver accepted the transport request. It is not evidence of downstream business processing.

## Timeout and concurrency bounds

`DEFAULT_DELIVERY_TIMEOUT_MS` is 5000 ms. Batch size and concurrency have conservative defaults and hard caps. The worker uses bounded workers instead of unbounded `Promise.all` over arbitrary outbox size.

## Tenant isolation

Every destination and event carries an explicit tenant. Destination/event tenant mismatch is rejected before network activity. Worker destination/tenant mismatch is rejected before outbox retrieval.

## SSRF protections

Production destinations must use HTTPS, cannot contain credentials, must resolve via DNS, and cannot resolve to private, loopback, link-local, multicast, unspecified, or otherwise reserved targets. HTTP redirects are not followed and are classified as invalid destinations, preventing redirect bypass.

Loopback HTTP is only allowed through the explicit `allowLoopbackForTests` option for local integration tests. This option is not wired to a public API or production scheduler.

## Limitations and disabled production dispatch

This task intentionally does not implement:

- persistent destination registry;
- destination administration UI;
- retry scheduling or exponential backoff;
- dead-letter handling;
- per-destination delivery history;
- HMAC signing or secret lifecycle;
- automatic polling or continuously running dispatch.

Automatic production dispatch remains disabled until WA-ERA3-05/06 add durable per-destination coordination, retries, idempotency/failure handling, destination management, and security.
