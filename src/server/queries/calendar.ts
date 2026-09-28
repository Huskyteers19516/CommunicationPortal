import "server-only";
// Team calendar (/calendar): every ACTIVE person sees every event; staff (canManageCalendar) also get the edit
// tools. Pages guard themselves (requireActiveUser); these loaders only read.

import type { Prisma } from "@/generated/prisma/client";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import type { CalendarEventTiming, IcsEvent } from "@/lib/calendar";
import { CALENDAR_MEET_KINDS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canManageCalendar } from "../permissions";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;

/** Most events one month grid loads (a busy month has a few dozen). */
export const CALENDAR_MONTH_LIMIT = 500;
/** The List view: everything coming up (a season has well under this). */
export const CALENDAR_UPCOMING_LIMIT = 300;
/** The Past view shows the most recent ones. */
export const CALENDAR_PAST_LIMIT = 100;
/** Most events in the "Add to my calendar" file. */
export const CALENDAR_EXPORT_LIMIT = 2000;

export interface CalendarEventItem extends CalendarEventTiming {
  id: string;
  title: string;
  kind: CalendarEventKind;
  location: string;
  /** A safe http(s) link, or "". */
  link: string;
}

export interface CalendarPerson {
  id: string;
  name: string;
}

export interface CalendarEventDetail extends CalendarEventItem {
  notes: string;
  createdBy: CalendarPerson | null;
  /** Whoever saved the last edit (null until someone edits it). */
  updatedBy: CalendarPerson | null;
  createdAt: string;
  updatedAt: string;
  /** What the edit form sends back as `version` (updatedAt, ISO). */
  version: string;
  /** Edit / Remove. */
  canManage: boolean;
}

const itemSelect = {
  id: true,
  title: true,
  kind: true,
  startsOn: true,
  endsOn: true,
  startTime: true,
  endTime: true,
  location: true,
  link: true,
} satisfies Prisma.CalendarEventSelect;

type ItemRow = Prisma.CalendarEventGetPayload<{ select: typeof itemSelect }>;

function toItem(row: ItemRow): CalendarEventItem {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    startsOn: dbToDateOnly(row.startsOn),
    endsOn: row.endsOn ? dbToDateOnly(row.endsOn) : null,
    startTime: row.startTime,
    endTime: row.endTime,
    location: row.location,
    link: row.link,
  };
}

/** Soonest first: first day, then all-day before timed, start time, title. */
const soonestFirst: Prisma.CalendarEventOrderByWithRelationInput[] = [
  { startsOn: "asc" },
  { startTime: { sort: "asc", nulls: "first" } },
  { title: "asc" },
  { id: "asc" },
];

/** Events whose last day (endsOn, or startsOn for a one-day event) is on or after `day`. */
function lastDayOnOrAfter(day: DateOnly): Prisma.CalendarEventWhereInput {
  const d = dateOnlyToDb(day);
  return { OR: [{ endsOn: { gte: d } }, { endsOn: null, startsOn: { gte: d } }] };
}

/** Events whose last day is before `day`. */
function lastDayBefore(day: DateOnly): Prisma.CalendarEventWhereInput {
  const d = dateOnlyToDb(day);
  return { OR: [{ endsOn: { lt: d } }, { endsOn: null, startsOn: { lt: d } }] };
}

function kindFilter(kind: CalendarEventKind | undefined): Prisma.CalendarEventWhereInput {
  return kind ? { kind } : {};
}

export function canManageCalendarFor(actor: ActorLike): boolean {
  return actor.status === "ACTIVE" && canManageCalendar(actor);
}

/** How many events there are at all (for "No events yet"). */
export async function countCalendarEvents(db: Db = prisma): Promise<number> {
  return db.calendarEvent.count();
}

/** Every event that overlaps the days `from`–`to` (a month grid, leading and trailing days included). */
export async function getCalendarEventsBetween(
  range: { from: DateOnly; to: DateOnly; kind?: CalendarEventKind },
  db: Db = prisma,
): Promise<CalendarEventItem[]> {
  const rows = await db.calendarEvent.findMany({
    where: { AND: [{ startsOn: { lte: dateOnlyToDb(range.to) } }, lastDayOnOrAfter(range.from), kindFilter(range.kind)] },
    orderBy: soonestFirst,
    take: CALENDAR_MONTH_LIMIT,
    select: itemSelect,
  });
  return rows.map(toItem);
}

/** Events that haven't ended (their last day is today or later), soonest first. */
export async function getUpcomingCalendarEvents(
  options: { today: DateOnly; kind?: CalendarEventKind; limit?: number },
  db: Db = prisma,
): Promise<{ items: CalendarEventItem[]; truncated: boolean }> {
  const limit = options.limit ?? CALENDAR_UPCOMING_LIMIT;
  const rows = await db.calendarEvent.findMany({
    where: { AND: [lastDayOnOrAfter(options.today), kindFilter(options.kind)] },
    orderBy: soonestFirst,
    take: limit + 1,
    select: itemSelect,
  });
  return { items: rows.slice(0, limit).map(toItem), truncated: rows.length > limit };
}

/** Events that are over (their last day is before today), most recent first. */
export async function getPastCalendarEvents(
  options: { today: DateOnly; kind?: CalendarEventKind; limit?: number },
  db: Db = prisma,
): Promise<{ items: CalendarEventItem[]; total: number }> {
  const where: Prisma.CalendarEventWhereInput = { AND: [lastDayBefore(options.today), kindFilter(options.kind)] };
  const [rows, total] = await Promise.all([
    db.calendarEvent.findMany({
      where,
      orderBy: [{ startsOn: "desc" }, { startTime: { sort: "desc", nulls: "last" } }, { title: "asc" }, { id: "asc" }],
      take: options.limit ?? CALENDAR_PAST_LIMIT,
      select: itemSelect,
    }),
    db.calendarEvent.count({ where }),
  ]);
  return { items: rows.map(toItem), total };
}

export interface NextMeet {
  /** The next league meet / ILT / scrimmage / competition (possibly happening right now). */
  event: CalendarEventItem;
  /** The one or two meets after it ("then …"). */
  following: CalendarEventItem[];
}

/**
 * Events that aren't over at `time` ("HH:MM", team timezone) on `today`: their last day is later, or it's today
 * and they have no end time or it hasn't passed (see eventIsOver). Written without NOT, so null times match.
 */
function notOverAt(today: DateOnly, time: string | null): Prisma.CalendarEventWhereInput {
  if (!time) return lastDayOnOrAfter(today);
  const d = dateOnlyToDb(today);
  const endNotPassed: Prisma.CalendarEventWhereInput = { OR: [{ endTime: null }, { endTime: { gt: time } }] };
  return {
    OR: [
      { endsOn: { gt: d } },
      { endsOn: null, startsOn: { gt: d } },
      { AND: [{ endsOn: d }, endNotPassed] },
      { AND: [{ endsOn: null, startsOn: d }, endNotPassed] },
    ],
  };
}

/**
 * The next meet: the first event of a CALENDAR_MEET_KINDS kind that isn't over (its last day is today or later,
 * so a multi-day tournament in progress counts; one that ended earlier today doesn't), by first day then start
 * time; plus the two after it. `time` is the team timezone's "HH:MM" now (null: count all of today). Null when
 * nothing is coming up.
 */
export async function getNextMeet(today: DateOnly, time: string | null = null, db: Db = prisma): Promise<NextMeet | null> {
  const rows = await db.calendarEvent.findMany({
    where: { AND: [{ kind: { in: CALENDAR_MEET_KINDS } }, notOverAt(today, time)] },
    orderBy: soonestFirst,
    take: 3,
    select: itemSelect,
  });
  if (rows.length === 0) return null;
  const [event, ...following] = rows.map(toItem);
  return { event, following };
}

/**
 * How long after the ILT it still counts as this season's. FTC seasons' ILTs are in winter and the next season's
 * meets start in the fall, so by then "date TBD" shows again until leaders add the new one.
 */
export const ILT_SEASON_LOOKBACK_DAYS = 120;

/** Whether this season's ILT is on the calendar: an ILT event that's coming up or ended in the last 120 days. */
export async function isIltOnCalendar(today: DateOnly, db: Db = prisma): Promise<boolean> {
  const since = addDays(today, -ILT_SEASON_LOOKBACK_DAYS);
  return (await db.calendarEvent.count({ where: { AND: [{ kind: "ILT" }, lastDayOnOrAfter(since)] } })) > 0;
}

/** One event with who added and last edited it; null when it doesn't exist. */
export async function getCalendarEvent(actor: ActorLike, id: string, db: Db = prisma): Promise<CalendarEventDetail | null> {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  const row = await db.calendarEvent.findUnique({
    where: { id },
    select: {
      ...itemSelect,
      notes: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { id: true, name: true } },
      updatedBy: { select: { id: true, name: true } },
    },
  });
  if (!row) return null;
  return {
    ...toItem(row),
    notes: row.notes,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.updatedAt.toISOString(),
    canManage: canManageCalendarFor(actor),
  };
}

const icsSelect = { ...itemSelect, notes: true, updatedAt: true } satisfies Prisma.CalendarEventSelect;

function toIcsEvent(row: Prisma.CalendarEventGetPayload<{ select: typeof icsSelect }>): IcsEvent {
  return { ...toItem(row), notes: row.notes, updatedAt: row.updatedAt };
}

/** Everything for "Add to my calendar": events whose last day is on or after `since`, soonest first. */
export async function getCalendarEventsForExport(since: DateOnly, db: Db = prisma): Promise<IcsEvent[]> {
  const rows = await db.calendarEvent.findMany({
    where: lastDayOnOrAfter(since),
    orderBy: soonestFirst,
    take: CALENDAR_EXPORT_LIMIT,
    select: icsSelect,
  });
  return rows.map(toIcsEvent);
}

/** One event for its own .ics file; null when it doesn't exist. */
export async function getCalendarEventForExport(id: string, db: Db = prisma): Promise<IcsEvent | null> {
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  const row = await db.calendarEvent.findUnique({ where: { id }, select: icsSelect });
  return row ? toIcsEvent(row) : null;
}
