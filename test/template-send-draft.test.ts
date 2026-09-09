import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TemplatePreview } from "@/components/whatsapp/template-preview";
import { templateSendDraft, type SendableTemplate } from "@/lib/whatsapp/template-send-draft";
import { buildTemplateContent } from "@/lib/whatsapp/template-content";
import { buildTemplateComponents } from "@/lib/whatsapp/template-params";

const template: SendableTemplate = {
  id: "welcome", name: "vun_welcome_01", language: "en", category: "MARKETING",
  components: [
    { type: "HEADER", format: "TEXT", text: "Welcome to {{1}}", example: { header_text: ["VUN"] } },
    { type: "BODY", text: "Hi *{{name}}*!\nYour code is {{code}}. Welcome, {{name}}.", example: { body_text_named_params: [{ param_name: "name", example: "SAMPLE" }] } },
    { type: "FOOTER", text: "Thank you" },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Get started" }] },
  ],
};

describe("template send preview", () => {
  it("renders placeholders rather than body samples until values are supplied", () => {
    const draft = templateSendDraft(template, {});
    expect(draft.ready).toBe(false);
    expect(draft.preview.body.examples).toEqual({});
    const html = renderToStaticMarkup(createElement(TemplatePreview, { builder: draft.preview }));
    expect(html).toContain("{{name}}");
    expect(html).toContain("{{code}}");
    expect(html).not.toContain("SAMPLE");
    expect(html).toContain("Welcome to VUN");
    expect(html).toContain("Thank you");
    expect(html).toContain("Get started");
    expect(template.components[1]).toHaveProperty("example");
  });

  it("updates repeated and named values, trimming identically for preview and sending", () => {
    const draft = templateSendDraft(template, { name: " Priya ", code: " 1234 " });
    expect(draft.ready).toBe(true);
    expect(draft.bodyVariables).toEqual({ name: "Priya", code: "1234" });
    expect(draft.preview.body.examples).toEqual(draft.bodyVariables);
    const html = renderToStaticMarkup(createElement(TemplatePreview, { builder: draft.preview }));
    expect(html.match(/Priya/g)).toHaveLength(2);
    expect(html).toContain("<strong>Priya</strong>");
    expect(html).toContain("1234");
    expect(html).toContain("<br/>");
    const edited = templateSendDraft(template, { name: "Arjun", code: "1234" });
    expect(renderToStaticMarkup(createElement(TemplatePreview, { builder: edited.preview }))).not.toContain("Priya");
  });

  it("orders positional variables numerically so their preview matches the sent message", () => {
    const numbered: SendableTemplate = { ...template, components: [{ type: "BODY", text: "{{2}}, {{1}}, {{2}}" }] };
    const draft = templateSendDraft(numbered, { "1": "First", "2": "Second" });
    expect(draft.tokens).toEqual(["1", "2"]);
    expect(draft.bodyVariables).toEqual(["First", "Second"]);
    const sent = buildTemplateContent({ name: numbered.name, language: numbered.language, definition: numbered.components, parameters: buildTemplateComponents({ body_variables: draft.bodyVariables }) });
    expect(sent.body).toBe("Second, First, Second");
    expect(renderToStaticMarkup(createElement(TemplatePreview, { builder: draft.preview }))).toContain(sent.body);
  });

  it("keeps incomplete and whitespace-only fields unresolved and blocks sending", () => {
    const draft = templateSendDraft(template, { name: "Priya", code: "   " });
    expect(draft.ready).toBe(false);
    expect(draft.preview.body.examples).toEqual({ name: "Priya" });
    expect(renderToStaticMarkup(createElement(TemplatePreview, { builder: draft.preview }))).toContain("{{code}}");
  });

  it("previews static templates without adding body variables to the request", () => {
    const draft = templateSendDraft({ ...template, components: [{ type: "BODY", text: "Welcome to VUN" }] }, {});
    expect(draft.ready).toBe(true);
    expect(draft.tokens).toEqual([]);
    expect(draft.bodyVariables).toBeUndefined();
    expect(renderToStaticMarkup(createElement(TemplatePreview, { builder: draft.preview }))).toContain("Welcome to VUN");
  });

  it("previews authentication codes and escapes user input", () => {
    const auth: SendableTemplate = { ...template, category: "AUTHENTICATION", components: [{ type: "BODY", text: "{{1}} is your verification code." }, { type: "BUTTONS", buttons: [{ type: "COPY_CODE", example: "SAMPLE" }] }] };
    const draft = templateSendDraft(auth, { "1": "<script>alert(1)</script>" });
    const html = renderToStaticMarkup(createElement(TemplatePreview, { builder: draft.preview }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Copy code");
    expect(html).not.toContain("SAMPLE");
  });

  it.each(["IMAGE", "VIDEO", "DOCUMENT"] as const)("keeps a %s header placeholder", (format) => {
    const draft = templateSendDraft({ ...template, components: [{ type: "HEADER", format, example: { header_handle: ["sample-handle"] } }, { type: "BODY", text: "Hello {{1}}" }] }, { "1": "Priya" });
    expect(draft.preview.header.type).toBe(format);
    const html = renderToStaticMarkup(createElement(TemplatePreview, { builder: draft.preview }));
    expect(html).toContain("Priya");
    expect(html).not.toContain('src="sample-handle"');
  });
});
