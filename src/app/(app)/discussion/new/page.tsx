import type { Metadata } from "next";
import { ThreadForm } from "@/components/discussion/thread-form";
import { BackLink } from "@/components/tasks/back-link";
import { PageHeader } from "@/components/ui/page-header";
import { DISCUSSION_CATEGORIES } from "@/lib/constants";
import { requireActiveUser } from "@/server/auth/session";
import { createThreadAction } from "../actions";

export const metadata: Metadata = { title: "Start a discussion" };

/** Everyone ACTIVE starts discussions; `?category=` starts on the one being looked at. */
export default async function NewDiscussionPage({ searchParams }: PageProps<"/discussion/new">) {
  await requireActiveUser();
  const sp = await searchParams;
  const wanted = Array.isArray(sp.category) ? sp.category[0] : sp.category;
  const category = DISCUSSION_CATEGORIES.find((c) => c === wanted) ?? "GENERAL";

  return (
    <div className="mx-auto w-full min-w-0 max-w-2xl">
      <BackLink href="/discussion">Discussion</BackLink>
      <PageHeader title="Start a discussion" description="The whole team can read it and reply right away." />
      <ThreadForm
        action={createThreadAction}
        initial={{ title: "", category, body: "" }}
        submitLabel="Post discussion"
        pendingText="Posting…"
        cancelHref="/discussion"
      />
    </div>
  );
}
