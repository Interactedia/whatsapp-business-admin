/**
 * Disposable PostgreSQL rehearsal for WA-ERA2-11A tenant-scoped identity migration.
 *
 * Run with:
 *   npx tsx test/integration/tenant-identity-migration-rehearsal.test.ts
 *
 * Optional PostgreSQL CLI env (PGHOST, PGPORT, PGUSER, PGPASSWORD) is honored by
 * createdb/dropdb/psql. The script creates and drops one disposable local DB.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dbName = `wa_era2_11a_rehearsal_${process.pid}_${Date.now()}`.toLowerCase();
const migrationPath = resolve("prisma/migrations/20261011180000_tenant_scoped_contact_conversation_identity/migration.sql");
const migrationSql = readFileSync(migrationPath, "utf8");
const checks: { label: string; ok: boolean; detail?: string }[] = [];

function run(command: string, args: string[], input?: string) {
  return execFileSync(command, args, {
    input,
    encoding: "utf8",
    stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
  });
}

function psql(sql: string) {
  return run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-d", dbName, "-At"], sql);
}

function psqlOk(sql: string) {
  try {
    psql(sql);
    return true;
  } catch {
    return false;
  }
}

function check(label: string, ok: boolean, detail?: string) {
  checks.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` → ${detail}` : ""}`);
  assert.equal(ok, true, detail ?? label);
}

function scalar(sql: string) {
  return psql(sql).trim();
}

function setupLegacySchema() {
  psql(`
    CREATE TABLE "Tenant" (
      "id" text PRIMARY KEY,
      "name" text NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now()
    );

    CREATE TABLE "WabaAccount" (
      "id" text PRIMARY KEY,
      "tenantId" text NOT NULL REFERENCES "Tenant"("id") ON DELETE RESTRICT,
      "metaWabaId" text NOT NULL,
      "name" text,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("tenantId", "metaWabaId")
    );

    CREATE TABLE "PhoneNumber" (
      "id" text PRIMARY KEY,
      "wabaAccountId" text NOT NULL REFERENCES "WabaAccount"("id") ON DELETE RESTRICT,
      "metaPhoneNumberId" text NOT NULL,
      "displayPhoneNumber" text NOT NULL,
      "verifiedName" text,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("wabaAccountId", "metaPhoneNumberId")
    );

    CREATE TABLE "Contact" (
      "id" text PRIMARY KEY,
      "tenantId" text REFERENCES "Tenant"("id") ON DELETE RESTRICT,
      "waId" text NOT NULL,
      "name" text,
      "profileName" text,
      "tags" text[] NOT NULL DEFAULT ARRAY[]::text[],
      "notes" text,
      "lastInboundAt" timestamp,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "Contact_waId_key" ON "Contact"("waId");
    CREATE INDEX "Contact_tenantId_idx" ON "Contact"("tenantId");

    CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'CLOSED');
    CREATE TABLE "Conversation" (
      "id" text PRIMARY KEY,
      "tenantId" text REFERENCES "Tenant"("id") ON DELETE RESTRICT,
      "contactId" text NOT NULL REFERENCES "Contact"("id") ON DELETE CASCADE,
      "phoneNumberId" text REFERENCES "PhoneNumber"("id") ON DELETE RESTRICT,
      "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
      "unreadCount" integer NOT NULL DEFAULT 0,
      "lastMessageAt" timestamp,
      "lastInboundAt" timestamp,
      "lastPreview" text,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "Conversation_contactId_key" ON "Conversation"("contactId");
    CREATE INDEX "Conversation_tenantId_idx" ON "Conversation"("tenantId");
    CREATE INDEX "Conversation_phoneNumberId_idx" ON "Conversation"("phoneNumberId");

    CREATE TYPE "MessageDirection" AS ENUM ('IN', 'OUT');
    CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');
    CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACTS', 'TEMPLATE', 'INTERACTIVE', 'BUTTON', 'REACTION', 'UNSUPPORTED');
    CREATE TABLE "Message" (
      "id" text PRIMARY KEY,
      "tenantId" text REFERENCES "Tenant"("id") ON DELETE RESTRICT,
      "conversationId" text NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
      "direction" "MessageDirection" NOT NULL,
      "type" "MessageType" NOT NULL DEFAULT 'TEXT',
      "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
      "content" jsonb,
      "waMessageId" text UNIQUE,
      "timestamp" timestamp NOT NULL DEFAULT now(),
      "createdAt" timestamp NOT NULL DEFAULT now()
    );
  `);
}

function seedLegacyData() {
  psql(`
    INSERT INTO "Tenant" ("id", "name") VALUES ('tenant_a', 'Tenant A'), ('tenant_b', 'Tenant B');
    INSERT INTO "WabaAccount" ("id", "tenantId", "metaWabaId", "name") VALUES
      ('waba_a', 'tenant_a', 'meta_waba_a', 'WABA A'),
      ('waba_b', 'tenant_b', 'meta_waba_b', 'WABA B');
    INSERT INTO "PhoneNumber" ("id", "wabaAccountId", "metaPhoneNumberId", "displayPhoneNumber") VALUES
      ('phone_a_1', 'waba_a', 'meta_phone_a_1', '+10000000001'),
      ('phone_a_2', 'waba_a', 'meta_phone_a_2', '+10000000002'),
      ('phone_b_1', 'waba_b', 'meta_phone_b_1', '+20000000001');

    INSERT INTO "Contact" ("id", "tenantId", "waId", "name") VALUES
      ('contact_safe', 'tenant_a', '1111111111', 'safe existing contact'),
      ('contact_other_phone', 'tenant_a', '2222222222', 'second business phone contact'),
      ('contact_ambiguous', NULL, '3333333333', 'legacy unowned contact');

    INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId", "lastPreview") VALUES
      ('conv_safe', 'tenant_a', 'contact_safe', 'phone_a_1', 'safe thread'),
      ('conv_other_phone', 'tenant_a', 'contact_other_phone', 'phone_a_2', 'same tenant second phone'),
      ('conv_ambiguous', NULL, 'contact_ambiguous', NULL, 'legacy unowned thread');

    INSERT INTO "Message" ("id", "tenantId", "conversationId", "direction", "type", "status", "waMessageId", "content") VALUES
      ('msg_safe_in', 'tenant_a', 'conv_safe', 'IN', 'TEXT', 'RECEIVED', 'wamid.safe.in', '{"text":"hello"}'),
      ('msg_safe_out', 'tenant_a', 'conv_safe', 'OUT', 'TEXT', 'SENT', 'wamid.safe.out', '{"text":"reply"}'),
      ('msg_other_phone', 'tenant_a', 'conv_other_phone', 'IN', 'TEXT', 'RECEIVED', 'wamid.other.phone', '{"text":"phone 2"}'),
      ('msg_ambiguous', NULL, 'conv_ambiguous', 'IN', 'TEXT', 'RECEIVED', 'wamid.ambiguous', '{"text":"legacy"}');
  `);
}

function ownershipSummary() {
  return scalar(`
    WITH classified AS (
      SELECT 'Contact' AS entity_type, c."id" AS entity_id,
        CASE
          WHEN c."tenantId" IS NULL THEN 'AMBIGUOUS'
          WHEN NOT EXISTS (SELECT 1 FROM "Tenant" t WHERE t."id" = c."tenantId") THEN 'INVALID_REFERENCE'
          ELSE 'SAFE_TO_BACKFILL'
        END AS classification
      FROM "Contact" c
      UNION ALL
      SELECT 'Conversation', v."id",
        CASE
          WHEN v."tenantId" IS NULL OR v."phoneNumberId" IS NULL THEN 'AMBIGUOUS'
          WHEN c."id" IS NULL OR p."id" IS NULL OR w."id" IS NULL THEN 'INVALID_REFERENCE'
          WHEN c."tenantId" IS DISTINCT FROM v."tenantId" OR w."tenantId" IS DISTINCT FROM v."tenantId" THEN 'INVALID_REFERENCE'
          ELSE 'SAFE_TO_BACKFILL'
        END
      FROM "Conversation" v
      LEFT JOIN "Contact" c ON c."id" = v."contactId"
      LEFT JOIN "PhoneNumber" p ON p."id" = v."phoneNumberId"
      LEFT JOIN "WabaAccount" w ON w."id" = p."wabaAccountId"
      UNION ALL
      SELECT 'Message', m."id",
        CASE
          WHEN m."tenantId" IS NULL THEN 'AMBIGUOUS'
          WHEN v."id" IS NULL THEN 'INVALID_REFERENCE'
          WHEN v."tenantId" IS DISTINCT FROM m."tenantId" THEN 'INVALID_REFERENCE'
          ELSE 'SAFE_TO_BACKFILL'
        END
      FROM "Message" m
      LEFT JOIN "Conversation" v ON v."id" = m."conversationId"
    )
    SELECT classification || '=' || count(*)
    FROM classified
    GROUP BY classification
    ORDER BY classification;
  `).split("\n").filter(Boolean).join(",");
}

function main() {
  console.log(`Creating disposable PostgreSQL database ${dbName}`);
  run("createdb", [dbName]);
  try {
    setupLegacySchema();
    seedLegacyData();

    const before = scalar(`
      SELECT concat(
        'contacts=', (SELECT count(*) FROM "Contact"),
        ',conversations=', (SELECT count(*) FROM "Conversation"),
        ',messages=', (SELECT count(*) FROM "Message"),
        ',message_links=', (SELECT count(*) FROM "Message" m JOIN "Conversation" v ON v."id" = m."conversationId"),
        ',conv_contact_links=', (SELECT count(*) FROM "Conversation" v JOIN "Contact" c ON c."id" = v."contactId")
      );
    `);
    check("pre-migration representative rows and FK links exist", before === "contacts=3,conversations=3,messages=4,message_links=4,conv_contact_links=3", before);
    check("pre-migration ownership classes include safe and ambiguous", ownershipSummary() === "AMBIGUOUS=3,SAFE_TO_BACKFILL=7", ownershipSummary());
    check("invalid message conversation reference fails before migration", !psqlOk(`INSERT INTO "Message" ("id", "conversationId", "direction") VALUES ('msg_invalid', 'missing_conversation', 'IN')`));

    psql(migrationSql);

    const after = scalar(`
      SELECT concat(
        'contacts=', (SELECT count(*) FROM "Contact"),
        ',conversations=', (SELECT count(*) FROM "Conversation"),
        ',messages=', (SELECT count(*) FROM "Message"),
        ',contact_ids=', (SELECT string_agg("id", ',' ORDER BY "id") FROM "Contact"),
        ',conversation_ids=', (SELECT string_agg("id", ',' ORDER BY "id") FROM "Conversation"),
        ',message_links=', (SELECT count(*) FROM "Message" m JOIN "Conversation" v ON v."id" = m."conversationId")
      );
    `);
    check(
      "post-migration rows, primary keys, and message FKs are preserved",
      after === "contacts=3,conversations=3,messages=4,contact_ids=contact_ambiguous,contact_other_phone,contact_safe,conversation_ids=conv_ambiguous,conv_other_phone,conv_safe,message_links=4",
      after,
    );
    check("post-migration ownership classes unchanged; ambiguous not reassigned", ownershipSummary() === "AMBIGUOUS=3,SAFE_TO_BACKFILL=7", ownershipSummary());
    check("legacy global Contact waId unique index removed", scalar(`SELECT count(*) FROM pg_indexes WHERE indexname = 'Contact_waId_key';`) === "0");
    check("legacy global Conversation contactId unique index removed", scalar(`SELECT count(*) FROM pg_indexes WHERE indexname = 'Conversation_contactId_key';`) === "0");
    check("tenant-scoped Contact uniqueness exists", scalar(`SELECT count(*) FROM pg_indexes WHERE indexname = 'Contact_tenantId_waId_key';`) === "1");
    check("tenant-phone-scoped Conversation uniqueness exists", scalar(`SELECT count(*) FROM pg_indexes WHERE indexname = 'Conversation_tenantId_phoneNumberId_contactId_key';`) === "1");
    check("same waId across two tenants succeeds after migration", psqlOk(`INSERT INTO "Contact" ("id", "tenantId", "waId") VALUES ('contact_cross_tenant', 'tenant_b', '1111111111')`));
    check("duplicate waId in same tenant fails after migration", !psqlOk(`INSERT INTO "Contact" ("id", "tenantId", "waId") VALUES ('contact_duplicate_same_tenant', 'tenant_a', '1111111111')`));
    check("same tenant can open same contact on second business phone", psqlOk(`INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId") VALUES ('conv_safe_phone_2', 'tenant_a', 'contact_safe', 'phone_a_2')`));
    check("duplicate tenant+phone+contact conversation fails", !psqlOk(`INSERT INTO "Conversation" ("id", "tenantId", "contactId", "phoneNumberId") VALUES ('conv_duplicate', 'tenant_a', 'contact_safe', 'phone_a_1')`));

    console.log(`PASS ${checks.length}/${checks.length} migration rehearsal checks in ${dbName}`);
  } finally {
    run("dropdb", ["--if-exists", dbName]);
    console.log(`Dropped disposable PostgreSQL database ${dbName}`);
  }
}

main();
