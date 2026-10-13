/**
 * WA-ERA5-02 — Regression tests for the Meta provider-message-id charset.
 *
 * Defect: `PROVIDER_ID_PATTERN` rejected legitimate Meta `wamid` values.
 * Real wamid identifiers are base64-encoded and contain `+`, `/` and `=`.
 * Evidence from the production-shaped baseline: 82-char wamids ending in `=`.
 *
 * The bound stays at 191 because `Message.waMessageId` is an unbounded TEXT
 * column — 191 is the application-level ceiling shared with the other envelope
 * identifiers, not a storage constraint.
 */

import { describe, expect, it } from "vitest";
import {
  EXTERNAL_EVENT_CONTRACT_VERSION,
  EXTERNAL_EVENT_TYPES,
  ExternalEventValidationError,
  isValidProviderId,
  validateExternalEvent,
} from "@/lib/events";

const ISO = "2026-10-11T12:00:00.000Z";

/** Builds a real inbound-message envelope with the given provider message id. */
function inboundEnvelope(providerMessageId: string) {
  return {
    id: "evt_01J0X00000000000000000000",
    type: EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED,
    version: EXTERNAL_EVENT_CONTRACT_VERSION,
    tenantId: "tenant_alpha",
    occurredAt: ISO,
    recordedAt: ISO,
    entities: [{ kind: "tenant", id: "tenant_alpha" }],
    meta: { producer: "core" },
    payload: {
      conversationId: "conv_1",
      messageId: "msg_1",
      contactId: "contact_1",
      phoneNumberId: "phone_1",
      wabaAccountId: "waba_1",
      type: "TEXT",
      receivedAt: ISO,
      providerMessageId,
      preview: "hola",
    },
  };
}

function validationErrorFor(providerMessageId: string): ExternalEventValidationError | null {
  try {
    validateExternalEvent(inboundEnvelope(providerMessageId));
    return null;
  } catch (error) {
    return error instanceof ExternalEventValidationError ? error : new ExternalEventValidationError("INVALID_PAYLOAD", String(error));
  }
}

/** Representative real Meta wamid shapes (base64 body, `=` padding). */
const REALISTIC_WAMIDS = [
  "wamid.HBgNMTA3MTEzNTIzMTkzEgAUMwAARJ0FA6EXAMPLEBODY+xyz/ABC==",
  "wamid.HBgNMTIzNDU2Nzg5MAAUCBBAAARJEXAMPLE+Slashes/And==",
  // 82 chars, matching the length observed in the baseline database.
  `wamid.HBgN${"A".repeat(70)}==`,
];

describe("provider message id validation (wamid charset)", () => {
  it.each(REALISTIC_WAMIDS)("accepts a legitimate Meta wamid: %s", (wamid) => {
    expect(isValidProviderId(wamid)).toBe(true);
  });

  it("accepts base64 characters +, / and =", () => {
    expect(isValidProviderId("abc+def")).toBe(true);
    expect(isValidProviderId("abc/def")).toBe(true);
    expect(isValidProviderId("abc==")).toBe(true);
  });

  it("preserves compatibility with previously supported provider ids", () => {
    // These shapes were accepted before the fix and must stay accepted.
    expect(isValidProviderId("wamid.123")).toBe(true);
    expect(isValidProviderId("wamid.124")).toBe(true);
    expect(isValidProviderId("plain")).toBe(true);
    expect(isValidProviderId("with_underscore")).toBe(true);
    expect(isValidProviderId("with-dash")).toBe(true);
    expect(isValidProviderId("with:colon")).toBe(true);
    expect(isValidProviderId("ABCdef0189")).toBe(true);
  });
});

describe("provider message id validation (bounded rejection)", () => {
  it("rejects non-string input", () => {
    expect(isValidProviderId(undefined)).toBe(false);
    expect(isValidProviderId(null)).toBe(false);
    expect(isValidProviderId(123)).toBe(false);
    expect(isValidProviderId({})).toBe(false);
    expect(isValidProviderId([])).toBe(false);
  });

  it("rejects an empty identifier", () => {
    expect(isValidProviderId("")).toBe(false);
  });

  it("rejects malformed and control characters", () => {
    expect(isValidProviderId("with space")).toBe(false);
    expect(isValidProviderId("tab\tchar")).toBe(false);
    expect(isValidProviderId("newline\nchar")).toBe(false);
    expect(isValidProviderId("carriage\rreturn")).toBe(false);
    expect(isValidProviderId("null\u0000byte")).toBe(false);
    expect(isValidProviderId('quote"char')).toBe(false);
    expect(isValidProviderId("semi;colon")).toBe(false);
    expect(isValidProviderId("back\\slash")).toBe(false);
    expect(isValidProviderId("emoji\ud83c\udf89")).toBe(false);
  });

  it("enforces the 191-character maximum", () => {
    expect(isValidProviderId("a".repeat(191))).toBe(true);
    expect(isValidProviderId("a".repeat(192))).toBe(false);
  });

  it("keeps the 191 bound for base64 bodies too", () => {
    expect(isValidProviderId(`${"+/=".repeat(63)}+`)).toBe(true);
    expect(isValidProviderId(`${"+/=".repeat(64)}`)).toBe(false);
  });
});

/**
 * End-to-end regression through the public contract validator.
 *
 * This is the path that actually failed against real Meta traffic: the
 * canonical-event build inside the inbound transaction threw
 * `INVALID_PAYLOAD` for `payload.providerMessageId`, rolling back the
 * Conversation and Message while the Contact — written outside the
 * transaction — was left orphaned. Asserting here pins the real defect, not
 * just the regex helper.
 */
describe("canonical inbound event accepts a legitimate Meta wamid", () => {
  it.each(REALISTIC_WAMIDS)("validates an inbound event carrying: %s", (wamid) => {
    expect(() => validateExternalEvent(inboundEnvelope(wamid))).not.toThrow();
  });

  it("rejects a malformed provider message id with INVALID_PAYLOAD", () => {
    const error = validationErrorFor("wamid.with space");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("INVALID_PAYLOAD");
    expect(error?.details.join(" ")).toContain("providerMessageId");
  });

  it("rejects an overlong provider message id", () => {
    const error = validationErrorFor(`wamid.${"A".repeat(200)}`);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("INVALID_PAYLOAD");
  });

  it("still accepts the pre-existing supported shapes", () => {
    expect(() => validateExternalEvent(inboundEnvelope("wamid.123"))).not.toThrow();
    expect(() => validateExternalEvent(inboundEnvelope("wamid.124"))).not.toThrow();
  });
});
