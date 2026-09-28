import { Pencil, Plus, Route, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { PathPlanner } from "@/components/strategy/path-planner";
import { StrategyList } from "@/components/strategy/strategy-list";
import { TeamSummary } from "@/components/strategy/team-summary";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination, parsePage } from "@/components/ui/pagination";
import { timeAgo } from "@/lib/dates";
import { leagueTeamRemoveQuestion } from "@/lib/strategy";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getLeagueTeam, parseTeamNumber } from "@/server/queries/league-teams";
import { listStrategies } from "@/server/queries/strategy";
import { deleteLeagueTeamAction } from "../actions";

// Shared by generateMetadata and the page so the team loads once per request.
const loadTeam = cache(async (number: string) => {
  const actor = await requireActiveUser();
  return { actor, team: await getLeagueTeam(actor, parseTeamNumber(number)) };
});

export async function generateMetadata({ params }: PageProps<"/strategy/teams/[number]">): Promise<Metadata> {
  const { number } = await params;
  const { team } = await loadTeam(number);
  return { title: team ? `${team.number} ${team.name}` : "Other team" };
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Request time, read outside of render so "3 h ago" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

/** Another team in the league: how they play, strategies about them, and the planner to trace their paths. */
export default async function LeagueTeamPage({ params, searchParams }: PageProps<"/strategy/teams/[number]">) {
  const { number } = await params;
  const sp = await searchParams;
  const { actor, team } = await loadTeam(number);
  if (!team) notFound();
  const strategies = await listStrategies(actor, { mine: false, teamId: team.id, page: parsePage(sp.page) });
  const now = requestTime();
  const timeZone = env.teamTimezone;
  const label = `${team.number} · ${team.name}`;
  const notice =
    first(sp.added) === "1"
      ? "Team added."
      : first(sp.saved) === "1"
        ? "Changes saved."
        : first(sp.removed) === "1"
          ? "Strategy removed."
          : null;
  const addHref = `/strategy/new?team=${team.number}`;

  return (
    <div className="min-w-0 space-y-6">
      <div>
        <BackLink href="/strategy/teams">Other teams</BackLink>
        {/* Takes focus, so keyboard and screen-reader users hear it (instead of landing on <body>). */}
        {notice && (
          <div className="mb-4">
            <FocusAlert tone="success">{notice}</FocusAlert>
          </div>
        )}
        <div className="flex flex-wrap items-end justify-between gap-4">
          <header className="min-w-0">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-brand-700">Other team</p>
            <h1 className="font-display text-2xl font-semibold uppercase tracking-wide text-ink-900 wrap-anywhere sm:text-3xl">
              {team.number} · {team.name}
            </h1>
            {team.city && <p className="mt-1 text-sm text-ink-500 wrap-anywhere">{team.city}</p>}
          </header>
          {team.canManage && (
            <div className="flex flex-wrap items-start gap-2">
              <ButtonLink href={`/strategy/teams/${team.number}/edit`} variant="secondary" aria-label={`Edit team ${label}`}>
                <Pencil className="size-4" aria-hidden />
                Edit team
              </ButtonLink>
              <ActionForm
                action={deleteLeagueTeamAction}
                fields={{ teamId: team.id }}
                variant="ghost"
                confirm={leagueTeamRemoveQuestion(label, team.strategyCount, team.fileCount)}
                pendingText="Removing…"
                aria-label={`Remove team ${label}`}
              >
                <Trash2 className="size-4" aria-hidden />
                Remove team
              </ActionForm>
            </div>
          )}
        </div>
      </div>

      <TeamSummary
        teamId={team.id}
        teamLabel={label}
        summary={team.summary}
        version={team.summaryVersion}
        updatedLabel={
          team.summaryUpdatedAt ? `Updated by ${team.summaryUpdatedByName} · ${timeAgo(team.summaryUpdatedAt, now, timeZone)}` : null
        }
      />

      <section aria-labelledby="team-strategies-title" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h2 id="team-strategies-title" className="text-lg font-semibold text-ink-900 wrap-anywhere">
              Strategies about {team.name}
            </h2>
            <p className="text-sm text-ink-500">Their autos (traced as .pp paths), match plans against them, scouting notes.</p>
          </div>
          <ButtonLink href={addHref} variant="secondary" aria-label={`Add a strategy about ${label}`}>
            <Plus className="size-4" aria-hidden />
            Add a strategy about this team
          </ButtonLink>
        </div>
        {!strategies || strategies.items.length === 0 ? (
          <Card>
            <EmptyState
              icon={Route}
              title="No strategies about them yet"
              description="Trace their auto in the planner below, download it as a .pp file (Save menu → Save As), and add it here."
            />
          </Card>
        ) : (
          <>
            <StrategyList strategies={strategies.items} now={now} timeZone={timeZone} />
            <Pagination
              page={strategies.page}
              pageCount={strategies.pageCount}
              hrefFor={(page) => (page > 1 ? `/strategy/teams/${team.number}?page=${page}` : `/strategy/teams/${team.number}`)}
            />
          </>
        )}
      </section>

      <PathPlanner
        id="trace"
        title="Trace their path"
        description="Watch their match, then redraw their auto in the Pedro Pathing planner."
        open="asked"
        showLabel="Open the planner"
        hint={
          <>
            Trace their auto, then in the planner open the Save menu (the disk icon, top right) → Save As → Confirm to
            download the .pp file. Once it has downloaded,{" "}
            {/* A new tab, so a trace that isn't downloaded yet isn't lost. */}
            <Link
              href={addHref}
              target="_blank"
              rel="noopener"
              className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-800"
            >
              add it to a strategy about this team
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
            . Paths saved inside the planner stay in this browser, and only here (not in a new tab).
          </>
        }
      />
    </div>
  );
}
