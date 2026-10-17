"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, MessageSquareText, Command } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/components/i18n/language-provider";

/**
 * Quick Reply data structure.
 * In the future, this will come from a tenant-specific API endpoint.
 * Currently populated with clearly-identified demo data.
 */
export type QuickReply = {
  id: string;
  name: string;
  command: string;
  content: string;
};

// ponytail: demo data only — replace with API call when backend exists
const DEMO_QUICK_REPLIES: QuickReply[] = [
  {
    id: "demo-1",
    name: "Saludo",
    command: "/saludo",
    content: "Hola, gracias por comunicarte con nosotros. ¿En qué podemos ayudarte hoy?",
  },
  {
    id: "demo-2",
    name: "Cotización",
    command: "/cotizacion",
    content:
      "Con gusto preparamos tu cotización. Por favor proporciona los detalles del producto o servicio que necesitas.",
  },
  {
    id: "demo-3",
    name: "Horarios",
    command: "/horarios",
    content:
      "Nuestro horario de atención es de lunes a viernes de 9:00 a 18:00 horas. Los fines de semana permanecemos cerrados.",
  },
  {
    id: "demo-4",
    name: "Seguimiento",
    command: "/seguimiento",
    content:
      "Para hacer seguimiento a tu solicitud, por favor proporciona el número de ticket o referencia que te proporcionamos.",
  },
  {
    id: "demo-5",
    name: "Despedida",
    command: "/despedida",
    content:
      "Fue un placer atenderte. Si tienes alguna otra consulta, no dudes en escribirnos. ¡Que tengas un excelente día!",
  },
  {
    id: "demo-6",
    name: "Fuera de horario",
    command: "/fuera-horario",
    content:
      "Gracias por contactarnos. Actualmente nos encontramos fuera de nuestro horario de atención. Te responderemos a la brevedad.",
  },
];

interface QuickReplySelectorProps {
  /** Whether the selector is visible */
  open: boolean;
  /** Callback to close the selector */
  onClose: () => void;
  /** Callback when a quick reply is selected — returns the content to insert */
  onSelect: (content: string) => void;
  /** Search query to pre-filter (e.g., slash command text) */
  initialQuery?: string;
  /** CSS class for the container */
  className?: string;
}

/**
 * Quick Reply Selector Component
 *
 * Provides a searchable list of pre-defined responses that operators can
 * insert into the message composer without sending automatically.
 *
 * Features:
 * - Opens above the composer (dropdown-style)
 * - Real-time search filtering by name, command, or content
 * - Keyboard navigation (ArrowUp/Down, Enter, Escape)
 * - Clear empty state messaging
 * - Demo data clearly marked (replaces with API when backend exists)
 *
 * Accessibility:
 * - Full keyboard navigation
 * - Focus management when opened
 * - ARIA roles and labels
 * - Escape to close
 */
export function QuickReplySelector({
  open,
  onClose,
  onSelect,
  initialQuery = "",
  className,
}: QuickReplySelectorProps) {
  const { t } = useI18n();
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter quick replies based on search query
  const filteredReplies = useMemo(() => {
    if (!searchQuery.trim()) return DEMO_QUICK_REPLIES;

    const query = searchQuery.toLowerCase().replace(/^\//, ""); // Remove leading slash for matching
    return DEMO_QUICK_REPLIES.filter(
      (reply) =>
        reply.name.toLowerCase().includes(query) ||
        reply.command.toLowerCase().includes(query) ||
        reply.content.toLowerCase().includes(query)
    );
  }, [searchQuery]);

  // Reset state when opening/closing
  useEffect(() => {
    if (open) {
      setSearchQuery(initialQuery);
      setFocusedIndex(0);
      // Focus search input after render
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [open, initialQuery]);

  // Reset focused index when filtered results change
  useEffect(() => {
    setFocusedIndex((prev) => Math.min(prev, Math.max(0, filteredReplies.length - 1)));
  }, [filteredReplies.length]);

  // Keyboard navigation handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((prev) => (prev < filteredReplies.length - 1 ? prev + 1 : 0));
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((prev) => (prev > 0 ? prev - 1 : filteredReplies.length - 1));
          break;
        case "Enter":
          e.preventDefault();
          if (filteredReplies.length > 0) {
            const selected = filteredReplies[focusedIndex];
            onSelect(selected.content);
            onClose();
          }
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filteredReplies, focusedIndex, onSelect, onClose]
  );

  // Click outside to close
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute bottom-full left-0 right-0 z-50 mb-2 max-h-80 w-full overflow-hidden rounded-lg border bg-popover shadow-lg",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className
      )}
      role="dialog"
      aria-label={t("inbox.quickReplySelector")}
      onKeyDown={handleKeyDown}
    >
      {/* Header with search */}
      <div className="flex items-center gap-2 border-b p-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          ref={searchInputRef}
          type="text"
          placeholder={t("inbox.searchQuickReplies")}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 flex-1 border-0 bg-transparent p-0 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          aria-label={t("inbox.searchQuickRepliesLabel")}
          aria-controls="quick-reply-list"
          aria-activedescendant={
            filteredReplies.length > 0 ? `quick-reply-item-${filteredReplies[focusedIndex].id}` : undefined
          }
        />
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          DEMO
        </span>
      </div>

      {/* Quick reply list */}
      <div
        id="quick-reply-list"
        role="listbox"
        aria-label={t("inbox.availableQuickReplies")}
        className="max-h-60 overflow-y-auto p-1 scroll-thin"
      >
        {filteredReplies.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            <MessageSquareText className="mx-auto mb-2 h-8 w-8 opacity-50" aria-hidden="true" />
            <p>{t("inbox.noMatchingReplies")}</p>
            <p className="mt-1 text-[10px]">{t("inbox.tryDifferentSearch")}</p>
          </div>
        ) : (
          <ul className="space-y-0.5">
            {filteredReplies.map((reply, index) => (
              <li
                key={reply.id}
                id={`quick-reply-item-${reply.id}`}
                role="option"
                aria-selected={index === focusedIndex}
                className={cn(
                  "group cursor-pointer rounded-md px-3 py-2 transition-colors",
                  "focus-within:bg-accent focus-within:text-accent-foreground",
                  index === focusedIndex
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/50"
                )}
                onClick={() => {
                  onSelect(reply.content);
                  onClose();
                }}
                onMouseEnter={() => setFocusedIndex(index)}
              >
                {/* Reply name and command */}
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{reply.name}</span>
                  <span className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                    <Command className="h-2.5 w-2.5" aria-hidden="true" />
                    {reply.command.replace("/", "")}
                  </span>
                </div>

                {/* Content preview */}
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  &ldquo;{reply.content}&rdquo;
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer hint */}
      <div className="flex items-center justify-between border-t px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>
          <kbd className="rounded bg-muted px-1">↑↓</kbd> {t("inbox.navigateUpDown")}
          <span className="mx-1">·</span>
          <kbd className="rounded bg-muted px-1">↵</kbd> {t("inbox.insertWithEnter")}
          <span className="mx-1">·</span>
          <kbd className="rounded bg-muted px-1">esc</kbd> {t("inbox.closeWithEsc")}
        </span>
      </div>
    </div>
  );
}

/**
 * Hook to manage slash command detection and state
 *
 * Detects when "/" is typed at the start of a command and triggers
 * the quick reply selector. Only activates for slash commands at the
 * beginning of the input or after whitespace.
 */
export function useSlashCommand(
  text: string,
  cursorPosition: number,
  onSlashCommand: (query: string) => void,
  onClose: () => void
) {
  useEffect(() => {
    // Find the start of the current "word" (after last space or from beginning)
    const textBeforeCursor = text.slice(0, cursorPosition);
    const lastSpaceIndex = textBeforeCursor.lastIndexOf(" ");
    const wordStart = lastSpaceIndex === -1 ? 0 : lastSpaceIndex + 1;
    const currentWord = textBeforeCursor.slice(wordStart);

    // Check if current word starts with "/" and is at the start of input or after whitespace
    if (currentWord.startsWith("/") && (wordStart === 0 || textBeforeCursor[wordStart - 1] === " ")) {
      onSlashCommand(currentWord);
    } else {
      // If user typed something that doesn't match slash pattern, close the selector
      if (!currentWord.startsWith("/") && text.includes("/")) {
        // Check if we're still in a slash command context
        const slashIndex = text.indexOf("/");
        const afterSlash = text.slice(slashIndex + 1, cursorPosition);
        if (!afterSlash.includes(" ") && afterSlash.length > 0) {
          // Still typing a slash command
          onSlashCommand("/" + afterSlash);
          return;
        }
      }
      onClose();
    }
  }, [text, cursorPosition, onSlashCommand, onClose]);
}
