import { Pencil, Trash2 } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { DiscussionCategoryBadge, DiscussionLockedBadge, DiscussionPinnedBadge } from "@/components/discussion/badges";
import { ModerationButtons } from "@/components/discussion/moderation-buttons";
import { JumpToNewReplies, ThreadReadState } from "@/components/discussion/read-state";
import { ReplyForm } from "@/components/discussion/reply-form";
import { ReplyItem, type ReplyItemData } from "@/components/discussion/reply-item";
import { FocusAlert } from "@/components/sponsors/focus-alert";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { RichText } from "@/components/ui/rich-text";
import { describeRole } from "@/lib/constants";
import { formatDateTime, timeAgo } from "@/lib/dates";
import { discussionHref, repliesLabel } from "@/lib/discussion";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { type DiscussionAuthor, getDiscussionThread } from "@/server/queries/discussion";
import { deleteThreadAction } from "../actions";

// Shared by generateMetadata and the page so the discussion loads once per request.
const loadThread = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return getDiscussionThread(actor, id);
});

export async function generateMetadata({ params }: PageProps<"/discussion/[id]">): Promise<Metadata> {
  const { id } = await params;
  const thread = await loadThread(id);
  return { title: thread?.title ?? "Discussion" };
}

function first(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/** Request time, read outside of render so "2 h ago" lines up with the data. */
function requestTime(): Date {
  return new Date();
}

const FORMER = "A former member";

function authorName(author: DiscussionAuthor | null): string {
  return author?.name ?? FORMER;
}

function position(author: DiscussionAuthor | null): string {
  return author ? describeRole(author.role, author.subteam) : "";
}

/** "Delete “Title” and its 3 replies? …" */
function deleteQuestion(title: string, replyCount: number): string {
  const replies = replyCount === 0 ? "" : replyCount === 1 ? " and its reply" : ` and its ${replyCount} replies`;
  return `Delete “${title}”${replies}? This can't be undone.`;
}

/** One discussion: the first post, the replies (oldest first, a "New" divider), and the reply box. */
export default async function DiscussionThreadPage({ params, searchParams }: PageProps<"/discussion/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const thread = await loadThread(id);
  if (!thread) notFound();
  const timeZone = env.teamTimezone;
  const now = requestTime();
  const started = first(sp.started) === "1";
  const saved = first(sp.saved);
  const deleted = first(sp.deleted) === "1";
  // Only ever a reply of mine on this page (never text from the link).
  const postedParam = first(sp.posted);
  const posted = thread.replies.find((r) => r.id === postedParam && r.mine)?.id ?? null;

  const replies = thread.replies.map(
    (r): ReplyItemData => ({
      id: r.id,
      body: r.body,
      version: r.version,
      authorName: authorName(r.author),
      position: position(r.author),
      mine: r.mine,
      canEdit: r.canEdit,
      canDelete: r.canDelete,
      when: timeAgo(r.createdAt, now, timeZone),
      whenTitle: formatDateTime(r.createdAt, timeZone),
      createdAt: r.createdAt.toISOString(),
      editedTitle: r.editedAt ? formatDateTime(r.editedAt, timeZone) : null,
    }),
  );

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl">
      <BackLink href="/discussion">Discussion</BackLink>

      {/* Takes focus: after posting or saving, the page would otherwise open where the form was scrolled to. */}
      {(started || saved) && (
        <div className="mb-4">
          <FocusAlert tone="success">
            {started ? "Your discussion is up. The whole team can see it and reply." : saved === "1" ? "Changes saved." : "Nothing changed."}
          </FocusAlert>
        </div>
      )}

      {/* Marks it read once it's open; keeps the "New" divider (and the link to it) while the page stays open. */}
      <ThreadReadState threadId={thread.id} seen={thread.seen.toISOString()} newFromReplyId={thread.newFromReplyId}>
        <header className="mb-4 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <DiscussionCategoryBadge category={thread.category} />
            {thread.pinned && <DiscussionPinnedBadge />}
            {thread.locked && <DiscussionLockedBadge />}
          </div>
          <h1 className="mt-2 text-xl font-semibold text-ink-900 wrap-anywhere sm:text-2xl">{thread.title}</h1>
          <JumpToNewReplies />
        </header>

        <Card>
          <CardBody>
            <div className="flex min-w-0 items-start gap-3">
              <Avatar name={authorName(thread.author)} className="mt-0.5" />
              <div className="min-w-0 flex-1 leading-tight">
                <p className="text-sm font-semibold text-ink-900 wrap-anywhere">
                  {authorName(thread.author)}
                  {thread.mine && <span className="font-normal text-ink-500"> (you)</span>}
                </p>
                <p className="mt-0.5 text-xs text-ink-500">
                  {thread.author && <span className="wrap-anywhere">{position(thread.author)} · </span>}
                  <time className="whitespace-nowrap" dateTime={thread.createdAt.toISOString()} title={formatDateTime(thread.createdAt, timeZone)}>
                    {timeAgo(thread.createdAt, now, timeZone)}
                  </time>
                  {thread.editedAt && (
                    <span className="whitespace-nowrap" title={`Edited ${formatDateTime(thread.editedAt, timeZone)}`}>
                      {" "}
                      · edited
                    </span>
                  )}
                </p>
              </div>
            </div>
            <RichText text={thread.body} className="mt-3 text-sm text-ink-800 wrap-anywhere sm:text-base" />
          </CardBody>
        </Card>

        {(thread.canEdit || thread.canDelete || thread.canModerate) && (
          <div className="mt-3 flex flex-wrap items-start gap-2">
            {thread.canEdit && (
              <ButtonLink href={`${discussionHref(thread.id)}/edit`} variant="secondary" aria-label="Edit this discussion">
                <Pencil className="size-4" aria-hidden />
                Edit
              </ButtonLink>
            )}
            {thread.canModerate && <ModerationButtons threadId={thread.id} pinned={thread.pinned} locked={thread.locked} />}
            {thread.canDelete && (
              <ActionForm
                action={deleteThreadAction}
                fields={{ threadId: thread.id }}
                variant="ghost"
                confirm={deleteQuestion(thread.title, thread.replyCount)}
                pendingText="Deleting…"
                aria-label="Delete this discussion"
              >
                <Trash2 className="size-4" aria-hidden />
                Delete
              </ActionForm>
            )}
          </div>
        )}

        <section id="replies" aria-labelledby="replies-heading" className="mt-6 scroll-mt-24">
          <h2 id="replies-heading" className="mb-3 text-sm font-semibold text-ink-700">
            {repliesLabel(thread.replyCount)}
          </h2>
          {deleted && (
            <div className="mb-3">
              <FocusAlert tone="success">Reply deleted.</FocusAlert>
            </div>
          )}
          {thread.olderHidden > 0 && (
            <p className="mb-3 rounded-lg bg-ink-100 px-3 py-2 text-center text-xs text-ink-600">
              Showing the latest {replies.length.toLocaleString("en-US")} replies. {thread.olderHidden.toLocaleString("en-US")} older{" "}
              {thread.olderHidden === 1 ? "one isn't" : "ones aren't"} shown.
            </p>
          )}
          {replies.length === 0 ? (
            <p className="rounded-xl border border-dashed border-ink-200 bg-white/60 px-4 py-6 text-center text-sm text-ink-500">
              {thread.canReply ? "No replies yet. Be the first to reply!" : "No replies."}
            </p>
          ) : (
            <ol className="space-y-3">
              {replies.map((r) => (
                <ReplyItem key={r.id} reply={r} justPosted={r.id === posted} />
              ))}
            </ol>
          )}
        </section>
      </ThreadReadState>

      <div className="mt-6">
        {thread.canReply ? (
          <Card>
            <CardBody>
              {/* A new key after each posted reply, so the box starts empty. */}
              <ReplyForm key={posted ?? "draft"} threadId={thread.id} />
            </CardBody>
          </Card>
        ) : (
          <Alert tone="info" title="This discussion is locked">
            {thread.canModerate ? "No one can reply or change posts here. Unlock it to open it again." : "No one can reply or change posts here."}
          </Alert>
        )}
      </div>
    </div>
  );
}
