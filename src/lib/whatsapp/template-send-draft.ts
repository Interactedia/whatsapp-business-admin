import { componentsToBuilder, extractVariables, isNamedToken, type ApiComponent, type TemplateCategory } from "./template-types";

export type SendableTemplate = {
  id: string;
  name: string;
  language: string;
  category: TemplateCategory;
  components: ApiComponent[];
};

/** Use the same normalized values for the live preview and the send request. */
export function templateSendDraft(template: SendableTemplate, values: Record<string, string>) {
  const preview = componentsToBuilder(template.components, template);
  const tokens = extractVariables(preview.body.text ?? "");
  const named = tokens.some(isNamedToken);
  if (!named) tokens.sort((a, b) => Number(a) - Number(b));
  const normalized = Object.fromEntries(tokens.map((token) => [token, (values[token] ?? "").trim()]));
  // Empty fields must remain placeholders; stored body examples are not input.
  preview.body.examples = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== ""));
  const bodyVariables = tokens.length === 0 ? undefined
    : named ? normalized : tokens.map((token) => normalized[token]);
  return { preview, tokens, bodyVariables, ready: tokens.every((token) => normalized[token] !== "") };
}
