import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PartForm } from "@/components/parts/part-form";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { getPartCategoryGroups, getPartForEdit } from "@/server/queries/parts";
import { deletePartAction, updatePartAction } from "../../actions";

export const metadata: Metadata = { title: "Edit part" };

/** Build leaders and all-scope staff: any part. Whoever asked for it: until someone grabs it. */
export default async function EditPartPage({ params }: PageProps<"/parts/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const [part, categoryGroups] = await Promise.all([getPartForEdit(actor, id), getPartCategoryGroups()]);
  if (!part) notFound();

  return (
    <>
      <BackLink href="/parts">Parts queue</BackLink>
      <PageHeader
        title="Edit part"
        description={
          part.byManager ? (
            <span className="wrap-anywhere">{part.name}</span>
          ) : (
            "You can change it until someone grabs it."
          )
        }
        actions={
          <ActionForm
            action={deletePartAction}
            fields={{ partId: part.id }}
            variant="secondary"
            confirm={`Remove “${part.name}” from the parts queue?`}
            pendingText="Removing…"
            aria-label={`Remove ${part.name}`}
          >
            <Trash2 className="size-4" aria-hidden />
            Remove
          </ActionForm>
        }
      />
      <div className="max-w-3xl">
        <PartForm
          action={updatePartAction}
          categoryGroups={categoryGroups}
          submitLabel="Save changes"
          initial={{
            id: part.id,
            name: part.name,
            process: part.process,
            quantity: String(part.quantity),
            material: part.material,
            fileUrl: part.fileUrl,
            notes: part.notes,
            forText: part.forText,
            neededBy: part.neededBy,
          }}
        />
      </div>
    </>
  );
}
