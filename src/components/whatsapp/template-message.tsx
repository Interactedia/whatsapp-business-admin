"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import type { TemplateContent } from "@/lib/whatsapp/template-content";
import { renderTemplateText } from "@/lib/whatsapp/format";

/** A sent message, using actual values rather than the editor's sample preview. */
export function TemplateMessage({ content, messageId, hasMedia = false }: { content: TemplateContent; messageId: string; hasMedia?: boolean }) {
  return (
    <div className="min-w-0 space-y-1.5 wrap-break-word">
      {content.media && <TemplateHeaderMedia media={content.media} messageId={messageId} hasMedia={hasMedia} />}
      {content.header && <div className="font-semibold" dangerouslySetInnerHTML={{ __html: renderTemplateText(content.header) }} />}
      {content.body && <div className="text-sm leading-snug" dangerouslySetInnerHTML={{ __html: renderTemplateText(content.body) }} />}
      {content.footer && <div className="text-xs opacity-75" dangerouslySetInnerHTML={{ __html: renderTemplateText(content.footer) }} />}
      {content.buttons.length > 0 && (
        <div className="divide-y divide-current/10 border-t border-current/10">
          {content.buttons.map((button, index) => (
            <div key={index} className="px-2 py-2 text-center text-xs">
              <div className="font-medium">{button.text}</div>
              {button.detail && <div className="mt-0.5 opacity-75">{button.detail}</div>}
            </div>
          ))}
        </div>
      )}
      {content.source === "unavailable" && <div className="text-xs">Template: {content.name}<div className="mt-1 opacity-75">Template content unavailable.</div></div>}
      {content.source === "reconstructed" && <div className="text-[10px] opacity-70">Reconstructed from the current template; original wording may differ.</div>}
      {content.missingValues && <div className="text-[10px] opacity-70">Some sent values are unavailable.</div>}
    </div>
  );
}

function TemplateHeaderMedia({ media, messageId, hasMedia }: { media: NonNullable<TemplateContent["media"]>; messageId: string; hasMedia: boolean }) {
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const url = `/api/media/${messageId}`;
  if (failed || (!hasMedia && !media.id && !media.link)) {
    return <div className="rounded-sm bg-black/5 p-3 text-xs capitalize dark:bg-white/10">{media.type} unavailable{media.filename ? `: ${media.filename}` : ""}</div>;
  }
  if (media.type === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="Template image" loading="lazy" onError={() => setFailed(true)} className="max-h-64 max-w-full rounded-sm object-contain" />;
  }
  if (media.type === "video") return <video src={url} controls preload="metadata" onError={() => setFailed(true)} className="max-h-64 max-w-full rounded-sm" />;
  async function openDocument() {
    setLoading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Media unavailable");
      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = media.filename || "document";
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  return <button type="button" disabled={loading} onClick={openDocument} className="flex max-w-full items-center gap-2 rounded-sm bg-black/5 p-2 text-left dark:bg-white/10"><FileText className="h-5 w-5 shrink-0" /><span className="min-w-0 wrap-break-word text-xs">{loading ? "Loading…" : media.filename || "Download document"}</span></button>;
}
