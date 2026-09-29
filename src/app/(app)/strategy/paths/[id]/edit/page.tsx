import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PlannerPathForm } from "@/components/strategy/planner-path-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { plannerPathWhose } from "@/lib/planner-paths";
import { requireActiveUser } from "@/server/auth/session";
import { getPlannerPathForEdit, listPlannerPathTeams } from "@/server/queries/planner-paths";
import { updatePlannerPathAction } from "../../actions";

export const metadata: Metadata = { title: "Edit saved path" };

/**
 * Rename a saved path, change its notes, or whose path it is: whoever saved it, and everyone with admin access.
 * Everyone else: 404. (The path itself is changed in the planner.)
 */
export default async function EditPlannerPathPage({ params, searchParams }: PageProps<"/strategy/paths/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const sp = await searchParams;
  const path = await getPlannerPathForEdit(actor, id);
  if (!path) notFound();
  const teams = (await listPlannerPathTeams(actor)) ?? [];
  const fromTeam = sp.from === "team" && path.team !== null;
  const back = fromTeam && path.team ? { href: `/strategy/teams/${path.team.number}`, label: plannerPathWhose(path.team) } : { href: "/strategy/paths", label: "Paths" };

  return (
    <>
      <BackLink href={back.href}>
        {/* A fixed cap: the back link sizes to its text, so a long name would otherwise widen the page. */}
        <span className="max-w-56 truncate sm:max-w-lg">{back.label}</span>
      </BackLink>
      <PageHeader title="Edit saved path" description={<span className="wrap-anywhere">{path.name}</span>} />
      <div className="max-w-xl">
        <PlannerPathForm
          action={updatePlannerPathAction}
          from={fromTeam ? "team" : "paths"}
          cancelHref={back.href}
          teams={teams}
          initial={{
            id: path.id,
            version: path.version,
            name: path.name,
            notes: path.notes,
            teamNumber: path.team ? String(path.team.number) : "",
          }}
        />
      </div>
    </>
  );
}
