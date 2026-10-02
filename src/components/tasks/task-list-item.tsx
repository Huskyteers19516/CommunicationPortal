import { ChevronRight } from "lucide-react";
import Link from "next/link";
import type { DateOnly } from "@/lib/dates";
import type { ManagedTaskRow } from "@/server/queries/tasks";
import { CategoryBadge, DueBadge, FinishedBadge, PriorityBadge, SignupBadge, SubteamBadge } from "../app/badges";
import { Badge } from "../ui/badge";
import { ProgressBar } from "../ui/progress-bar";

/** One row in the Manage → Tasks list. The whole row is the link (big tap target on phones). */
export function TaskListItem({ task, today }: { task: ManagedTaskRow; today: DateOnly }) {
  const { counts } = task;
  const allDone = task.finished || (counts.total > 0 && counts.approved === counts.total);
  return (
    <Link href={`/manage/tasks/${task.id}`} className="group flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-ink-50 sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 font-medium text-ink-900 wrap-anywhere group-hover:text-brand-800">{task.title}</p>
          {counts.submitted > 0 && (
            <Badge tone="yellow" className="shrink-0">
              {counts.submitted} to review
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <FinishedBadge finished={task.finished} />
          <SubteamBadge subteam={task.subteam} />
          <CategoryBadge name={task.category?.name} />
          <DueBadge due={task.dueDate} today={today} done={allDone} />
          <PriorityBadge priority={task.priority} />
          <SignupBadge
            signupMode={task.signupMode}
            signupOpen={task.signupOpen && !task.finished}
            signupLimit={task.signupLimit}
            spotsTaken={counts.total}
          />
          <span className="text-xs text-ink-500">
            {counts.total} {task.signupMode ? "on it" : "assigned"}
            {task.isMine ? "" : ` · by ${task.createdByName}`}
          </span>
        </div>
        {counts.total > 0 ? (
          <ProgressBar className="mt-2.5" done={counts.approved} pending={counts.submitted} total={counts.total} />
        ) : (
          <p className="mt-2 text-xs text-ink-500">{task.signupMode ? "Nobody has signed up yet." : "Nobody is assigned yet."}</p>
        )}
      </div>
      <ChevronRight className="hidden size-5 shrink-0 text-ink-300 group-hover:text-ink-500 sm:block" aria-hidden />
    </Link>
  );
}
