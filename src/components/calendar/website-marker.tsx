import { EyeOff, Globe } from "lucide-react";
import { cn } from "@/lib/cn";
import type { PublicEventStatus } from "@/lib/public-events";

/**
 * Whether a calendar event is on the team website's Events page: "On the team website" (a meet, the ILT, a scrimmage,
 * a competition, or outreach), "Hidden from the team website" (one of those with the box ticked), or nothing (other
 * kinds, the Events page turned off, or before the season it starts at). `publicEventStatus` decides.
 */
export function TeamWebsiteMarker({ status, className }: { status: PublicEventStatus; className?: string }) {
  if (!status) return null;
  const hidden = status === "hidden";
  const Icon = hidden ? EyeOff : Globe;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        hidden ? "bg-ink-50 text-ink-600 ring-ink-200" : "bg-white text-brand-800 ring-brand-200",
        className,
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {hidden ? "Hidden from the team website" : "On the team website"}
    </span>
  );
}
