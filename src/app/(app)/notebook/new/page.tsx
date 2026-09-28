import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NotebookForm } from "@/components/notebook/notebook-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { requireActiveUser } from "@/server/auth/session";
import { canManageNotebooks } from "@/server/permissions";
import { createNotebookAction } from "../actions";

export const metadata: Metadata = { title: "New notebook" };

/** The captain, mentors, teachers, and owners add notebooks. Everyone else: 404. */
export default async function NewNotebookPage() {
  const actor = await requireActiveUser();
  if (!canManageNotebooks(actor)) notFound();
  return (
    <>
      <BackLink href="/notebook">Team notebook</BackLink>
      <PageHeader title="New notebook" description="It goes at the end of the list. Add its pages next." />
      <div className="max-w-2xl">
        <NotebookForm
          action={createNotebookAction}
          submitLabel="Add notebook"
          cancelHref="/notebook"
          initial={{ title: "", emoji: "", description: "", subteam: "" }}
        />
      </div>
    </>
  );
}
