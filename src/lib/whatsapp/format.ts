/**
 * Render WhatsApp-style markup (*bold*, _italic_, ~strike~, ```mono```) to safe
 * HTML, and substitute {{n}} placeholders with sample values. Client-safe.
 */

const VARIABLE_MARKER_START = "\uE000";
const VARIABLE_MARKER_END = "\uE001";

export type WhatsAppTextFormat = "bold" | "italic" | "strike";

type SelectionSegment = {
  start: number;
  end: number;
  contentStart: number;
  contentEnd: number;
  markerPosition: "inside" | "outside" | null;
};

type TextEdit = { start: number; end: number; replacement: string };

export type FormatSelectionResult = {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  changed: boolean;
  formatted: boolean;
  reason?: "no-selection" | "max-length";
};

const FORMAT_MARKERS: Record<WhatsAppTextFormat, string> = {
  bold: "*",
  italic: "_",
  strike: "~",
};

function expandAcrossVariables(text: string, start: number, end: number) {
  let expandedStart = start;
  let expandedEnd = end;
  for (const match of text.matchAll(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g)) {
    const tokenStart = match.index;
    const tokenEnd = tokenStart + match[0].length;
    if (expandedStart < tokenEnd && expandedEnd > tokenStart) {
      expandedStart = Math.min(expandedStart, tokenStart);
      expandedEnd = Math.max(expandedEnd, tokenEnd);
    }
  }
  return { start: expandedStart, end: expandedEnd };
}

function selectionSegments(text: string, start: number, end: number, marker: string): SelectionSegment[] {
  const expanded = expandAcrossVariables(text, start, end);
  const selected = text.slice(expanded.start, expanded.end);
  const segments: SelectionSegment[] = [];
  let lineOffset = 0;

  for (const line of selected.split("\n")) {
    const leading = line.match(/^[ \t\r]*/)?.[0].length ?? 0;
    const trailing = line.match(/[ \t\r]*$/)?.[0].length ?? 0;
    const lineStart = expanded.start + lineOffset;
    const coreStart = lineStart + leading;
    const coreEnd = lineStart + line.length - trailing;

    if (coreStart < coreEnd) {
      const markerInside = coreEnd - coreStart >= 3 && text[coreStart] === marker && text[coreEnd - 1] === marker;
      const markerOutside = !markerInside && text[coreStart - 1] === marker && text[coreEnd] === marker;
      segments.push({
        start: coreStart,
        end: coreEnd,
        contentStart: markerInside ? coreStart + 1 : coreStart,
        contentEnd: markerInside ? coreEnd - 1 : coreEnd,
        markerPosition: markerInside ? "inside" : markerOutside ? "outside" : null,
      });
    }
    lineOffset += line.length + 1;
  }
  return segments;
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  return [...edits]
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((value, edit) => value.slice(0, edit.start) + edit.replacement + value.slice(edit.end), text);
}

function mapPosition(position: number, edits: TextEdit[], includeInsertAtPosition: boolean): number {
  let mapped = position;
  for (const edit of edits) {
    if (edit.start === edit.end) {
      if (edit.start < position || (includeInsertAtPosition && edit.start === position)) mapped += edit.replacement.length;
    } else if (edit.end <= position) {
      mapped += edit.replacement.length - (edit.end - edit.start);
    }
  }
  return mapped;
}

export function selectionHasWhatsAppFormat(text: string, start: number, end: number, format: WhatsAppTextFormat): boolean {
  if (start === end) return false;
  const segments = selectionSegments(text, start, end, FORMAT_MARKERS[format]);
  return segments.length > 0 && segments.every((segment) => segment.markerPosition !== null);
}

/** Toggle WhatsApp formatting around the selected non-whitespace text. */
export function toggleWhatsAppFormat(
  text: string,
  start: number,
  end: number,
  format: WhatsAppTextFormat,
  maxLength = Number.POSITIVE_INFINITY,
): FormatSelectionResult {
  if (start === end) return { text, selectionStart: start, selectionEnd: end, changed: false, formatted: false, reason: "no-selection" };

  const marker = FORMAT_MARKERS[format];
  const segments = selectionSegments(text, start, end, marker);
  if (!segments.length) return { text, selectionStart: start, selectionEnd: end, changed: false, formatted: false, reason: "no-selection" };

  const removeFormatting = segments.every((segment) => segment.markerPosition !== null);
  const edits: TextEdit[] = [];

  for (const segment of segments) {
    if (removeFormatting) {
      if (segment.markerPosition === "inside") {
        edits.push({ start: segment.start, end: segment.start + 1, replacement: "" });
        edits.push({ start: segment.end - 1, end: segment.end, replacement: "" });
      } else if (segment.markerPosition === "outside") {
        edits.push({ start: segment.start - 1, end: segment.start, replacement: "" });
        edits.push({ start: segment.end, end: segment.end + 1, replacement: "" });
      }
    } else if (segment.markerPosition === null) {
      edits.push({ start: segment.start, end: segment.start, replacement: marker });
      edits.push({ start: segment.end, end: segment.end, replacement: marker });
    }
  }

  const nextText = applyTextEdits(text, edits);
  if (nextText.length > maxLength) {
    return { text, selectionStart: start, selectionEnd: end, changed: false, formatted: false, reason: "max-length" };
  }

  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    text: nextText,
    selectionStart: mapPosition(first.contentStart, edits, true),
    selectionEnd: mapPosition(last.contentEnd, edits, false),
    changed: nextText !== text,
    formatted: !removeFormatting,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Replace {{token}} (positional or named) with example values. Missing → highlighted chip. */
export function substituteVariables(text: string, examples: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, token) => {
    const value = examples[token];
    if (value && value.trim()) return value;
    return `${VARIABLE_MARKER_START}VAR:${token}${VARIABLE_MARKER_END}`;
  });
}

// Build the formatting patterns from strings to keep their parsing consistent
// across the server and Webpack's browser transform.
const RE_CODE = new RegExp("```([\\s\\S]+?)```", "g");
const RE_BOLD = new RegExp("\\*(?!\\s)([^*\\n]*?[^*\\s])\\*", "g");
const RE_ITALIC = new RegExp("(?<![\\w])_(?!\\s)([^_\\n]*?[^_\\s])_(?![\\w])", "g");
const RE_STRIKE = new RegExp("~(?!\\s)([^~\\n]*?[^~\\s])~", "g");
const RE_BOLD1 = new RegExp("\\*([^\\s*])\\*", "g");
const RE_VARIABLE_MARKER = new RegExp(
  `${VARIABLE_MARKER_START}VAR:([a-zA-Z0-9_]+)${VARIABLE_MARKER_END}`,
  "g",
);

export function whatsappToHtml(text: string): string {
  let html = escapeHtml(text);

  // Markers wrap non-empty text that doesn't start/end with a space (WhatsApp rule),
  // and may be followed by punctuation (e.g. *Priya*, renders "Priya" bold).
  html = html.replace(RE_CODE, "<code>$1</code>");
  html = html.replace(RE_BOLD, "<strong>$1</strong>");
  html = html.replace(RE_ITALIC, "<em>$1</em>");
  html = html.replace(RE_STRIKE, "<del>$1</del>");
  html = html.replace(RE_BOLD1, "<strong>$1</strong>");
  html = html.replace(/\n/g, "<br/>");

  // Style unresolved variable placeholders.
  html = html.replace(
    RE_VARIABLE_MARKER,
    (_m, n) => `<span class="rounded-sm bg-amber-200/70 px-1 text-amber-900">{{${n}}}</span>`,
  );
  return html;
}

/** Full pipeline: substitute samples then format. */
export function renderTemplateText(text: string, examples: Record<string, string> = {}): string {
  return whatsappToHtml(substituteVariables(text, examples));
}
