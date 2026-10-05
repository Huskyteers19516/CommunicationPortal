import type { Metadata } from "next";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { WorkshopProjectForm } from "@/components/workshop/project-form";
import { requireActiveUser } from "@/server/auth/session";
import { getWorkshopPeople } from "@/server/queries/workshop";
import { createWorkshopProjectAction } from "../actions";

export const metadata: Metadata = { title: "Add a project" };

/** Everyone can add a project. It starts as a draft: photos come next, on its page. */
export default async function NewWorkshopProjectPage() {
  const actor = await requireActiveUser();
  const people = await getWorkshopPeople(actor);
  return (
    <>
      <BackLink href="/workshop">Workshop</BackLink>
      <PageHeader
        title="Add a project"
        description="Say what it is and who made it. Next you'll add photos, then send it for approval to go on the team website."
      />
      <div className="max-w-2xl">
        <WorkshopProjectForm
          action={createWorkshopProjectAction}
          submitLabel="Add project"
          cancelHref="/workshop"
          people={people}
          initial={{
            kind: "PART",
            title: "",
            summary: "",
            material: "",
            season: "",
            extraCredits: "",
            link: "",
            codeLink: "",
            credits: [{ id: actor.id, name: actor.name }],
          }}
        />
      </div>
    </>
  );
}
