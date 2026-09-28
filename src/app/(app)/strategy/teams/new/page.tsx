import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LeagueTeamForm } from "@/components/strategy/league-team-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { canManageLeagueTeams } from "@/server/permissions";
import { createLeagueTeamAction } from "../actions";

export const metadata: Metadata = { title: "Add a team" };

/** People with admin access add the other teams in the league. Everyone else: 404. */
export default async function NewLeagueTeamPage() {
  const actor = await requireActiveUser();
  if (!canManageLeagueTeams(actor)) notFound();
  return (
    <>
      <BackLink href="/strategy/teams">Other teams</BackLink>
      <PageHeader title="Add a team" description="Another team in our league. Everyone can then write about how they play." />
      <div className="max-w-xl">
        <LeagueTeamForm
          action={createLeagueTeamAction}
          submitLabel="Add team"
          cancelHref="/strategy/teams"
          initial={{ number: "", name: "", city: "" }}
        />
      </div>
    </>
  );
}
