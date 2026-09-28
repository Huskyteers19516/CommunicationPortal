// Client-safe attendance helpers: the team's schedule settings, weekdays, labels, two-week report periods, and
// attendance credits (how much a check-in counts toward the weekly target).
// Settings live in the TeamNote "attendance-settings" as JSON (read with getAttendanceSettings on the server).
// Extra meetings are Team calendar events of the kind MEETING: getAttendanceSettings adds the days they cover
// (`extraDays`), and each counts as a regular day everywhere (isRegularDay / isTeamDay / teamDaysFrom).
import type { AttendanceCreditKind, AttendanceKind, CheckInMethod, RsvpAnswer } from "@/generated/prisma/enums";
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

/** The schedule as it's saved (TeamNote "attendance-settings"). */
export interface SavedAttendanceSettings {
  /** Days with regular practice (members answer Yes / Half / No). */
  regularDays: Weekday[];
  /** Days with the school's Flex period (members also answer "Attend Flex?" Yes / No). */
  flexDays: Weekday[];
  /** First day of the first two-week report period (a Monday). Periods run 14 days from here. */
  reportStart: DateOnly;
  /**
   * How many times a week (Mon–Sun, team timezone) each person should come: their check-ins' credits add up
   * toward it (EC and Flex count too). WEEKLY_TARGET_MIN–WEEKLY_TARGET_MAX.
   */
  weeklyTarget: number;
}

export interface AttendanceSettings extends SavedAttendanceSettings {
  /**
   * Days with an extra meeting (Team calendar events of the kind "Extra meeting", MEETING): each counts as a regular
   * day. getAttendanceSettings loads the ones from today to the last day people can answer for; they're never saved
   * with the schedule.
   */
  extraDays: DateOnly[];
}

export const WEEKLY_TARGET_MIN = 1;
export const WEEKLY_TARGET_MAX = 7;

/** Regular meetings on Monday, Tuesday, and Thursday; the school's Flex period on Tuesday and Thursday; 2 a week. */
export const DEFAULT_ATTENDANCE_SETTINGS: AttendanceSettings = {
  regularDays: [1, 2, 4],
  flexDays: [2, 4],
  reportStart: "2026-08-31",
  weeklyTarget: 2,
  extraDays: [],
};

/** A whole number of times a week in range, else null. */
export function parseWeeklyTarget(value: unknown): number | null {
  const n = typeof value === "string" && /^\s*\d{1,2}\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= WEEKLY_TARGET_MIN && n <= WEEKLY_TARGET_MAX ? n : null;
}

function weekdayList(value: unknown, fallback: Weekday[]): Weekday[] {
  if (!Array.isArray(value)) return fallback;
  const days = value.filter((d): d is Weekday => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Stored JSON → settings, falling back to the defaults for anything missing or malformed (never trusts the column).
 * Extra meetings come from the Team calendar, never from here: `extraDays` is always empty.
 */
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
  // Only a whole number in range (never a string or 2.5 slipped into the JSON).
  const weeklyTarget = (typeof raw.weeklyTarget === "number" && parseWeeklyTarget(raw.weeklyTarget)) || DEFAULT_ATTENDANCE_SETTINGS.weeklyTarget;
  return {
    regularDays: weekdayList(raw.regularDays, DEFAULT_ATTENDANCE_SETTINGS.regularDays),
    flexDays: weekdayList(raw.flexDays, DEFAULT_ATTENDANCE_SETTINGS.flexDays),
    reportStart,
    weeklyTarget,
    extraDays: [],
  };
}

/**
 * Settings → the JSON that's saved: only the weekdays, the report start, and the weekly target (never the extra
 * meeting days or anything else passed in).
 */
export function serializeAttendanceSettings(settings: SavedAttendanceSettings): string {
  const { regularDays, flexDays, reportStart, weeklyTarget } = settings;
  return JSON.stringify({ regularDays, flexDays, reportStart, weeklyTarget });
}

/** Weekday of a calendar day. */
export function weekdayOf(day: DateOnly): Weekday {
  return new Date(`${day}T00:00:00Z`).getUTCDay() as Weekday;
}

/** An extra meeting (Team calendar, kind MEETING) covers this day. */
export function isExtraMeetingDay(settings: Pick<AttendanceSettings, "extraDays">, day: DateOnly): boolean {
  return settings.extraDays.includes(day);
}

/** A day with regular practice: one of the regular weekdays, or a day with an extra meeting. */
export function isRegularDay(settings: AttendanceSettings, day: DateOnly): boolean {
  return settings.regularDays.includes(weekdayOf(day)) || isExtraMeetingDay(settings, day);
}

/** A day with the school's Flex period (Flex weekdays only: an extra meeting doesn't add Flex). */
export function isFlexDay(settings: AttendanceSettings, day: DateOnly): boolean {
  return settings.flexDays.includes(weekdayOf(day));
}

/** A day members are asked about (regular practice, an extra meeting, or Flex). */
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

/** A calendar event's days, for extra meetings: `startsOn` to `endsOn` (inclusive; null = one day). */
export interface ExtraMeetingDays {
  startsOn: DateOnly;
  endsOn: DateOnly | null;
}

/** A meeting's last day (like lib/calendar's eventLastDay, kept here so this file stays light for the browser). */
function lastDayOf(m: ExtraMeetingDays): DateOnly {
  return m.endsOn && m.endsOn > m.startsOn ? m.endsOn : m.startsOn;
}

/**
 * The days `from`–`to` (inclusive) that these extra meetings cover, sorted, each once. A multi-day meeting covers
 * every day from its first to its last.
 */
export function extraMeetingDays(meetings: ExtraMeetingDays[], from: DateOnly, to: DateOnly): DateOnly[] {
  const days = new Set<DateOnly>();
  for (const m of meetings) {
    const last = lastDayOf(m);
    for (let day = m.startsOn > from ? m.startsOn : from; day <= last && day <= to; day = addDays(day, 1)) days.add(day);
  }
  return [...days].sort();
}

/** The extra meetings on one day (e.g. for an "Extra meeting" badge with its title). */
export function extraMeetingsOn<T extends ExtraMeetingDays>(meetings: T[], day: DateOnly): T[] {
  return meetings.filter((m) => m.startsOn <= day && lastDayOf(m) >= day);
}

/**
 * The first day of an extra meeting that people can answer "Coming?" for now (from today, at most `daysAhead` days
 * ahead), "later" while it's further off than that, or null once it's over.
 */
export function extraMeetingAnswerDay(meeting: ExtraMeetingDays, today: DateOnly, daysAhead: number): DateOnly | "later" | null {
  if (lastDayOf(meeting) < today) return null;
  const first = meeting.startsOn > today ? meeting.startsOn : today;
  return daysBetween(today, first) <= daysAhead ? first : "later";
}

/** "Mon, Tue, Thu" (Monday first), or "None". */
export function formatWeekdays(days: Weekday[]): string {
  const list = WEEKDAYS.filter((d) => days.includes(d)).map((d) => WEEKDAY_SHORT[d]);
  return list.length > 0 ? list.join(", ") : "None";
}

/**
 * Every team day people can answer "Coming?" for (the "Coming?" list and the planner): from today to `daysAhead`
 * days ahead, the same days setRsvp / setDayPlan accept — extra meetings included, however many there are.
 */
export function upcomingTeamDays(settings: AttendanceSettings, today: DateOnly, daysAhead: number): DateOnly[] {
  return teamDaysFrom(settings, today, daysAhead + 1);
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

/** What the report periods go by: only `reportStart` (the saved schedule is enough, extra meetings don't matter). */
type ReportStart = Pick<SavedAttendanceSettings, "reportStart">;

export function reportPeriodByIndex(settings: ReportStart, index: number): ReportPeriod {
  const start = addDays(settings.reportStart, index * REPORT_PERIOD_DAYS);
  return { index, start, end: addDays(start, REPORT_PERIOD_DAYS - 1) };
}

/** The two-week period a day falls in. */
export function reportPeriodFor(settings: ReportStart, day: DateOnly): ReportPeriod {
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
export function reportPeriodsUpTo(settings: ReportStart, today: DateOnly): ReportPeriod[] {
  return reportPeriodsBetween(settings, 0, reportPeriodFor(settings, today).index);
}

/** Most two-week periods the reports list goes back (10 years). */
export const REPORT_PERIODS_MAX = 260;

/** Periods `first`…`last` by index (negative = before settings.reportStart), newest first, at most REPORT_PERIODS_MAX. */
export function reportPeriodsBetween(settings: ReportStart, first: number, last: number): ReportPeriod[] {
  const out: ReportPeriod[] = [];
  for (let i = last; i >= first && out.length < REPORT_PERIODS_MAX; i--) out.push(reportPeriodByIndex(settings, i));
  return out;
}

/**
 * The oldest period the reports reach: the one the earliest session is in, so moving "Reports start" later never
 * hides attendance taken before it (those periods get negative indices). Never later than period 0.
 */
export function firstReportIndex(settings: ReportStart, earliestSession: DateOnly | null, current: number): number {
  const earliest = earliestSession ? reportPeriodFor(settings, earliestSession).index : 0;
  return Math.max(Math.min(0, earliest), current - REPORT_PERIODS_MAX + 1);
}

/** The [index] segment of a report's address: a whole number, negative for periods before "Reports start". */
export function parseReportIndex(raw: string): number | null {
  return /^(0|-?[1-9]\d{0,4})$/.test(raw) ? Number(raw) : null;
}

/**
 * "What we did" and deleting a session: sessions from the last this-many days by anyone who runs attendance, older
 * ones only by teachers, mentors, and owners (canFixOldAttendance). Who was there and their credits have no time
 * limit: everyone with admin access fixes those any time (canFixAttendance), and each change is in the change log.
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

// ── Credits (how much a check-in counts toward the weekly target) ──────────────

/**
 * Credits are stored in sixths (AttendanceRecord.credit): 6 = 1, 4 = 2/3, 3 = 1/2, 2 = 1/3, so every option adds up
 * exactly. Regular, EC (extra credit), and Flex all count toward the weekly target. 0 = "No credit": the person is on
 * the sheet but counts as not there (e.g. said they'd come and didn't) — admins set it.
 *
 * Who sets what:
 * - A member's own check-in (QR code, typed code, in-app scanner) counts as 1 at Regular (no picking) and 1 Flex at
 *   Flex, where they may switch to 1/2 Flex that day (memberCreditOptions).
 * - Admins (canFixAttendance) change anyone's any time: a scanned record to any option (adminCreditOptions); by hand
 *   (MANUAL, no scan) only the partial ones, EC, or No credit (HAND_CREDIT_IDS) — never 1 or Flex, which need the scan.
 * - EC only by the Business leader, teachers, mentors, and owners (canGiveExtraCredit).
 */
export const CREDIT_SIXTHS = 6;

export const CREDIT_OPTION_IDS = ["1", "2/3", "1/2", "1/3", "1/2ec", "1ec", "1/2flex", "1flex", "none"] as const;
export type CreditOptionId = (typeof CREDIT_OPTION_IDS)[number];

/** "No credit" (0): on the sheet, but counts as not there. */
export const NO_CREDIT: CreditOptionId = "none";

export interface CreditOption {
  id: CreditOptionId;
  /** In sixths. */
  credit: number;
  kind: AttendanceCreditKind;
  /** "1/2 EC" */
  label: string;
  /** A few words for the picker ("About half"). */
  hint: string;
}

/** Every option, in the order menus list them. */
export const CREDIT_OPTIONS: readonly CreditOption[] = [
  { id: "1", credit: 6, kind: "REGULAR", label: "1", hint: "The whole practice" },
  { id: "2/3", credit: 4, kind: "REGULAR", label: "2/3", hint: "Most of it" },
  { id: "1/2", credit: 3, kind: "REGULAR", label: "1/2", hint: "About half" },
  { id: "1/3", credit: 2, kind: "REGULAR", label: "1/3", hint: "A short time" },
  { id: "1/2ec", credit: 3, kind: "EXTRA", label: "1/2 EC", hint: "Half, extra credit" },
  { id: "1ec", credit: 6, kind: "EXTRA", label: "1 EC", hint: "Full, extra credit" },
  { id: "1/2flex", credit: 3, kind: "FLEX", label: "1/2 Flex", hint: "Half of Flex" },
  { id: "1flex", credit: 6, kind: "FLEX", label: "1 Flex", hint: "All of Flex" },
  { id: "none", credit: 0, kind: "REGULAR", label: "No credit", hint: "Wasn't there" },
];

export function creditOption(id: string): CreditOption | undefined {
  return CREDIT_OPTIONS.find((o) => o.id === id);
}

/** What a check-in at this kind of session counts as: Regular 1, 2/3, 1/2, 1/3, 1/2 EC, 1 EC; Flex 1/2 Flex, 1 Flex. */
export function creditOptionsFor(kind: AttendanceKind): CreditOption[] {
  return CREDIT_OPTIONS.filter((o) => o.id !== NO_CREDIT && (kind === "FLEX" ? o.kind === "FLEX" : o.kind !== "FLEX"));
}

/** What a check-in counts as until someone changes it: "1" at Regular, "1 Flex" at Flex. */
export function defaultCreditOption(kind: AttendanceKind): CreditOption {
  return creditOption(kind === "FLEX" ? "1flex" : "1") as CreditOption;
}

export function creditOptionFits(id: string, kind: AttendanceKind): boolean {
  return creditOptionsFor(kind).some((o) => o.id === id);
}

/** EC ("1/2 EC", "1 EC"): only the Business leader, teachers, mentors, and owners give it (canGiveExtraCredit). */
export function isExtraCreditOption(id: string): boolean {
  return creditOption(id)?.kind === "EXTRA";
}

/**
 * What a member picks for their own check-in: at Flex 1/2 Flex or 1 Flex (it starts as 1 Flex); at Regular nothing —
 * a check-in counts as 1, and only admins make it less.
 */
export function memberCreditOptions(kind: AttendanceKind): CreditOption[] {
  return kind === "FLEX" ? creditOptionsFor("FLEX") : [];
}

/**
 * Adding someone by hand (no scan) — a MANUAL record, at Regular or Flex: only the partial credits, EC, or No credit.
 * Never 1 or Flex credit: those need the person to scan in.
 */
export const HAND_CREDIT_IDS: readonly CreditOptionId[] = ["2/3", "1/2", "1/3", "1/2ec", "1ec", "none"];

/** Menus list full credit first ("1" / "1 Flex"), then the partial ones, EC, and No credit last. */
const ADMIN_MENU_ORDER: readonly CreditOptionId[] = ["1", "1flex", "1/2flex", "2/3", "1/2", "1/3", "1/2ec", "1ec", "none"];

/**
 * The options an admin may set on a record: a scanned one (QR / CODE) any that fits the session plus the ones for
 * adding by hand; one added by hand (MANUAL) only HAND_CREDIT_IDS. EC only when they may give EC.
 */
export function adminCreditOptions(input: { kind: AttendanceKind; method: CheckInMethod; canGiveExtraCredit: boolean }): CreditOption[] {
  const ids = new Set<CreditOptionId>(HAND_CREDIT_IDS);
  if (input.method !== "MANUAL") for (const o of creditOptionsFor(input.kind)) ids.add(o.id);
  return ADMIN_MENU_ORDER.filter((id) => ids.has(id) && (input.canGiveExtraCredit || !isExtraCreditOption(id))).map(
    (id) => creditOption(id) as CreditOption,
  );
}

/** One group of a credit menu (`label` null = not in a group). */
export interface CreditMenuGroup {
  label: string | null;
  options: CreditOption[];
}

/**
 * How a credit menu groups its options: at Flex, the Flex credits and the regular part credits / EC under their own
 * headings (so "1/2" isn't taken for "1/2 Flex"), with No credit last on its own; at Regular, one plain list.
 */
export function creditMenuGroups(kind: AttendanceKind, options: CreditOption[]): CreditMenuGroup[] {
  if (kind !== "FLEX") return [{ label: null, options }];
  const groups: CreditMenuGroup[] = [
    { label: "Flex", options: options.filter((o) => o.kind === "FLEX") },
    { label: "Regular credit", options: options.filter((o) => o.kind !== "FLEX" && o.id !== NO_CREDIT) },
    { label: null, options: options.filter((o) => o.id === NO_CREDIT) },
  ];
  return groups.filter((g) => g.options.length > 0);
}

/** Whether a record counts as "came" (anything but No credit). */
export function cameWith(record: { credit: number }): boolean {
  return record.credit > 0;
}

/** The option a saved credit matches, or null (e.g. an old or hand-made value). 0 is always "No credit". */
export function creditOptionOf(credit: number, kind: AttendanceCreditKind): CreditOptionId | null {
  if (credit <= 0) return NO_CREDIT;
  return CREDIT_OPTIONS.find((o) => o.credit === credit && o.kind === kind)?.id ?? null;
}

/** Sixths as a mixed number: 12 → "2", 10 → "1 2/3", 9 → "1 1/2", 5 → "5/6", 2 → "1/3", 0 → "0". */
export function formatSixths(sixths: number): string {
  const n = Math.max(0, Math.round(sixths));
  const whole = Math.floor(n / CREDIT_SIXTHS);
  const rest = n % CREDIT_SIXTHS;
  if (rest === 0) return String(whole);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(rest, CREDIT_SIXTHS);
  const fraction = `${rest / g}/${CREDIT_SIXTHS / g}`;
  return whole > 0 ? `${whole} ${fraction}` : fraction;
}

/** A remainder in sixths as one fraction character (⅙ ⅓ ½ ⅔ ⅚): screen readers say "one half", not "one slash two". */
const SIXTH_GLYPHS = ["", "⅙", "⅓", "½", "⅔", "⅚"] as const;

/**
 * Sixths for people to read (totals toward the weekly goal): 27 → "4½", 4 → "⅔", 10 → "1⅔", 12 → "2", 0 → "0". The
 * CSVs use decimals instead (sixthsToDecimal), and the credit options keep their names ("1/2 EC").
 */
export function formatCredits(sixths: number): string {
  const n = Math.max(0, Math.round(sixths));
  const whole = Math.floor(n / CREDIT_SIXTHS);
  const rest = n % CREDIT_SIXTHS;
  if (rest === 0) return String(whole);
  return `${whole > 0 ? whole : ""}${SIXTH_GLYPHS[rest]}`;
}

/** Sixths as a decimal for spreadsheets ("1.67", "0.5", "2"): a CSV cell "1/2" would turn into a date in Excel. */
export function sixthsToDecimal(sixths: number): string {
  return String(Math.round((Math.max(0, sixths) / CREDIT_SIXTHS) * 100) / 100);
}

/** "1/2 EC", "1 Flex", "2/3" (a value no option has still reads right: "5/6 EC"). */
export function creditLabel(credit: number, kind: AttendanceCreditKind): string {
  const id = creditOptionOf(credit, kind);
  if (id) return (creditOption(id) as CreditOption).label;
  return `${formatSixths(credit)}${kind === "EXTRA" ? " EC" : kind === "FLEX" ? " Flex" : ""}`;
}

// ── Weekly target ──────────────────────────────────────────────────────────────

/** The Monday of `day`'s week (weeks run Monday to Sunday, by calendar day in the team timezone). */
export function weekStartOf(day: DateOnly): DateOnly {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** `day`'s Monday-to-Sunday week (inclusive). */
export function weekOf(day: DateOnly): { start: DateOnly; end: DateOnly } {
  const start = weekStartOf(day);
  return { start, end: addDays(start, 6) };
}

/** A person's credits in one week, in sixths: the total and how much was regular, EC, and Flex. */
export interface WeekCredit {
  total: number;
  regular: number;
  extra: number;
  flex: number;
}

export function emptyWeekCredit(): WeekCredit {
  return { total: 0, regular: 0, extra: 0, flex: 0 };
}

/** Adds one check-in's credit (every kind counts toward the total). */
export function addCredit(week: WeekCredit, record: { credit: number; creditKind: AttendanceCreditKind }): WeekCredit {
  const credit = Math.max(0, record.credit);
  week.total += credit;
  if (record.creditKind === "EXTRA") week.extra += credit;
  else if (record.creditKind === "FLEX") week.flex += credit;
  else week.regular += credit;
  return week;
}

export function sumCredits(records: { credit: number; creditKind: AttendanceCreditKind }[]): WeekCredit {
  return records.reduce(addCredit, emptyWeekCredit());
}

/** Whether a week's credits reach the target (a whole number of times). */
export function metWeeklyTarget(total: number, target: number): boolean {
  return total >= target * CREDIT_SIXTHS;
}

/**
 * "1⅔ of 2" — "of", not "/", so it doesn't read as a fraction next to the credits themselves (and never as
 * "3/4" sessions next to it in the report).
 */
export function weekProgressText(total: number, target: number): string {
  return `${formatCredits(total)} of ${target}`;
}

/** "1 regular · ½ Flex · ½ EC" (only what's there), or "" for nothing yet. */
export function creditBreakdown(week: WeekCredit): string {
  const parts: string[] = [];
  if (week.regular > 0) parts.push(`${formatCredits(week.regular)} regular`);
  if (week.flex > 0) parts.push(`${formatCredits(week.flex)} Flex`);
  if (week.extra > 0) parts.push(`${formatCredits(week.extra)} EC`);
  return parts.join(" · ");
}
