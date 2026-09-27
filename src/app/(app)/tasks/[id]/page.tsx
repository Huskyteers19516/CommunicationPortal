import { MessageCircleQuestionMark, Settings2, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CategoryBadge, DueBadge, PriorityBadge, SignupBadge, SubteamBadge } from "@/components/app/badges";
import { PUBLIC_STATUS_STYLES, PublicStatusIcon } from "@/components/board/people-chips";
import { SignupButtons } from "@/components/board/signup-buttons";
import { BackLink } from "@/components/tasks/back-link";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import { RichText } from "@/components/ui/rich-text";
import { cn } from "@/lib/cn";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { formatDateOnly, todayInTimezone } from "@/lib/dates";
import { isSignupTask, spotsSummary } from "@/lib/signup";
import { requireActiveUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getBoardTask } from "@/server/queries/board";

export const metadata: Metadata = { title: "Task" };

export default async function BoardTaskPage({ params }: PageProps<"/tasks/[id]">) {
  const actor = await requireActiveUser();
  const { id } = await params;
  const today = todayInTimezone(env.teamTimezone);
  const task = await getBoardTask(actor, id, { today });
  if (!task) notFound();

  const { counts } = task;
  const allDone = counts.total > 0 && counts.done === counts.total;
  const signupTask = isSignupTask(task);
  const countParts = [
    counts.done && `${counts.done} done`,
    counts.checked && `${counts.checked} checked off`,
    counts.todo && `${counts.todo} to do`,
  ].filter(Boolean);

  return (
    <div className="mx-auto w-full max-w-3xl">
      <BackLink href="/tasks">Task dashboard</BackLink>
      <PageHeader
        title={<span className="wrap-anywhere">{task.title}</span>}
        description={
          <>
            {signupTask ? "Posted" : "Assigned"} by {task.createdBy.id === actor.id ? "you" : task.createdBy.name} · due{" "}
            {formatDateOnly(task.dueDate, today)}
          </>
        }
        actions={
          task.canManage && (
            <ButtonLink href={`/manage/tasks/${task.id}`} variant="secondary">
              <Settings2 className="size-4" aria-hidden />
              Manage task
            </ButtonLink>
          )
        }
      />

      <div className="-mt-3 mb-6 flex flex-wrap gap-1.5">
        <SubteamBadge subteam={task.subteam} />
        <CategoryBadge name={task.category?.name} />
        <DueBadge due={task.dueDate} today={today} done={allDone} />
        <PriorityBadge priority={task.priority} />
        <SignupBadge {...task} />
      </div>

      <div className="space-y-4">
        <Card>
          <CardBody className="space-y-4">
            {task.description ? (
              <RichText text={task.description} className="text-sm text-ink-800" />
            ) : (
              <p className="text-sm text-ink-500">No details were added to this task.</p>
            )}
            {/* People who run the task answer questions; they don't ask them. */}
            {!task.canManage && (
              <Link
                href={`/questions/new?taskId=${encodeURIComponent(task.id)}`}
                className="-ml-2 inline-flex h-10 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-brand-700 transition-colors hover:bg-brand-50 hover:text-brand-800"
              >
                <MessageCircleQuestionMark className="size-4" aria-hidden />
                Ask a question about this
              </Link>
            )}
          </CardBody>
        </Card>

        {signupTask && (
          <Card>
            <CardHeader
              title="Sign-up"
              description={
                task.signupOpen
                  ? task.subteam
                    ? `${SUBTEAM_LABELS[task.subteam]} members can sign themselves up.`
                    : "Anyone on the team can sign up."
                  : "Sign-ups are closed."
              }
            />
            <CardBody className="space-y-3">
              <p className="text-sm text-ink-700">{spotsSummary(task)}</p>
              {task.isMine && !task.canLeave && (
                <p className="text-sm text-ink-500">You&apos;re on this task. It&apos;s on your checklist.</p>
              )}
              <SignupButtons task={task} />
              {/* "Closed" is already in the card's description. */}
              {task.signupNote && task.signupOpen && <p className="text-sm text-ink-500">{task.signupNote}</p>}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title={`People (${counts.total})`}
            description={counts.total > 0 ? countParts.join(" · ") : undefined}
          />
          {task.people.length === 0 ? (
            <EmptyState
              icon={Users}
              title={signupTask ? "Nobody has signed up yet" : "Nobody is on this task yet"}
              description={task.canSignUp ? "Be the first — sign up above." : undefined}
            />
          ) : (
            <>
              <div className="px-4 pt-4 sm:px-5">
                <ProgressBar done={counts.done} pending={counts.checked} total={counts.total} />
              </div>
              <ul className="divide-y divide-ink-100">
                {task.people.map((person) => {
                  const status = PUBLIC_STATUS_STYLES[person.publicStatus];
                  return (
                    <li key={person.id} className="flex min-h-14 items-center gap-3 px-4 py-2.5 sm:px-5">
                      <Avatar name={person.name} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-900">
                          {person.name}
                          {person.isMe && <span className="font-normal text-ink-500"> (you)</span>}
                        </p>
                        {person.selfAssigned && (
                          <Badge tone="blue" className="mt-0.5">
                            Signed up
                          </Badge>
                        )}
                      </div>
                      <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", status.className)}>
                        <PublicStatusIcon status={person.publicStatus} />
                        <span className="text-ink-700">{status.label}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
