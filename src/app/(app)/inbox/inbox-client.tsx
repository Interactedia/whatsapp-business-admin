"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search, Send, Paperclip, Check, CheckCheck, Clock, AlertCircle, MessageSquare, FileText, LayoutTemplate, Workflow, ArrowLeft, Bot, X,
  Mail, User, Star, ListFilter, Clock3, Lock, ChevronDown,
} from "lucide-react";
import { apiFetch } from "@/lib/fetcher";
import { cn, formatInboxTimestamp } from "@/lib/utils";
import { useRealtime } from "@/hooks/use-realtime";
import {
  OrderingGuard,
  RequestToken,
  SeenSet,
  processEvent,
  type SyncAction,
} from "@/lib/realtime/sync";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/use-toast";
import { TemplateMessage } from "@/components/whatsapp/template-message";
import { TemplatePicker } from "@/components/whatsapp/template-picker";
import type { TemplateContent } from "@/lib/whatsapp/template-content";

type Contact = { id: string; waId: string; name: string | null; profileName: string | null; tags: string[] };
type Conversation = {
  id: string;
  contact: Contact;
  status: "OPEN" | "CLOSED";
  lastPreview: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  assignedUserId: string | null;
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
  errorJson?: { code?: string; message?: string; uncertain?: boolean; metaStatus?: number } | null;
  templateContent?: TemplateContent;
  location?: { latitude: number; longitude: number; name: string | null; address: string | null; url: string | null };
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

const TAG_COLORS = [
  "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300",
  "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  "bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-300",
];

function tagColor(tag: string): string {
  // Consistent color per tag name
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onClick: () => void;
  onMarkUnread: () => void;
  onToggleStatus: () => void;
  onAssign: () => void;
  isPending: boolean;
}

function ConversationItem({
  conversation: c,
  isActive,
  onClick,
  onMarkUnread,
  onToggleStatus,
  onAssign,
  isPending,
}: ConversationItemProps) {
  const hasTags = c.contact.tags.length > 0;
  const visibleTags = c.contact.tags.slice(0, 2);
  const extraTags = c.contact.tags.length - 2;

  return (
    <div
      className={cn(
        // WA-UI-012-R4: card clara sobre lienzo gris, separada por gap (no bordes de tabla)
        "group relative flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
        isPending && "opacity-70",
        isActive
          ? "bg-[var(--conv-selected)] before:absolute before:top-1/2 before:left-1 before:h-7 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-[var(--conv-active)] before:content-['']"
          : "bg-[var(--conv-card)] hover:bg-[var(--conv-hover)]",
      )}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
      aria-label={`Open conversation with ${displayName(c.contact)}`}
      aria-current={isActive ? "true" : undefined}
    >
      {/* Avatar - 36-40px, fondo suave, iniciales centradas */}
      <Avatar className="mt-0.5 h-9 w-9 shrink-0">
        <AvatarFallback className="bg-[var(--avatar-bg)] text-[11px] font-medium text-[var(--avatar-text)]">{initials(c.contact)}</AvatarFallback>
      </Avatar>

      {/* Main content */}
      <div className="min-w-0 flex-1">
        {/* Header row: name + time + unread */}
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "truncate text-[13px]",
              c.unreadCount > 0 ? "font-semibold text-foreground" : "font-medium text-[var(--text-secondary)]",
            )}
          >
            {displayName(c.contact)}
          </span>
          <div className="flex items-center gap-1.5">
            {c.lastMessageAt && (
              <span className="whitespace-nowrap text-[11px] text-[var(--text-muted)]">
                {formatInboxTimestamp(c.lastMessageAt)}
              </span>
            )}
            {c.unreadCount > 0 && (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--unread-badge)] px-1.5 text-[11px] font-semibold text-white">
                {c.unreadCount > 99 ? "99+" : c.unreadCount}
              </span>
            )}
          </div>
        </div>

        {/* Preview row */}
        <p className={cn("mt-0.5 truncate text-[12px]", c.unreadCount > 0 ? "text-foreground font-normal" : "text-[var(--text-muted)]")}>
          {c.lastPreview || "—"}
        </p>

        {/* Tags row */}
        {hasTags && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {visibleTags.map((tag) => (
              <span
                key={tag}
                className={cn(
                  "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                  tagColor(tag),
                )}
              >
                {tag}
              </span>
            ))}
            {extraTags > 0 && (
              <span className="text-[10px] text-[var(--text-muted)]">+{extraTags}</span>
            )}
          </div>
        )}
      </div>

      {/* Context menu - Scope C & D: ChevronDown refinado con menú contextual */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="absolute right-1.5 top-1/2 z-10 flex h-8 w-8 shrink-0 -translate-y-1/2 items-center justify-center text-[var(--text-muted)] opacity-0 transition-all hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            aria-label="Opciones de conversación"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-56 rounded-xl border-[var(--menu-border)] bg-[var(--menu-bg)] p-1 shadow-[var(--menu-shadow)]" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onMarkUnread(); }}
            disabled={isPending}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-foreground transition-colors hover:bg-[var(--menu-item-hover)] focus:bg-[var(--menu-item-hover)] data-[disabled]:opacity-50 cursor-pointer"
          >
            <Mail className="h-4 w-4 text-[var(--text-muted)]" />
            {c.unreadCount > 0 ? "Marcar como leído" : "Marcar como no leído"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onToggleStatus(); }}
            disabled={isPending}
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-foreground transition-colors hover:bg-[var(--menu-item-hover)] focus:bg-[var(--menu-item-hover)] data-[disabled]:opacity-50 cursor-pointer"
          >
            <Clock3 className="h-4 w-4 text-[var(--text-muted)]" />
            {c.status === "OPEN" ? "Cerrar conversación" : "Reabrir conversación"}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-1 bg-[var(--separator)]" />
          <DropdownMenuItem
            onClick={(e) => { e.stopPropagation(); onAssign(); }}
            disabled
            className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[var(--text-disabled)] cursor-not-allowed"
            title="Función próximamente disponible"
          >
            <User className="h-4 w-4 text-[var(--text-disabled)]" />
            Asignar agente
          </DropdownMenuItem>
          <DropdownMenuItem disabled className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[var(--text-disabled)] cursor-not-allowed" title="Función próximamente disponible">
            <Star className="h-4 w-4 text-[var(--text-disabled)]" />
            Añadir a favoritos
          </DropdownMenuItem>
          <DropdownMenuItem disabled className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[var(--text-disabled)] cursor-not-allowed" title="Función próximamente disponible">
            <ListFilter className="h-4 w-4 text-[var(--text-disabled)]" />
            Añadir a lista
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-1 bg-[var(--separator)]" />
          <DropdownMenuItem disabled className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[var(--text-disabled)] cursor-not-allowed" title="Función próximamente disponible">
            <Lock className="h-4 w-4 text-[var(--text-disabled)]" />
            Ver contacto
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function InboxClient({ conversationsUrl, basePath }: { conversationsUrl: string; basePath: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { toast } = useToast();
  const activeId = params.get("c");
  // Derive tenantId from the explicit tenant-scoped basePath (/t/:tenantId/conversations).
  const tenantId = basePath.startsWith("/t/") ? basePath.split("/")[2] : "";
  const [search, setSearch] = useState("");
  const [showAiAssistant, setShowAiAssistant] = useState(false);

  // Close the AI Assistant panel on Escape (works for both the inline
  // desktop column and the tablet/mobile overlay drawer).
  useEffect(() => {
    if (!showAiAssistant) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowAiAssistant(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showAiAssistant]);

  // WA-ERA4-05: per-tenant sync helpers. Reset on tenant switch so
  // seen ids and high-water marks from a previous tenant never leak.
  const seenRef = useRef(new SeenSet());
  const orderingRef = useRef(new OrderingGuard());
  const listTokenRef = useRef(new RequestToken());
  const prevTenantRef = useRef(tenantId);
  useEffect(() => {
    if (prevTenantRef.current === tenantId) return;
    seenRef.current.reset();
    orderingRef.current.reset();
    // Drop cached entries for the previous tenant. We do NOT call
    // cancelQueries here: that would reject the in-flight query's
    // promise with a CancelledError, marking the query as failed and
    // triggering TanStack Query's automatic retry. The queryFn's
    // RequestToken guard handles the in-flight response safely
    // (returns the previous cache, not an error).
    qc.removeQueries({ queryKey: ["conversations", prevTenantRef.current] });
    qc.removeQueries({ queryKey: ["thread", prevTenantRef.current] });
    prevTenantRef.current = tenantId;
  }, [tenantId, qc]);

  const conversationsQuery = useQuery({
    queryKey: ["conversations", tenantId, search],
    queryFn: async () => {
      const base = conversationsUrl;
      const qs = search ? `search=${encodeURIComponent(search)}` : "";
      const token = listTokenRef.current.next();
      const result = await apiFetch<Conversation[]>(qs ? `${base}?${qs}` : base);
      // Stale response: return the previous cache (or the incoming
      // result if no prior cache). We DO NOT throw — throwing would
      // mark the query as failed and trigger TanStack Query's
      // automatic retry loop.
      if (!listTokenRef.current.isCurrent(token) || prevTenantRef.current !== tenantId) {
        const cached = qc.getQueryData<Conversation[]>(["conversations", tenantId, search]);
        return (cached ?? result) as Conversation[];
      }
      return result;
    },
    refetchInterval: 30_000,
  });
  const conversations = conversationsQuery.data ?? [];

  // Realtime: refresh lists + the open thread on any event for this tenant.
  // WA-ERA4-05: route the event through the sync helpers to dedup
  // duplicates, reject stale timestamps, and decide whether the list
  // or the open thread actually needs a refetch.
  useRealtime(
    tenantId || null,
    (msg) => {
      const verdict = processEvent(
        msg,
        activeId,
        seenRef.current,
        orderingRef.current,
        ["message:new", "message:status", "message:image-enriched", "conversation:updated"],
      );
      if (!verdict.admitted) return;
      const action: SyncAction = verdict.action;
      if (action.kind === "ignore") return;
      if (action.kind === "refetch-list" || action.kind === "refetch-list-and-thread") {
        // Bump the request token so any in-flight response is dropped
        // (the queryFn returns the previous cache rather than throwing).
        // Then trigger a refetch. We do NOT call cancelQueries — that
        // would mark the in-flight query as failed.
        listTokenRef.current.next();
        qc.invalidateQueries({ queryKey: ["conversations", tenantId] });
      }
      if (action.kind === "refetch-thread" || action.kind === "refetch-list-and-thread") {
        qc.invalidateQueries({ queryKey: ["thread", tenantId, action.conversationId] });
      }
    },
    // WA-ERA4-09: on a successful reconnect (NOT the initial open), Redis
    // Pub/Sub has already lost every event we missed — recovery is a
    // canonical HTTP refetch of the conversations list and, if one is
    // open, the active thread. Bumping the request token first ensures
    // any in-flight response from before the disconnect is dropped by the
    // queryFn guard rather than regressing the cache. Tenant-scoped keys
    // make cross-tenant contamination impossible.
    () => {
      listTokenRef.current.next();
      qc.invalidateQueries({ queryKey: ["conversations", tenantId] });
      if (activeId) {
        qc.invalidateQueries({ queryKey: ["thread", tenantId, activeId] });
      }
    },
  );

  function openConversation(id: string) {
    router.push(`${basePath}?c=${id}`);
  }

  // Mutation for context menu actions (mark unread, close/reopen, assign)
  const conversationMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiFetch(`${conversationsUrl}/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations", tenantId] });
      if (activeId) {
        qc.invalidateQueries({ queryKey: ["thread", tenantId, activeId] });
      }
    },
    onError: (e: Error) => toast({ variant: "destructive", title: "Action failed", description: e.message }),
  });

  return (
    <div className="flex h-full min-w-0">
      {/* Conversation list - Scope B: ~340px width */}
      <div className={cn("w-full shrink-0 flex-col border-r md:flex md:w-[340px]", activeId ? "hidden" : "flex", "bg-[var(--conv-canvas)]")}>
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Buscar conversaciones…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto scroll-thin p-2">
          {conversations.length === 0 && (
            <div className="p-6 text-center text-xs text-muted-foreground">Sin conversaciones aún.</div>
          )}
          {conversations.map((c) => (
            <ConversationItem
              key={c.id}
              conversation={c}
              isActive={c.id === activeId}
              onClick={() => openConversation(c.id)}
              onMarkUnread={() => conversationMutation.mutate({ id: c.id, patch: { unreadCount: c.unreadCount > 0 ? 0 : (c.unreadCount || 1) + 1 } })}
              onToggleStatus={() => conversationMutation.mutate({ id: c.id, patch: { status: c.status === "OPEN" ? "CLOSED" : "OPEN" } })}
              onAssign={() => {/* TODO: assign agent UI */}}
              isPending={conversationMutation.isPending && conversationMutation.variables?.id === c.id}
            />
          ))}
        </div>
      </div>

      {/* Thread */}
      <div className={cn("min-w-0 flex-1", activeId ? "block" : "hidden md:block")}>
        {activeId ? <ThreadPane tenantId={tenantId} conversationId={activeId} onBack={() => router.push(basePath)} showAiAssistant={showAiAssistant} onToggleAi={() => setShowAiAssistant(!showAiAssistant)} /> : <EmptyThread onToggleAi={() => setShowAiAssistant(!showAiAssistant)} />}
      </div>
      {/* AI Assistant — inline third column (desktop xl+). Below xl the
          overlay drawer below renders instead, so the chat is never squeezed. */}
      <div className={cn("hidden w-80 shrink-0 flex-col border-l bg-background", showAiAssistant && "xl:flex")}>
        <AiAssistantPanel onClose={() => setShowAiAssistant(false)} />
      </div>
      {/* AI Assistant — overlay drawer (below xl): accessible on tablet/mobile
          without compressing the conversation. Backdrop, close button and
          Escape all dismiss it. */}
      {showAiAssistant && (
        <div className="fixed inset-0 z-50 xl:hidden" role="dialog" aria-modal="true" aria-label="Asistente IA">
          <button
            type="button"
            aria-label="Cerrar asistente IA"
            className="absolute inset-0 h-full w-full cursor-default bg-black/40"
            onClick={() => setShowAiAssistant(false)}
          />
          <div className="absolute inset-y-0 right-0 flex w-full max-w-80 flex-col border-l bg-background shadow-lg">
            <AiAssistantPanel onClose={() => setShowAiAssistant(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

function AiAssistantPanel({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div className="flex min-h-12 shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">Asistente IA</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label="Cerrar asistente IA"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
        <Bot className="mb-3 h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          Próximamente podrás consultar información<br />relacionada con esta conversación.
        </p>
      </div>
    </>
  );
}

function EmptyThread({ onToggleAi }: { onToggleAi: () => void }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center text-muted-foreground">
      <MessageSquare className="mb-2 h-10 w-10 opacity-30" />
      <p className="text-sm">Select a conversation to start chatting.</p>
      <Button
        variant="ghost"
        size="icon"
        className="absolute bottom-4 right-4 h-10 w-10 rounded-full shadow-md"
        onClick={onToggleAi}
        aria-label="Abrir asistente IA"
      >
        <Bot className="h-5 w-5" />
      </Button>
    </div>
  );
}

function ThreadPane({ tenantId, conversationId, onBack, showAiAssistant, onToggleAi }: { tenantId: string; conversationId: string; onBack: () => void; showAiAssistant: boolean; onToggleAi: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [showFlows, setShowFlows] = useState(false);
  const [previewImage, setPreviewImage] = useState<{ url: string; alt: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // ponytail: throttle typing pings to the server. The server's Meta client
  // already enforces TYPING_MIN_INTERVAL_MS, but we cap the request rate
  // here to keep the network and auth hook quiet.
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef<number>(0);
  function sendTypingPing(draft: string) {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    const now = Date.now();
    const since = now - lastTypingSentRef.current;
    const wait = since >= 2000 ? 0 : 2000 - since;
    typingTimerRef.current = setTimeout(() => {
      lastTypingSentRef.current = Date.now();
      void apiFetch(`/api/tenants/${tenantId}/conversations/${conversationId}/typing`, {
        method: "POST",
        body: JSON.stringify({ draft }),
      }).catch(() => {
        // ponytail: best-effort; never let typing pings surface a toast
      });
    }, wait);
  }
  // WA-ERA4-05: per-thread token guard for stale HTTP responses. The
  // query below returns the previously-cached thread when the active
  // tenant+conversation has moved on by the time the response arrives.
  // We DO NOT throw — throwing would mark the query as failed and
  // trigger TanStack Query's automatic retry loop. Returning the
  // previous data keeps the visible window stable.
  const threadTokenRef = useRef(new RequestToken());
  const qc2 = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["thread", tenantId, conversationId],
    queryFn: async () => {
      const token = threadTokenRef.current.next();
      const result = await apiFetch<Thread>(
        `/api/tenants/${tenantId}/conversations/${conversationId}/messages`,
      );
      if (!threadTokenRef.current.isCurrent(token)) {
        // Return the current cached value, or the incoming result if
        // there is no prior cache. Either way, no error is raised.
        const cached = qc2.getQueryData<Thread>(["thread", tenantId, conversationId]);
        return (cached ?? result) as Thread;
      }
      return result;
    },
  });

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [data?.messages.length]);

  // Opening a thread marks it read server-side; refresh the list to clear the badge.
  // WA-ERA4-07: gate the list invalidation on the thread data being
  // loaded, so the refetch runs AFTER the server-side mark-read has
  // committed. This avoids a race where the list is refetched before
  // the unreadCount is reset to 0 in the database, which would leave
  // the visible badge stale until the next poll.
  useEffect(() => {
    if (data && Array.isArray(data.messages)) {
      qc.invalidateQueries({ queryKey: ["conversations", tenantId] });
    }
  }, [data, tenantId, qc]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["thread", tenantId, conversationId] });
    qc.invalidateQueries({ queryKey: ["conversations", tenantId] });
  };

  const sendText = useMutation({
    mutationFn: (t: string) =>
      apiFetch(`/api/tenants/${tenantId}/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ kind: "text", text: t }) }),
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
      return fetch(`/api/tenants/${tenantId}/conversations/${conversationId}/messages`, { method: "POST", body: fd }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error || "Upload failed");
      });
    },
    onSuccess: invalidate,
    onError: (e: Error) => toast({ variant: "destructive", title: "Not sent", description: e.message }),
  });

  const sendTemplate = useMutation({
    mutationFn: (input: { templateId: string; bodyVariables?: string[] | Record<string, string> }) =>
      apiFetch(`/api/tenants/${tenantId}/conversations/${conversationId}/messages`, {
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
    mutationFn: (flowId: string) => apiFetch(`/api/tenants/${tenantId}/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ kind: "flow", flowId, cta: "Open form" }) }),
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
        <div className="ml-auto flex items-center gap-2">
          <Badge variant={windowOpen ? "success" : "warning"} className="hidden sm:inline-flex">{windowInfo?.label}</Badge>
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-8 w-8", showAiAssistant && "bg-accent")}
            onClick={onToggleAi}
            aria-label={showAiAssistant ? "Cerrar asistente IA" : "Abrir asistente IA"}
          >
            <Bot className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="wa-wallpaper min-h-0 flex-1 space-y-1.5 overflow-auto p-2 scroll-thin sm:p-4">
        {data.messages.map((m) => <div key={m.id}><MessageBubble m={m} onPreviewImage={setPreviewImage} />{data.flowSubmissions.filter((submission) => submission.waMessageId === m.waMessageId).map((submission) => <FlowSubmissionCard key={submission.id} submission={submission} />)}</div>)}
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
              onChange={(e) => {
                const v = e.target.value;
                setText(v);
                if (v.trim()) sendTypingPing(v);
              }}
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
      <Dialog open={!!previewImage} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <DialogContent className="max-w-5xl border-0 bg-transparent p-0 shadow-none">
          <DialogHeader className="sr-only"><DialogTitle>{previewImage?.alt || "Image preview"}</DialogTitle></DialogHeader>
          {previewImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewImage.url} alt={previewImage.alt} className="max-h-[85vh] w-full rounded-lg object-contain" />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FlowSubmissionCard({ submission }: { submission: FlowSubmission }) {
  return <div className="ml-2 mt-1 max-w-md rounded-lg border border-emerald-200 bg-white p-3 text-zinc-900 shadow-xs dark:border-emerald-900 dark:bg-[#202c33] dark:text-zinc-50"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-400"><Workflow className="h-4 w-4" /> {submission.flow.name} submitted</div>{submission.response ? <div className="space-y-1">{Object.entries(submission.response).map(([key, value]) => <div key={key} className="grid grid-cols-1 gap-0.5 text-xs min-[430px]:grid-cols-[110px_1fr] min-[430px]:gap-2"><span className="font-medium">{key}</span><span className="wrap-break-word text-muted-foreground">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span></div>)}</div> : <div className="text-xs text-muted-foreground">Response data has been purged.</div>}</div>;
}

function MessageBubble({ m, onPreviewImage }: { m: Msg; onPreviewImage: (image: { url: string; alt: string }) => void }) {
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
          {m.type === "LOCATION" && m.location ? <LocationContent m={m} /> : null}
          {m.hasMedia && <MediaContent m={m} onPreviewImage={onPreviewImage} />}
          {m.type !== "LOCATION" && m.text && <div className="whitespace-pre-wrap wrap-break-word">{m.text}</div>}
          {m.caption && <div className="whitespace-pre-wrap wrap-break-word">{m.caption}</div>}
        </>}
        <div className={cn("mt-0.5 flex items-center justify-end gap-1 text-[10px] [&>svg]:shrink-0", out ? "text-zinc-600 dark:text-zinc-300" : "text-muted-foreground")}>
          <span className="min-w-0 text-right">{formatInboxTimestamp(m.timestamp)}</span>
          {out && <StatusTick status={m.status} errorJson={m.errorJson} />}
        </div>
      </div>
    </div>
  );
}

function LocationContent({ m }: { m: Msg }) {
  if (!m.location) return null;
  const { latitude, longitude, name, address } = m.location;
  const q = encodeURIComponent(`${latitude},${longitude}`);
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${q}`;
  const staticUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${latitude},${longitude}&zoom=16&size=420x220&markers=${latitude},${longitude},red-pushpin`;
  return (
    <a href={mapUrl} target="_blank" rel="noreferrer" className="mb-1 block overflow-hidden rounded-md border bg-muted/40 no-underline">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={staticUrl} alt={name ?? "Location"} className="h-40 w-full object-cover" />
      <div className="space-y-0.5 p-2">
        <div className="font-medium text-inherit">{name ?? "Location"}</div>
        {address && <div className="text-xs text-muted-foreground">{address}</div>}
        <div className="text-xs text-muted-foreground">{latitude.toFixed(6)}, {longitude.toFixed(6)}</div>
      </div>
    </a>
  );
}

function MediaContent({ m, onPreviewImage }: { m: Msg; onPreviewImage: (image: { url: string; alt: string }) => void }) {
  const url = `/api/media/${m.id}`;
  const mime = m.mediaMime || "";
  if (mime.startsWith("image/")) {
    const alt = m.mediaFilename || m.caption || "Image";
    return (
      <button type="button" className="mb-1 block cursor-zoom-in overflow-hidden rounded-sm p-0" onClick={() => onPreviewImage({ url, alt })}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={alt} className="max-h-64 rounded-sm" />
      </button>
    );
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

function StatusTick({ status, errorJson }: { status: string; errorJson?: { uncertain?: boolean } | null }) {
  // UNCERTAIN (Meta accepted but response was timeout/5xx/parse) must
  // be visually distinct from PENDING. The worker keeps status=PENDING and stamps
  // errorJson.uncertain=true, so the client must look at errorJson to render it.
  if (status === "PENDING" && errorJson?.uncertain) {
    return <AlertCircle className="h-3 w-3 text-amber-500" />;
  }
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
