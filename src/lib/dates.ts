// Date helpers. Task due dates are calendar days ("YYYY-MM-DD") in the team timezone,
// stored in Postgres as DATE (Prisma returns them as Date at 00:00 UTC).

export type DateOnly = string; // "YYYY-MM-DD"

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: string): value is DateOnly {
  if (!DATE_ONLY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The calendar day it currently is in `timeZone`. */
export function todayInTimezone(timeZone: string, now: Date = new Date()): DateOnly {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** "YYYY-MM-DD" -> Date suitable for a Prisma @db.Date field. */
export function dateOnlyToDb(value: DateOnly): Date {
  return new Date(`${value}T00:00:00Z`);
}

/** Prisma @db.Date value -> "YYYY-MM-DD". */
export function dbToDateOnly(value: Date): DateOnly {
  return value.toISOString().slice(0, 10);
}

export function addDays(value: DateOnly, days: number): DateOnly {
  const d = dateOnlyToDb(value);
  d.setUTCDate(d.getUTCDate() + days);
  return dbToDateOnly(d);
}

/** Whole days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round((dateOnlyToDb(to).getTime() - dateOnlyToDb(from).getTime()) / 86_400_000);
}

/** "Mon, Sep 29" (adds the year when it differs from `today`). */
export function formatDateOnly(value: DateOnly, today?: DateOnly): string {
  const d = dateOnlyToDb(value);
  const sameYear = today ? today.slice(0, 4) === value.slice(0, 4) : true;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(d);
}

/** Human label relative to today: "Today", "Tomorrow", "Yesterday", "In 3 days", "2 days overdue"… */
export function relativeDueLabel(due: DateOnly, today: DateOnly): string {
  const diff = daysBetween(today, due);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  if (diff > 1 && diff < 7) return `In ${diff} days`;
  if (diff < -1) return `${-diff} days ago`;
  return formatDateOnly(due, today);
}

/** Timestamp formatting in the team timezone, e.g. "Sep 24, 3:05 PM". */
export function formatDateTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

/** Default team timezone for display helpers that run in the browser (server code passes env.teamTimezone). */
export const DEFAULT_TEAM_TIMEZONE = "America/Los_Angeles";

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a date (in the team timezone, not the server's). */
export function timeAgo(value: Date, now: Date = new Date(), timeZone: string = DEFAULT_TEAM_TIMEZONE): string {
  const s = Math.max(0, Math.round((now.getTime() - value.getTime()) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(value);
}

/** When someone last used the app: `timeAgo`, or "Never" for an account that never signed in (People lists). */
export function lastSeenLabel(value: Date | null, now: Date = new Date(), timeZone: string = DEFAULT_TEAM_TIMEZONE): string {
  return value ? timeAgo(value, now, timeZone) : "Never";
}
