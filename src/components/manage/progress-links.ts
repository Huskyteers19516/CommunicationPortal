// Labels and URL builders shared by the Manage overview and progress pages.
import type { Subteam } from "@/generated/prisma/enums";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { type DateOnly, formatDateOnly, timeAgo } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { hasAllScope, ledSubteam } from "@/server/permissions";
import type { ProgressRange } from "@/server/queries/progress";

export const RANGE_OPTIONS: { value: ProgressRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "Last 30 days" },
];

/** "today" / "Sep 18 – Sep 24" for descriptions. */
export function describeRange(range: ProgressRange, from: DateOnly, to: DateOnly, today: DateOnly): string {
  if (range === "today") return `today, ${formatDateOnly(today, today)}`;
  return `${formatDateOnly(from, today)} – ${formatDateOnly(to, today)}`;
}

/** Short scope hint for page headers: "Build subteam" or "Whole team". */
export function scopeLabel(actor: Pick<Actor, "id" | "role" | "subteam" | "isAdmin">): string {
  if (hasAllScope(actor)) return "Whole team";
  const led = ledSubteam(actor);
  return led ? `${SUBTEAM_LABELS[led]} subteam` : "Your tasks";
}

/** Label for a subteam group in progress summaries (null = people without a subteam). */
export function subteamGroupLabel(subteam: Subteam | null): string {
  return subteam ? SUBTEAM_LABELS[subteam] : "No subteam";
}

export function teamProgressHref(opts: { range?: ProgressRange; subteam?: Subteam | null; page?: number } = {}): string {
  const q = new URLSearchParams();
  if (opts.range) q.set("range", opts.range);
  if (opts.subteam) q.set("subteam", opts.subteam);
  if (opts.page && opts.page > 1) q.set("page", String(opts.page));
  const qs = q.toString();
  return qs ? `/manage/progress?${qs}` : "/manage/progress";
}

/** The overdue reminder for a group; `range` is Team progress's, carried so its back link returns there. */
export function overdueReminderHref(opts: { range?: ProgressRange; subteam?: Subteam | null } = {}): string {
  const q = new URLSearchParams();
  if (opts.subteam) q.set("subteam", opts.subteam);
  if (opts.range) q.set("range", opts.range);
  const qs = q.toString();
  return qs ? `/manage/progress/reminder?${qs}` : "/manage/progress/reminder";
}

export function memberProgressHref(userId: string, range?: ProgressRange): string {
  const path = `/manage/progress/${encodeURIComponent(userId)}`;
  return range ? `${path}?range=${range}` : path;
}

export function manageTaskHref(taskId: string): string {
  return `/manage/tasks/${encodeURIComponent(taskId)}`;
}

/** "3 h ago" / "never". Older dates ("Sep 12") are shown in `timeZone` (pass env.teamTimezone). */
export function lastSeenLabel(lastSeenAt: Date | null, now: Date, timeZone?: string): string {
  return lastSeenAt ? timeAgo(lastSeenAt, now, timeZone) : "never";
}
