# WA-ERA2-11A tenant-scoped identity rework evidence

## Scope

This note records the certification evidence added after commit `ca4a172` for the approved tenant-scoped identity model. It does not change production activation, public APIs, authorization rules, queue topology, WebSocket behavior, or webhook relay behavior.

## Migration SQL safety

Inspected migration: `prisma/migrations/20261011180000_tenant_scoped_contact_conversation_identity/migration.sql`.

The migration is additive/data-preserving for rows:

- It does not `DELETE`, `UPDATE`, truncate, rewrite, or backfill row ownership.
- It removes legacy global unique indexes:
  - `Contact_waId_key`
  - `Conversation_contactId_key`
- It creates tenant-scoped uniqueness matching `prisma/schema.prisma`:
  - `Contact_tenantId_waId_key` on `Contact(tenantId, waId)`
  - `Conversation_tenantId_phoneNumberId_contactId_key` on `Conversation(tenantId, phoneNumberId, contactId)`
- It adds `Conversation_contactId_idx` so contact-based reads remain indexed after the legacy unique index is removed.
- Existing primary keys and foreign keys are untouched.

Dropping the legacy unique indexes is intentional and non-destructive: it changes allowed identity cardinality, but it does not delete data. It is not rollback-compatible once tenants legitimately create duplicate `waId` values across tenants or multiple conversations for the same contact on different business phones.

## Ownership classification policy

Representative migration rehearsal classifies rows before and after migration:

- `SAFE_TO_BACKFILL`: the row already has tenant ownership and all referenced tenant/phone/contact/conversation relationships agree.
- `AMBIGUOUS`: ownership is missing or insufficiently evidenced, such as legacy unowned contacts, conversations with no business phone, or messages with no tenant. These rows are not reassigned by this migration.
- `INVALID_REFERENCE`: a row points to a missing or contradictory tenant/phone/contact/conversation relationship. PostgreSQL foreign keys reject representable invalid references in the rehearsal schema, and the migration does not bypass those constraints.

Ambiguous rows are safely preserved as ambiguous. The migration does not invent ownership, does not claim unowned rows, and does not silently reassign tenant IDs.

## Disposable PostgreSQL rehearsal

Run command:

```sh
npx tsx test/integration/tenant-identity-migration-rehearsal.test.ts
```

The rehearsal creates a disposable local PostgreSQL database with representative pre-migration tables and records, applies the actual migration SQL, verifies data integrity, then drops the database.

Covered fixture shape:

- Existing `Contact` records.
- Existing `Conversation` records.
- Existing `Message` foreign keys.
- Existing tenant/WABA/phone relationships.
- Multiple business phones for one tenant.
- Ambiguous legacy records with nullable ownership where representable by the schema.
- Invalid reference behavior through PostgreSQL FK rejection.

Required evidence checked by the script:

- Pre-migration row counts and FK links exist.
- `SAFE_TO_BACKFILL` and `AMBIGUOUS` classifications are present before migration.
- Invalid message references fail safely before migration.
- Post-migration row counts match pre-migration counts.
- Contact primary keys are preserved.
- Conversation primary keys are preserved.
- Message conversation foreign keys are preserved.
- Ambiguous rows remain ambiguous and are not reassigned.
- Legacy global indexes are removed.
- New composite unique indexes exist.
- Same `waId` across two tenants succeeds.
- Duplicate `waId` in the same tenant fails.
- Same tenant can use a second business phone for the same contact.
- Duplicate `tenantId + phoneNumberId + contactId` conversation fails.

## Deployment compatibility

Recommended sequence:

1. Stop old application and worker processes, or put them in maintenance mode.
2. Apply Prisma migrations with `npm run db:migrate:deploy` against the target PostgreSQL database.
3. Start the `ca4a172` or newer application/worker code.
4. Run smoke checks for tenant-scoped contact and conversation creation.

Compatibility assessment:

- Old code with new schema is not safe for mixed-version writes if it still uses global contact/conversation identity assumptions. The database will now permit cross-tenant duplicate `waId` and multiple phone-scoped conversations, which old code may not resolve correctly.
- New code requires the migration first because Prisma client operations use `tenantId_waId` and rely on tenant/phone-scoped conversation uniqueness.
- Mixed-version execution is not supported for write paths touching contacts or conversations.
- Rollback to old code is not safe after duplicate `waId` records exist across tenants or after one contact has multiple phone-scoped conversations.

Forward-fix recovery procedure:

1. Keep the new schema in place.
2. Redeploy the approved new application/worker version.
3. If old code wrote incorrect data during an accidental mixed-version window, pause workers and classify affected rows as `SAFE_TO_BACKFILL`, `AMBIGUOUS`, or `INVALID_REFERENCE` using tenant/WABA/phone evidence.
4. Repair only rows with a single verified tenant/phone candidate inside a reviewed transaction.
5. Leave ambiguous rows unclaimed until a human-approved mapping exists.

## Limitations

The rehearsal is intentionally disposable and local. It does not alter production data and does not claim rollback compatibility. It demonstrates migration mechanics and integrity constraints for representative legacy data; production rollout still needs a database backup and maintenance window appropriate for the target deployment.
