/**
 * WA-ERA5-02 — Bounded webhook failure diagnostics.
 *
 * Defect: `WebhookEvent.error` stored a bare message string, insufficient to
 * identify the failed stage, the validation field, or the error category.
 *
 * Diagnostics are serialized into the existing single TEXT column (no schema
 * migration, no destructive change). Every value is length-capped, the total
 * is capped, and credential-shaped material is screened out before storage.
 */

import { describe, expect, it } from "vitest";
import { ExternalEventValidationError } from "@/lib/events";
import {
  authRejectionDiagnostic,
  formatWebhookError,
  processingErrorDiagnostic,
  rejectionSummary,
} from "@/lib/whatsapp/inbound/diagnostics";

function parse(serialized: string): Record<string, string> {
  return JSON.parse(serialized) as Record<string, string>;
}

describe("formatWebhookError — structured, bounded output", () => {
  it("records stage, category and reason", () => {
    const out = parse(formatWebhookError({
      stage: "webhook.authentication",
      category: "AUTH_REJECTED",
      reason: "SIGNATURE_INVALID",
    }));

    expect(out.stage).toBe("webhook.authentication");
    expect(out.category).toBe("AUTH_REJECTED");
    expect(out.reason).toBe("SIGNATURE_INVALID");
  });

  it("records the offending validation field and correlation id", () => {
    const out = parse(formatWebhookError({
      stage: "inbound.processing",
      category: "VALIDATION",
      reason: "INVALID_IDENTIFIER",
      field: "payload.providerMessageId has an invalid format",
      correlationId: "clx0webhookevent1",
    }));

    expect(out.field).toBe("payload.providerMessageId has an invalid format");
    expect(out.correlationId).toBe("clx0webhookevent1");
  });

  it("omits optional fields instead of storing empty placeholders", () => {
    const serialized = formatWebhookError({ stage: "inbound.processing", category: "INTERNAL", reason: "boom" });
    expect(serialized).not.toContain("field");
    expect(serialized).not.toContain("correlationId");
  });

  it("caps an overlong reason", () => {
    const out = parse(formatWebhookError({
      stage: "inbound.processing",
      category: "INTERNAL",
      reason: "x".repeat(5000),
    }));

    expect(out.reason.length).toBeLessThanOrEqual(161); // 160 + ellipsis
  });

  it("keeps total serialization within the storage bound", () => {
    const serialized = formatWebhookError({
      stage: "inbound.processing",
      category: "INTERNAL",
      reason: "y".repeat(5000),
      field: "z".repeat(5000),
      correlationId: "w".repeat(5000),
    });

    expect(serialized.length).toBeLessThanOrEqual(1024);
  });

  it("flattens embedded newlines so the value stays single-line", () => {
    const out = parse(formatWebhookError({
      stage: "inbound.processing",
      category: "INTERNAL",
      reason: "line1\nline2\ttabbed",
    }));

    expect(out.reason).toBe("line1 line2 tabbed");
  });
});

describe("formatWebhookError — never stores credential material", () => {
  const SECRETS = {
    appSecret: "super_secret_app_value",
    accessToken: "EAAGm0PX4ZCps_TOKEN_VALUE",
    signature: "sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  };

  it("redacts an app secret while keeping the diagnostic readable", () => {
    const serialized = formatWebhookError({
      stage: "webhook.authentication",
      category: "AUTH_REJECTED",
      reason: "SIGNATURE_INVALID",
      field: `configured appSecret=${SECRETS.appSecret}`,
    });

    expect(serialized).not.toContain(SECRETS.appSecret);
    expect(serialized).toContain("[REDACTED]");
    // The row is still useful for triage.
    expect(parse(serialized).stage).toBe("webhook.authentication");
  });

  it("redacts signature material", () => {
    const serialized = formatWebhookError({
      stage: "webhook.authentication",
      category: "AUTH_REJECTED",
      reason: "SIGNATURE_INVALID",
      field: `received header ${SECRETS.signature}`,
    });

    expect(serialized).not.toContain("deadbeefdeadbeef");
  });

  it("redacts an access token in key=value, header and app_secret forms", () => {
    for (const field of [
      `accessToken=${SECRETS.accessToken}`,
      `Authorization: Bearer ${SECRETS.accessToken}`,
      `app_secret ${SECRETS.appSecret}`,
    ]) {
      const serialized = formatWebhookError({
        stage: "inbound.processing",
        category: "INTERNAL",
        reason: "boom",
        field,
      });
      expect(serialized).not.toContain(SECRETS.accessToken);
      expect(serialized).not.toContain(SECRETS.appSecret);
    }
  });

  it("redacts credentials carried in the reason itself", () => {
    const serialized = formatWebhookError({
      stage: "inbound.processing",
      category: "INTERNAL",
      reason: `graph call failed with accessToken=${SECRETS.accessToken}`,
    });

    expect(serialized).not.toContain(SECRETS.accessToken);
  });

  it("omits a detail that reduces to only the redaction marker", () => {
    const serialized = formatWebhookError({
      stage: "webhook.authentication",
      category: "AUTH_REJECTED",
      reason: "SIGNATURE_INVALID",
      field: SECRETS.signature,
    });

    const out = parse(serialized);
    expect(out.field).toBeUndefined();
  });
});

describe("authRejectionDiagnostic", () => {
  it("names the judged header, never its value", () => {
    const out = parse(formatWebhookError(authRejectionDiagnostic("SIGNATURE_MISSING")));
    expect(out.field).toBe("x-hub-signature-256");
    expect(out.category).toBe("AUTH_REJECTED");
    expect(out.stage).toBe("webhook.authentication");
  });

  it("reports each rejection reason distinctly", () => {
    const reasons = ["SIGNATURE_MISSING", "SIGNATURE_MALFORMED", "SIGNATURE_INVALID", "APP_SECRET_UNCONFIGURED"] as const;
    const persisted = reasons.map((reason) => parse(formatWebhookError(authRejectionDiagnostic(reason))).reason);
    expect(persisted).toEqual([...reasons]);
  });

  it("omits the header field when no secret exists to judge against", () => {
    const serialized = formatWebhookError(authRejectionDiagnostic("APP_SECRET_UNCONFIGURED"));
    expect(serialized).not.toContain("x-hub-signature-256");
  });

  it("carries the correlation id", () => {
    const out = parse(formatWebhookError(authRejectionDiagnostic("SIGNATURE_INVALID", "evt_42")));
    expect(out.correlationId).toBe("evt_42");
  });
});

describe("processingErrorDiagnostic", () => {
  it("maps a canonical validation error onto VALIDATION with the field", () => {
    const error = new ExternalEventValidationError(
      "INVALID_IDENTIFIER",
      "providerMessageId has an invalid format",
      ["payload.providerMessageId has an invalid format"],
    );
    const diagnostic = processingErrorDiagnostic("inbound.processing", error, "evt_7");

    expect(diagnostic.category).toBe("VALIDATION");
    expect(diagnostic.reason).toBe("INVALID_IDENTIFIER");
    expect(diagnostic.field).toBe("payload.providerMessageId has an invalid format");
    expect(diagnostic.correlationId).toBe("evt_7");
  });

  it("maps a Prisma unique violation onto DUPLICATE", () => {
    const diagnostic = processingErrorDiagnostic("inbound.processing", { code: "P2002" }, "evt_8");
    expect(diagnostic.category).toBe("DUPLICATE");
  });

  it("maps an unresolvable phone onto TENANT_UNRESOLVED", () => {
    const error = new Error("Unable to resolve inbound phone number 123 to a tenant (found 2 records)");
    const diagnostic = processingErrorDiagnostic("inbound.processing", error, "evt_9");
    expect(diagnostic.category).toBe("TENANT_UNRESOLVED");
  });

  it("falls back to INTERNAL for an unknown error", () => {
    expect(processingErrorDiagnostic("inbound.processing", new Error("something odd")).category).toBe("INTERNAL");
    expect(processingErrorDiagnostic("inbound.processing", "plain string").category).toBe("INTERNAL");
  });

  it("does not leak a secret embedded in an upstream error message", () => {
    const error = new Error("graph call failed with accessToken=EAAGm0PX4ZCps_TOKEN_VALUE");
    const serialized = formatWebhookError(processingErrorDiagnostic("inbound.processing", error, "evt_10"));
    expect(serialized).not.toContain("EAAGm0PX4ZCps_TOKEN_VALUE");
  });
});

describe("rejectionSummary", () => {
  it("produces a short human label for the logs screen", () => {
    expect(rejectionSummary("SIGNATURE_INVALID")).toBe("rejected: signature invalid");
    expect(rejectionSummary("APP_SECRET_UNCONFIGURED")).toBe("rejected: app secret unconfigured");
  });
});
