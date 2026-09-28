// Team calendar helpers shared by the server and the browser (client-safe): the event form's field checks,
// date/time labels and countdowns, the month grid, and .ics (iCalendar, RFC 5545) files.
//
// Days are calendar days in the team timezone ("YYYY-MM-DD"); times are "HH:MM" (24 h) wall-clock times in the
// team timezone. An event runs from `startsOn` to `endsOn` (inclusive; null = one day). No start time = all day.
import { z } from "zod";
import { CalendarEventKind } from "@/generated/prisma/enums";
import { CALENDAR_EVENT_KIND_LABELS, LIMITS } from "./constants";
import { addDays, type DateOnly, dateOnlyToDb, daysBetween, formatDateOnly, isDateOnly } from "./dates";
import { withHttps } from "./sponsorships";
import { parseHttpUrl } from "./urls";
import { dateOnlySchema, optionalText, text } from "./validation";

// ---------- field checks (the add / edit form) ----------

/** How far back / ahead an event's days may be. Catches year typos (a desktop date field turns "26" into 0026). */
export const CALENDAR_DATE_MAX_PAST_DAYS = 5 * 365;
export const CALENDAR_DATE_MAX_FUTURE_DAYS = 2 * 365;
/** The last day may be at most this many days after the first (a tournament, a build week, a fundraiser drive). */
export const CALENDAR_MAX_SPAN_DAYS = 30;

export const CALENDAR_DATE_TOO_EARLY = "That date is more than 5 years ago. Check the year.";
export const CALENDAR_DATE_TOO_LATE = "That date is more than 2 years away. Check the year.";
export const CALENDAR_END_BEFORE_START = "The last day can't be before the first day.";
export const CALENDAR_SPAN_TOO_LONG = `The last day can be at most ${CALENDAR_MAX_SPAN_DAYS} days after the first.`;
export const CALENDAR_TIME_MESSAGE = "Enter a time like 8:00 AM.";
export const CALENDAR_END_TIME_NEEDS_START = "Add a start time too, or leave both empty for all day.";
export const CALENDAR_END_TIME_ORDER = "The end time must be after the start time.";
export const CALENDAR_LINK_MESSAGE = "Enter a web link, like https://ftc-events.firstinspires.org/…";
export const CALENDAR_KIND_MESSAGE = "Pick what kind of event it is.";

/** The earliest and latest day the form accepts (the date fields' min/max). */
export function calendarDateBounds(today: DateOnly): { min: DateOnly; max: DateOnly } {
  return { min: addDays(today, -CALENDAR_DATE_MAX_PAST_DAYS), max: addDays(today, CALENDAR_DATE_MAX_FUTURE_DAYS) };
}

/** Null when `date` is within the bounds, else what to fix. */
export function calendarDateProblem(date: DateOnly, today: DateOnly): string | null {
  const { min, max } = calendarDateBounds(today);
  if (date < min) return CALENDAR_DATE_TOO_EARLY;
  if (date > max) return CALENDAR_DATE_TOO_LATE;
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * A time as people type it → "HH:MM" (24 h), or null when it isn't one. Time fields send "08:00"; browsers
 * without one (or people) may send "8:00", "8:00 am", "8 PM", "20:00:00".
 */
export function parseTime(value: string): string | null {
  const v = value.trim().toLowerCase().replace(/\s+/g, " ");
  const m = /^(\d{1,2})(?::([0-5]\d))?(?::([0-5]\d))?(?: ?([ap])\.?(?:m\.?)?)?$/.exec(v);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const half = m[4];
  if (!m[2] && !half) return null; // "8" alone: morning or evening?
  if (half) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "p" ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

const blankToUndefined = (v: unknown) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v);

/** "" / missing = no time; otherwise a time (see parseTime). */
const timeField = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z.string({ error: CALENDAR_TIME_MESSAGE }).transform((v, ctx): string | null => {
    if (v.trim() === "") return null;
    const time = parseTime(v);
    if (!time) {
      ctx.addIssue({ code: "custom", message: CALENDAR_TIME_MESSAGE });
      return z.NEVER;
    }
    return time;
  }),
);

/** "" = no link; otherwise an http(s) address (https:// is added to a bare "ftc-events.firstinspires.org/…"). */
const linkField = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z
    .string({ error: CALENDAR_LINK_MESSAGE })
    .trim()
    .transform((v, ctx) => {
      if (v === "") return "";
      const url = parseHttpUrl(withHttps(v));
      if (!url) {
        ctx.addIssue({ code: "custom", message: CALENDAR_LINK_MESSAGE });
        return z.NEVER;
      }
      return url;
    }),
);

const startsOnField = z.preprocess(blankToUndefined, dateOnlySchema);
const endsOnField = z.preprocess(blankToUndefined, dateOnlySchema.optional());

/** Each field on its own (the cross-field rules are in checkCalendarEventFields). */
export const calendarEventFieldSchema = z.object({
  title: text("Title", LIMITS.calendarTitleMax),
  kind: z.preprocess(blankToUndefined, z.enum(CalendarEventKind, { error: CALENDAR_KIND_MESSAGE })),
  startsOn: startsOnField,
  endsOn: endsOnField,
  startTime: timeField,
  endTime: timeField,
  location: optionalText("Location", LIMITS.calendarLocationMax),
  link: linkField,
  notes: optionalText("Notes", LIMITS.calendarNotesMax),
});

/** A checked event, ready to save. `endsOn` is null for a one-day event (a last day equal to the first counts as one day). */
export interface CalendarEventFields {
  title: string;
  kind: CalendarEventKind;
  startsOn: DateOnly;
  endsOn: DateOnly | null;
  startTime: string | null;
  endTime: string | null;
  location: string;
  link: string;
  notes: string;
}

export type CalendarFieldCheck = { ok: true; value: CalendarEventFields } | { ok: false; fieldErrors: Record<string, string> };

/**
 * Check the whole form at once (every field, the days' range and order, the times' order), so every problem
 * shows in one go. `keep`: the days the event has now — an edit may leave them as they are, however far back.
 */
export function checkCalendarEventFields(
  raw: Record<string, unknown>,
  today: DateOnly,
  keep: { startsOn?: DateOnly | null; endsOn?: DateOnly | null } = {},
): CalendarFieldCheck {
  const errors: Record<string, string> = {};
  const parsed = calendarEventFieldSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "_form");
      errors[key] ??= issue.message;
    }
  }

  // Rules across fields, for the fields that are fine on their own.
  const starts = startsOnField.safeParse(raw.startsOn);
  const ends = endsOnField.safeParse(raw.endsOn);
  const startTime = timeField.safeParse(raw.startTime);
  const endTime = timeField.safeParse(raw.endTime);
  const startsOn = starts.success ? starts.data : undefined;
  const endsOn = ends.success ? ends.data : undefined;

  if (startsOn && startsOn !== keep.startsOn) {
    const problem = calendarDateProblem(startsOn, today);
    if (problem) errors.startsOn ??= problem;
  }
  if (endsOn) {
    const problem = endsOn === keep.endsOn ? null : calendarDateProblem(endsOn, today);
    if (problem) errors.endsOn ??= problem;
    else if (startsOn && endsOn < startsOn) errors.endsOn ??= CALENDAR_END_BEFORE_START;
    else if (startsOn && daysBetween(startsOn, endsOn) > CALENDAR_MAX_SPAN_DAYS && !(startsOn === keep.startsOn && endsOn === keep.endsOn)) {
      errors.endsOn ??= CALENDAR_SPAN_TOO_LONG;
    }
  }
  const oneDay = !endsOn || endsOn === startsOn;
  if (startTime.success && endTime.success && endTime.data) {
    if (!startTime.data) errors.endTime ??= CALENDAR_END_TIME_NEEDS_START;
    else if (oneDay && endTime.data <= startTime.data) errors.endTime ??= CALENDAR_END_TIME_ORDER;
  }

  if (Object.keys(errors).length > 0 || !parsed.success) return { ok: false, fieldErrors: errors };
  const f = parsed.data;
  return {
    ok: true,
    value: {
      title: f.title,
      kind: f.kind,
      startsOn: f.startsOn,
      endsOn: f.endsOn && f.endsOn !== f.startsOn ? f.endsOn : null,
      startTime: f.startTime,
      endTime: f.endTime,
      location: f.location ?? "",
      link: f.link,
      notes: f.notes ?? "",
    },
  };
}

// ---------- labels ----------

/** When an event happens: what the calendar, the countdowns, and .ics files need. */
export interface CalendarEventTiming {
  startsOn: DateOnly;
  /** Last day (inclusive), or null for a one-day event. */
  endsOn: DateOnly | null;
  /** "HH:MM" (24 h, team timezone), or null = all day / not known yet. */
  startTime: string | null;
  endTime: string | null;
}

/** The last day it runs (the first day for a one-day event). */
export function eventLastDay(e: Pick<CalendarEventTiming, "startsOn" | "endsOn">): DateOnly {
  return e.endsOn && e.endsOn > e.startsOn ? e.endsOn : e.startsOn;
}

export function isMultiDay(e: Pick<CalendarEventTiming, "startsOn" | "endsOn">): boolean {
  return eventLastDay(e) !== e.startsOn;
}

/** "08:00" → "8:00 AM", "13:05" → "1:05 PM". (Plain spaces, so the server and the browser print the same.) */
export function formatTime(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}:${pad2(m)} ${h < 12 ? "AM" : "PM"}`;
}

/** "08:00" → "8am", "13:30" → "1:30pm" (the month grid's chips). */
export function formatTimeShort(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${pad2(m)}` : ""}${h < 12 ? "am" : "pm"}`;
}

/** "8:00 AM – 5:00 PM", "8:00 AM", or "All day" (the times alone). */
export function formatEventTimes(e: Pick<CalendarEventTiming, "startTime" | "endTime">): string {
  if (!e.startTime) return "All day";
  return e.endTime ? `${formatTime(e.startTime)} – ${formatTime(e.endTime)}` : formatTime(e.startTime);
}

/** "Sat, Oct 17" or "Fri, Jan 8 – Sun, Jan 10" (the days alone; the year only when it isn't this year). */
export function formatEventDates(e: Pick<CalendarEventTiming, "startsOn" | "endsOn">, today: DateOnly): string {
  const last = eventLastDay(e);
  const first = formatDateOnly(e.startsOn, today);
  return last === e.startsOn ? first : `${first} – ${formatDateOnly(last, today)}`;
}

/**
 * A multi-day event with times, as its two ends: "Fri, Oct 9, 5:00 PM" and "Sun, Oct 11, 12:00 PM" (or just
 * "Sun, Oct 11" without an end time). Its times are the first day's start and the last day's end, not daily
 * hours, so they're never shown apart from their days. Null for every other event.
 */
export function multiDayTimedEnds(e: CalendarEventTiming, today: DateOnly): { starts: string; ends: string } | null {
  if (!e.startTime || !isMultiDay(e)) return null;
  const last = eventLastDay(e);
  return {
    starts: `${formatDateOnly(e.startsOn, today)}, ${formatTime(e.startTime)}`,
    ends: e.endTime ? `${formatDateOnly(last, today)}, ${formatTime(e.endTime)}` : formatDateOnly(last, today),
  };
}

/**
 * When it is, in one line: "Sat, Oct 17 · 8:00 AM – 5:00 PM", "Sat, Oct 17 · All day", "Fri, Jan 8 – Sun, Jan 10",
 * or "Fri, Jan 8, 8:00 AM – Sun, Jan 10, 5:00 PM" (a multi-day event with times runs from the first day's start
 * to the last day's end, like it does in a calendar app).
 */
export function formatEventWhen(e: CalendarEventTiming, today: DateOnly): string {
  if (!isMultiDay(e)) return `${formatDateOnly(e.startsOn, today)} · ${formatEventTimes(e)}`;
  const ends = multiDayTimedEnds(e, today);
  return ends ? `${ends.starts} – ${ends.ends}` : formatEventDates(e, today);
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock time in `timeZone` at `now`, "HH:MM" (24 h), to compare with events' times. */
export function timeInTimezone(timeZone: string, now: Date = new Date()): string {
  let fmt = clockFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
    clockFormatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  return `${pad2(Number(parts.hour) % 24)}:${pad2(Number(parts.minute))}`;
}

/**
 * Over by `time` ("HH:MM", team timezone) on `today`: its last day is before today, or it's today and its end
 * time has passed. Without an end time an event lasts all of its last day.
 */
export function eventIsOver(e: CalendarEventTiming, today: DateOnly, time: string | null): boolean {
  const last = eventLastDay(e);
  if (last !== today) return last < today;
  return !!(time && e.startTime && e.endTime && e.endTime <= time);
}

/**
 * "Happening now" (a multi-day event that started before today and hasn't ended), "Today", "Tomorrow",
 * "In 12 days", "Yesterday", "3 days ago".
 */
export function countdownLabel(daysUntil: number, happeningNow = false): string {
  if (happeningNow) return "Happening now";
  if (daysUntil === 0) return "Today";
  if (daysUntil === 1) return "Tomorrow";
  if (daysUntil > 1) return `In ${daysUntil} days`;
  if (daysUntil === -1) return "Yesterday";
  return `${-daysUntil} days ago`;
}

export interface EventCountdown {
  /** Days from today to the first day (negative once it started). */
  daysUntil: number;
  /** Started before today and its last day is today or later. */
  happeningNow: boolean;
  /** Its last day is before today. */
  past: boolean;
  /** countdownLabel(); for past events, counted from the last day ("3 days ago"). */
  label: string;
}

export function eventCountdown(e: Pick<CalendarEventTiming, "startsOn" | "endsOn">, today: DateOnly): EventCountdown {
  const daysUntil = daysBetween(today, e.startsOn);
  const last = eventLastDay(e);
  const past = last < today;
  const happeningNow = daysUntil < 0 && !past;
  return { daysUntil, happeningNow, past, label: past ? countdownLabel(daysBetween(today, last)) : countdownLabel(daysUntil, happeningNow) };
}

/** Sort order everywhere: first day, then longer events first, all-day before timed, start time, title. */
export function compareEvents<T extends CalendarEventTiming & { title: string; id: string }>(a: T, b: T): number {
  if (a.startsOn !== b.startsOn) return a.startsOn < b.startsOn ? -1 : 1;
  const lastA = eventLastDay(a);
  const lastB = eventLastDay(b);
  if (lastA !== lastB) return lastA > lastB ? -1 : 1;
  if (a.startTime !== b.startTime) {
    if (a.startTime === null) return -1;
    if (b.startTime === null) return 1;
    return a.startTime < b.startTime ? -1 : 1;
  }
  return a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// ---------- the month grid ----------

/** A month, "YYYY-MM". */
export type MonthKey = string;

/** A valid "YYYY-MM" (years 1970–2199), or null. */
export function parseMonthKey(value: unknown): MonthKey | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1970 && year <= 2199 ? `${m[1]}-${m[2]}` : null;
}

export function monthOf(date: DateOnly): MonthKey {
  return date.slice(0, 7);
}

export function addMonths(month: MonthKey, n: number): MonthKey {
  const year = Number(month.slice(0, 4));
  const index = year * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${pad2((index % 12) + 1)}`;
}

export function monthFirstDay(month: MonthKey): DateOnly {
  return `${month}-01`;
}

export function monthLastDay(month: MonthKey): DateOnly {
  return addDays(monthFirstDay(addMonths(month, 1)), -1);
}

/** "October 2026". */
export function formatMonth(month: MonthKey): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(dateOnlyToDb(monthFirstDay(month)));
}

/** "Oct" / "October" for a month key. */
export function formatMonthName(month: MonthKey, width: "short" | "long" = "long"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: width }).format(dateOnlyToDb(monthFirstDay(month)));
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: DateOnly): number {
  return dateOnlyToDb(date).getUTCDay();
}

export interface MonthGridDay {
  date: DateOnly;
  /** Day of the month, 1–31. */
  day: number;
  /** False for the leading / trailing days from the months around it. */
  inMonth: boolean;
}

export interface MonthGrid {
  month: MonthKey;
  /** The first and last day shown (a Sunday and a Saturday). */
  first: DateOnly;
  last: DateOnly;
  /** Whole weeks, Sunday first (4–6 of them). */
  weeks: MonthGridDay[][];
}

/** The month as whole weeks, Sunday first, with the days before and after it that fill its first and last week. */
export function buildMonthGrid(month: MonthKey): MonthGrid {
  const start = monthFirstDay(month);
  const end = monthLastDay(month);
  const first = addDays(start, -weekdayOf(start));
  const last = addDays(end, 6 - weekdayOf(end));
  const weeks: MonthGridDay[][] = [];
  for (let d = first; d <= last; d = addDays(d, 7)) {
    const week: MonthGridDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(d, i);
      week.push({ date, day: Number(date.slice(8, 10)), inMonth: monthOf(date) === month });
    }
    weeks.push(week);
  }
  return { month, first, last, weeks };
}

/** Events on one day (multi-day events on each of their days), sorted. */
export function eventsOnDay<T extends CalendarEventTiming & { id: string; title: string }>(events: T[], date: DateOnly): T[] {
  return events.filter((e) => e.startsOn <= date && eventLastDay(e) >= date).sort(compareEvents);
}

/** One event's piece in one day cell of the grid. */
export interface PlacedEvent<T> {
  event: T;
  /** Its row inside the week, so a multi-day event stays on one line across the days it spans. */
  lane: number;
  /** This day is the event's first / last day. */
  startsHere: boolean;
  endsHere: boolean;
  /** This day starts / ends the event's piece in this week (it may continue from, or into, another week). */
  segmentStart: boolean;
  segmentEnd: boolean;
  /** How many days this week's piece covers (drawn as one bar from `segmentStart`). */
  segmentDays: number;
}

/**
 * Place events on the grid's days. Each week gives every event overlapping it a lane (the lowest free one, in
 * compareEvents order), and each day lists its lanes in order, with null where a lane is free that day, so
 * bars line up across the week. Days without events aren't in the map.
 */
export function placeEventsOnGrid<T extends CalendarEventTiming & { id: string; title: string }>(
  grid: Pick<MonthGrid, "weeks">,
  events: T[],
): Map<DateOnly, (PlacedEvent<T> | null)[]> {
  const byDay = new Map<DateOnly, (PlacedEvent<T> | null)[]>();
  for (const week of grid.weeks) {
    const weekStart = week[0].date;
    const weekEnd = week[week.length - 1].date;
    const inWeek = events.filter((e) => e.startsOn <= weekEnd && eventLastDay(e) >= weekStart).sort(compareEvents);
    const laneEnds: DateOnly[] = [];
    for (const event of inWeek) {
      const last = eventLastDay(event);
      const from = event.startsOn > weekStart ? event.startsOn : weekStart;
      const to = last < weekEnd ? last : weekEnd;
      let lane = laneEnds.findIndex((end) => end < from);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = to;
      const segmentDays = daysBetween(from, to) + 1;
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const lanes = byDay.get(d) ?? [];
        lanes[lane] = {
          event,
          lane,
          startsHere: d === event.startsOn,
          endsHere: d === last,
          segmentStart: d === from,
          segmentEnd: d === to,
          segmentDays,
        };
        byDay.set(d, lanes);
      }
    }
  }
  // Sparse arrays → explicit nulls for the free lanes.
  for (const [day, lanes] of byDay) byDay.set(day, Array.from(lanes, (p) => p ?? null));
  return byDay;
}

// ---------- .ics files (RFC 5545) ----------

/** What an .ics file needs about an event. */
export interface IcsEvent extends CalendarEventTiming {
  id: string;
  title: string;
  kind: CalendarEventKind;
  location: string;
  link: string;
  notes: string;
  updatedAt?: Date | string | null;
}

/**
 * TEXT value escaping: backslash, semicolon, comma, and line breaks (as "\n"). Other control characters
 * (which TEXT may not contain) are dropped; tabs are kept.
 */
export function escapeIcsText(value: string): string {
  let clean = "";
  for (const ch of value.replace(/\r\n?/g, "\n")) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) continue;
    clean += ch;
  }
  return clean.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** UTF-8 length of one code point. */
function utf8Length(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/**
 * Fold a content line so no line is longer than 75 octets (UTF-8): continuation lines start with one space,
 * and a multi-byte character is never split.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = utf8Length(ch);
    if (bytes + n > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74; // the leading space counts toward the 75
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone`'s wall clock is ahead of UTC at the instant `ms` (e.g. -7 h for Anaheim in summer). */
export function timeZoneOffsetMs(ms: number, timeZone: string): number {
  let fmt = offsetFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      era: "short",
    });
    offsetFormatters.set(timeZone, fmt);
  }
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  let year = Number(parts.year);
  if (parts.era === "BC" || parts.era === "B") year = 1 - year;
  const wall = new Date(0);
  wall.setUTCFullYear(year, Number(parts.month) - 1, Number(parts.day));
  wall.setUTCHours(Number(parts.hour) % 24, Number(parts.minute), Number(parts.second), 0);
  return wall.getTime() - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time on a day in `timeZone` happens (DST-aware). A time that happens twice (the hour
 * repeated when clocks go back) is its first occurrence; one that doesn't exist (skipped when clocks go forward)
 * moves forward with the clocks (2:30 AM → 3:30 AM), like calendar apps do.
 */
export function zonedTimeToUtc(date: DateOnly, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const asUtc = new Date(0);
  asUtc.setUTCFullYear(y, mo - 1, d);
  asUtc.setUTCHours(h, mi, 0, 0);
  const wall = asUtc.getTime();
  const DAY = 86_400_000;
  // The offsets in force around that day (a transition is never closer than a day to another one).
  const offsets = [...new Set([wall - DAY, wall, wall + DAY].map((t) => timeZoneOffsetMs(t, timeZone)))];
  const matches = offsets
    .map((offset) => wall - offset)
    .filter((instant) => timeZoneOffsetMs(instant, timeZone) === wall - instant)
    .sort((a, b) => a - b);
  if (matches.length > 0) return new Date(matches[0]);
  return new Date(wall - Math.min(...offsets));
}

/** 2026-10-17T15:00:00Z → "20261017T150000Z". */
export function formatIcsUtc(instant: Date): string {
  return instant.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/** "2026-10-17" → "20261017". */
export function formatIcsDate(date: DateOnly): string {
  return date.replace(/-/g, "");
}

/** The UID every copy of this event gets, so importing it again updates it instead of adding a duplicate. */
export function icsUid(eventId: string): string {
  return `${eventId}@huskyteers-portal`;
}

function icsEventLines(e: IcsEvent, timeZone: string, now: Date): string[] {
  const last = eventLastDay(e);
  const lines = ["BEGIN:VEVENT", `UID:${icsUid(e.id)}`, `DTSTAMP:${formatIcsUtc(now)}`];
  if (e.startTime) {
    const start = zonedTimeToUtc(e.startsOn, e.startTime, timeZone);
    lines.push(`DTSTART:${formatIcsUtc(start)}`);
    // No end time: a one-day event ends when it starts; a multi-day one runs to the end of its last day.
    const end = e.endTime
      ? zonedTimeToUtc(last, e.endTime, timeZone)
      : last !== e.startsOn
        ? zonedTimeToUtc(addDays(last, 1), "00:00", timeZone)
        : null;
    if (end && end > start) lines.push(`DTEND:${formatIcsUtc(end)}`);
  } else {
    // All day: DTEND is exclusive, the day after the last day.
    lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(e.startsOn)}`, `DTEND;VALUE=DATE:${formatIcsDate(addDays(last, 1))}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(e.title)}`);
  if (e.location.trim()) lines.push(`LOCATION:${escapeIcsText(e.location)}`);
  const description = [e.notes.trim(), e.link].filter(Boolean).join("\n\n");
  if (description) lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  if (e.link) lines.push(`URL:${e.link}`);
  lines.push(`CATEGORIES:${escapeIcsText(CALENDAR_EVENT_KIND_LABELS[e.kind])}`);
  if (e.updatedAt) lines.push(`LAST-MODIFIED:${formatIcsUtc(new Date(e.updatedAt))}`);
  lines.push("END:VEVENT");
  return lines;
}

/**
 * An iCalendar file with these events: CRLF line endings, lines folded at 75 octets, TEXT escaped, timed events
 * in UTC (converted from the team timezone's wall clock), all-day events as dates.
 */
export function buildIcs(events: IcsEvent[], options: { teamTimezone: string; now: Date; calendarName: string }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FTC 19516 The Huskyteers//Team calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(options.calendarName)}`,
  ];
  for (const e of events) lines.push(...icsEventLines(e, options.teamTimezone, options.now));
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

/** "League Meet #2!" → "huskyteers-league-meet-2.ics" (ASCII only; for Content-Disposition). */
export function icsFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug ? `huskyteers-${slug}.ics` : "huskyteers-event.ics";
}

/** Only real "YYYY-MM-DD" days (e.g. the new-event form's `?date=`). */
export function parseDateParam(value: unknown): DateOnly | null {
  return typeof value === "string" && isDateOnly(value) ? value : null;
}
