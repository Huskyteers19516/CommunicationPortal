import { ChevronLeft, ChevronRight, ClipboardList } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { QuestionStatusBadge, SubteamBadge } from "@/components/app/badges";
import { UserChipWithPhoto } from "@/components/app/user-avatar";
import { audienceLabel, repliesLabel, topicLabel } from "@/components/questions/labels";
import { QuestionActions } from "@/components/questions/question-actions";
import { ReplyForm } from "@/components/questions/reply-form";
import { ThreadMessage } from "@/components/questions/thread-message";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody } from "@/components/ui/card";
import { RichText } from "@/components/ui/rich-text";
import { formatDateTime, timeAgo } from "@/lib/dates";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getQuestionThread, type QuestionThread } from "@/server/queries/questions";
import { deleteQuestionAction, replyToQuestionAction, setQuestionStatusAction } from "./actions";

// Shared by generateMetadata and the page so the thread loads once per request.
const loadThread = cache(async (id: string) => {
  const actor = await requireActiveUser();
  return getQuestionThread(actor, id);
});

export async function generateMetadata({ params }: PageProps<"/questions/[id]">): Promise<Metadata> {
  const { id } = await params;
  const thread = await loadThread(id);
  return { title: thread?.title ?? "Question" };
}

/** Members can't open Manage pages, so only people who manage the task get a link. */
function RelatedTask({ task }: { task: NonNullable<QuestionThread["task"]> }) {
  const content = (
    <>
      <ClipboardList className="size-4 shrink-0 text-ink-400" aria-hidden />
      <span className="shrink-0 text-ink-500">Related task</span>
      <span className="min-w-0 truncate font-medium text-ink-900">{task.title}</span>
      {task.canManage && <ChevronRight className="ml-auto size-4 shrink-0 text-ink-400" aria-hidden />}
    </>
  );
  const box = "mt-3 flex min-h-10 w-full items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm sm:w-fit sm:max-w-full";
  return task.canManage ? (
    <Link href={`/manage/tasks/${task.id}`} className={`${box} transition-colors hover:border-brand-300 hover:bg-brand-50/40`}>
      {content}
    </Link>
  ) : (
    <div className={box}>{content}</div>
  );
}

/** Who gets notified when the asker posts. */
function askerHint(thread: QuestionThread): string {
  if (thread.recipient) return `${thread.recipient.name} will get an email.`;
  return thread.subteam ? `The ${topicLabel(thread.subteam)} leaders will get an email.` : "The captain will get an email.";
}

export default async function QuestionPage({ params }: PageProps<"/questions/[id]">) {
  const { id } = await params;
  const thread = await loadThread(id);
  if (!thread) notFound();

  const now = new Date();
  const timeZone = env.teamTimezone;
  const { permissions: perm, viewer } = thread;
  const answering = viewer.isStaff && !viewer.isAsker;
  const hiddenReplies = thread.replyCount - thread.replies.length;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link
        href="/questions"
        className="-ml-2 mb-2 inline-flex h-10 items-center gap-1 rounded-lg px-2 text-sm font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800"
      >
        <ChevronLeft className="size-4" aria-hidden />
        Questions
      </Link>

      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <QuestionStatusBadge status={thread.status} />
          <SubteamBadge subteam={thread.subteam} />
        </div>
        <h1 className="mt-2 break-words text-xl font-semibold text-ink-900 sm:text-2xl">{thread.title}</h1>
        <p className="mt-1 text-sm text-ink-500">
          Asked by <span className="font-medium text-ink-700">{viewer.isAsker ? "you" : thread.asker.name}</span> to{" "}
          <span className="font-medium text-ink-700">{audienceLabel(thread.recipient?.name ?? null, thread.subteam)}</span>{" "}
          {/* The topic is already the badge above. Keep "· 6 h ago" together so it never splits across lines. */}
          <span className="whitespace-nowrap">
            ·{" "}
            <time dateTime={thread.createdAt.toISOString()} title={formatDateTime(thread.createdAt, timeZone)}>
              {timeAgo(thread.createdAt, now, timeZone)}
            </time>
          </span>
        </p>
        {thread.task && <RelatedTask task={thread.task} />}
      </header>

      <Card>
        <CardBody>
          <UserChipWithPhoto userId={thread.asker.id} name={thread.asker.name} role={thread.asker.role} subteam={thread.asker.subteam} />
          <RichText text={thread.body} className="mt-3 text-ink-800" />
        </CardBody>
      </Card>

      <section className="mt-6" aria-labelledby="replies-heading">
        <h2 id="replies-heading" className="mb-3 text-sm font-semibold text-ink-700">
          {repliesLabel(thread.replyCount)}
        </h2>
        {hiddenReplies > 0 && (
          <p className="mb-3 text-center text-xs text-ink-500">Showing the latest {thread.replies.length} replies.</p>
        )}
        {thread.replies.length === 0 ? (
          <p className="rounded-xl border border-dashed border-ink-200 bg-white/60 px-4 py-6 text-center text-sm text-ink-500">
            {viewer.isAsker ? "No replies yet. You'll get an email when someone answers." : "No replies yet — be the first to answer."}
          </p>
        ) : (
          <ol className="space-y-3">
            {thread.replies.map((r) => (
              <ThreadMessage
                key={r.id}
                author={r.author}
                body={r.body}
                createdAt={r.createdAt}
                staff={r.isStaff}
                mine={r.isMine}
                now={now}
                timeZone={timeZone}
              />
            ))}
          </ol>
        )}
      </section>

      {perm.canReply && (
        <Card className="mt-6">
          <CardBody>
            {thread.status === "RESOLVED" && (
              <Alert tone="info" className="mb-4">
                This question is resolved. Replying will reopen it.
              </Alert>
            )}
            <ReplyForm
              action={replyToQuestionAction.bind(null, thread.id)}
              hint={answering ? "The asker will get an email (unless they turned it off)." : askerHint(thread)}
              placeholder={answering ? "Write an answer…" : "Add a follow-up…"}
            />
          </CardBody>
        </Card>
      )}

      {(perm.canResolve || perm.canReopen || perm.canDelete) && (
        <div className="mt-4 space-y-2">
          {viewer.isAsker && thread.status === "ANSWERED" && (
            <p className="text-sm text-ink-600">Got what you needed? Mark it as resolved.</p>
          )}
          <QuestionActions
            resolveAction={perm.canResolve ? setQuestionStatusAction.bind(null, thread.id, "RESOLVED") : undefined}
            reopenAction={perm.canReopen ? setQuestionStatusAction.bind(null, thread.id, "OPEN") : undefined}
            deleteAction={perm.canDelete ? deleteQuestionAction.bind(null, thread.id) : undefined}
          />
        </div>
      )}
    </div>
  );
}
