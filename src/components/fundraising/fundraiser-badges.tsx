import { Globe, HandCoins, type LucideIcon, PartyPopper, ShoppingBag } from "lucide-react";
import type { FundraiserKind, FundraiserStatus } from "@/generated/prisma/enums";
import { cn } from "@/lib/cn";
import { FUNDRAISER_KIND_LABELS, FUNDRAISER_STATUS_LABELS } from "@/lib/constants";
import { formatDollars } from "@/lib/money";
import { goalPercent } from "@/lib/fundraising";
import { Badge, type BadgeTone } from "../ui/badge";

export const FUNDRAISER_KIND_ICONS: Record<FundraiserKind, LucideIcon> = {
  EVENT: PartyPopper,
  SALE: ShoppingBag,
  ONLINE: Globe,
  OTHER: HandCoins,
};

/** Examples shown under each kind in the form. */
export const FUNDRAISER_KIND_HINTS: Record<FundraiserKind, string> = {
  EVENT: "Car wash, restaurant night",
  SALE: "Bake sale, merch, candy grams",
  ONLINE: "Donation page, crowdfunding",
  OTHER: "Anything else",
};

const statusTone: Record<FundraiserStatus, BadgeTone> = {
  PLANNING: "gray",
  UPCOMING: "blue",
  ACTIVE: "brand",
  DONE: "green",
  CANCELLED: "red",
};

/**
 * The status, or "Dates passed" for one still marked Planning / Upcoming / Happening now after its last day
 * (so the badge doesn't say "Upcoming" next to "sign-ups are closed").
 */
export function FundraiserStatusBadge({ status, datesPassed = false }: { status: FundraiserStatus; datesPassed?: boolean }) {
  if (datesPassed) return <Badge tone="yellow">Dates passed</Badge>;
  return <Badge tone={statusTone[status]}>{FUNDRAISER_STATUS_LABELS[status]}</Badge>;
}

export function FundraiserKindBadge({ kind }: { kind: FundraiserKind }) {
  const Icon = FUNDRAISER_KIND_ICONS[kind];
  return (
    <Badge tone="gray">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {FUNDRAISER_KIND_LABELS[kind]}
    </Badge>
  );
}

/** The kind's icon in a square (cards and the detail page). Decorative: the kind badge says it in words. */
export function FundraiserKindMark({ kind, done = false }: { kind: FundraiserKind; done?: boolean }) {
  const Icon = FUNDRAISER_KIND_ICONS[kind];
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-11 shrink-0 items-center justify-center rounded-lg",
        done ? "bg-ink-100 text-ink-500" : "bg-brand-50 text-brand-700",
      )}
    >
      <Icon className="size-5" />
    </span>
  );
}

/**
 * Money raised against a goal. The bar fills up to the goal (green once it's reached); screen readers get
 * "$350 of $500 (70%)".
 */
export function FundsBar({
  raised,
  goal,
  label,
  size = "md",
  className,
}: {
  raised: number;
  goal: number;
  label: string;
  size?: "md" | "lg";
  className?: string;
}) {
  const width = goal > 0 ? Math.min(100, (raised / goal) * 100) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={goal}
      aria-valuenow={Math.min(raised, goal)}
      aria-valuetext={`${formatDollars(raised)} of ${formatDollars(goal)} (${goalPercent(raised, goal)}%)`}
      className={cn("overflow-hidden rounded-full bg-ink-100", size === "lg" ? "h-4" : "h-2", className)}
    >
      <div className={cn("h-full rounded-full", raised >= goal ? "bg-emerald-500" : "bg-brand-500")} style={{ width: `${width}%` }} />
    </div>
  );
}
