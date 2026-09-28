// Client-safe attendance helpers: the team's schedule settings, weekdays, labels, and two-week report periods.
// Settings live in the TeamNote "attendance-settings" as JSON (read with getAttendanceSettings on the server).
import type { AttendanceKind, CheckInMethod, RsvpAnswer } from "@/generated/prisma/enums";
import { addDays, type DateOnly, daysBetween, isDateOnly } from "./dates";

export const ATTENDANCE_SETTINGS_KEY = "attendance-settings";

/** 0 = Sunday … 6 = Saturday (like Date#getUTCDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

export const WEEKDAY_SHORT: Record<Weekday, string> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

export interface AttendanceSettings {
  /** Days with regular practice (members answer Yes / Half / No). */
  regularDays: Weekday[];
  /** Days with the school's Flex period (members also answer "Attend Flex?" Yes / No). */
  flexDays: Weekday[];
  /** First day of the first two-week report period (a Monday). Periods run 14 days from here. */
  reportStart: DateOnly;
}

export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = {
  regularDays: [1, 2, 3, 4, 5],
  flexDays: [2, 4],
  reportStart: "2026-08-31",
};

function weekdayList(value: unknown, fallback: Weekday[]): Weekday[] {
  if (!Array.isArray(value)) return fallback;
  const days = value.filter((d): d is Weekday => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** Stored JSON → settings, falling back to the defaults for anything missing or malformed (never trusts the column). */
export function parseAttendanceSettings(body: string | null | undefined): AttendanceSettings {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = body ? JSON.parse(body) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const reportStart =
    typeof raw.reportStart === "string" && isDateOnly(raw.reportStart) ? raw.reportStart : DEFAULT_ATTENDANCE_SETTINGS.reportStart;
  return {
    regularDays: weekdayList(raw.regularDays, DEFAULT_ATTENDANCE_SETTINGS.regularDays),
    flexDays: weekdayList(raw.flexDays, DEFAULT_ATTENDANCE_SETTINGS.flexDays),
    reportStart,
  };
}

/** Weekday of a calendar day. */
export function weekdayOf(day: DateOnly): Weekday {
  return new Date(`${day}T00:00:00Z`).getUTCDay() as Weekday;
}

export function isRegularDay(settings: AttendanceSettings, day: DateOnly): boolean {
  return settings.regularDays.includes(weekdayOf(day));
}

export function isFlexDay(settings: AttendanceSettings, day: DateOnly): boolean {
  return settings.flexDays.includes(weekdayOf(day));
}

/** A day members are asked about (regular practice or Flex). */
export function isTeamDay(settings: AttendanceSettings, day: DateOnly): boolean {
  return isRegularDay(settings, day) || isFlexDay(settings, day);
}

/** The team days from `from` (inclusive) for `count` calendar days. */
export function teamDaysFrom(settings: AttendanceSettings, from: DateOnly, count: number): DateOnly[] {
  const out: DateOnly[] = [];
  for (let i = 0; i < count; i++) {
    const day = addDays(from, i);
    if (isTeamDay(settings, day)) out.push(day);
  }
  return out;
}

/** How many upcoming team days the "Coming?" list and the planner show. */
export const UPCOMING_TEAM_DAYS = 14;

/** The next team days people can answer for: from today, within `daysAhead` days, at most `max` of them. */
export function upcomingTeamDays(settings: AttendanceSettings, today: DateOnly, daysAhead: number, max = UPCOMING_TEAM_DAYS): DateOnly[] {
  return teamDaysFrom(settings, today, daysAhead + 1).slice(0, max);
}

// ── Two-week report periods ────────────────────────────────────────────────────

export interface ReportPeriod {
  /** 0-based number of the period since settings.reportStart (negative before it). */
  index: number;
  start: DateOnly;
  /** Last day, inclusive (start + 13). */
  end: DateOnly;
}

export const REPORT_PERIOD_DAYS = 14;

export function reportPeriodByIndex(settings: AttendanceSettings, index: number): ReportPeriod {
  const start = addDays(settings.reportStart, index * REPORT_PERIOD_DAYS);
  return { index, start, end: addDays(start, REPORT_PERIOD_DAYS - 1) };
}

/** The two-week period a day falls in. */
export function reportPeriodFor(settings: AttendanceSettings, day: DateOnly): ReportPeriod {
  const index = Math.floor(daysBetween(settings.reportStart, day) / REPORT_PERIOD_DAYS);
  return reportPeriodByIndex(settings, index);
}

// ── Labels ─────────────────────────────────────────────────────────────────────

export const ATTENDANCE_KIND_LABELS: Record<AttendanceKind, string> = {
  REGULAR: "Regular",
  FLEX: "Flex",
};

export const RSVP_LABELS: Record<RsvpAnswer, string> = {
  YES: "Yes",
  HALF: "Half",
  NO: "No",
};

export const CHECK_IN_METHOD_LABELS: Record<CheckInMethod, string> = {
  QR: "Scanned the QR code",
  CODE: "Typed the code",
  MANUAL: "Added by hand",
};

/** Every two-week period from the first one (settings.reportStart) up to the one `today` is in, newest first. */
export function reportPeriodsUpTo(settings: AttendanceSettings, today: DateOnly): ReportPeriod[] {
  return reportPeriodsBetween(settings, 0, reportPeriodFor(settings, today).index);
}

/** Most two-week periods the reports list goes back (10 years). */
export const REPORT_PERIODS_MAX = 260;

/** Periods `first`…`last` by index (negative = before settings.reportStart), newest first, at most REPORT_PERIODS_MAX. */
export function reportPeriodsBetween(settings: AttendanceSettings, first: number, last: number): ReportPeriod[] {
  const out: ReportPeriod[] = [];
  for (let i = last; i >= first && out.length < REPORT_PERIODS_MAX; i--) out.push(reportPeriodByIndex(settings, i));
  return out;
}

/**
 * The oldest period the reports reach: the one the earliest session is in, so moving "Reports start" later never
 * hides attendance taken before it (those periods get negative indices). Never later than period 0.
 */
export function firstReportIndex(settings: AttendanceSettings, earliestSession: DateOnly | null, current: number): number {
  const earliest = earliestSession ? reportPeriodFor(settings, earliestSession).index : 0;
  return Math.max(Math.min(0, earliest), current - REPORT_PERIODS_MAX + 1);
}

/** The [index] segment of a report's address: a whole number, negative for periods before "Reports start". */
export function parseReportIndex(raw: string): number | null {
  return /^(0|-?[1-9]\d{0,4})$/.test(raw) ? Number(raw) : null;
}

/**
 * Sessions from the last this-many days can be fixed by anyone who runs attendance (add/remove people, "What we
 * did", delete); older ones only by teachers, mentors, and owners (canFixOldAttendance), so the Business leader or
 * the captain can't quietly rewrite old reports.
 */
export const ATTENDANCE_EDIT_DAYS = 7;

/** "Sep 14 – Sep 27" (years added when they differ from `today`'s). */
export function formatPeriod(period: { start: DateOnly; end: DateOnly }, today?: DateOnly): string {
  const fmt = (d: DateOnly) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      ...(today && today.slice(0, 4) !== d.slice(0, 4) ? { year: "numeric" } : {}),
    }).format(new Date(`${d}T00:00:00Z`));
  return `${fmt(period.start)} – ${fmt(period.end)}`;
}

// ── Scanning ───────────────────────────────────────────────────────────────────

const SCAN_PATH_RE = /^\/attendance\/scan\/[A-Za-z0-9._-]{1,200}$/;

/**
 * The in-app scanner only follows our own attendance links: a QR code whose text is a URL on one of
 * `origins` with the path /attendance/scan/<token>. Returns that path (to open on this site), else null.
 */
export function attendanceScanPath(text: string, origins: string[]): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (!origins.includes(url.origin)) return null;
  return SCAN_PATH_RE.test(url.pathname) ? url.pathname : null;
}

/** The origins the in-app scanner accepts, from the configured app URL (the scanner adds the page's own). */
export function scanOrigins(appUrl: string): string[] {
  try {
    return [new URL(appUrl).origin];
  } catch {
    return [];
  }
}

/** "Today", "Tomorrow", or null (for a small badge next to the date). */
export function nearDayLabel(day: DateOnly, today: DateOnly): string | null {
  const diff = daysBetween(today, day);
  return diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : null;
}

/** "3:05 PM" in `timeZone`. */
export function formatClock(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(value);
}
