import { Circle, CircleCheck, CircleMinus, Clock, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import type { BoardPerson, PublicStatus } from "@/server/queries/board";
import { firstName } from "../checklist/format";
import { UserAvatar } from "../app/user-avatar";

// Icon colors stay well above 3:1 on white cards and on the canvas (amber-600 / ink-400 were borderline).
export const PUBLIC_STATUS_STYLES: Record<PublicStatus, { label: string; legend: string; icon: LucideIcon; className: string }> = {
  done: { label: "Done", legend: "Done (approved)", icon: CircleCheck, className: "text-brand-600" },
  checked: { label: "Checked off", legend: "Checked off (waiting for review)", icon: Clock, className: "text-amber-700" },
  todo: { label: "To do", legend: "To do", icon: Circle, className: "text-ink-500" },
  closed: { label: "Closed", legend: "Closed (task finished without it)", icon: CircleMinus, className: "text-ink-500" },
};

/** Small status icon with its meaning for screen readers (and a tooltip). */
export function PublicStatusIcon({ status, className }: { status: PublicStatus; className?: string }) {
  const s = PUBLIC_STATUS_STYLES[status];
  const Icon = s.icon;
  return <Icon className={cn("size-3.5 shrink-0", s.className, className)} aria-hidden />;
}

/** Legend for the status icons used on the dashboard ("Closed" only where finished tasks can show: Past). */
export function PublicStatusLegend({ className, showClosed = false }: { className?: string; showClosed?: boolean }) {
  const statuses: PublicStatus[] = showClosed ? ["done", "checked", "todo", "closed"] : ["done", "checked", "todo"];
  return (
    <p className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500", className)}>
      {statuses.map((status) => (
        <span key={status} className="inline-flex items-center gap-1">
          <PublicStatusIcon status={status} />
          {PUBLIC_STATUS_STYLES[status].legend}
        </span>
      ))}
    </p>
  );
}

/**
 * Who is on a task: avatar + first name + status icon per person (the viewer shows as "You").
 * Shows up to `max` people, then "+N more" linking to the task page.
 */
export function PeopleChips({
  people,
  taskId,
  max = 8,
  emptyText,
  className,
}: {
  people: BoardPerson[];
  taskId: string;
  max?: number;
  emptyText: string;
  className?: string;
}) {
  if (people.length === 0) return <p className={cn("text-xs text-ink-500", className)}>{emptyText}</p>;
  // Keep the viewer visible even in a long list.
  const me = people.find((p) => p.isMe);
  const ordered = me ? [me, ...people.filter((p) => !p.isMe)] : people;
  const shown = ordered.length > max ? ordered.slice(0, max - 1) : ordered;
  const hidden = ordered.length - shown.length;

  return (
    <ul className={cn("flex flex-wrap items-center gap-1.5", className)} aria-label="People on this task">
      {shown.map((p) => {
        const status = PUBLIC_STATUS_STYLES[p.publicStatus].label;
        const description = `${p.isMe ? "You" : p.name}: ${status}${p.selfAssigned ? " (signed up)" : ""}`;
        return (
          <li
            key={p.id}
            title={description}
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-xs",
              p.isMe ? "border-brand-300 bg-brand-50" : "border-ink-200 bg-white",
            )}
          >
            <UserAvatar userId={p.id} name={p.name} size="sm" />
            <span aria-hidden className="truncate font-medium text-ink-800">
              {p.isMe ? "You" : firstName(p.name)}
            </span>
            <PublicStatusIcon status={p.publicStatus} />
            <span className="sr-only">{description}</span>
          </li>
        );
      })}
      {hidden > 0 && (
        <li>
          <Link
            href={`/tasks/${taskId}`}
            className="inline-flex min-h-10 items-center rounded-full px-2 text-xs font-medium text-brand-700 hover:bg-brand-50 hover:text-brand-800"
            aria-label={`${hidden} more ${hidden === 1 ? "person" : "people"} — see everyone on this task`}
          >
            +{hidden} more
          </Link>
        </li>
      )}
    </ul>
  );
}
