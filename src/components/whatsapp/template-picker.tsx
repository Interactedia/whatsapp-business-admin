"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { cn } from "@/lib/utils";
import { templateSendDraft, type SendableTemplate } from "@/lib/whatsapp/template-send-draft";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TemplatePreview } from "./template-preview";

export function TemplatePicker({ open, onClose, onPick, pending }: {
  open: boolean;
  onClose: () => void;
  onPick: (input: { templateId: string; bodyVariables?: string[] | Record<string, string> }) => void;
  pending: boolean;
}) {
  const [selected, setSelected] = useState<SendableTemplate | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const { data: templates = [] } = useQuery({
    queryKey: ["templates", "approved"],
    queryFn: () => apiFetch<SendableTemplate[]>("/api/templates?approved=true"),
    enabled: open,
  });
  const draft = selected ? templateSendDraft(selected, values) : null;

  function reset() {
    setSelected(null);
    setValues({});
  }

  useEffect(() => {
    if (!open) {
      setSelected(null);
      setValues({});
    }
  }, [open]);

  function sendSelected() {
    if (!selected || !draft?.ready || pending) return;
    onPick({ templateId: selected.id, ...(draft.bodyVariables ? { bodyVariables: draft.bodyVariables } : {}) });
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) { reset(); onClose(); } }}>
      <DialogContent className={cn("flex flex-col overflow-hidden", selected && "max-w-3xl")}>
        <DialogHeader className="shrink-0 pr-6">
          <DialogTitle className="wrap-break-word">{selected ? `Send ${selected.name}` : "Choose an approved template"}</DialogTitle>
          <DialogDescription>
            {selected ? draft?.tokens.length ? "Enter the values and review your message before sending." : "Review your message before sending." : "Select a template to preview it before sending."}
          </DialogDescription>
        </DialogHeader>
        {selected && draft ? (
          <>
            <div className={cn("grid min-h-0 gap-4 overflow-y-auto scroll-thin", draft.tokens.length > 0 && "md:grid-cols-2")}>
              {draft.tokens.length > 0 && (
                <div className="min-w-0 space-y-3 p-1">
                  {draft.tokens.map((token) => (
                    <label key={token} className="block space-y-1 text-xs font-medium">
                      <span>{selected.category === "AUTHENTICATION" ? "Verification code" : `{{${token}}}`}</span>
                      <Input
                        value={values[token] ?? ""}
                        onChange={(event) => setValues((current) => ({ ...current, [token]: event.target.value }))}
                        placeholder={selected.category === "AUTHENTICATION" ? "e.g. 123456" : `Value for {{${token}}}`}
                        autoFocus={token === draft.tokens[0]}
                        disabled={pending}
                      />
                    </label>
                  ))}
                </div>
              )}
              <section aria-label="Message preview" className="min-w-0 space-y-2">
                <h3 className="text-xs font-medium">Message preview</h3>
                <div><TemplatePreview builder={draft.preview} /></div>
              </section>
            </div>
            <div className="flex shrink-0 justify-between gap-2 border-t pt-3">
              <Button variant="outline" onClick={reset} disabled={pending}>Back</Button>
              <Button onClick={sendSelected} disabled={!draft.ready || pending}>
                <Send className="h-4 w-4" /> {pending ? "Sending…" : "Send template"}
              </Button>
            </div>
          </>
        ) : (
          <div className="max-h-80 min-h-0 space-y-1 overflow-auto scroll-thin">
            {templates.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No approved templates. Create and get one approved first.</p>}
            {templates.map((template) => (
              <button
                key={template.id}
                disabled={pending}
                onClick={() => { setSelected(template); setValues({}); }}
                className="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm hover:border-primary/40 disabled:opacity-50"
              >
                <span className="min-w-0 wrap-break-word font-medium">{template.name}</span>
                <Badge variant="outline">{template.language}</Badge>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
