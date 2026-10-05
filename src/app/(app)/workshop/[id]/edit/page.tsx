import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { WorkshopProjectForm } from "@/components/workshop/project-form";
import { requireActiveUser } from "@/server/auth/session";
import { getWorkshopPeople, getWorkshopProject } from "@/server/queries/workshop";
import { updateWorkshopProjectAction } from "../../actions";

export const metadata: Metadata = { title: "Edit project" };

/** Whoever added the project, the people credited on it, and reviewers. Everyone else: 404. */
export default async function EditWorkshopProjectPage({ params }: PageProps<"/workshop/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const project = await getWorkshopProject(actor, id);
  if (!project || !project.canEdit) notFound();
  const people = await getWorkshopPeople(actor);
  const resubmits = project.status === "APPROVED" && !project.canReview;

  return (
    <>
      <BackLink href={`/workshop/${encodeURIComponent(project.id)}`}>
        {/* A fixed cap: the back link sizes to its text, so a long title would otherwise widen the page. */}
        <span className="max-w-56 truncate sm:max-w-lg">{project.title}</span>
      </BackLink>
      <PageHeader
        title="Edit details"
        description={
          resubmits
            ? "It's on the team website: saving a change takes it off until a leader approves it again."
            : <span className="wrap-anywhere">{project.title}</span>
        }
      />
      <div className="max-w-2xl">
        <WorkshopProjectForm
          action={updateWorkshopProjectAction}
          submitLabel="Save changes"
          cancelHref={`/workshop/${encodeURIComponent(project.id)}`}
          people={people}
          initial={{
            id: project.id,
            kind: project.kind,
            title: project.title,
            summary: project.summary,
            material: project.material,
            season: project.season,
            extraCredits: project.extraCredits,
            link: project.link,
            codeLink: project.codeLink,
            credits: project.credits,
          }}
        />
      </div>
    </>
  );
}
