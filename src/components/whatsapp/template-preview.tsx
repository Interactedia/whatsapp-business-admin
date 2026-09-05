"use client";

import { Image as ImageIcon, Film, FileText, Phone, ExternalLink, Copy, Reply } from "lucide-react";
import { type TemplateBuilder, extractVariables } from "@/lib/whatsapp/template-types";
import { renderTemplateText } from "@/lib/whatsapp/format";

// Fixed sample time so the preview renders identically on server and client
// (avoids a hydration mismatch from locale/timezone-dependent current time).
const SAMPLE_TIME = "12:00";

/** Renders a WhatsApp message bubble that mirrors how the template will appear. */
export function TemplatePreview({ builder }: { builder: TemplateBuilder }) {
  const headerToken = builder.header.type === "TEXT" ? extractVariables(builder.header.text ?? "")[0] : undefined;
  const headerExamples: Record<string, string> =
    headerToken && builder.header.textExample ? { [headerToken]: builder.header.textExample } : {};

  return (
    <div className="wa-wallpaper flex h-full flex-col rounded-lg border p-4">
      <div className="mx-auto w-full max-w-[320px]">
        <div className="rounded-lg rounded-tl-none bg-white p-2 shadow-xs dark:bg-[#202c33] dark:text-zinc-100">
          {/* Header */}
          {builder.header.type === "TEXT" && builder.header.text && (
            <div
              className="mb-1 font-semibold"
              dangerouslySetInnerHTML={{ __html: renderTemplateText(builder.header.text, headerExamples) }}
            />
          )}
          {builder.header.type === "IMAGE" && <MediaBox icon={<ImageIcon className="h-6 w-6" />} label="Image" />}
          {builder.header.type === "VIDEO" && <MediaBox icon={<Film className="h-6 w-6" />} label="Video" />}
          {builder.header.type === "DOCUMENT" && (
            <div className="mb-2 flex items-center gap-2 rounded-sm bg-black/5 p-2 dark:bg-white/10">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <span className="truncate text-xs">{builder.header.mediaFilename || "document.pdf"}</span>
            </div>
          )}

          {/* Body */}
          {builder.body.text ? (
            <div
              className="whitespace-pre-wrap wrap-break-word text-sm leading-snug"
              dangerouslySetInnerHTML={{ __html: renderTemplateText(builder.body.text, builder.body.examples) }}
            />
          ) : (
            <div className="text-sm italic text-muted-foreground">Your message body…</div>
          )}

          {/* Footer */}
          {builder.footer.text && (
            <div className="mt-1 text-[11px] text-muted-foreground">{builder.footer.text}</div>
          )}

          <div className="mt-0.5 text-right text-[10px] text-muted-foreground">{SAMPLE_TIME}</div>
        </div>

        {/* Buttons */}
        {builder.buttons.length > 0 && (
          <div className="mt-1 space-y-1">
            {builder.buttons.map((btn, i) => (
              <div
                key={i}
                className="flex items-center justify-center gap-1.5 rounded-lg bg-white py-2 text-[13px] font-medium text-[#00a5f4] shadow-xs dark:bg-[#202c33]"
              >
                {btn.type === "QUICK_REPLY" && <Reply className="h-3.5 w-3.5" />}
                {btn.type === "URL" && <ExternalLink className="h-3.5 w-3.5" />}
                {btn.type === "PHONE_NUMBER" && <Phone className="h-3.5 w-3.5" />}
                {btn.type === "COPY_CODE" && <Copy className="h-3.5 w-3.5" />}
                <span className="truncate">
                  {btn.type === "COPY_CODE" ? "Copy offer code" : btn.text || "Button"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaBox({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="mb-2 flex h-28 flex-col items-center justify-center gap-1 rounded-sm bg-black/5 text-muted-foreground dark:bg-white/10">
      {icon}
      <span className="text-[11px]">{label} header</span>
    </div>
  );
}
