import { ClipboardList, MessageSquareText } from "lucide-react";
import Link from "next/link";
import { AssignmentStatusBadge, DueBadge, PriorityBadge, SubteamBadge } from "@/components/app/badges";
import { EmptyState } from "@/components/ui/empty-state";
import { RichText } from "@/components/ui/rich-text";
import { type DateOnly, formatDateTime } from "@/lib/dates";
import type { MemberAssignment } from "@/server/queries/progress";
import { manageTaskHref } from "./progress-links";

/** "Checked off …" and "Approved … by …" — shown as separate parts of a wrapping meta row. */
function timeline(item: MemberAssignment, timeZone: string): string[] {
  const parts: string[] = [];
  if (item.submittedAt) parts.push(`Checked off ${formatDateTime(item.submittedAt, timeZone)}`);
  if (item.reviewedAt && (item.status === "APPROVED" || item.status === "REJECTED")) {
    const verb = item.finishedWithTask ? "Counted done with the whole task" : item.status === "APPROVED" ? "Approved" : "Sent back";
    parts.push(`${verb} ${formatDateTime(item.reviewedAt, timeZone)}${item.reviewerName ? ` by ${item.reviewerName}` : ""}`);
  }
  // True whether it was never approved or a leader took the credit back afterwards.
  if (item.closed) parts.push("Doesn't count — the task was marked finished without it");
  return parts;
}

/** One person's checklist items with status, due date and the leader's note. */
export function MemberAssignmentList({
  items,
  today,
  timeZone,
  emptyText,
}: {
  items: MemberAssignment[];
  today: DateOnly;
  timeZone: string;
  emptyText: string;
}) {
  if (items.length === 0) {
    return <EmptyState icon={ClipboardList} title="Nothing here" description={emptyText} />;
  }
  return (
    <ul className="divide-y divide-ink-100">
      {items.map((item) => {
        const done = item.status === "APPROVED" || item.status === "SUBMITTED" || item.closed;
        const meta = timeline(item, timeZone);
        return (
          <li key={item.id} className="px-4 py-3.5 sm:px-5">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
              <div className="min-w-0">
                {item.canManageTask ? (
                  <Link
                    href={manageTaskHref(item.task.id)}
                    className="-my-2 inline-block break-words py-2 font-medium text-ink-900 hover:text-brand-700 hover:underline"
                  >
                    {item.task.title}
                  </Link>
                ) : (
                  <p className="break-words font-medium text-ink-900">{item.task.title}</p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <DueBadge due={item.task.dueDate} today={today} done={done} />
                  <SubteamBadge subteam={item.task.subteam} />
                  <PriorityBadge priority={item.task.priority} />
                </div>
              </div>
              <div className="shrink-0">
                <AssignmentStatusBadge status={item.status} closed={item.closed} />
              </div>
            </div>
            {meta.length > 0 && (
              <p className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-500">
                {meta.map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </p>
            )}
            {item.reviewNote && (
              <div className="mt-2 flex gap-2 rounded-lg border border-ink-100 bg-ink-50 px-3 py-2 text-sm text-ink-700">
                <MessageSquareText className="mt-0.5 size-4 shrink-0 text-ink-400" aria-hidden />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink-500">
                    {item.finishedWithTask || item.closed
                      ? "Earlier feedback"
                      : item.reviewerName
                        ? `Note from ${item.reviewerName}`
                        : "Leader's note"}
                  </p>
                  <RichText text={item.reviewNote} />
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
