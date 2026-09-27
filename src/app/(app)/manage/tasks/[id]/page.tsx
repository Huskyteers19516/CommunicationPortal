import {
  CopyPlus,
  Lock,
  LockOpen,
  MessageCircleQuestionMark,
  Pencil,
  RotateCcw,
  SquareKanban,
  Trash2,
  UserMinus,
  Users,
} from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AssignmentStatusBadge,
  CategoryBadge,
  DueBadge,
  PriorityBadge,
  QuestionStatusBadge,
  SignupBadge,
  SubteamBadge,
} from "@/components/app/badges";
import { UserChip } from "@/components/app/user-chip";
import { ActionForm } from "@/components/tasks/action-form";
import { BackLink } from "@/components/tasks/back-link";
import { NoteBlock } from "@/components/tasks/note-block";
import { ReviewActions } from "@/components/tasks/review-actions";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ProgressBar } from "@/components/ui/progress-bar";
import { RichText } from "@/components/ui/rich-text";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { formatDateOnly, timeAgo, todayInTimezone } from "@/lib/dates";
import { spotsSummary } from "@/lib/signup";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { getManagedTaskDetail, type ManagedAssignment } from "@/server/queries/tasks";
import { reviewAssignmentAction } from "../../review/actions";
import { deleteTaskAction, removeAssignmentAction, reopenAssignmentAction, setSignupOpenAction } from "../actions";

export const metadata: Metadata = { title: "Task" };

function currentTime() {
  return new Date();
}

export default async function ManageTaskPage({ params }: PageProps<"/manage/tasks/[id]">) {
  const actor = await requireStaffUser();
  const { id } = await params;
  const task = await getManagedTaskDetail(actor, id);
  if (!task) notFound();

  const today = todayInTimezone(env.teamTimezone);
  const now = currentTime();
  const { counts } = task;
  const allDone = counts.total > 0 && counts.approved === counts.total;
  const signupTask = task.assignMode === "signup";
  const countParts = [
    counts.approved && `${counts.approved} approved`,
    counts.submitted && `${counts.submitted} waiting for review`,
    counts.rejected && `${counts.rejected} sent back`,
    counts.todo && `${counts.todo} to do`,
  ].filter(Boolean);

  return (
    <>
      <BackLink href="/manage/tasks">Tasks</BackLink>
      <PageHeader
        title={<span className="wrap-anywhere">{task.title}</span>}
        description={
          <>
            {signupTask ? "Posted" : "Assigned"} by {task.createdBy.id === actor.id ? "you" : task.createdBy.name} · due{" "}
            {formatDateOnly(task.dueDate, today)}
          </>
        }
        actions={
          <>
            <ButtonLink href={`/manage/tasks/${task.id}/edit`} variant="secondary">
              <Pencil className="size-4" aria-hidden />
              Edit
            </ButtonLink>
            <ButtonLink href={`/tasks/${task.id}`} variant="secondary">
              <SquareKanban className="size-4" aria-hidden />
              View on dashboard
            </ButtonLink>
            <ButtonLink href={`/manage/tasks/new?from=${encodeURIComponent(task.id)}`} variant="secondary">
              <CopyPlus className="size-4" aria-hidden />
              Duplicate
            </ButtonLink>
            <ActionForm
              action={deleteTaskAction}
              fields={{ taskId: task.id }}
              variant="danger"
              pendingText="Deleting…"
              confirm="Delete this task? It disappears from everyone's checklist. This can't be undone."
            >
              <Trash2 className="size-4" aria-hidden />
              Delete
            </ActionForm>
          </>
        }
      />

      <div className="-mt-3 mb-6 flex flex-wrap gap-1.5">
        <SubteamBadge subteam={task.subteam} />
        <CategoryBadge name={task.category?.name} />
        <DueBadge due={task.dueDate} today={today} done={allDone} />
        <PriorityBadge priority={task.priority} />
        <SignupBadge
          signupMode={signupTask}
          signupOpen={task.signupOpen}
          signupLimit={task.signupLimit}
          spotsTaken={counts.total}
        />
      </div>

      <div className="space-y-4">
        <Card>
          <CardBody className="space-y-4">
            {task.description ? (
              <RichText text={task.description} className="text-sm text-ink-800" />
            ) : (
              <p className="text-sm text-ink-500">No details were added to this task.</p>
            )}
            <div className="border-t border-ink-100 pt-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm font-medium text-ink-800">Progress</p>
                <p className="text-xs text-ink-500">
                  {counts.total > 0 ? countParts.join(" · ") : signupTask ? "Nobody on it yet" : "Nobody assigned yet"}
                </p>
              </div>
              {/* An empty 0/0 bar says nothing. */}
              {counts.total > 0 && (
                <ProgressBar className="mt-2" done={counts.approved} pending={counts.submitted} total={counts.total} />
              )}
            </div>
          </CardBody>
        </Card>

        {signupTask && (
          <Card>
            <CardHeader
              title="Sign-ups"
              description={
                task.signupOpen
                  ? task.subteam
                    ? `Open — ${SUBTEAM_LABELS[task.subteam]} members can sign themselves up on the Task dashboard.`
                    : "Open — anyone on the team can sign up on the Task dashboard."
                  : "Sign-ups are closed."
              }
              actions={
                <ActionForm
                  action={setSignupOpenAction}
                  fields={{ taskId: task.id, open: task.signupOpen ? "false" : "true" }}
                  pendingText={task.signupOpen ? "Closing…" : "Opening…"}
                >
                  {task.signupOpen ? <Lock className="size-4" aria-hidden /> : <LockOpen className="size-4" aria-hidden />}
                  {task.signupOpen ? "Close sign-ups" : "Open sign-ups"}
                </ActionForm>
              }
            />
            <CardBody>
              <p className="text-sm text-ink-700">
                {spotsSummary({ signupOpen: task.signupOpen, signupLimit: task.signupLimit, spotsTaken: counts.total })}
              </p>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title={`${signupTask ? "People on it" : "Assigned people"} (${counts.total})`}
            description="Approve submissions so they officially count."
          />
          {task.assignments.length === 0 ? (
            <EmptyState
              icon={Users}
              title={!signupTask ? "Nobody is assigned" : task.signupOpen ? "Nobody has signed up yet" : "Nobody is on it"}
              description={
                !signupTask
                  ? "Edit the task to add people."
                  : task.signupOpen
                    ? "People show up here when they sign up. You can also add people yourself."
                    : "Open sign-ups again, or add people yourself."
              }
              action={
                <ButtonLink href={`/manage/tasks/${task.id}/edit`} variant="secondary">
                  Add people
                </ButtonLink>
              }
            />
          ) : (
            <ul className="divide-y divide-ink-100">
              {task.assignments.map((a) => (
                <li key={a.id} className="space-y-3 px-4 py-4 sm:px-5">
                  <AssignmentRow assignment={a} now={now} timeZone={env.teamTimezone} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Questions about this task" />
          {task.questions.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-500 sm:px-5">No questions yet.</p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {task.questions.map((q) => (
                <li key={q.id}>
                  <Link
                    href={`/questions/${q.id}`}
                    className="flex min-h-12 items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-50 sm:px-5"
                  >
                    <MessageCircleQuestionMark className="size-4 shrink-0 text-ink-400" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">{q.title}</span>
                    <QuestionStatusBadge status={q.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function AssignmentRow({ assignment: a, now, timeZone }: { assignment: ManagedAssignment; now: Date; timeZone: string }) {
  const firstName = a.user.name.trim().split(/\s+/)[0] || a.user.name;
  const remove = a.canRemove && (
    <ActionForm
      action={removeAssignmentAction}
      fields={{ assignmentId: a.id }}
      variant="ghost"
      pendingText="Removing…"
      confirm={`Remove ${a.user.name} from this task? Their checklist item${a.status === "TODO" ? "" : " and submission"} will be deleted.`}
      aria-label={`Remove ${a.user.name} from this task`}
    >
      <UserMinus className="size-4" aria-hidden />
      Remove
    </ActionForm>
  );
  const showSubmitted = a.submittedAt && a.status !== "TODO";

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <UserChip name={a.user.name} role={a.user.role} subteam={a.user.subteam} />
          {a.selfAssigned && <Badge tone="blue">Signed up</Badge>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <AssignmentStatusBadge status={a.status} />
          {showSubmitted && <span className="text-xs text-ink-500">Submitted {timeAgo(a.submittedAt!, now, timeZone)}</span>}
        </div>
      </div>
      {a.submissionNote && a.status !== "TODO" && <NoteBlock label={`${firstName}'s note`} text={a.submissionNote} />}
      {a.reviewNote && (
        <NoteBlock
          tone="feedback"
          label={a.status === "SUBMITTED" ? "Previous feedback" : a.reviewerName ? `Feedback from ${a.reviewerName}` : "Feedback"}
          text={a.reviewNote}
        />
      )}
      {a.status === "SUBMITTED" && a.canReview ? (
        <ReviewActions assignmentId={a.id} personName={a.user.name} action={reviewAssignmentAction} extra={remove} />
      ) : (
        <div className="flex flex-wrap items-start gap-2">
          {a.status === "APPROVED" && a.canReview && (
            <ActionForm
              action={reopenAssignmentAction}
              fields={{ assignmentId: a.id }}
              pendingText="Reopening…"
              aria-label={`Reopen ${a.user.name}'s checklist item`}
            >
              <RotateCcw className="size-4" aria-hidden />
              Reopen
            </ActionForm>
          )}
          {remove}
          {!a.canRemove && (
            <p className="self-center text-xs text-ink-500">
              {a.status === "SUBMITTED"
                ? "This is your own item — another leader or the captain reviews it."
                : "This is your own item — ask another leader or the captain to change it."}
            </p>
          )}
        </div>
      )}
    </>
  );
}
