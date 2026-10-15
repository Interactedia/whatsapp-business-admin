"use client";

import { cn } from "@/lib/utils";

/**
 * WA-UI-016: Automation Status Indicators
 *
 * Compact visual indicators showing Copilot/Human and Follow-up status.
 *
 * IMPORTANT: These indicators are purely informational.
 * No state source exists yet (ADR-0009 §11: deferred).
 * We render empty indicators zone - no invented states.
 *
 * When backend is connected, the conversation type will include
 * copilotEnabled and followUpEnabled fields.
 */

interface AutomationIndicatorsProps {
  /** Will be populated when backend contracts exist */
  copilotEnabled?: boolean | null;
  followUpEnabled?: boolean | null;
  className?: string;
}

export function AutomationIndicators({ className }: AutomationIndicatorsProps) {
  // WA-UI-016 §C: No invented states until backend contracts exist.
  // The indicator zone renders but shows nothing until a real state source is available.
  // When connected, render: <CopilotIndicator enabled={copilotEnabled} /> <FollowUpIndicator enabled={followUpEnabled} />

  return (
    <div
      className={cn("flex items-center gap-1", className)}
      role="status"
      aria-label="Indicadores de automatización"
    >
      {/* Empty zone - states will be connected when ADR-0009 §11 is implemented */}
    </div>
  );
}
