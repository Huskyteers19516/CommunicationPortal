import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ResourceForm } from "@/components/resources/resource-form";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { NoteBlock } from "@/components/tasks/note-block";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { canManageResources } from "@/server/permissions";
import { getResourceForEdit, listResourceGroups } from "@/server/queries/resources";
import { deleteResourceAction, updateResourceAction } from "../../actions";

export const metadata: Metadata = { title: "Edit resource" };

/** People with admin access: any resource. Members: their own, until it's approved. */
export default async function EditResourcePage({ params }: PageProps<"/resources/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const [resource, groups] = await Promise.all([getResourceForEdit(actor, id), listResourceGroups()]);
  if (!resource) notFound();
  const manager = canManageResources(actor);

  return (
    <>
      <BackLink href={`/resources/${resource.id}`}>
        {/* A fixed cap: the back link sizes to its text, so a long title would otherwise widen the page. */}
        <span className="max-w-56 truncate sm:max-w-lg">{resource.title}</span>
      </BackLink>
      <PageHeader
        title="Edit resource"
        description={
          manager ? <span className="wrap-anywhere">{resource.title}</span> : "Saving sends it to a leader or admin for approval again."
        }
        actions={
          resource.canDelete ? (
            <ActionForm
              action={deleteResourceAction}
              fields={{ resourceId: resource.id }}
              variant="secondary"
              confirm={`Remove “${resource.title}” from Resources?`}
              pendingText="Removing…"
              aria-label={`Remove ${resource.title}`}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove
            </ActionForm>
          ) : null
        }
      />
      {resource.status === "REJECTED" && resource.reviewNote && (
        <NoteBlock label="Why it was sent back" text={resource.reviewNote} tone="feedback" className="mb-6" />
      )}
      <ResourceForm
        action={updateResourceAction}
        groups={groups}
        submitLabel={manager ? "Save changes" : "Save and send for approval"}
        canPin={manager}
        needsApproval={!manager}
        initial={{
          id: resource.id,
          kind: resource.kind,
          title: resource.title,
          url: resource.url,
          description: resource.description,
          type: resource.type,
          group: resource.group,
          pinned: resource.pinned,
          linksText: resource.linksText,
          currentFile: resource.file,
        }}
      />
    </>
  );
}
