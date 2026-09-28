import { Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NotebookForm } from "@/components/notebook/notebook-form";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { getNotebookForEdit } from "@/server/queries/notebook";
import { deleteNotebookAction, updateNotebookAction } from "../../../actions";

export const metadata: Metadata = { title: "Edit notebook" };

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The captain, mentors, teachers, and owners. Everyone else: 404. */
export default async function EditNotebookPage({ params }: PageProps<"/notebook/n/[notebookId]/edit">) {
  const actor = await requireActiveUser();
  const { notebookId } = await params;
  const notebook = await getNotebookForEdit(actor, notebookId);
  if (!notebook) notFound();

  const goes =
    notebook.pageCount > 0
      ? ` Its ${plural(notebook.pageCount, "page", "pages")} and ${plural(notebook.entryCount, "entry", "entries")} (with their pictures) go too.`
      : "";

  return (
    <>
      <BackLink href={`/notebook#notebook-${notebook.id}`}>Team notebook</BackLink>
      <PageHeader
        title="Edit notebook"
        description={<span className="wrap-anywhere">{notebook.title}</span>}
        actions={
          <ActionForm
            action={deleteNotebookAction}
            fields={{ notebookId: notebook.id }}
            variant="secondary"
            confirm={`Delete “${notebook.title}”?${goes} This can't be undone.`}
            pendingText="Deleting…"
            aria-label={`Delete ${notebook.title}`}
          >
            <Trash2 className="size-4 text-red-600" aria-hidden />
            Delete notebook
          </ActionForm>
        }
      />
      <div className="max-w-2xl">
        <NotebookForm
          action={updateNotebookAction}
          submitLabel="Save changes"
          cancelHref={`/notebook#notebook-${notebook.id}`}
          initial={{
            id: notebook.id,
            title: notebook.title,
            emoji: notebook.emoji,
            description: notebook.description,
            subteam: notebook.subteam ?? "",
          }}
        />
      </div>
    </>
  );
}
