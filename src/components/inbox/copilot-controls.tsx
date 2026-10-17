"use client";

import { Bot, Clock, Info } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useI18n } from "@/components/i18n/language-provider";

/**
 * WA-UI-015: Copilot, Handoff & Follow-up controls
 *
 * These controls are visual only — no backend contracts exist yet.
 * All switches are disabled with clear "Disponible próximamente" messaging.
 *
 * Following ADR-0009 guidance:
 * - D5: Controls in conversation header
 * - No Prisma changes
 * - UI is simulation-approved but execution is deferred
 */

// Compact label for controls
function ControlLabel({
  icon: Icon,
  label,
  disabled,
}: {
  icon: React.ElementType;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-1.5", disabled && "opacity-50")}>
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

// Disabled switch with tooltip explanation
function DisabledSwitchControl({
  label,
  sublabel,
}: {
  label: string;
  sublabel: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <Switch disabled />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <span className="pl-[52px] text-[10px] text-muted-foreground/70">
        {sublabel}
      </span>
    </div>
  );
}

/**
 * CopilotControls: Compact control panel for Copilot ON/OFF and Follow-up ON/OFF.
 * Appears in the conversation header when a conversation is selected.
 *
 * Desktop: Inline with header controls
 * Tablet/Mobile: Compact row below contact info
 */
export function CopilotControls() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-2 sm:gap-3">
      {/* Switch row - responsive: inline on desktop, compact on mobile */}
      <div className="flex flex-wrap items-center gap-3 sm:gap-4">
        {/* Copilot switch */}
        <div className="flex items-center gap-2">
          <ControlLabel icon={Bot} label={t("inbox.copilot")} />
          <DisabledSwitchControl
            label={t("inbox.on")}
            sublabel={t("inbox.availableSoon")}
          />
        </div>

        {/* Follow-up switch */}
        <div className="flex items-center gap-2">
          <ControlLabel icon={Clock} label={t("inbox.followUp")} />
          <DisabledSwitchControl
            label={t("inbox.on")}
            sublabel={t("inbox.availableSoon")}
          />
        </div>
      </div>

      {/* Handoff status zone */}
      <HandoffStatus />
    </div>
  );
}

/**
 * HandoffStatus: Informational zone showing current attention mode.
 *
 * States (informational only, no real data yet):
 * - "Control de atención no configurado"
 *
 * Following ADR-0009 D5 guidance - informational only, no simulated state.
 */
export function HandoffStatus() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-muted-foreground/20 bg-muted/30 px-3 py-2">
      <Info className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">
        {t("inbox.attentionControlNotConfigured")}
      </span>
    </div>
  );
}
