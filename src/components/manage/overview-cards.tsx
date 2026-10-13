import { BadgeCheck, CalendarCheck, ChartColumn, ChevronRight, Inbox, Mail, PartyPopper, Plus } from "lucide-react";
import Link from "next/link";
import { FinishedBadge, PriorityBadge, SubteamBadge } from "@/components/app/badges";
import { UserAvatar } from "@/components/app/user-avatar";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ProgressBar } from "@/components/ui/progress-bar";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/dates";
import type { ActivityItem, AttentionPerson, TodaysTask } from "@/server/queries/progress";
import { PersonLabel } from "./person-label";
import { manageTaskHref, memberProgressHref } from "./progress-links";

const cardLink =
  "-my-2 -mr-2 inline-flex h-10 items-center rounded-lg px-2 text-sm font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-800";

/** New task · Review queue · Team progress. */
export function QuickActions({ reviewCount, className }: { reviewCount: number; className?: string }) {
  return (
    <div className={cn("grid grid-cols-1 gap-2 sm:flex sm:flex-wrap", className)}>
      <ButtonLink href="/manage/tasks/new">
        <Plus className="size-4" aria-hidden />
        New task
      </ButtonLink>
      <ButtonLink href="/manage/review" variant="secondary">
        <BadgeCheck className="size-4" aria-hidden />
        Review queue
        {reviewCount > 0 && (
          <Badge tone="yellow" className="ml-0.5">
            {reviewCount}
          </Badge>
        )}
      </ButtonLink>
      <ButtonLink href="/manage/progress" variant="secondary">
        <ChartColumn className="size-4" aria-hidden />
        Team progress
      </ButtonLink>
    </div>
  );
}

export function TodaysTasksCard({
  tasks,
  total,
  className,
}: {
  tasks: TodaysTask[];
  total: number;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader
        title="Today's tasks"
        description={total > 0 ? `${total} ${total === 1 ? "task is" : "tasks are"} due today` : undefined}
        actions={
          <Link href="/manage/tasks" className={cardLink}>
            All tasks
          </Link>
        }
      />
      {tasks.length === 0 ? (
        <EmptyState
          icon={CalendarCheck}
          title="No tasks due today"
          description="Plan the next thing for the team to work on."
          action={
            <ButtonLink href="/manage/tasks/new">
              <Plus className="size-4" aria-hidden />
              New task
            </ButtonLink>
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-ink-100">
            {tasks.map((task) => {
              const open = task.counts.todo + task.counts.rejected;
              const countParts =
                task.counts.total === 0
                  ? ["Nobody assigned"]
                  : [
                      `${task.counts.approved} approved`,
                      task.counts.submitted > 0 ? `${task.counts.submitted} waiting for review` : null,
                      open > 0 ? `${open} still to do` : null,
                      task.counts.closed > 0 ? `${task.counts.closed} closed (no credit)` : null,
                    ].filter((part): part is string => part !== null);
              return (
                <li key={task.id}>
                  <Link
                    href={manageTaskHref(task.id)}
                    className="block px-4 py-3 transition-colors hover:bg-ink-50 active:bg-ink-100 sm:px-5"
                  >
                    {/* Phones: the title gets its own line and the badges wrap below. sm+: one line. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 basis-full break-words font-medium text-ink-900 sm:basis-0 sm:flex-1 sm:truncate">
                        {task.title}
                      </span>
                      <FinishedBadge finished={task.finished} />
                      <SubteamBadge subteam={task.subteam} />
                      <PriorityBadge priority={task.priority} />
                    </div>
                    <ProgressBar
                      done={task.counts.approved}
                      pending={task.counts.submitted}
                      total={task.counts.total}
                      className="mt-2"
                    />
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500">
                      {countParts.map((part) => (
                        <span key={part}>{part}</span>
                      ))}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
          {total > tasks.length && (
            <Link
              href="/manage/tasks"
              className="flex items-center justify-between gap-3 border-t border-ink-100 px-4 py-3 text-sm text-ink-500 transition-colors hover:bg-ink-50 sm:px-5"
            >
              <span>
                Showing {tasks.length} of {total} tasks due today
              </span>
              <span className="inline-flex items-center gap-1 font-medium text-brand-700">
                See all <ChevronRight className="size-4" aria-hidden />
              </span>
            </Link>
          )}
        </>
      )}
    </Card>
  );
}

/** `reminderHref`: link to the overdue reminder (people with admin access), shown while someone is behind. */
export function AttentionCard({
  people,
  reminderHref,
  className,
}: {
  people: AttentionPerson[];
  reminderHref?: string;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader
        title="Needs attention"
        description="Most overdue checklist items"
        actions={
          reminderHref &&
          people.length > 0 && (
            <ButtonLink href={reminderHref} variant="secondary">
              <Mail className="size-4" aria-hidden />
              Remind them
            </ButtonLink>
          )
        }
      />
      {people.length === 0 ? (
        <EmptyState icon={PartyPopper} title="Nobody is behind" description="No overdue items right now. Nice work!" />
      ) : (
        <ul className="divide-y divide-ink-100">
          {people.map((person) => (
            <li key={person.id}>
              <Link
                href={memberProgressHref(person.id, "week")}
                className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-ink-50 active:bg-ink-100 sm:px-5"
              >
                <PersonLabel userId={person.id} name={person.name} role={person.role} subteam={person.subteam} />
                <span className="flex shrink-0 items-center gap-1">
                  <Badge tone="red">{person.overdueCount} overdue</Badge>
                  <ChevronRight className="size-4 text-ink-300" aria-hidden />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function activityText(item: ActivityItem) {
  const task = <span className="font-medium text-ink-900">{item.task.title}</span>;
  const person = <span className="font-medium text-ink-900">{item.person.name}</span>;
  if (item.status === "SUBMITTED") {
    return (
      <>
        {person} checked off {task}
      </>
    );
  }
  const verb = item.status === "APPROVED" ? "approved" : "sent back";
  if (item.reviewerName) {
    return (
      <>
        <span className="font-medium text-ink-900">{item.reviewerName}</span> {verb} {person}&apos;s {task}
      </>
    );
  }
  return (
    <>
      {person}&apos;s {task} was {verb}
    </>
  );
}

const activityDot: Record<ActivityItem["status"], string> = {
  TODO: "bg-ink-300",
  SUBMITTED: "bg-amber-400",
  APPROVED: "bg-brand-500",
  REJECTED: "bg-red-500",
};

export function RecentActivityCard({
  items,
  now,
  timeZone,
  className,
}: {
  items: ActivityItem[];
  now: Date;
  /** Team timezone for older dates ("Sep 12"). */
  timeZone: string;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader title="Recent activity" />
      {items.length === 0 ? (
        <EmptyState icon={Inbox} title="No activity yet" description="Check-offs and reviews will show up here." />
      ) : (
        <CardBody className="py-2 sm:py-2">
          <ul>
            {items.map((item) => {
              const href = item.canManageTask
                ? manageTaskHref(item.task.id)
                : item.canViewPerson
                  ? memberProgressHref(item.person.id, "week")
                  : null;
              const body = (
                <>
                  <span className="relative shrink-0">
                    <UserAvatar userId={item.person.id} name={item.person.name} size="sm" />
                    <span
                      className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-white", activityDot[item.status])}
                      aria-hidden
                    />
                  </span>
                  <span className="min-w-0 flex-1 text-sm text-ink-600">
                    <span className="line-clamp-2 break-words">{activityText(item)}</span>
                    <time dateTime={item.at.toISOString()} className="mt-0.5 block text-xs text-ink-500">
                      {timeAgo(item.at, now, timeZone)}
                    </time>
                  </span>
                </>
              );
              return (
                <li key={`${item.id}-${item.status}`}>
                  {href ? (
                    <Link href={href} className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-ink-50">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-start gap-3 py-2.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}
