import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StrategyForm } from "@/components/strategy/strategy-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { STRATEGY_KINDS } from "@/lib/constants";
import { requireActiveUser } from "@/server/auth/session";
import { getLeagueTeam, parseTeamNumber } from "@/server/queries/league-teams";
import { createStrategyAction } from "../actions";

export const metadata: Metadata = { title: "Add a strategy" };

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Everyone can add strategies; the whole team sees them right away. `?kind=` starts on that kind; `?team=9040`
 * makes it a strategy about that other team (Strategy → Other teams).
 */
export default async function NewStrategyPage({ searchParams }: PageProps<"/strategy/new">) {
  const actor = await requireActiveUser();
  const sp = await searchParams;
  const startKind = STRATEGY_KINDS.find((k) => k === first(sp.kind)) ?? "AUTO";
  const teamParam = first(sp.team);
  const team = teamParam ? await getLeagueTeam(actor, parseTeamNumber(teamParam)) : null;
  if (teamParam && !team) notFound();
  const label = team ? `${team.number} · ${team.name}` : null;
  const backHref = team ? `/strategy/teams/${team.number}` : "/strategy#strategies";

  return (
    <>
      <BackLink href={backHref}>
        {/* A fixed cap: the back link sizes to its text, so a long name would otherwise widen the page. */}
        <span className="max-w-56 truncate sm:max-w-lg">{label ?? "Strategy"}</span>
      </BackLink>
      <PageHeader
        title={team ? "Add a strategy about this team" : "Add a strategy"}
        description={
          team
            ? "Their auto traced in the planner (.pp), how they play, how to play against them… The whole team sees it right away."
            : "An auto path from the planner, a match plan, scouting notes… The whole team sees it right away."
        }
      />
      <div className="max-w-2xl">
        <StrategyForm
          action={createStrategyAction}
          submitLabel="Add strategy"
          cancelHref={backHref}
          initial={{ title: "", kind: startKind, description: "", link: "", team: team && label ? { id: team.id, label } : null }}
        />
      </div>
    </>
  );
}
