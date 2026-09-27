import { CalendarDays, MapPin, Pencil } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DateOnly } from "@/lib/dates";
import { fundraiserDatesLabel, goalPercent, helpersLine } from "@/lib/fundraising";
import { formatDollars } from "@/lib/money";
import type { FundraiserItem } from "@/server/queries/fundraising";
import { Badge } from "../ui/badge";
import { ButtonLink } from "../ui/button";
import { FundraiserKindBadge, FundraiserKindMark, FundraiserStatusBadge, FundsBar } from "./fundraiser-badges";
import { HelperChips } from "./helper-chips";
import { VolunteerButtons } from "./volunteer-buttons";

/** Money line: bar + "$350 of $500 · 70%" with a goal, "$350 raised" without one, nothing before any money or goal. */
export function FundraiserMoney({ fundraiser: f, className }: { fundraiser: Pick<FundraiserItem, "name" | "raisedAmount" | "goalAmount">; className?: string }) {
  if (f.goalAmount) {
    return (
      <div className={className}>
        <p className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <span className="font-semibold tabular-nums text-ink-900">
            {formatDollars(f.raisedAmount)} <span className="font-normal text-ink-500">of {formatDollars(f.goalAmount)}</span>
          </span>
          <span className="text-xs font-medium tabular-nums text-ink-600">
            {f.raisedAmount >= f.goalAmount ? "Goal reached!" : `${goalPercent(f.raisedAmount, f.goalAmount)}%`}
          </span>
        </p>
        <FundsBar raised={f.raisedAmount} goal={f.goalAmount} label={`Raised for ${f.name}`} />
      </div>
    );
  }
  if (f.raisedAmount > 0) {
    return (
      <p className={cn("text-sm font-semibold tabular-nums text-ink-900", className)}>
        {formatDollars(f.raisedAmount)} <span className="font-normal text-ink-500">raised</span>
      </p>
    );
  }
  return null;
}

/** One fundraiser on /fundraising: what, when, where, money, who's leading and helping, and "I'll help". */
export function FundraiserCard({ fundraiser: f, today }: { fundraiser: FundraiserItem; today: DateOnly }) {
  const headingId = `fundraiser-${f.id}-name`;
  const dates = fundraiserDatesLabel(f, today);
  const finished = f.status === "DONE" || f.status === "CANCELLED";

  return (
    <article
      id={`fundraiser-${f.id}`}
      aria-labelledby={headingId}
      className={cn(
        "min-w-0 scroll-mt-24 rounded-xl border bg-white p-3 shadow-sm sm:p-4",
        f.isVolunteer && !finished ? "border-brand-300" : "border-ink-200",
      )}
    >
      <div className="flex items-start gap-3">
        <FundraiserKindMark kind={f.kind} done={finished} />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="text-base font-semibold leading-snug text-ink-900">
            {/* Padded out to a ≥ 40px tap target (22px line + 2 × 10px) without moving the text. */}
            <Link
              href={`/fundraising/${f.id}`}
              className="-my-2.5 block rounded py-2.5 underline-offset-2 wrap-anywhere hover:text-brand-800 hover:underline"
            >
              {f.name}
            </Link>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <FundraiserStatusBadge status={f.status} datesPassed={f.datesPassed} />
            <FundraiserKindBadge kind={f.kind} />
            {f.isVolunteer && !finished && <Badge tone="brand">You&apos;re helping</Badge>}
            {f.isLead && !finished && <Badge tone="purple">You&apos;re leading</Badge>}
          </div>
          {(dates || f.location) && (
            <div className="mt-2 space-y-1 text-sm text-ink-700">
              {dates && (
                <p className="flex items-start gap-1.5">
                  <CalendarDays className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
                  <span className="sr-only">When: </span>
                  <span className="min-w-0">{dates}</span>
                </p>
              )}
              {f.location && (
                <p className="flex items-start gap-1.5">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-ink-500" aria-hidden />
                  <span className="sr-only">Where: </span>
                  <span className="min-w-0 wrap-anywhere">{f.location}</span>
                </p>
              )}
            </div>
          )}
          {f.lead && <p className="mt-1.5 text-xs text-ink-500 wrap-anywhere">Led by {f.isLead ? "you" : f.lead.name}</p>}
        </div>
      </div>

      <FundraiserMoney fundraiser={f} className="mt-3" />

      <div className="mt-3 border-t border-ink-100 pt-3">
        <p className="text-xs font-medium text-ink-700">{helpersLine(f)}</p>
        <HelperChips
          helpers={f.volunteers}
          fundraiserId={f.id}
          className="mt-2"
          emptyText={f.closedReason ? "" : f.canVolunteer ? "Be the first to help." : ""}
        />
        {/* Its last day passed before anyone marked it done: say so, and point the Business team at the fix. */}
        {f.datesPassed && (
          <>
            <p className="mt-2 text-xs text-ink-500">
              Its dates have passed, so sign-ups are closed.{f.canManage && " Mark it Done once the money is in."}
            </p>
            {f.canManage && (
              <ButtonLink
                href={`/fundraising/${f.id}?edit=1#status`}
                variant="secondary"
                className="mt-3"
                aria-label={`Update status of ${f.name}`}
              >
                <Pencil className="size-4" aria-hidden />
                Update status
              </ButtonLink>
            )}
          </>
        )}
        <VolunteerButtons fundraiser={f} className="mt-3" />
      </div>
    </article>
  );
}
