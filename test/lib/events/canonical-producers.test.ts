import { describe, expect, it } from "vitest";
import {
  EXTERNAL_EVENT_CONTRACT_VERSION,
  EXTERNAL_EVENT_TYPES,
  ExternalEventValidationError,
  validateExternalEvent,
} from "@/lib/events";
import {
  buildConversationChangedEvent,
  buildConversationStatusChangedEvent,
  buildInboundMessageReceivedEvent,
  buildOutboundMessageAcceptedEvent,
  buildOutboundMessageStatusChangedEvent,
} from "@/lib/events/producers";

const base = {
  tenantId: "tenant_alpha",
  conversationId: "conv_1",
  contactId: "contact_1",
  phoneNumberId: "phone_1",
  wabaAccountId: "waba_1",
  occurredAt: "2026-10-11T12:00:00.000Z",
  recordedAt: "2026-10-11T12:00:01.000Z",
};

describe("canonical event producers", () => {
  it("builds validated inbound.message.received events", () => {
    const event = buildInboundMessageReceivedEvent({
      ...base,
      messageId: "msg_in_1",
      type: "TEXT",
      providerMessageId: "wamid.in.1",
      preview: "hola",
    });

    expect(validateExternalEvent(event)).toEqual(event);
    expect(event).toMatchObject({
      id: "evt:inbound.message.received:tenant_alpha:msg_in_1",
      type: EXTERNAL_EVENT_TYPES.INBOUND_MESSAGE_RECEIVED,
      version: EXTERNAL_EVENT_CONTRACT_VERSION,
      tenantId: "tenant_alpha",
      payload: { messageId: "msg_in_1", preview: "hola" },
    });
  });

  it("uses stable inbound identity for duplicate provider deliveries", () => {
    const first = buildInboundMessageReceivedEvent({
      ...base,
      messageId: "msg_existing",
      type: "TEXT",
      providerMessageId: "wamid.same",
      preview: "first preview",
    });
    const duplicate = buildInboundMessageReceivedEvent({
      ...base,
      messageId: "msg_existing",
      type: "TEXT",
      providerMessageId: "wamid.same",
      preview: "second preview",
      recordedAt: "2026-10-11T12:05:00.000Z",
    });

    expect(duplicate.id).toBe(first.id);
  });

  it("builds validated outbound.message.accepted events", () => {
    const event = buildOutboundMessageAcceptedEvent({
      ...base,
      messageId: "msg_out_1",
      type: "TEMPLATE",
    });

    expect(validateExternalEvent(event)).toEqual(event);
    expect(event).toMatchObject({
      id: "evt:outbound.message.accepted:tenant_alpha:msg_out_1",
      type: EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_ACCEPTED,
      payload: { acceptedAt: base.occurredAt, type: "TEMPLATE" },
    });
  });

  it("keeps distinct outbound accepted transitions distinct", () => {
    const first = buildOutboundMessageAcceptedEvent({ ...base, messageId: "msg_out_1", type: "TEXT" });
    const second = buildOutboundMessageAcceptedEvent({ ...base, messageId: "msg_out_2", type: "TEXT" });

    expect(first.id).not.toBe(second.id);
  });

  it("builds validated outbound status change events", () => {
    const event = buildOutboundMessageStatusChangedEvent({
      ...base,
      messageId: "msg_out_1",
      previousStatus: "PENDING",
      status: "SENT",
      providerMessageId: "wamid.out.1",
    });

    expect(event).not.toBeNull();
    expect(validateExternalEvent(event!)).toEqual(event);
    expect(event).toMatchObject({
      id: "evt:outbound.message.status_changed:tenant_alpha:msg_out_1:PENDING:SENT",
      type: EXTERNAL_EVENT_TYPES.OUTBOUND_MESSAGE_STATUS_CHANGED,
      payload: { previousStatus: "PENDING", status: "SENT" },
    });
  });

  it("does not generate repeated outbound status no-op events", () => {
    expect(buildOutboundMessageStatusChangedEvent({
      ...base,
      messageId: "msg_out_1",
      previousStatus: "SENT",
      status: "SENT",
    })).toBeNull();
  });

  it("keeps distinct status transitions distinct", () => {
    const sent = buildOutboundMessageStatusChangedEvent({
      ...base,
      messageId: "msg_out_1",
      previousStatus: "PENDING",
      status: "SENT",
    });
    const delivered = buildOutboundMessageStatusChangedEvent({
      ...base,
      messageId: "msg_out_1",
      previousStatus: "SENT",
      status: "DELIVERED",
    });

    expect(sent?.id).not.toBe(delivered?.id);
  });

  it("builds validated conversation.changed creation events", () => {
    const event = buildConversationChangedEvent({
      ...base,
      kind: "CREATED",
      status: "OPEN",
    });

    expect(validateExternalEvent(event)).toEqual(event);
    expect(event).toMatchObject({
      id: "evt:conversation.changed:tenant_alpha:conv_1:CREATED:OPEN",
      type: EXTERNAL_EVENT_TYPES.CONVERSATION_CHANGED,
      payload: { kind: "CREATED", status: "OPEN" },
    });
  });

  it("does not generate conversation.changed for no-op status updates", () => {
    expect(buildConversationStatusChangedEvent({
      ...base,
      previousStatus: "OPEN",
      status: "OPEN",
    })).toBeNull();
  });

  it("requires tenant ownership", () => {
    expect(() => buildInboundMessageReceivedEvent({
      ...base,
      tenantId: "",
      messageId: "msg_in_1",
      type: "TEXT",
    })).toThrow(ExternalEventValidationError);
  });

  it("rejects malformed producer context", () => {
    expect(() => buildOutboundMessageAcceptedEvent({
      ...base,
      messageId: "msg out invalid",
      type: "TEXT",
    })).toThrow(ExternalEventValidationError);
  });

  it("does not expose cross-tenant payload fields", () => {
    const event = buildOutboundMessageAcceptedEvent({
      ...base,
      tenantId: "tenant_alpha",
      messageId: "msg_out_1",
      type: "TEXT",
    });

    expect(JSON.stringify(event.payload)).not.toContain("tenant_beta");
    expect(event.tenantId).toBe("tenant_alpha");
  });
});
