"use client";

import { useState } from "react";
import { Bot, UserRound, Clock, X, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * WA-UI-016: Status Filter Dropdown
 *
 * Compact dropdown filter for Copilot/Human and Follow-up status.
 *
 * IMPORTANT: These filters are informational only.
 * No backend state source exists yet (ADR-0009 §11: deferred).
 * Options are disabled with accessible explanation.
 *
 * Scope B requirements:
 * - Located next to existing filters
 * - Compact, non-saturating
 * - Combines with existing filters (main filter, search)
 * - Accessible menu
 * - Active filter indication
 * - Clear filters option
 * - Appropriate empty state
 * - No horizontal overflow
 */

export type AttentionFilter = "all" | "copilot" | "human";
export type FollowUpFilter = "all" | "with" | "without";

export interface StatusFilterState {
  attention: AttentionFilter;
  followUp: FollowUpFilter;
}

interface StatusFilterProps {
  value: StatusFilterState;
  onChange: (value: StatusFilterState) => void;
}

const ATTENTION_OPTIONS: { value: AttentionFilter; label: string; icon: React.ReactNode; disabled: boolean; disabledReason?: string }[] = [
  {
    value: "all",
    label: "Todos",
    icon: null,
    disabled: false,
  },
  {
    value: "copilot",
    label: "Copilot",
    icon: <Bot className="h-3.5 w-3.5 text-teal-600" />,
    disabled: true,
    disabledReason: "Disponible cuando se habilite el control de automatización",
  },
  {
    value: "human",
    label: "Humano",
    icon: <UserRound className="h-3.5 w-3.5 text-slate-500" />,
    disabled: true,
    disabledReason: "Disponible cuando se habilite el control de automatización",
  },
];

const FOLLOWUP_OPTIONS: { value: FollowUpFilter; label: string; icon: React.ReactNode; disabled: boolean; disabledReason?: string }[] = [
  {
    value: "all",
    label: "Todos",
    icon: null,
    disabled: false,
  },
  {
    value: "with",
    label: "Con seguimiento",
    icon: <Clock className="h-3.5 w-3.5 text-amber-600" />,
    disabled: true,
    disabledReason: "Disponible cuando se habilite el control de automatización",
  },
  {
    value: "without",
    label: "Sin seguimiento",
    icon: null,
    disabled: true,
    disabledReason: "Disponible cuando se habilite el control de automatización",
  },
];

export function StatusFilter({ value, onChange }: StatusFilterProps) {
  const [open, setOpen] = useState(false);

  const hasActiveFilters = value.attention !== "all" || value.followUp !== "all";

  const toggleAttention = (newValue: AttentionFilter) => {
    if (newValue === value.attention) {
      onChange({ ...value, attention: "all" });
    } else {
      onChange({ ...value, attention: newValue });
    }
  };

  const toggleFollowUp = (newValue: FollowUpFilter) => {
    if (newValue === value.followUp) {
      onChange({ ...value, followUp: "all" });
    } else {
      onChange({ ...value, followUp: newValue });
    }
  };

  const clearFilters = () => {
    onChange({ attention: "all", followUp: "all" });
  };

  const getActiveFiltersCount = () => {
    let count = 0;
    if (value.attention !== "all") count++;
    if (value.followUp !== "all") count++;
    return count;
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-7 gap-1.5 px-2 text-xs",
            hasActiveFilters && "border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300"
          )}
          aria-label="Filtrar por estado"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>Estado</span>
          {hasActiveFilters && (
            <span className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-teal-500 text-[10px] font-semibold text-white">
              {getActiveFiltersCount()}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-56"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        {/* Attention section */}
        <div className="px-2 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Atención
          </span>
        </div>
        {ATTENTION_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            disabled={option.disabled}
            onSelect={(e) => {
              e.preventDefault();
              if (!option.disabled) {
                toggleAttention(option.value);
              }
            }}
            className={cn(
              "flex items-center gap-2 py-2",
              value.attention === option.value && !option.disabled && "bg-teal-50 dark:bg-teal-900/30",
              option.disabled && "opacity-60"
            )}
            aria-disabled={option.disabled}
            title={option.disabled ? option.disabledReason : undefined}
          >
            {option.icon}
            <span className="flex-1">{option.label}</span>
            {option.disabled && (
              <span className="text-[10px] text-muted-foreground/70">Pronto</span>
            )}
            {value.attention === option.value && !option.disabled && (
              <span className="ml-auto text-teal-600">✓</span>
            )}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        {/* Follow-up section */}
        <div className="px-2 py-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Seguimiento
          </span>
        </div>
        {FOLLOWUP_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.value}
            disabled={option.disabled}
            onSelect={(e) => {
              e.preventDefault();
              if (!option.disabled) {
                toggleFollowUp(option.value);
              }
            }}
            className={cn(
              "flex items-center gap-2 py-2",
              value.followUp === option.value && !option.disabled && "bg-teal-50 dark:bg-teal-900/30",
              option.disabled && "opacity-60"
            )}
            aria-disabled={option.disabled}
            title={option.disabled ? option.disabledReason : undefined}
          >
            {option.icon}
            <span className="flex-1">{option.label}</span>
            {option.disabled && (
              <span className="text-[10px] text-muted-foreground/70">Pronto</span>
            )}
            {value.followUp === option.value && !option.disabled && (
              <span className="ml-auto text-teal-600">✓</span>
            )}
          </DropdownMenuItem>
        ))}

        {hasActiveFilters && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                clearFilters();
              }}
              className="text-destructive focus:text-destructive"
            >
              <X className="mr-2 h-3.5 w-3.5" />
              Limpiar filtros
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
