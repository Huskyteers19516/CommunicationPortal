import type { SponsorshipStage } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { SPONSORSHIP_STAGE_LABELS } from "@/lib/constants";

/**
 * Stage colors, like the colored dropdown in the Business team's sheet: Haven't started gray, Do soon
 * amber, Needs work orange, Submitted sky, Accepted green, Declined red, Finished brand green.
 */
export const STAGE_STYLES: Record<SponsorshipStage, { badge: string; control: string }> = {
  NOT_STARTED: { badge: "bg-ink-100 text-ink-700 ring-ink-200", control: "border-ink-200 bg-ink-50 text-ink-800" },
  DO_SOON: { badge: "bg-amber-50 text-amber-800 ring-amber-200", control: "border-amber-300 bg-amber-50 text-amber-900" },
  IN_PROGRESS: { badge: "bg-orange-50 text-orange-800 ring-orange-200", control: "border-orange-300 bg-orange-50 text-orange-900" },
  SUBMITTED: { badge: "bg-sky-50 text-sky-700 ring-sky-200", control: "border-sky-300 bg-sky-50 text-sky-900" },
  ACCEPTED: { badge: "bg-emerald-50 text-emerald-700 ring-emerald-200", control: "border-emerald-300 bg-emerald-50 text-emerald-900" },
  DECLINED: { badge: "bg-red-50 text-red-700 ring-red-200", control: "border-red-300 bg-red-50 text-red-900" },
  FINISHED: { badge: "bg-brand-50 text-brand-700 ring-brand-200", control: "border-brand-300 bg-brand-50 text-brand-900" },
};

export function StageBadge({ stage, className }: { stage: SponsorshipStage; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        STAGE_STYLES[stage].badge,
        className,
      )}
    >
      {SPONSORSHIP_STAGE_LABELS[stage]}
    </span>
  );
}
