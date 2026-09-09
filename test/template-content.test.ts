import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTemplateContent, readTemplateContent, templateContentPreview, templateContentText } from "@/lib/whatsapp/template-content";
import { TemplateMessage } from "@/components/whatsapp/template-message";

const build = (definition: unknown, parameters: unknown = []) => buildTemplateContent({ name: "vun_welcome_01", language: "en", definition, parameters });

describe("template message content", () => {
  it("renders the complete static card with safe WhatsApp formatting", () => {
    const content = build([
      { type: "HEADER", format: "TEXT", text: "Welcome" },
      { type: "BODY", text: "Hello *friend*!\n<script>alert(1)</script>" },
      { type: "FOOTER", text: "Thank you" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Get started" }, { type: "FLOW", text: "Register" }] },
    ]);
    const html = renderToStaticMarkup(createElement(TemplateMessage, { content, messageId: "m1" }));
    expect(html).toContain("Welcome");
    expect(html).toContain("<strong>friend</strong>");
    expect(html).toContain("<br/>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Thank you");
    expect(html).toContain("Get started");
    expect(html).toContain("Register");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Template: vun_welcome_01");
  });

  it("substitutes numbered variables by index, including repeats and independent headers", () => {
    const content = build([
      { type: "HEADER", format: "TEXT", text: "Order {{1}}" },
      { type: "BODY", text: "{{2}}, hello {{1}} / {{1}}" },
    ], [
      { type: "header", parameters: [{ type: "text", text: "123" }] },
      { type: "body", parameters: [{ type: "text", text: "Priya" }, { type: "text", text: "Welcome" }] },
    ]);
    expect(content).toMatchObject({ header: "Order 123", body: "Welcome, hello Priya / Priya", missingValues: false });
  });

  it("uses named parameters rather than their array order and escapes sent HTML", () => {
    const content = build([{ type: "BODY", text: "Hi {{name}}, {{code}}" }], [
      { type: "body", parameters: [{ type: "text", parameter_name: "code", text: "123" }, { type: "text", parameter_name: "name", text: "<img src=x onerror=alert(1)>" }] },
    ]);
    expect(content.body).toBe("Hi <img src=x onerror=alert(1)>, 123");
    expect(renderToStaticMarkup(createElement(TemplateMessage, { content, messageId: "m" }))).toContain("&lt;img");
  });

  it("preserves missing values instead of using samples or recursively substituting values", () => {
    const content = build([{ type: "BODY", text: "{{1}} / {{2}}", example: { body_text: [["SAMPLE", "SAMPLE"]] } }], [
      { type: "body", parameters: [{ type: "text", text: "{{2}}" }] },
    ]);
    expect(content.body).toBe("{{2}} / {{2}}");
    expect(content.missingValues).toBe(true);
    expect(templateContentText(content)).not.toContain("SAMPLE");
  });

  it("handles currency and date fallbacks", () => {
    const content = build([{ type: "BODY", text: "{{1}} on {{2}}" }], [{ type: "body", parameters: [
      { type: "currency", currency: { fallback_value: "₹100" } },
      { type: "date_time", date_time: { fallback_value: "9 September" } },
    ] }]);
    expect(content.body).toBe("₹100 on 9 September");
  });

  it("captures visible button values and excludes hidden recipient/Flow payloads", () => {
    const content = build([{ type: "BODY", text: "Offers" }, { type: "BUTTONS", buttons: [
      { type: "URL", text: "View", url: "https://example.test/{{1}}" },
      { type: "PHONE_NUMBER", text: "Call", phone_number: "+911234567890" },
      { type: "COPY_CODE" }, { type: "QUICK_REPLY", text: "Reply" }, { type: "FLOW", text: "Open" },
    ] }], [
      { type: "button", index: "0", parameters: [{ type: "text", text: "order-123" }] },
      { type: "button", index: 2, parameters: [{ type: "coupon_code", coupon_code: "SAVE10" }] },
      { type: "button", index: 3, parameters: [{ type: "payload", payload: "hidden-reply" }] },
      { type: "button", index: 4, parameters: [{ type: "action", action: { flow_token: "secret-token", flow_action_data: { secret: "hidden-form" } } }] },
    ]);
    expect(content.buttons.map((b) => b.detail)).toEqual(["https://example.test/order-123", "+911234567890", "SAVE10", "", ""]);
    expect(JSON.stringify(content)).not.toMatch(/secret-token|hidden-reply|hidden-form|flow_token/);
  });

  it.each(["image", "video", "document"])("captures actual %s header media, not sample handles", (type) => {
    const content = build([{ type: "HEADER", format: type.toUpperCase(), example: { header_handle: ["SAMPLE"] } }], [
      { type: "header", parameters: [{ type, [type]: { id: "123", link: "https://example.test/media", filename: "receipt.pdf" } }] },
    ]);
    expect(content.media).toEqual({ type, id: "123", link: "https://example.test/media", filename: "receipt.pdf" });
    expect(JSON.stringify(content)).not.toContain("SAMPLE");
  });

  it("shows unavailable media and reconstruction notes", () => {
    const content = build([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}" }]);
    content.source = "reconstructed";
    const html = renderToStaticMarkup(createElement(TemplateMessage, { content, messageId: "m" }));
    expect(html).toContain("image unavailable");
    expect(html).toContain("original wording may differ");
    expect(html).toContain("Some sent values are unavailable");
  });

  it("uses cached header media when original source parameters are missing", () => {
    const content = build([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Welcome" }]);
    const html = renderToStaticMarkup(createElement(TemplateMessage, { content, messageId: "cached", hasMedia: true }));
    expect(html).toContain('src="/api/media/cached"');
    expect(html).not.toContain("image unavailable");
  });

  it("handles missing definitions and malformed historical components", () => {
    expect(build(null, ["[REDACTED FLOW PARAMETERS]"])).toMatchObject({ source: "unavailable", name: "vun_welcome_01" });
    expect(build([{ type: "BODY", text: "Hello {{name}}" }], [null, "redacted"])).toMatchObject({ body: "Hello {{name}}", missingValues: true });
    expect(readTemplateContent({ templateContent: { version: 99 } })).toBeNull();
  });

  it("keeps full text while limiting and flattening the conversation preview", () => {
    const content = build([{ type: "BODY", text: "Welcome\n" + "x".repeat(200) }]);
    expect(templateContentText(content).length).toBeGreaterThan(200);
    expect(templateContentPreview(content)).toHaveLength(140);
    expect(templateContentPreview(content)).toMatch(/^Welcome x/);
    expect(readTemplateContent({ templateContent: JSON.parse(JSON.stringify(content)) })).toEqual(content);
  });
});
