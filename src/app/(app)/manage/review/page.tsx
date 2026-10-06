import { CircleCheckBig } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DueBadge, PriorityBadge, SubteamBadge } from "@/components/app/badges";
import { UserChipWithPhoto } from "@/components/app/user-avatar";
import { BulkApproveProvider, BulkCheckbox, BulkSelectGroup, BulkToolbar } from "@/components/tasks/bulk-approve";
import { FilterChips } from "@/components/tasks/filter-chips";
import { NoteBlock } from "@/components/tasks/note-block";
import { ReviewActions } from "@/components/tasks/review-actions";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { timeAgo, todayInTimezone } from "@/lib/dates";
import { requireStaffUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { hasAllScope } from "@/server/permissions";
import { getReviewQueue, parseSubteamFilter, type SubteamFilter } from "@/server/queries/tasks";
import { approveManyAction, reviewAssignmentAction } from "./actions";

export const metadata: Metadata = { title: "Review" };

function hrefFor(subteam?: SubteamFilter) {
  return subteam ? `/manage/review?subteam=${subteam}` : "/manage/review";
}

function currentTime() {
  return new Date();
}

export default async function ReviewPage({ searchParams }: PageProps<"/manage/review">) {
  const actor = await requireStaffUser();
  const sp = await searchParams;
  const allScope = hasAllScope(actor);
  const subteam = allScope ? parseSubteamFilter(sp.subteam) : undefined;
  const queue = await getReviewQueue(actor, { subteam });
  const today = todayInTimezone(env.teamTimezone);
  const now = currentTime();
  const ids = queue.groups.flatMap((g) => g.items.map((i) => i.id));
  const taskCount = queue.groups.length;

  const summary =
    queue.total === 0
      ? "Approve checklist items so they officially count."
      : `${queue.total} ${queue.total === 1 ? "submission" : "submissions"} waiting${
          queue.total === queue.shown ? ` across ${taskCount} ${taskCount === 1 ? "task" : "tasks"}` : ""
        }. Oldest first.`;

  return (
    <>
      <PageHeader title="Review" description={summary} />

      {allScope && (
        <FilterChips
          label="Filter by subteam"
          className="mb-4"
          chips={[
            { href: hrefFor(), label: "All subteams", active: !subteam },
            ...SUBTEAMS.map((s) => ({ href: hrefFor(s), label: SUBTEAM_LABELS[s], active: subteam === s })),
            { href: hrefFor("TEAM"), label: "Whole team", active: subteam === "TEAM" },
          ]}
        />
      )}

      {queue.total === 0 ? (
        <Card>
          <EmptyState
            icon={CircleCheckBig}
            title="All caught up — nothing waiting for review."
            description={subteam ? "Nothing here for this filter. Try another subteam." : "New submissions show up here as people check off their tasks."}
          />
        </Card>
      ) : (
        <BulkApproveProvider ids={ids} action={approveManyAction}>
          <BulkToolbar className="mb-4" />
          <div className="space-y-4">
            {queue.groups.map((group) => (
              <Card key={group.task.id} className="overflow-hidden">
                <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    {group.task.canManage ? (
                      <Link
                        href={`/manage/tasks/${group.task.id}`}
                        className="break-words text-base font-semibold text-ink-900 hover:text-brand-800 hover:underline"
                      >
                        {group.task.title}
                      </Link>
                    ) : (
                      // Whole-team task: a subteam leader reviews their own members' items but doesn't manage the task.
                      <p className="break-words text-base font-semibold text-ink-900">{group.task.title}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <SubteamBadge subteam={group.task.subteam} />
                      <DueBadge due={group.task.dueDate} today={today} />
                      <PriorityBadge priority={group.task.priority} />
                    </div>
                  </div>
                  {group.items.length > 1 && (
                    <BulkSelectGroup ids={group.items.map((i) => i.id)} label={group.task.title} className="-mr-2 shrink-0" />
                  )}
                </div>
                <ul className="divide-y divide-ink-100">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex gap-3 px-4 py-4 sm:px-5">
                      <div className="pt-1.5">
                        <BulkCheckbox id={item.id} label={item.user.name} />
                      </div>
                      <div className="min-w-0 flex-1 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                          <UserChipWithPhoto userId={item.user.id} name={item.user.name} role={item.user.role} subteam={item.user.subteam} />
                          {item.submittedAt && <span className="text-xs text-ink-500">Submitted {timeAgo(item.submittedAt, now, env.teamTimezone)}</span>}
                        </div>
                        {item.submissionNote && <NoteBlock label="Their note" text={item.submissionNote} />}
                        {item.previousReviewNote && <NoteBlock tone="feedback" label="Previous feedback" text={item.previousReviewNote} />}
                        <ReviewActions assignmentId={item.id} personName={item.user.name} action={reviewAssignmentAction} />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
          {queue.total > queue.shown && (
            <p className="mt-4 text-center text-sm text-ink-500">
              Showing the oldest {queue.shown} of {queue.total}. Approve some to see the rest.
            </p>
          )}
        </BulkApproveProvider>
      )}
    </>
  );
}
