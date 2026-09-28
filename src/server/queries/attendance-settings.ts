import "server-only";
import { cache } from "react";
import type { Prisma } from "@/generated/prisma/client";
import {
  ATTENDANCE_SETTINGS_KEY,
  type AttendanceSettings,
  extraMeetingDays,
  parseAttendanceSettings,
  type SavedAttendanceSettings,
} from "@/lib/attendance";
import { CALENDAR_DATE_MAX_FUTURE_DAYS } from "@/lib/calendar";
import { LIMITS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import { type Db, prisma } from "../db";

/** An extra meeting: a Team calendar event of the kind MEETING ("Extra meeting"). */
export interface ExtraMeeting {
  id: string;
  title: string;
  startsOn: DateOnly;
  /** Last day (inclusive), or null for a one-day meeting. */
  endsOn: DateOnly | null;
  startTime: string | null;
  endTime: string | null;
}

/** Most extra meetings loaded at once (a season has a handful). */
export const EXTRA_MEETINGS_MAX = 200;

/**
 * The days whose extra meetings the settings carry: today and every day people can answer "Coming?" for
 * (LIMITS.rsvpDaysAhead) — the only days anything asks "is this a meeting day?" about (reports go by the sessions
 * held). A day outside it counts by its weekday only.
 */
export function extraMeetingWindow(today: DateOnly): { from: DateOnly; to: DateOnly } {
  return { from: today, to: addDays(today, LIMITS.rsvpDaysAhead) };
}

const extraMeetingSelect = {
  id: true,
  title: true,
  startsOn: true,
  endsOn: true,
  startTime: true,
  endTime: true,
} satisfies Prisma.CalendarEventSelect;

/** Extra meetings that overlap the days `from`–`to` (inclusive), soonest first. */
export async function getExtraMeetings(range: { from: DateOnly; to: DateOnly }, db: Db = prisma, take = EXTRA_MEETINGS_MAX): Promise<ExtraMeeting[]> {
  const from = dateOnlyToDb(range.from);
  const rows = await db.calendarEvent.findMany({
    where: {
      kind: "MEETING",
      startsOn: { lte: dateOnlyToDb(range.to) },
      OR: [{ endsOn: { gte: from } }, { endsOn: null, startsOn: { gte: from } }],
    },
    orderBy: [{ startsOn: "asc" }, { startTime: { sort: "asc", nulls: "first" } }, { title: "asc" }, { id: "asc" }],
    take,
    select: extraMeetingSelect,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    startsOn: dbToDateOnly(r.startsOn),
    endsOn: r.endsOn ? dbToDateOnly(r.endsOn) : null,
    startTime: r.startTime,
    endTime: r.endTime,
  }));
}

/** Extra meetings that aren't over yet (their last day is `today` or later), soonest first (the Schedule page). */
export async function getUpcomingExtraMeetings(today: DateOnly, db: Db = prisma, take = 20): Promise<ExtraMeeting[]> {
  return getExtraMeetings({ from: today, to: addDays(today, CALENDAR_DATE_MAX_FUTURE_DAYS) }, db, take);
}

export interface AttendanceSchedule {
  /** The saved schedule, plus the days extra meetings cover from today on (`extraDays`). */
  settings: AttendanceSettings;
  /** The extra meetings in extraMeetingWindow(today) (for "Extra meeting" badges with their titles). */
  extraMeetings: ExtraMeeting[];
}

/**
 * Only the saved schedule (regular and Flex weekdays, first report period, weekly target), with defaults — one read,
 * no extra meetings. For what goes by `reportStart`, the weekdays, or the target alone (reports, the Schedule form).
 */
export async function getSavedAttendanceSettings(db: Db = prisma): Promise<SavedAttendanceSettings> {
  const note = await db.teamNote.findUnique({ where: { key: ATTENDANCE_SETTINGS_KEY }, select: { body: true } });
  const { regularDays, flexDays, reportStart, weeklyTarget } = parseAttendanceSettings(note?.body);
  return { regularDays, flexDays, reportStart, weeklyTarget };
}

async function loadAttendanceSchedule(today: DateOnly, db: Db): Promise<AttendanceSchedule> {
  const window = extraMeetingWindow(today);
  const [saved, extraMeetings] = await Promise.all([getSavedAttendanceSettings(db), getExtraMeetings(window, db)]);
  return { settings: { ...saved, extraDays: extraMeetingDays(extraMeetings, window.from, window.to) }, extraMeetings };
}

/**
 * Pages read it more than once per request (Today: the page and its attendance card), so reads through the app-wide
 * client are shared for the request (React `cache`; outside rendering, e.g. in a server action, it just loads).
 */
const loadScheduleForRequest = cache((today: DateOnly) => loadAttendanceSchedule(today, prisma));

/** The attendance schedule (see getAttendanceSettings) with the extra meetings it counted. */
export function getAttendanceSchedule(today: DateOnly, db: Db = prisma): Promise<AttendanceSchedule> {
  // A service's own client (ctx.db, maybe a transaction) always reads fresh.
  return db === prisma ? loadScheduleForRequest(today) : loadAttendanceSchedule(today, db);
}

/**
 * The team's attendance schedule (regular days, Flex days, first report period), with defaults, plus the days the
 * Team calendar's extra meetings cover from `today` on (extraMeetingWindow), which count as regular days. Anyone
 * signed in may read it. Services pass ctx.db and their team-timezone today.
 */
export async function getAttendanceSettings(today: DateOnly, db: Db = prisma): Promise<AttendanceSettings> {
  return (await getAttendanceSchedule(today, db)).settings;
}
