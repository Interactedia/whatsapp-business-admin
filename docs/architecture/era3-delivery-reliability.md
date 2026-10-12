# ERA 3 canonical delivery reliability

Task: WA-ERA3-05.

## Boundary

This adds durable delivery state for canonical `ExternalEvent` v1 envelopes already stored in `CanonicalEventOutbox`. It does not register webhook destinations, store destination URLs, store credentials, sign requests, or enable automatic production dispatch. Destinations are still trusted internal descriptors with stable `id`, `tenantId`, and `url`.

## Delivery identity

A logical delivery is uniquely identified by:

- `tenantId`
- canonical `eventId`
- stable `destinationId`

The database enforces `tenantId + eventId + destinationId` uniqueness in `CanonicalEventDelivery`. Destination URL is never used as identity.

## State machine

`CanonicalEventDelivery.state` is explicit:

- `PENDING`: delivery exists and is eligible when `nextAttemptAt <= now`.
- `IN_PROGRESS`: one worker owns a bounded lease.
- `RETRY_PENDING`: prior attempt failed retryably and `nextAttemptAt` schedules the next try.
- `ACCEPTED`: destination returned HTTP 2xx transport acceptance.
- `FAILED_TERMINAL`: terminal 4xx, invalid destination, or retry exhaustion.

Canonical outbox rows are not updated or deleted by delivery.

## Attempt history

Each actual attempt creates a `CanonicalEventDeliveryAttempt` row with:

- delivery id
- lease owner
- attempt number
- start and completion timestamps
- HTTP status when present
- classified result
- bounded error summary
- next retry timestamp when scheduled

Error summaries are bounded and must not include credentials, sensitive headers, tokens, or raw response bodies.

## Claim and lease semantics

Claims are PostgreSQL-backed. A claim updates one eligible delivery to `IN_PROGRESS`, assigns a `leaseOwner`, increments `attemptCount`, sets `leaseExpiresAt`, and inserts the attempt in the same transaction. Eligibility includes expired `IN_PROGRESS` leases, which supports restart recovery.

Completion verifies `tenantId`, `deliveryId`, active `leaseOwner`, and `IN_PROGRESS` state. A stale worker cannot complete or overwrite a newer lease.

HTTP timeout defaults to 5s and is capped at 30s. Durable worker leases default to at least 45s and are forced to outlive the configured timeout by 5s when invoked through the worker.

## Retry classification

- HTTP 2xx: `ACCEPTED` (transport acceptance only).
- HTTP 408: retryable.
- HTTP 429: retryable.
- HTTP 5xx: retryable.
- Other HTTP 4xx: terminal by default.
- Network errors: retryable.
- Timeouts: retryable.
- Invalid destination: terminal until corrected.

## Backoff and Retry-After

Default retry policy:

- max attempts: 5
- base delay: 1s
- max delay: 60s
- jitter: off by default for deterministic tests

Valid `Retry-After` seconds or HTTP-date values are honored but capped by max delay. Malformed `Retry-After` is ignored and bounded exponential backoff is used.

## Guarantees and limitations

Delivery is at-least-once. Exactly-once HTTP delivery is not claimed. Repeated HTTP delivery may occur after ambiguous network outcomes or expired leases. Consumers must deduplicate by canonical event identity.

Each destination has independent state. Failure or retry exhaustion for one destination does not alter another destination's delivery row.

All persistent operations include tenant ownership. Cross-tenant reads, claims, and completion do not match rows.

## Operational limitations and WA-ERA3-06 dependency

This task keeps production dispatch disabled. Durable state can be driven by explicit internal invocation only. Persistent tenant-scoped destination configuration, HMAC signing, credential storage, secret rotation, and administrative authorization remain WA-ERA3-06 scope.
