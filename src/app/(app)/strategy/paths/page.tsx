import { ExternalLink, Route, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { PlannerPathFilters } from "@/components/strategy/planner-path-filters";
import { PlannerPathList } from "@/components/strategy/planner-path-list";
import { StrategyTabs } from "@/components/strategy/strategy-tabs";
import { buttonClasses, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { parsePlannerPathTeamFilter, PLANNER_URL, plannerPathTeamParam, plannerPathWhose } from "@/lib/planner-paths";
import { cleanSearchText } from "@/lib/search";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getStrategyTabCounts } from "@/server/queries/league-teams";
import { listPlannerPaths, listPlannerPathTeams, PLANNER_PATH_SEARCH_MAX } from "@/server/queries/planner-paths";

export const metadata: Metadata = { title: "Saved paths" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Request time, read outside of render so "saved 3 h ago" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * Strategy → Paths: the team library, every path saved from the planner ("Save to team library"), newest first.
 * Everyone sees them all; filter by whose they are (ours, or another team's) and search names and notes.
 */
export default async function PlannerPathsPage({ searchParams }: PageProps<"/strategy/paths">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const team = parsePlannerPathTeamFilter(first(sp.team)) ?? "all";
  const q = cleanSearchText(first(sp.q), PLANNER_PATH_SEARCH_MAX) ?? "";
  const [list, counts, teams] = await Promise.all([
    listPlannerPaths(actor, { team, q }),
    getStrategyTabCounts(actor),
    listPlannerPathTeams(actor),
  ]);
  const now = requestTime();
  const filtered = team !== "all" || q !== "";
  const teamRow = typeof team === "number" ? (teams ?? []).find((t) => t.number === team) : undefined;
  const whose = team === "all" ? "" : team === "ours" ? "ours" : teamRow ? plannerPathWhose(teamRow) : `team ${team}`;
  const notice = first(sp.saved) === "1" ? "Changes saved." : first(sp.removed) === "1" ? "Path removed." : null;

  const total = list?.total ?? 0;
  const shown = list?.paths.length ?? 0;
  const resultLine = !list
    ? ""
    : `${plural(total, "path", "paths")}${whose ? ` · ${whose}` : ""}${q ? ` matching “${q}”` : ""}${shown < total ? ` · showing the ${shown} newest` : ""}`;

  const openPlanner = (
    <a href={PLANNER_URL} target="_blank" rel="noopener" className={buttonClasses("primary", "md")}>
      <ExternalLink className="size-4" aria-hidden />
      Open the planner
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );

  return (
    <>
      <PageHeader
        title="Strategy"
        description="Plan autonomous paths, keep the team's game plans in one place, and track how other teams play."
        actions={openPlanner}
      />
      <StrategyTabs active="paths" counts={counts} />

      {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
      {notice && (
        <div className="mb-4">
          <FocusAlert tone="success">{notice}</FocusAlert>
        </div>
      )}

      <section aria-labelledby="paths-title" className="space-y-4">
        <div className="min-w-0">
          <h2 id="paths-title" className="text-lg font-semibold text-ink-900">
            Saved paths
          </h2>
          <p className="text-sm text-ink-500">
            Paths saved from the planner with <span className="font-medium text-ink-700">Save to team library</span> —
            ours, and other teams&apos; autos we traced. Open one in the planner to keep working on it, or download the .pp
            file.
          </p>
        </div>

        {/* Keyed by the filters so "Clear filters" (a client navigation) resets the menu and the search box too. */}
        <PlannerPathFilters key={JSON.stringify([team, q])} team={team} q={q} teams={teams ?? []} />

        <div className="flex flex-wrap items-center justify-between gap-x-3 text-sm text-ink-500">
          <p role="status" className="min-w-0 wrap-anywhere">
            {resultLine}
          </p>
          {filtered && (
            <Link href="/strategy/paths" className="inline-flex min-h-10 items-center font-medium text-brand-700 hover:underline">
              Clear filters
            </Link>
          )}
        </div>

        {!list || list.paths.length === 0 ? (
          <Card>
            {filtered ? (
              <EmptyState
                icon={SearchX}
                title="No saved paths match"
                description={q ? "Try another word from the path's name or notes." : `No saved paths for ${whose} yet.`}
                action={
                  <ButtonLink href="/strategy/paths" variant="secondary">
                    Show all paths
                  </ButtonLink>
                }
              />
            ) : (
              <EmptyState
                icon={Route}
                title="No saved paths yet"
                description="Draw a path in the planner, then use Save to team library: the whole team sees it here."
                action={openPlanner}
              />
            )}
          </Card>
        ) : (
          <PlannerPathList
            paths={list.paths}
            now={now}
            timeZone={env.teamTimezone}
            from={{ page: "paths", team: plannerPathTeamParam(team) ?? undefined, q: q || undefined }}
          />
        )}
      </section>
    </>
  );
}
