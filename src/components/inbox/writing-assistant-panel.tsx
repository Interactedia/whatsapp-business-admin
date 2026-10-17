"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X, Check, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n/language-provider";

/**
 * Writing Assistant Modes (Feature C)
 * Prepared for future LLM integration - no prompts implemented yet.
 */
export type WritingMode = "spelling" | "writing" | "professional" | "brief";

export const WRITING_MODES: { id: WritingMode; labelKey: string; descriptionKey: string }[] = [
  { id: "spelling", labelKey: "inbox.mode.spelling", descriptionKey: "inbox.mode.spellingDesc" },
  { id: "writing", labelKey: "inbox.mode.writing", descriptionKey: "inbox.mode.writingDesc" },
  { id: "professional", labelKey: "inbox.mode.professional", descriptionKey: "inbox.mode.professionalDesc" },
  { id: "brief", labelKey: "inbox.mode.brief", descriptionKey: "inbox.mode.briefDesc" },
];

// Demo suggestion text - clearly marked as DEMO per WA-UI-018 Feature D
const DEMO_SUGGESTION = {
  original: "hola como estas? quiero saber si tienen el producto disponible",
  suggested: "Estimado/a,\n\nEspero que se encuentre bien. Le escribo para consultar si el producto se encuentra disponible.\n\nQuedo atento/a a su respuesta.",
  mode: "professional" as WritingMode,
};

interface WritingAssistantPanelProps {
  /** Whether the panel is visible */
  open: boolean;
  /** The original text to improve */
  originalText: string;
  /** Current writing mode */
  mode: WritingMode;
  /** Callback to change mode */
  onModeChange: (mode: WritingMode) => void;
  /** Callback to close the panel */
  onClose: () => void;
  /** Callback when user accepts the suggestion */
  onAccept: (suggestedText: string) => void;
  /** Callback when user discards */
  onDiscard: () => void;
}

/**
 * Writing Assistant Panel Component
 *
 * Displays a preview of text improvement suggestions.
 * For WA-UI-018, this is a pure UI implementation with demo data.
 * Real LLM integration will be implemented separately.
 *
 * Features:
 * - Shows original text and suggested improvement
 * - Editable suggestion field
 * - Mode selector (spelling, writing, professional, brief)
 * - Accept/Discard actions
 * - Demo clearly identified
 *
 * Accessibility:
 * - Full keyboard navigation
 * - Escape to close
 * - Focus management
 * - ARIA labels
 */
export function WritingAssistantPanel({
  open,
  originalText,
  mode,
  onModeChange,
  onClose,
  onAccept,
  onDiscard,
}: WritingAssistantPanelProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const suggestionRef = useRef<HTMLTextAreaElement>(null);
  const [editedSuggestion, setEditedSuggestion] = useState(DEMO_SUGGESTION.suggested);

  // Reset suggestion when panel opens or mode changes
  useEffect(() => {
    if (open) {
      // In real implementation, this would be the LLM response
      // For demo, we use predefined text
      setEditedSuggestion(DEMO_SUGGESTION.suggested);
    }
  }, [open, mode]);

  // Keyboard handler for the panel
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onClose]
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

  // Focus management
  useEffect(() => {
    if (open) {
      // Focus the suggestion textarea when panel opens
      setTimeout(() => suggestionRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  // Determine which text to show as original
  // WA-UI-018: Always show demo warning because suggestion is always demo (no LLM backend)
  const hasUserText = originalText.trim();
  const displayOriginal = hasUserText ? originalText : DEMO_SUGGESTION.original;
  // isDemoMode: true when showing example/demo content (no user text)
  const isDemoMode = !hasUserText;
  // canApplySuggestion: false until LLM backend is implemented
  const canApplySuggestion = false; // TODO: Enable when LLM backend is implemented

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-lg border bg-popover shadow-lg",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        "w-full sm:max-w-lg sm:mx-auto sm:left-1/2 sm:-translate-x-1/2"
      )}
      role="dialog"
      aria-label={t("inbox.improveWriting")}
      onKeyDown={handleKeyDown}
    >
      {/* WA-UI-018: Prominent DEMO warning banner - always visible */}
      <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <span className="text-xs font-medium text-amber-800">
          {isDemoMode
            ? t("inbox.demoNotProcessedYourText")
            : t("inbox.demoExampleSuggestionNotProcessed")}
        </span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold">{t("inbox.improveWriting")}</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label={t("inbox.closePanel")}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Mode Selector */}
      <div className="border-b px-3 py-2">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("inbox.improvementMode")}>
          {WRITING_MODES.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => onModeChange(m.id)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                mode === m.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
              title={t(m.descriptionKey)}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-h-80 space-y-3 overflow-y-auto p-3">
        {/* Original Text */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {isDemoMode ? t("inbox.originalTextExample") : t("inbox.yourOriginalText")}
          </label>
          <div
            className={cn(
              "rounded-md border p-2",
              isDemoMode
                ? "border-dashed border-amber-200 bg-amber-50/50"
                : "bg-muted/30 border-muted"
            )}
          >
            <p className="whitespace-pre-wrap text-sm">{displayOriginal}</p>
          </div>
          {isDemoMode && (
            <p className="mt-1 text-[10px] text-amber-600">
              {t("inbox.thisIsDemoExample")}
            </p>
          )}
        </div>

        {/* Visual separator */}
        <div className="flex items-center gap-2">
          <div className="h-px flex-1 border-t border-dashed border-muted-foreground/30" />
          <span className="shrink-0 text-[10px] text-muted-foreground">{t("inbox.suggestion")}</span>
          <div className="h-px flex-1 border-t border-dashed border-muted-foreground/30" />
        </div>

        {/* Suggested Text */}
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {isDemoMode ? t("inbox.suggestionExample") : t("inbox.improvedSuggestion")}
          </label>
          <textarea
            ref={suggestionRef}
            value={editedSuggestion}
            onChange={(e) => setEditedSuggestion(e.target.value)}
            className={cn(
              "w-full rounded-md border p-2 text-sm",
              "placeholder:text-muted-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "resize-none min-h-[80px]",
              isDemoMode ? "border-amber-200 bg-amber-50/30" : "bg-background border-input"
            )}
            aria-label={t("inbox.suggestedTextEditable")}
            placeholder={t("inbox.writeSomethingToSeeSuggestions")}
          />
          {isDemoMode && (
            <p className="mt-1 flex items-center gap-1 text-[10px] text-amber-600">
              <AlertTriangle className="h-3 w-3" />
              {t("inbox.demoSuggestionNotApplied")}
            </p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onDiscard();
            onClose();
          }}
          className="text-xs"
        >
          {t("inbox.discard")}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            // Only accept if there's actual user text AND LLM backend exists
            if (canApplySuggestion && hasUserText) {
              onAccept(editedSuggestion);
              onClose();
            }
          }}
          className="text-xs"
          disabled={!editedSuggestion.trim() || !canApplySuggestion}
          title={!canApplySuggestion ? t("inbox.aiBackendNotConnected") : t("inbox.useSuggestion")}
        >
          <Check className="mr-1 h-3 w-3" />
          {t("inbox.useSuggestion")}
        </Button>
      </div>

      {/* Footer hint */}
      <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-[10px] text-muted-foreground">
        <span>
          {isDemoMode
            ? t("inbox.demoModeEscToClose")
            : t("inbox.useArrowsToChangeModeEscToClose")}
        </span>
        {isDemoMode && (
          <span className="text-amber-600">{t("inbox.aiBackendNotConnected")}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Writing Assistant Button (Feature A)
 *
 * Sparkles button to trigger the writing assistant panel.
 * Disabled when the input field is empty.
 */
interface WritingAssistantButtonProps {
  /** Whether the button is disabled (empty input) */
  disabled: boolean;
  /** Whether the panel is currently open */
  active: boolean;
  /** Click handler */
  onClick: () => void;
}

export function WritingAssistantButton({ disabled, active, onClick }: WritingAssistantButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={disabled}
      onClick={onClick}
      title="Mejorar texto"
      aria-label="Mejorar texto del mensaje"
      aria-pressed={active}
      className={cn(
        "transition-colors",
        active && "bg-accent text-accent-foreground"
      )}
    >
      <Sparkles className={cn("h-4 w-4", disabled ? "text-muted-foreground/50" : "")} />
    </Button>
  );
}
