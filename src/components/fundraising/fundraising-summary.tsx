import { CalendarClock, HandHeart } from "lucide-react";
import { type DateOnly, formatDateOnly } from "@/lib/dates";
import { goalPercent } from "@/lib/fundraising";
import { formatDollars } from "@/lib/money";
import type { FundraisingSummary } from "@/server/queries/fundraising";
import { Card, CardBody } from "../ui/card";
import { FundsBar } from "./fundraiser-badges";
import { SeasonGoalEditor } from "./season-goal-editor";

/** What the big number measures against, this season (a season start is set) or all-time. */
function heading(targetKind: FundraisingSummary["targetKind"], thisSeason: boolean): string {
  if (targetKind === "season") return "Season goal";
  if (targetKind === "goals") return thisSeason ? "This season's fundraiser goals added up" : "All fundraiser goals added up";
  return thisSeason ? "This season" : "Team total";
}

/**
 * The team's progress at the top of /fundraising: "Raised $X of $Y", a big bar, which fundraisers count
 * (since the season start, or all of them), and what's coming up.
 */
export function FundraisingSummaryCard({
  summary,
  canManage,
  today,
}: {
  summary: FundraisingSummary;
  canManage: boolean;
  today: DateOnly;
}) {
  const { raised, target, targetKind, seasonStart, upcomingCount, helpingCount } = summary;
  const reached = target !== null && raised >= target;
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-ink-500">{heading(targetKind, seasonStart !== null)}</h2>
            <p className="font-display text-3xl font-semibold tabular-nums text-ink-900 sm:text-4xl">
              Raised {formatDollars(raised)}
              {target !== null && <span className="text-ink-500"> of {formatDollars(target)}</span>}
            </p>
          </div>
          {target !== null && (
            <p className="text-sm font-semibold tabular-nums text-brand-700">{reached ? "Goal reached!" : `${goalPercent(raised, target)}%`}</p>
          )}
        </div>
        {target !== null ? (
          <FundsBar raised={raised} goal={target} size="lg" label="Team fundraising progress" />
        ) : (
          <p className="text-sm text-ink-500">
            {canManage ? "No goal yet. Set a season goal, or give fundraisers their own goals." : "No goal set yet."}
          </p>
        )}
        <p className="text-xs text-ink-500">
          {seasonStart
            ? `Counts fundraisers since ${formatDateOnly(seasonStart, today)} (not cancelled ones).`
            : "Counts every fundraiser so far (not cancelled ones)."}
        </p>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-700">
          <li className="inline-flex items-center gap-1.5">
            <CalendarClock className="size-4 shrink-0 text-ink-500" aria-hidden />
            {upcomingCount === 0 ? "Nothing coming up" : `${upcomingCount} coming up`}
          </li>
          <li className="inline-flex items-center gap-1.5">
            <HandHeart className="size-4 shrink-0 text-ink-500" aria-hidden />
            {helpingCount === 0 ? "You're not helping with any yet" : `You're helping with ${helpingCount}`}
          </li>
        </ul>
        {canManage && <SeasonGoalEditor goal={summary.seasonGoal} seasonStart={seasonStart} today={today} />}
      </CardBody>
    </Card>
  );
}
