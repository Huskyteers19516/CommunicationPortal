import type { Metadata } from "next";
import { ResourceForm } from "@/components/resources/resource-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { canManageResources } from "@/server/permissions";
import { listResourceGroups } from "@/server/queries/resources";
import { createResourceAction } from "../actions";

export async function generateMetadata(): Promise<Metadata> {
  const actor = await requireActiveUser();
  return { title: canManageResources(actor) ? "Add resource" : "Share a resource" };
}

/** Everyone can share; members' resources wait for approval (the service decides). */
export default async function NewResourcePage() {
  const actor = await requireActiveUser();
  const manager = canManageResources(actor);
  const groups = await listResourceGroups();
  return (
    <>
      <BackLink href="/resources">Resources</BackLink>
      <PageHeader
        title={manager ? "Add resource" : "Share a resource"}
        description={
          manager ? "Everyone on the team will see it on the Resources page." : "Share a link or a file with the team."
        }
      />
      <ResourceForm
        action={createResourceAction}
        groups={groups}
        submitLabel={manager ? "Add resource" : "Send for approval"}
        canPin={manager}
        needsApproval={!manager}
        initial={{ kind: "link", title: "", url: "", description: "", type: "DOCUMENT", group: "", pinned: false, linksText: "" }}
      />
    </>
  );
}
