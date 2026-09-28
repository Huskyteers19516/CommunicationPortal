import "server-only";
// Meeting updates (/updates): every ACTIVE person reads every subteam's updates. The feed is paged by
// meeting day (newest first); each day holds every update written for it, grouped by subteam.
import type { Prisma } from "@/generated/prisma/client";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { type DateOnly, dateOnlyToDb, dbToDateOnly, isDateOnly } from "@/lib/dates";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canEditMeetingUpdate, meetingUpdateSubteams } from "../permissions";

type Viewer = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;

/** Meeting days per page of the feed. */
export const MEETING_DAYS_PER_PAGE = 10;
/** Safety cap on the updates loaded for one page (a normal day has a handful). Past it, the newest are kept. */
export const PAGE_UPDATES_MAX = 500;

export interface MeetingUpdatePerson {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
}

export interface MeetingUpdateItem {
  id: string;
  meetingDate: DateOnly;
  subteam: Subteam;
  /** "What we did". */
  body: string;
  /** "Next time" ("" = not filled in). */
  nextSteps: string;
  /** "Problems or help needed" ("" = none). */
  blockers: string;
  /** Null when the author's account was deleted. */
  author: MeetingUpdatePerson | null;
  createdAt: Date;
  /** Set once someone changes it after it was posted. */
  lastEditedAt: Date | null;
  lastEditedBy: { id: string; name: string } | null;
  /** The viewer wrote it. */
  mine: boolean;
  /** The viewer may edit or remove it. */
  canEdit: boolean;
}

export interface MeetingDay {
  date: DateOnly;
  /** Each subteam's updates that day, in the order they were written ([] = none). */
  bySubteam: Record<Subteam, MeetingUpdateItem[]>;
}

export interface MeetingUpdatesFeed {
  days: MeetingDay[];
  page: number;
  pageCount: number;
  /** Meeting days that match the filters. */
  dayCount: number;
  /** There's at least one update (ignoring the filters) — tells "nothing yet" from "nothing matches". */
  anyAtAll: boolean;
  /** Subteams the viewer can write for (the "Write one" links). */
  writable: Subteam[];
}

const itemSelect = {
  id: true,
  meetingDate: true,
  subteam: true,
  body: true,
  nextSteps: true,
  blockers: true,
  authorId: true,
  createdAt: true,
  lastEditedAt: true,
  author: { select: { id: true, name: true, role: true, subteam: true } },
  lastEditedBy: { select: { id: true, name: true } },
} as const satisfies Prisma.MeetingUpdateSelect;

type ItemRow = Prisma.MeetingUpdateGetPayload<{ select: typeof itemSelect }>;

function toItem(row: ItemRow, viewer: Viewer): MeetingUpdateItem {
  return {
    id: row.id,
    meetingDate: dbToDateOnly(row.meetingDate),
    subteam: row.subteam,
    body: row.body,
    nextSteps: row.nextSteps,
    blockers: row.blockers,
    author: row.author,
    createdAt: row.createdAt,
    lastEditedAt: row.lastEditedAt,
    lastEditedBy: row.lastEditedAt ? row.lastEditedBy : null,
    mine: row.authorId !== null && row.authorId === viewer.id,
    canEdit: canEditMeetingUpdate(viewer, { authorId: row.authorId, subteam: row.subteam }),
  };
}

function emptyBySubteam(): Record<Subteam, MeetingUpdateItem[]> {
  return { SOFTWARE: [], BUILD: [], BUSINESS: [] };
}

function feedWhere(viewer: Viewer, opts: { subteam?: Subteam; mine?: boolean }): Prisma.MeetingUpdateWhereInput {
  return {
    ...(opts.subteam ? { subteam: opts.subteam } : {}),
    ...(opts.mine ? { authorId: viewer.id } : {}),
  };
}

/**
 * One page of the feed: meeting days newest first (`MEETING_DAYS_PER_PAGE` a page), each with its updates
 * grouped by subteam. Filters: one subteam, and/or only updates the viewer wrote (`mine`). Without a `page`,
 * `focusId` opens the page that has that update (after saving it). Null for accounts that aren't active.
 */
export async function getMeetingUpdatesFeed(
  viewer: Viewer,
  opts: { subteam?: Subteam; mine?: boolean; page?: number; focusId?: string } = {},
  db: Db = prisma,
): Promise<MeetingUpdatesFeed | null> {
  if (viewer.status !== "ACTIVE") return null;
  const where = feedWhere(viewer, opts);
  const dayRows = await db.meetingUpdate.groupBy({ by: ["meetingDate"], where, orderBy: { meetingDate: "desc" } });
  const allDays = dayRows.map((r) => dbToDateOnly(r.meetingDate));
  const pageCount = Math.max(1, Math.ceil(allDays.length / MEETING_DAYS_PER_PAGE));

  let page = opts.page ?? 1;
  if (opts.page === undefined && opts.focusId && opts.focusId.length <= 64) {
    const focus = await db.meetingUpdate.findFirst({ where: { AND: [where, { id: opts.focusId }] }, select: { meetingDate: true } });
    const index = focus ? allDays.indexOf(dbToDateOnly(focus.meetingDate)) : -1;
    if (index >= 0) page = Math.floor(index / MEETING_DAYS_PER_PAGE) + 1;
  }
  page = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);

  const pageDays = allDays.slice((page - 1) * MEETING_DAYS_PER_PAGE, page * MEETING_DAYS_PER_PAGE);
  // Newest first so that, past the cap, the most recently written updates are the ones kept; then oldest first.
  const rows =
    pageDays.length === 0
      ? []
      : (
          await db.meetingUpdate.findMany({
            where: { AND: [where, { meetingDate: { in: pageDays.map(dateOnlyToDb) } }] },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: PAGE_UPDATES_MAX,
            select: itemSelect,
          })
        ).reverse();

  const byDay = new Map<DateOnly, MeetingDay>(pageDays.map((date) => [date, { date, bySubteam: emptyBySubteam() }]));
  for (const row of rows) {
    const item = toItem(row, viewer);
    byDay.get(item.meetingDate)?.bySubteam[item.subteam].push(item);
  }

  const filtered = !!opts.subteam || !!opts.mine;
  const anyAtAll = allDays.length > 0 || (filtered && (await db.meetingUpdate.findFirst({ select: { id: true } })) !== null);

  return {
    days: pageDays.map((date) => byDay.get(date)!),
    page,
    pageCount,
    dayCount: allDays.length,
    anyAtAll,
    writable: meetingUpdateSubteams(viewer),
  };
}

export interface MeetingUpdateDetail extends MeetingUpdateItem {
  /** updatedAt (ISO) — the edit form sends it back as `version`. */
  version: string;
}

/** One update (e.g. for the edit page), or null when it doesn't exist or the viewer isn't active. */
export async function getMeetingUpdate(viewer: Viewer, id: string, db: Db = prisma): Promise<MeetingUpdateDetail | null> {
  if (viewer.status !== "ACTIVE" || !id || id.length > 64) return null;
  const row = await db.meetingUpdate.findUnique({ where: { id }, select: { ...itemSelect, updatedAt: true } });
  if (!row) return null;
  return { ...toItem(row, viewer), version: row.updatedAt.toISOString() };
}

// ---------- for other features ----------

export interface MeetingUpdateSummary {
  id: string;
  meetingDate: DateOnly;
  subteam: Subteam;
  body: string;
  nextSteps: string;
  blockers: string;
  authorId: string | null;
  /** Null when the author's account was deleted. */
  authorName: string | null;
  createdAt: Date;
  lastEditedAt: Date | null;
  lastEditedByName: string | null;
}

/** At most this many updates come back from getMeetingUpdatesBetween (a two-week report has a few dozen). */
export const MEETING_UPDATES_BETWEEN_MAX = 1000;

/**
 * Every meeting update from `start` through `end` (inclusive, "YYYY-MM-DD" team-timezone days), ordered by
 * day, then subteam (Software, Build, Business), then when it was written. For reports (e.g. attendance's
 * two-week report). No viewer check: every ACTIVE person may read every update — callers guard their page.
 */
export async function getMeetingUpdatesBetween(start: DateOnly, end: DateOnly, db: Db = prisma): Promise<MeetingUpdateSummary[]> {
  if (!isDateOnly(start) || !isDateOnly(end) || start > end) return [];
  const rows = await db.meetingUpdate.findMany({
    where: { meetingDate: { gte: dateOnlyToDb(start), lte: dateOnlyToDb(end) } },
    // Postgres sorts the Subteam enum in its declared order: Software, Build, Business.
    orderBy: [{ meetingDate: "asc" }, { subteam: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: MEETING_UPDATES_BETWEEN_MAX,
    select: {
      id: true,
      meetingDate: true,
      subteam: true,
      body: true,
      nextSteps: true,
      blockers: true,
      authorId: true,
      createdAt: true,
      lastEditedAt: true,
      author: { select: { name: true } },
      lastEditedBy: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
      id: r.id,
      meetingDate: dbToDateOnly(r.meetingDate),
      subteam: r.subteam,
      body: r.body,
      nextSteps: r.nextSteps,
      blockers: r.blockers,
      authorId: r.authorId,
      authorName: r.author?.name ?? null,
      createdAt: r.createdAt,
      lastEditedAt: r.lastEditedAt,
    lastEditedByName: r.lastEditedAt ? (r.lastEditedBy?.name ?? null) : null,
  }));
}

// ---------- Today page ----------

export interface TodayUpdateStatus {
  today: DateOnly;
  /** The subteams the viewer writes for, each with today's updates (oldest first; [] = none yet). */
  subteams: { subteam: Subteam; updates: { id: string; authorName: string | null; mine: boolean }[] }[];
}

/**
 * Whether today's meeting update exists for each subteam the viewer writes for (their own; the captain,
 * mentors, teachers, and owners: all three). Null when there's nothing to show (no such subteam, or the
 * account isn't active) — TodayUpdateNudge then renders nothing.
 */
export async function getTodayUpdateStatus(viewer: Viewer, today: DateOnly, db: Db = prisma): Promise<TodayUpdateStatus | null> {
  if (viewer.status !== "ACTIVE" || !isDateOnly(today)) return null;
  const subteams = meetingUpdateSubteams(viewer);
  if (subteams.length === 0) return null;
  const rows = await db.meetingUpdate.findMany({
    where: { meetingDate: dateOnlyToDb(today), subteam: { in: subteams } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 50,
    select: { id: true, subteam: true, authorId: true, author: { select: { name: true } } },
  });
  return {
    today,
    subteams: subteams.map((subteam) => ({
      subteam,
      updates: rows
        .filter((r) => r.subteam === subteam)
        .map((r) => ({ id: r.id, authorName: r.author?.name ?? null, mine: r.authorId !== null && r.authorId === viewer.id })),
    })),
  };
}
