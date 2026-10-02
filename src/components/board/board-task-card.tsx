import Link from "next/link";
import { cn } from "@/lib/cn";
import type { DateOnly } from "@/lib/dates";
import type { BoardTask } from "@/server/queries/board";
import { DueBadge, FinishedBadge, PriorityBadge, SignupBadge } from "../app/badges";
import { Badge } from "../ui/badge";
import { PeopleChips } from "./people-chips";
import { SignupButtons } from "./signup-buttons";

/** One task on the dashboard: title (links to /tasks/[id]), finished/due/priority/sign-up badges, people, actions. */
export function BoardTaskCard({ task, today }: { task: BoardTask; today: DateOnly }) {
  const finished = task.completedAt !== null;
  const allDone = finished || (task.counts.total > 0 && task.counts.done === task.counts.total);
  const signupTask = task.signupMode;
  return (
    <article
      aria-label={task.title}
      className={cn("min-w-0 rounded-lg border bg-white p-3 shadow-sm", task.isMine ? "border-brand-300" : "border-ink-200")}
    >
      <div className="flex items-start justify-between gap-2">
        {/* The only way into the task: padded out to a ≥ 40px tap target without moving the text. */}
        <Link
          href={`/tasks/${task.id}`}
          className="-mb-2 -mt-2.5 block min-w-0 flex-1 rounded pb-2 pt-2.5 font-medium leading-snug text-ink-900 underline-offset-2 wrap-anywhere hover:text-brand-800 hover:underline"
        >
          {task.title}
        </Link>
        {task.isMine && (
          <Badge tone="brand" className="shrink-0">
            You&apos;re on it
          </Badge>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <FinishedBadge finished={finished} />
        <DueBadge due={task.dueDate} today={today} done={allDone} />
        <PriorityBadge priority={task.priority} />
        <SignupBadge
          signupMode={task.signupMode}
          signupOpen={task.signupOpen}
          signupLimit={task.signupLimit}
          spotsTaken={task.spotsTaken}
        />
      </div>
      <PeopleChips
        people={task.people}
        taskId={task.id}
        className="mt-2.5"
        emptyText={signupTask ? "Nobody has signed up yet." : "Nobody is on this task yet."}
      />
      <SignupButtons task={task} className="mt-3" />
    </article>
  );
}
