import { ChevronRight, Plus, Search, SearchX, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { StrategyTabs } from "@/components/strategy/strategy-tabs";
import { TeamSearchClear } from "@/components/strategy/team-search-clear";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { LIMITS, OUR_TEAM_NUMBER } from "@/lib/constants";
import { timeAgo } from "@/lib/dates";
import { leagueTeamRemovedNotice } from "@/lib/strategy";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getStrategyTabCounts, listLeagueTeams } from "@/server/queries/league-teams";

export const metadata: Metadata = { title: "Other teams" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Request time, read outside of render so "updated 3 d ago" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The other teams in our league: what we know about how they play, and strategies about them. */
export default async function OtherTeamsPage({ searchParams }: PageProps<"/strategy/teams">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const [list, counts] = await Promise.all([listLeagueTeams(actor, { q }), getStrategyTabCounts(actor)]);
  // "?removed=9040 · STEAMpunks Alpha&strategies=3" after removing a team.
  const removed = first(sp.removed)?.slice(0, LIMITS.leagueTeamNameMax + 12);
  const removedStrategies = Number.parseInt(first(sp.strategies) ?? "", 10);
  // Our own number is never on the list: say so instead of "no match".
  const searchedUs = q.replace(/^#/, "") === String(OUR_TEAM_NUMBER);
  const resultLine =
    !q || !list
      ? ""
      : searchedUs && list.teams.length === 0
        ? `${OUR_TEAM_NUMBER} is us. This list is the other teams.`
        : list.teams.length === 0
          ? `No teams match “${q}”.`
          : `${plural(list.teams.length, "team matches", "teams match")} “${q}”.`;
  const now = requestTime();
  const timeZone = env.teamTimezone;

  const addButton = list?.canManage ? (
    <ButtonLink href="/strategy/teams/new">
      <Plus className="size-4" aria-hidden />
      Add a team
    </ButtonLink>
  ) : undefined;

  return (
    <>
      <PageHeader
        title="Strategy"
        description="Plan autonomous paths, keep the team's game plans in one place, and track how other teams play."
        actions={addButton}
      />
      <StrategyTabs active="teams" counts={counts} />

      {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
      {removed && (
        <div className="mb-4">
          <FocusAlert tone="success">
            <span className="wrap-anywhere">{leagueTeamRemovedNotice(removed, removedStrategies)}</span>
          </FocusAlert>
        </div>
      )}

      <div className="max-w-3xl">
        <p className="mb-3 text-sm text-ink-600">
          The other teams in our league. Open one to write down how they play, trace their auto in the planner, and
          keep strategies about them.
        </p>

        <Form action="/strategy/teams" role="search" className="mb-4 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-48 space-y-1.5">
            <Label htmlFor="team-search">Find a team</Label>
            <Input
              id="team-search"
              name="q"
              type="search"
              defaultValue={q}
              placeholder="Number, name, or city"
              autoComplete="off"
              enterKeyHint="search"
            />
          </div>
          <Button type="submit" variant="secondary">
            <Search className="size-4" aria-hidden />
            Search
          </Button>
          {q && <TeamSearchClear inputId="team-search" href="/strategy/teams" />}
        </Form>

        {/* Always rendered (empty without a search), so screen readers announce the first result too. */}
        <p className={resultLine ? "mb-3 text-sm text-ink-500 wrap-anywhere" : "sr-only"} role="status">
          {resultLine}
        </p>

        {!list || list.teams.length === 0 ? (
          <Card>
            {q ? (
              <EmptyState
                icon={SearchX}
                title="No teams match"
                description={searchedUs ? `${OUR_TEAM_NUMBER} is us, the Huskyteers. Try another team's number, or part of its name or city.` : "Try the team's number, or part of its name or city."}
                action={
                  <ButtonLink href="/strategy/teams" variant="secondary">
                    Show all teams
                  </ButtonLink>
                }
              />
            ) : (
              <EmptyState
                icon={UsersRound}
                title="No other teams yet"
                description={
                  list?.canManage ? "Add the teams in our league to start tracking how they play." : "A leader can add the teams in our league."
                }
                action={addButton}
              />
            )}
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-ink-100">
              {list.teams.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/strategy/teams/${t.number}`}
                    className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-50 focus-visible:bg-ink-50 focus-visible:outline-none sm:px-5"
                  >
                    <span className="w-14 shrink-0 font-semibold tabular-nums text-brand-800">{t.number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink-900 wrap-anywhere">{t.name}</span>
                      <span className="block text-xs text-ink-500 wrap-anywhere">
                        {[
                          t.city,
                          t.strategyCount > 0 && plural(t.strategyCount, "strategy", "strategies"),
                          t.hasSummary && t.summaryUpdatedAt && `summary updated ${timeAgo(t.summaryUpdatedAt, now, timeZone)}`,
                          t.strategyCount === 0 && !t.hasSummary && "no notes yet",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-ink-400" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
