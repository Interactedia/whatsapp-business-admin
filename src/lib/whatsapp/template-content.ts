/** Presentation-only template snapshot. Never contains recipient action payloads. */
export type TemplateContent = {
  version: 1;
  name: string;
  language: string;
  source: "snapshot" | "reconstructed" | "unavailable";
  missingValues: boolean;
  header: string;
  body: string;
  footer: string;
  buttons: { type: string; text: string; detail: string }[];
  media: { type: "image" | "video" | "document"; id: string; link: string; filename: string } | null;
};

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const str = (value: unknown): string => typeof value === "string" ? value : "";
const records = (value: unknown) => Array.isArray(value) ? value.map(asRecord) : [];

export function readTemplateContent(payload: unknown): TemplateContent | null {
  const value = asRecord(asRecord(payload).templateContent);
  if (value.version !== 1 || typeof value.name !== "string" || typeof value.body !== "string"
    || typeof value.header !== "string" || typeof value.footer !== "string" || !Array.isArray(value.buttons)) return null;
  if (value.source !== "snapshot" && value.source !== "reconstructed" && value.source !== "unavailable") return null;
  const media = asRecord(value.media);
  return {
    version: 1, name: value.name, language: str(value.language), source: value.source,
    missingValues: value.missingValues === true, header: value.header, body: value.body, footer: value.footer,
    buttons: records(value.buttons).map((button) => ({ type: str(button.type), text: str(button.text), detail: str(button.detail) })),
    media: media.type === "image" || media.type === "video" || media.type === "document"
      ? { type: media.type, id: str(media.id), link: str(media.link), filename: str(media.filename) } : null,
  };
}

export function buildTemplateContent(input: {
  name: string; language: string; definition: unknown; parameters?: unknown;
  source?: TemplateContent["source"];
}): TemplateContent {
  const definition = records(input.definition);
  const runtime = records(input.parameters);
  const result: TemplateContent = {
    version: 1, name: input.name, language: input.language,
    source: definition.length ? input.source ?? "snapshot" : "unavailable",
    missingValues: false, header: "", body: "", footer: "", buttons: [], media: null,
  };
  function substitute(text: string, component: Record<string, unknown>) {
    const params = records(component.parameters);
    return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (placeholder, token: string) => {
      const param = /^\d+$/.test(token) ? params[Number(token) - 1] : params.find((p) => p.parameter_name === token);
      if (param) {
        if (param.type === "text" && typeof param.text === "string") return param.text;
        if (param.type === "currency" || param.type === "date_time") {
          const fallback = asRecord(param[str(param.type)]).fallback_value;
          if (typeof fallback === "string") return fallback;
        }
      }
      result.missingValues = true;
      return placeholder;
    });
  }
  for (const component of definition) {
    const type = str(component.type).toUpperCase();
    const params = runtime.find((p) => str(p.type).toUpperCase() === type) ?? {};
    if (type === "HEADER") {
      const format = str(component.format).toLowerCase();
      if (format === "text") result.header = substitute(str(component.text), params);
      if (format === "image" || format === "video" || format === "document") {
        const media = asRecord(records(params.parameters).find((p) => p.type === format)?.[format]);
        result.media = { type: format, id: str(media.id), link: str(media.link), filename: str(media.filename) };
      }
    }
    if (type === "BODY") result.body = substitute(str(component.text), params);
    if (type === "FOOTER") result.footer = str(component.text);
    if (type === "BUTTONS") {
      result.buttons = records(component.buttons).map((button, index) => {
        const type = str(button.type).toUpperCase();
        const runtimeButton = runtime.find((p) => str(p.type).toLowerCase() === "button" && String(p.index) === String(index)) ?? {};
        let detail = "";
        if (type === "URL") detail = substitute(str(button.url), runtimeButton);
        if (type === "PHONE_NUMBER") detail = str(button.phone_number);
        if (type === "COPY_CODE" || type === "OTP") {
          const code = records(runtimeButton.parameters).find((p) => p.type === "coupon_code" || p.type === "text");
          detail = str(code?.coupon_code ?? code?.text);
        }
        return { type, text: str(button.text) || (type === "OTP" ? "Copy code" : type === "COPY_CODE" ? "Copy offer code" : "Button"), detail };
      });
    }
  }
  if (!result.body) result.source = "unavailable";
  return result;
}

export function templateContentText(content: TemplateContent): string {
  return [content.header, content.body, content.footer,
    ...content.buttons.map((button) => [button.text, button.detail].filter(Boolean).join(": ")),
  ].filter(Boolean).join("\n\n") || `Template: ${content.name}`;
}

export function templateContentPreview(content: TemplateContent): string {
  return (content.body || templateContentText(content)).replace(/\s+/g, " ").slice(0, 140);
}
