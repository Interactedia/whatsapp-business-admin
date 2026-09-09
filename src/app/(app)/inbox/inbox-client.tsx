"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Send, Paperclip, Check, CheckCheck, Clock, AlertCircle, MessageSquare, FileText, LayoutTemplate, Workflow, ArrowLeft,
} from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { cn, formatInboxTimestamp } from "@/lib/utils";
import { useRealtime } from "@/hooks/use-realtime";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { TemplateMessage } from "@/components/whatsapp/template-message";
import { TemplatePicker } from "@/components/whatsapp/template-picker";
import type { TemplateContent } from "@/lib/whatsapp/template-content";

type Contact = { id: string; waId: string; name: string | null; profileName: string | null };
type Conversation = {
  id: string;
  contact: Contact;
  lastPreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  windowOpen: boolean;
};
type Msg = {
  id: string;
  direction: "IN" | "OUT";
  type: string;
  status: string;
  text: string | null;
  caption: string | null;
  hasMedia: boolean;
  mediaMime: string | null;
  mediaFilename: string | null;
  timestamp: string;
  waMessageId: string | null;
  templateContent?: TemplateContent;
};
type FlowSubmission = { id: string; waMessageId: string | null; flow: { name: string }; response: Record<string, unknown> | null; purgedAt: string | null; completedAt: string };
type Thread = {
  conversation: { id: string; contact: Contact; windowOpen: boolean; lastInboundAt: string | null };
  messages: Msg[];
  flowSubmissions: FlowSubmission[];
};

function displayName(c: Contact) {
  return c.name || c.profileName || `+${c.waId}`;
}
function initials(c: Contact) {
  return displayName(c).replace("+", "").slice(0, 2).toUpperCase();
}

export function InboxClient() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const activeId = params.get("c");
  const [search, setSearch] = useState("");

  const { data: conversations = [] } = useQuery({
    queryKey: ["conversations", search],
    queryFn: () => apiFetch<Conversation[]>(`/api/conversations${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    refetchInterval: 30_000,
  });

  // Realtime: refresh lists + the open thread on any event.
  useRealtime((msg) => {
    if (msg.type.startsWith("message:")) {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      const p = msg.payload as { conversationId?: string };
      if (p.conversationId && p.conversationId === activeId) {
        qc.invalidateQueries({ queryKey: ["thread", activeId] });
      }
    }
  });

  function openConversation(id: string) {
    router.push(`/inbox?c=${id}`);
  }

  return (
    <div className="flex h-full min-w-0">
      {/* Conversation list */}
      <div className={cn("w-full shrink-0 flex-col border-r md:flex md:w-64 lg:w-72", activeId ? "hidden" : "flex")}>
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto scroll-thin">
          {conversations.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">No conversations yet.</div>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => openConversation(c.id)}
              className={cn(
                "flex min-h-14 w-full items-center gap-2 border-b px-3 py-2 text-left transition-colors hover:bg-accent md:min-h-0 md:px-2.5",
                c.id === activeId && "bg-accent",
              )}
            >
              <Avatar className="h-9 w-9">
                <AvatarFallback>{initials(c.contact)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                  <span className="truncate text-sm font-medium">{displayName(c.contact)}</span>
                  {c.lastMessageAt && (
                    <span className="ml-auto max-w-full text-right text-[10px] text-muted-foreground">{formatInboxTimestamp(c.lastMessageAt)}</span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs text-muted-foreground">{c.lastPreview || "—"}</span>
                  {c.unreadCount > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                      {c.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      <div className={cn("min-w-0 flex-1", activeId ? "block" : "hidden md:block")}>
        {activeId ? <ThreadPane conversationId={activeId} onBack={() => router.push("/inbox")} /> : <EmptyThread />}
      </div>
    </div>
  );
}

function EmptyThread() {
  return (
    <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
      <MessageSquare className="mb-2 h-10 w-10 opacity-30" />
      <p className="text-sm">Select a conversation to start chatting.</p>
    </div>
  );
}

function ThreadPane({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [showFlows, setShowFlows] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["thread", conversationId],
    queryFn: () => apiFetch<Thread>(`/api/conversations/${conversationId}/messages`),
  });

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.messages.length]);

  // Opening a thread marks it read server-side; refresh the list to clear the badge.
  useEffect(() => {
    qc.invalidateQueries({ queryKey: ["conversations"] });
  }, [conversationId, qc]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["thread", conversationId] });
    qc.invalidateQueries({ queryKey: ["conversations"] });
  };

  const sendText = useMutation({
    mutationFn: (t: string) =>
      apiFetch(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ kind: "text", text: t }) }),
    onSuccess: () => {
      setText("");
      invalidate();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Not sent", description: e.message }),
  });

  const sendMedia = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      return fetch(`/api/conversations/${conversationId}/messages`, { method: "POST", body: fd }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Upload failed");
      });
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast({ variant: "destructive", title: "Not sent", description: e.message }),
  });

  const sendTemplate = useMutation({
    mutationFn: (input: { templateId: string; bodyVariables?: string[] | Record<string, string> }) =>
      apiFetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ kind: "template", ...input }),
      }),
    onSuccess: () => {
      setShowTemplates(false);
      invalidate();
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Not sent", description: e.message }),
  });
  const sendFlow = useMutation({
    mutationFn: (flowId: string) => apiFetch(`/api/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ kind: "flow", flowId, cta: "Open form" }) }),
    onSuccess: () => { setShowFlows(false); invalidate(); },
    onError: (e: Error) => toast({ variant: "destructive", title: "Flow not sent", description: e.message }),
  });

  const windowInfo = useMemo(() => {
    if (!data) return null;
    if (data.conversation.windowOpen && data.conversation.lastInboundAt) {
      const closesAt = new Date(data.conversation.lastInboundAt).getTime() + 24 * 3600 * 1000;
      const hrs = Math.max(0, Math.round((closesAt - Date.now()) / 3600000));
      return { open: true, label: `Session open · ~${hrs}h left` };
    }
    return { open: false, label: "24h window closed — send an approved template" };
  }, [data]);

  if (isLoading || !data) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>;

  const contact = data.conversation.contact;
  const windowOpen = data.conversation.windowOpen;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-card px-2 py-1 sm:px-3">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onBack} aria-label="Back to conversations"><ArrowLeft className="h-5 w-5" /></Button>
        <Avatar className="h-8 w-8">
          <AvatarFallback>{initials(contact)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{displayName(contact)}</div>
          <div className="text-[11px] text-muted-foreground">+{contact.waId}</div>
        </div>
        <div className="ml-auto hidden sm:block">
          <Badge variant={windowOpen ? "success" : "warning"}>{windowInfo?.label}</Badge>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="wa-wallpaper min-h-0 flex-1 space-y-1.5 overflow-auto p-2 scroll-thin sm:p-4">
        {data.messages.map((m) => <div key={m.id}><MessageBubble m={m} />{data.flowSubmissions.filter((submission) => submission.waMessageId === m.waMessageId).map((submission) => <FlowSubmissionCard key={submission.id} submission={submission} />)}</div>)}
        {data.messages.length === 0 && (
          <div className="mt-10 text-center text-xs text-muted-foreground">No messages yet. Say hello 👋</div>
        )}
      </div>

      {/* Composer */}
      <div className="safe-bottom shrink-0 border-t bg-card p-2">
        {windowOpen ? (
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) sendMedia.mutate(f);
                e.target.value = "";
              }}
            />
            <Button variant="ghost" size="icon" title="Attach" onClick={() => fileRef.current?.click()} disabled={sendMedia.isPending}>
              <Paperclip className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" title="Send Flow" onClick={() => setShowFlows(true)}><Workflow className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" title="Send template" onClick={() => setShowTemplates(true)}><LayoutTemplate className="h-4 w-4" /></Button>
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && text.trim()) {
                  e.preventDefault();
                  sendText.mutate(text.trim());
                }
              }}
              placeholder="Type a message…"
            />
            <Button size="icon" disabled={!text.trim() || sendText.isPending} onClick={() => sendText.mutate(text.trim())}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-stretch gap-2 rounded-md bg-muted/50 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              This chat is outside the 24-hour window. You can only send an approved template.
            </span>
            <Button size="sm" onClick={() => setShowTemplates(true)}>
              <LayoutTemplate className="h-4 w-4" /> Send template
            </Button>
          </div>
        )}
      </div>

      <TemplatePicker
        open={showTemplates}
        onClose={() => setShowTemplates(false)}
        onPick={(input) => sendTemplate.mutate(input)}
        pending={sendTemplate.isPending}
      />
      <FlowPicker open={showFlows} onClose={() => setShowFlows(false)} onPick={(id) => sendFlow.mutate(id)} pending={sendFlow.isPending} />
    </div>
  );
}

function FlowSubmissionCard({ submission }: { submission: FlowSubmission }) {
  return <div className="ml-2 mt-1 max-w-md rounded-lg border border-emerald-200 bg-white p-3 text-zinc-900 shadow-xs dark:border-emerald-900 dark:bg-[#202c33] dark:text-zinc-50"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400"><Workflow className="h-4 w-4" /> {submission.flow.name} submitted</div>{submission.response ? <div className="space-y-1">{Object.entries(submission.response).map(([key, value]) => <div key={key} className="grid grid-cols-1 gap-0.5 text-xs min-[430px]:grid-cols-[110px_1fr] min-[430px]:gap-2"><span className="font-medium">{key}</span><span className="wrap-break-word text-muted-foreground">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span></div>)}</div> : <div className="text-xs text-muted-foreground">Response data has been purged.</div>}</div>;
}

function MessageBubble({ m }: { m: Msg }) {
  const out = m.direction === "OUT";
  return (
    <div className={cn("flex", out ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-lg px-2.5 py-1.5 text-sm shadow-xs sm:max-w-[70%]",
          out ? "rounded-tr-none bg-[#d9fdd3] text-zinc-900 dark:bg-[#005c4b] dark:text-zinc-50" : "rounded-tl-none bg-white text-zinc-900 dark:bg-[#202c33] dark:text-zinc-50",
        )}
      >
        {m.type === "TEMPLATE" && m.templateContent ? <TemplateMessage content={m.templateContent} messageId={m.id} hasMedia={m.hasMedia} /> : <>
          {m.hasMedia && <MediaContent m={m} />}
          {m.text && <div className="whitespace-pre-wrap wrap-break-word">{m.text}</div>}
          {m.caption && <div className="whitespace-pre-wrap wrap-break-word">{m.caption}</div>}
        </>}
        <div className={cn("mt-0.5 flex items-center justify-end gap-1 text-[10px] [&>svg]:shrink-0", out ? "text-zinc-600 dark:text-zinc-300" : "text-muted-foreground")}>
          <span className="min-w-0 text-right">{formatInboxTimestamp(m.timestamp)}</span>
          {out && <StatusTick status={m.status} />}
        </div>
      </div>
    </div>
  );
}

function MediaContent({ m }: { m: Msg }) {
  const url = `/api/media/${m.id}`;
  const mime = m.mediaMime || "";
  if (mime.startsWith("image/")) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="mb-1 max-h-64 rounded-sm" />;
  }
  if (mime.startsWith("video/")) return <video src={url} controls className="mb-1 max-h-64 rounded-sm" />;
  if (mime.startsWith("audio/")) return <audio src={url} controls className="mb-1 w-56" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-2 rounded-sm bg-black/5 p-2 dark:bg-white/10">
      <FileText className="h-5 w-5" />
      <span className="truncate text-xs">{m.mediaFilename || "Document"}</span>
    </a>
  );
}

function StatusTick({ status }: { status: string }) {
  switch (status) {
    case "PENDING": return <Clock className="h-3 w-3" />;
    case "SENT": return <Check className="h-3 w-3" />;
    case "DELIVERED": return <CheckCheck className="h-3 w-3" />;
    case "READ": return <CheckCheck className="h-3 w-3 text-sky-500" />;
    case "FAILED": return <AlertCircle className="h-3 w-3 text-destructive" />;
    default: return null;
  }
}

type PublishedFlow = { id: string; name: string; categories: string[] };
function FlowPicker({ open, onClose, onPick, pending }: { open: boolean; onClose: () => void; onPick: (id: string) => void; pending: boolean }) {
  const { data: flows = [] } = useQuery({ queryKey: ["flows", "published"], queryFn: () => apiFetch<PublishedFlow[]>("/api/flows?published=true"), enabled: open });
  return <Dialog open={open} onOpenChange={(value) => !value && onClose()}><DialogContent><DialogHeader><DialogTitle>Send a WhatsApp Flow</DialogTitle></DialogHeader><div className="max-h-80 space-y-1 overflow-auto">{flows.map((flow) => <button key={flow.id} disabled={pending} onClick={() => onPick(flow.id)} className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left hover:border-primary/40 disabled:opacity-50"><span className="text-sm font-medium">{flow.name}</span><Badge variant="outline">{flow.categories[0]?.replaceAll("_", " ")}</Badge></button>)}{!flows.length && <p className="py-6 text-center text-xs text-muted-foreground">No published Flows are available.</p>}</div></DialogContent></Dialog>;
}
