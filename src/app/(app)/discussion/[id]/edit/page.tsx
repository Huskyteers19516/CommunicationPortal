import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ThreadForm } from "@/components/discussion/thread-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { discussionHref } from "@/lib/discussion";
import { requireActiveUser } from "@/server/auth/session";
import { discussionExists, getDiscussionThreadForEdit } from "@/server/queries/discussion";
import { updateThreadAction } from "../../actions";

export const metadata: Metadata = { title: "Edit discussion" };

/**
 * Only whoever started it changes it, and not while it's locked. Anyone else (or a locked one, e.g. from an old tab
 * or a bookmark) goes to the discussion itself, which says it's locked; a missing one is a 404.
 */
export default async function EditDiscussionPage({ params }: PageProps<"/discussion/[id]/edit">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const thread = await getDiscussionThreadForEdit(actor, id);
  if (!thread) {
    if (await discussionExists(actor, id)) redirect(discussionHref(id));
    notFound();
  }
  const back = discussionHref(thread.id);

  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl">
      <BackLink href={back}>Back to the discussion</BackLink>
      <PageHeader title="Edit discussion" description="Replies stay as they are. People see that it was edited." />
      <ThreadForm
        action={updateThreadAction}
        initial={thread}
        submitLabel="Save changes"
        pendingText="Saving…"
        cancelHref={back}
      />
    </div>
  );
}
