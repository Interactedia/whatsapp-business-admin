# WhatsApp Typing Indicator Architecture & Integration Contract

## 1. Overview & Purpose

The WhatsApp Typing Indicator service provides an ephemeral, tenant-safe capability for signaling that a response is being prepared for an incoming WhatsApp conversation via the Meta WhatsApp Cloud API.

The service is intentionally designed as an uncoupled control-plane capability:
- **Backoffice** owns WhatsApp connectivity, tenant boundaries, and provider communication.
- **Frappe** owns CRM data and external customer definitions.
- **Mastra** will own automated agent reasoning in future eras.
- **Human Operators** will trigger typing via UI actions in future eras.

The typing capability does not activate automatically on webhooks or messages.

---

## 2. Official Meta Cloud API Semantics

Meta's WhatsApp Business Cloud API provides typing indicators through the standard message endpoint:

```http
POST /v21.0/{phone_number_id}/messages
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "<INCOMING_WHATSAPP_MESSAGE_ID>",
  "typing_indicator": {
    "type": "text"
  }
}
```

### Response
```json
{
  "success": true
}
```

### Key Meta Semantics & Behavior
1. **Coupling to Read-Receipt:** Meta does not provide an isolated message-level typing indicator. Indicating typing for an incoming message explicitly marks the message (and previous messages in the conversation) as read at Meta's layer (blue check marks).
2. **Ephemeral Lifetime:** The typing indicator on the customer's WhatsApp application is dismissed as soon as an outbound message is sent, or automatically after **25 seconds**, whichever occurs first.
3. **Correlation Requirement:** The request requires a valid incoming WhatsApp provider message ID (`waMessageId` / `wamid`) received within 30 days.

---

## 3. Read-Receipt Policy & Backoffice Invariants

Because Meta couples typing indicators with read receipts, this service implements strict policy boundaries:

1. **Explicit Caller Authorization (`markAsRead: true`):**
   Callers must pass `markAsRead: true` explicitly. If omitted or `false`, the service rejects the request immediately without communicating with Meta.
2. **Zero Internal State Mutation:**
   The service never modifies `Conversation.unreadCount` or internal message statuses. Meta's external read status and Backoffice internal unread tracking remain separate.
3. **No Automatic Inbound Activation:**
   Inbound webhooks never automatically trigger typing indicators.

---

## 4. Architectural Boundaries & Guarantees

| Concern | Architectural Rule |
| :--- | :--- |
| **Durability** | Ephemeral only. **No** Transactional Outbox, **no** database writes, **no** durable retry. |
| **Delivery Blocking** | Failures in typing indicators **never** block or fail outbound message delivery. |
| **Tenant Isolation** | Strict validation: `context.tenantId` must own the conversation, phone number, and message. Cross-tenant attempts throw `TenantAuthorizationError`. |
| **Transport** | Reuses centralized `graphFetch` client with automatic token redaction and `AbortSignal` timeout handling. |
| **Activation** | Controlled via `WHATSAPP_TYPING_ENABLED=true` environment variable. Defaults to disabled. |

---

## 5. Rate Control & Concurrency

- **In-process Queue:** Implemented via `p-queue` per phone number ID (`TYPING_MIN_INTERVAL_MS = 5000ms`, `concurrency = 1`).
- **Instance Limitation:** In-process rate limiting applies per Node.js process. Distributed cross-instance rate limiting across multi-server deployments is deferred to ADR-0005 (Redis/BullMQ).

---

## 6. Internal Service Contract

```typescript
import { sendTypingIndicator, type SendTypingOptions, type SendTypingResult } from "@/lib/whatsapp/typing";

// Callers obtain a trusted TenantContext (via resolveTenantContext or resolveApiKeyTenantContext)
const result: SendTypingResult = await sendTypingIndicator({
  context,
  conversationId: "conv_cuid",
  inboundMessageId: "msg_cuid",
  markAsRead: true, // Mandatory explicit opt-in
});

if (result.success) {
  // Meta confirmed request
} else {
  // Handled safely; inspect result.reason
}
```

---

## 7. Future Integration Contracts

### Future Human UI (Operator Console)
- An operator focusing the message composer in the Inbox may trigger an ephemeral typing indicator.
- The UI must only dispatch the call when the conversation has an inbound message within the last 30 days.
- Rate limiting prevents multiple rapid keystrokes from spamming Meta.

### Future Mastra Automation (Agent Workflow)
- Mastra agents processing an incoming inquiry can dispatch a typing indicator when beginning inference or tool execution.
- Mastra must provide its authorized execution context and explicitly declare `markAsRead: true`.
- If inference takes longer than 25 seconds, Mastra may send another indicator or proceed to respond.
- Typing indicator failures must be treated as warnings and must never abort the agent run or response dispatch.

---

## 8. Implementation vs. Activation

- **Implementation (Current Status):** Core service, authorization validation, correlation, in-process rate limiting, unit tests, and integration tests are fully implemented and verified.
- **Activation (Production Deployment):** Remains deactivated by default. Set `WHATSAPP_TYPING_ENABLED=true` in environment configuration when ready for staging or production testing.
