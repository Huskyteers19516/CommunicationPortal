import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LeagueTeamForm } from "@/components/strategy/league-team-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { getLeagueTeamForEdit, parseTeamNumber } from "@/server/queries/league-teams";
import { updateLeagueTeamAction } from "../../actions";

export const metadata: Metadata = { title: "Edit team" };

/** People with admin access change a team's number, name, or city. Everyone else: 404. */
export default async function EditLeagueTeamPage({ params }: PageProps<"/strategy/teams/[number]/edit">) {
  const actor = await requireActiveUser();
  const { number } = await params;
  const team = await getLeagueTeamForEdit(actor, parseTeamNumber(number));
  if (!team) notFound();
  return (
    <>
      <BackLink href={`/strategy/teams/${team.number}`}>
        {/* A fixed cap: the back link sizes to its text, so a long name would otherwise widen the page. */}
        <span className="max-w-56 truncate sm:max-w-lg">
          {team.number} · {team.name}
        </span>
      </BackLink>
      <PageHeader title="Edit team" description={<span className="wrap-anywhere">{`${team.number} · ${team.name}`}</span>} />
      <div className="max-w-xl">
        <LeagueTeamForm
          action={updateLeagueTeamAction}
          submitLabel="Save changes"
          cancelHref={`/strategy/teams/${team.number}`}
          initial={{ id: team.id, number: String(team.number), name: team.name, city: team.city }}
        />
      </div>
    </>
  );
}
