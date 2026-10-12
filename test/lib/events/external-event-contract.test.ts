import { describe, expect, it } from "vitest";
import {
  EXTERNAL_CONVERSATION_CHANGE_KINDS,
  EXTERNAL_CONVERSATION_STATUSES,
  EXTERNAL_EVENT_CONTRACT_VERSION,
  EXTERNAL_EVENT_CONTRACTS,
  EXTERNAL_EVENT_TYPES,
  EXTERNAL_MESSAGE_STATUSES,
  EXTERNAL_MESSAGE_TYPES,
  ExternalEventValidationError,
  validateExternalEvent,
  validateExternalEventOfType,
  type AnyExternalEvent,
  type ExternalConversationChangedPayload,
  type ExternalEvent,
  type ExternalInboundMessageReceivedPayload,
  type ExternalOutboundMessageAcceptedPayload,
  type ExternalOutboundMessageStatusChangedPayload,
} from "@/lib/events";

const TENANT_A = "tenant_alpha";
const TENANT_B = "tenant_beta";
const ISO = "2026-10-11T12:00:00.000Z";

function baseEnvelope<T extends AnyExternalEvent["type"]>(
  type: T,
  overrides: Partial<AnyExternalEvent> = {},
): AnyExternalEvent {
  return {
    id: "evt_01J0X00000000000000000000",
    type,
    version: EXTERNAL_EVENT_CONTRACT_VERSION,
    tenantId: TENANT_A,
    occurredAt: ISO,
    recordedAt: ISO,
    entities: [{ kind: "tenant", id: TENANT_A }],
    meta: { producer: "core" },
    payload: {} as never,
    ...overrides,
  } as AnyExternalEvent;
}

const inboundPayload: ExternalInboundMessageReceivedPayload = {
  conversationId: "conv_1",
  messageId: "msg_1",
  contactId: "contact_1",
  phoneNumberId: "phone_1",
  wabaAccountId: "waba_1",
  type: "TEXT",
  receivedAt: ISO,
  providerMessageId: "wamid.123",
  preview: "hola",
};

const outboundAcceptedPayload: ExternalOutboundMessageAcceptedPayload = {
  conversationId: "conv_1",
  messageId: "msg_2",
  contactId: "contact_1",
  phoneNumberId: "phone_1",
  wabaAccountId: "waba_1",
  type: "TEXT",
  acceptedAt: ISO,
  providerMessageId: "wamid.124",
};

const outboundStatusPayload: ExternalOutboundMessageStatusChangedPayload = {
  conversationId: "conv_1",
  messageId: "msg_2",
  phoneNumberId: "phone_1",
  wabaAccountId: "waba_1",
  previousStatus: "SENT",
  status: "DELIVERED",
  changedAt: ISO,
  providerMessageId: "wamid.124",
};

const conversationChangedPayload: ExternalConversationChangedPayload = {
  conversationId: "conv_1",
  contactId: "contact_1",
  phoneNumberId: "phone_1",
  wabaAccountId: "waba_1",
  kind: "STATUS_CHANGED",
  status: "OPEN",
  occurredAt: ISO,
};

describe("canonical external event contract", () => {
  it("declares exactly one envelope model, one contract version, and one event-type catalog", () => {
    expect(EXTERNAL_EVENT_CONTRACT_VERSION).toBe(1);
    expect(Object.keys(EXTERNAL_EVENT_CONTRACTS).sort()).toEqual(
      Object.values(EXTERNAL_EVENT_TYPES).sort(),
    );
    expect(Object.values(EXTERNAL_EVENT_CONTRACTS).every((c) => c.version === 1)).toBe(
      true,
    );
  });

  it("exposes only event families supported by authoritative state", () => {
    expect(Object.values(EXTERNAL_EVENT_TYPES)).toEqual([
      "inbound.message.received",
      "outbound.message.accepted",
      "outbound.message.status_changed",
      "conversation.changed",
    ]);
  });

  it("narrows the allowed message and conversation values to contract surfaces", () => {
    expect(new Set(EXTERNAL_MESSAGE_STATUSES)).toEqual(
      new Set(["PENDING", "SENT", "DELIVERED", "READ", "FAILED", "RECEIVED"]),
    );
    expect(new Set(EXTERNAL_MESSAGE_TYPES)).not.toContain("UNSUPPORTED");
    expect(new Set(EXTERNAL_CONVERSATION_STATUSES)).toEqual(
      new Set(["OPEN", "CLOSED"]),
    );
    expect(new Set(EXTERNAL_CONVERSATION_CHANGE_KINDS)).toEqual(
      new Set(["CREATED", "STATUS_CHANGED", "REASSIGNED"]),
    );
  });
});

describe("validateExternalEvent — happy path", () => {
  it("accepts a well-formed inbound envelope", () => {
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
        payload: inboundPayload,
        entities: [
          { kind: "tenant", id: TENANT_A },
          { kind: "conversation", id: "conv_1" },
          { kind: "message", id: "msg_1" },
          { kind: "webhook_event", id: "webhook_1" },
        ],
        meta: { producer: "queue-producer", correlationId: "trace_1" },
      }),
    );
    expect(event.type).toBe(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED);
    const payload = event.payload as ExternalInboundMessageReceivedPayload;
    expect(payload.type).toBe("TEXT");
  });

  it("accepts a well-formed outbound-accepted envelope", () => {
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED, {
        payload: outboundAcceptedPayload,
      }),
    );
    const payload = event.payload as ExternalOutboundMessageAcceptedPayload;
    expect(payload.providerMessageId).toBe("wamid.124");
  });

  it("accepts a well-formed outbound-status envelope with previous status", () => {
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED, {
        payload: outboundStatusPayload,
      }),
    );
    const payload = event.payload as ExternalOutboundMessageStatusChangedPayload;
    expect(payload.status).toBe("DELIVERED");
    expect(payload.previousStatus).toBe("SENT");
  });

  it("accepts a well-formed conversation-changed envelope with null phone/waba", () => {
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED, {
        payload: {
          conversationId: "conv_2",
          contactId: "contact_2",
          phoneNumberId: null,
          wabaAccountId: null,
          kind: "CREATED",
          status: "OPEN",
          occurredAt: ISO,
        },
      }),
    );
    const payload = event.payload as ExternalConversationChangedPayload;
    expect(payload.kind).toBe("CREATED");
  });
});

describe("validateExternalEvent — envelope invariants", () => {
  it("rejects non-object input", () => {
    expect(() => validateExternalEvent("nope")).toThrowError(
      ExternalEventValidationError,
    );
    expect(() => validateExternalEvent(null)).toThrow(ExternalEventValidationError);
  });

  it("rejects unknown event types with UNSUPPORTED_TYPE", () => {
    try {
      validateExternalEvent(
        baseEnvelope("totally.bogus.type" as AnyExternalEvent["type"]),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalEventValidationError);
      expect((err as ExternalEventValidationError).code).toBe("UNSUPPORTED_TYPE");
    }
  });

  it("rejects unknown schema versions with UNSUPPORTED_VERSION", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          version: 99 as never,
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalEventValidationError);
      expect((err as ExternalEventValidationError).code).toBe("UNSUPPORTED_VERSION");
    }
  });

  it("requires exactly one tenant", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          tenantId: "",
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExternalEventValidationError);
      expect((err as ExternalEventValidationError).code).toBe("MISSING_TENANT");
    }
  });

  it("rejects empty or malformed event id", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          id: "",
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_IDENTIFIER");
    }
  });

  it("rejects missing/invalid ISO timestamps", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          occurredAt: "not-a-date",
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_TIMESTAMP");
    }
  });

  it("rejects non-array entities", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          entities: "nope" as never,
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_ENTITY");
    }
  });

  it("rejects entities with unknown kind", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          entities: [{ kind: "secret_warehouse", id: "x" } as never],
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_ENTITY");
    }
  });

  it("rejects entities with malformed id", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          entities: [{ kind: "tenant", id: "" }],
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_ENTITY");
    }
  });

  it("rejects entities with malformed providerId", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          entities: [{ kind: "message", id: "msg_1", providerId: "" }],
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_ENTITY");
    }
  });

  it("rejects malformed meta.producer", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          meta: { producer: "PROD UC" } as never,
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("rejects malformed meta.correlationId", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          meta: { producer: "core", correlationId: "with space" },
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_REFERENCE");
    }
  });
});

describe("validateExternalEvent — payload isolation", () => {
  it("rejects payloads with disallowed message types", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          payload: { ...inboundPayload, type: "UNSUPPORTED" } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("rejects payloads with disallowed status values", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED, {
          payload: { ...outboundStatusPayload, status: "BOGUS" } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("rejects payloads that are missing required identifiers", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          payload: { ...inboundPayload, messageId: undefined } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("rejects payloads with malformed providerMessageId", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          payload: { ...inboundPayload, providerMessageId: "with space" } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("rejects inbound previews over the contract length", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          payload: { ...inboundPayload, preview: "a".repeat(281) } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("accepts conversation.changed with null status and null phone/waba", () => {
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED, {
        payload: {
          conversationId: "conv_3",
          contactId: "contact_3",
          phoneNumberId: null,
          wabaAccountId: null,
          kind: "REASSIGNED",
          status: null,
          occurredAt: ISO,
        },
      }),
    );
    const payload = event.payload as ExternalConversationChangedPayload;
    expect(payload.status).toBeNull();
  });

  it("rejects payloads with non-ISO occurredAt", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED, {
          payload: { ...conversationChangedPayload, occurredAt: "yesterday" } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });

  it("rejects payloads with disallowed conversation change kind", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED, {
          payload: { ...conversationChangedPayload, kind: "BOGUS" } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("INVALID_PAYLOAD");
    }
  });
});

describe("validateExternalEvent — sensitive data and raw provider leakage", () => {
  it("rejects an envelope carrying a top-level token field", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          accessToken: "leaked",
          payload: inboundPayload,
        } as never),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("SENSITIVE_FIELD");
    }
  });

  it("rejects a payload carrying a secret field", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          payload: { ...inboundPayload, appSecret: "leaked" } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("SENSITIVE_FIELD");
    }
  });

  it("rejects a payload carrying a raw provider webhook body", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          payload: { ...inboundPayload, webhookPayload: { entry: [] } } as never,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("SENSITIVE_FIELD");
    }
  });

  it("ignores providerMessageId for envelope identity (providerId cannot be sole id)", () => {
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
        entities: [{ kind: "message", id: "msg_1", providerId: "wamid.123" }],
        payload: inboundPayload,
      }),
    );
    expect(event.entities[0].id).toBe("msg_1");
    expect(event.entities[0].providerId).toBe("wamid.123");
    // Canonical envelope identity lives in `id` (stable, producer-issued),
    // not in any provider-specific alias.
    expect(event.id).toBe("evt_01J0X00000000000000000000");
  });
});

describe("validateExternalEvent — tenant ownership", () => {
  it("rejects an envelope without a tenantId", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          tenantId: undefined as never,
          entities: [{ kind: "tenant", id: TENANT_A }],
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("MISSING_TENANT");
    }
  });

  it("rejects an envelope with a malformed tenantId", () => {
    try {
      validateExternalEvent(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          tenantId: " ",
          entities: [{ kind: "tenant", id: TENANT_A }],
          payload: inboundPayload,
        }),
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("MISSING_TENANT");
    }
  });

  it("accepts envelopes that reference entities in other tenants (authorization is a runtime concern, not contract)", () => {
    // The contract does not embed cross-tenant authorization semantics.
    // It guarantees the envelope declares exactly one tenant, with the
    // canonical identifiers. Cross-tenant access control is enforced
    // by the API layer and the durable authorization guards, not by the
    // shape of the event envelope.
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
        tenantId: TENANT_A,
        entities: [
          { kind: "tenant", id: TENANT_B },
          { kind: "message", id: "msg_1" },
        ],
        payload: inboundPayload,
      }),
    );
    expect(event.tenantId).toBe(TENANT_A);
  });

  it("rejects an envelope with empty entities and missing tenant entity", () => {
    const event = validateExternalEvent(
      baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
        tenantId: TENANT_A,
        entities: [{ kind: "message", id: "msg_1" }],
        payload: inboundPayload,
      }),
    );
    expect(event.tenantId).toBe(TENANT_A);
    expect(event.entities).toHaveLength(1);
  });
});

describe("validateExternalEventOfType", () => {
  it("narrows the result when the type matches", () => {
    const event: ExternalEvent = validateExternalEventOfType(
      baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
        payload: inboundPayload,
      }),
      EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED,
    );
    expect(event.type).toBe(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED);
  });

  it("rejects mismatched type with UNSUPPORTED_TYPE", () => {
    try {
      validateExternalEventOfType(
        baseEnvelope(EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED, {
          payload: inboundPayload,
        }),
        EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED,
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as ExternalEventValidationError).code).toBe("UNSUPPORTED_TYPE");
    }
  });
});
