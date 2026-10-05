import { Star } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { WORKSHOP_STATUS_LABELS, type WorkshopStatusValue } from "@/lib/workshop";

const STATUS_TONES: Record<WorkshopStatusValue, BadgeTone> = {
  DRAFT: "gray",
  PENDING: "yellow",
  APPROVED: "green",
  REJECTED: "red",
};

/** Draft / Waiting for approval / On the website / Needs changes. */
export function WorkshopStatusBadge({ status, className }: { status: WorkshopStatusValue; className?: string }) {
  return (
    <Badge tone={STATUS_TONES[status]} className={className}>
      {WORKSHOP_STATUS_LABELS[status]}
    </Badge>
  );
}

const DOT: Record<WorkshopStatusValue, string> = {
  DRAFT: "bg-ink-400",
  PENDING: "bg-amber-500",
  APPROVED: "bg-emerald-500",
  REJECTED: "bg-red-500",
};

const DOT_TEXT: Record<WorkshopStatusValue, string> = {
  DRAFT: "text-ink-600",
  PENDING: "text-amber-800",
  APPROVED: "text-emerald-700",
  REJECTED: "text-red-700",
};

/** The status as a dot and words that wrap (narrow grid cards). */
export function WorkshopStatusLine({ status, className }: { status: WorkshopStatusValue; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs font-medium", DOT_TEXT[status], className)}>
      <span aria-hidden className={cn("mt-1 size-2 shrink-0 rounded-full", DOT[status])} />
      {WORKSHOP_STATUS_LABELS[status]}
    </p>
  );
}

/** "Featured" (shown first on the team website). */
export function FeaturedBadge({ className }: { className?: string }) {
  return (
    <Badge tone="yellow" className={className}>
      <Star className="size-3 fill-current" aria-hidden />
      Featured
    </Badge>
  );
}
