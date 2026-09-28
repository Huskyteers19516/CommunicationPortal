import "server-only";
// Announcements (read side). Every ACTIVE person reads every announcement; who one is "for" (the whole team or one
// subteam) only decides whose nav badge and Today card it shows up on ("for you": the whole team's plus your
// subteam's; the captain, mentors, teachers, and owners: all of them).
// "New" / unread = posted after the person last opened Announcements (User.announcementsSeenAt; never opened: when
// the account was created), not by them.
import type { Prisma } from "@/generated/prisma/client";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { type AnnouncementAudienceFilter, type AnnouncementFormValues, audienceValue } from "@/lib/announcements";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { announcementAudiences, canEditAnnouncement, hasAllScope, ledSubteam } from "../permissions";

type Viewer = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;
type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

/** Announcements per page of the list. */
export const ANNOUNCEMENTS_PAGE_SIZE = 20;
/** Unread announcements listed on Today. */
export const TODAY_ANNOUNCEMENTS_MAX = 3;

// ---------- who it's for ----------

/** Whose announcements are "for" this person: all of them (all-scope staff), or the whole team's plus one subteam's. */
export function announcementsForYou(actor: ActorLike): { all: true } | { all: false; subteam: Subteam | null } {
  if (hasAllScope(actor)) return { all: true };
  return { all: false, subteam: ledSubteam(actor) ?? actor.subteam };
}

/** Whether an announcement for `subteam` (null = the whole team) is "for" this person. */
export function isAnnouncementForYou(actor: ActorLike, subteam: Subteam | null): boolean {
  const scope = announcementsForYou(actor);
  return scope.all || subteam === null || subteam === scope.subteam;
}

/** Where-clause: the announcements "for" this person (mirror of isAnnouncementForYou). */
export function announcementsForYouWhere(actor: ActorLike): Prisma.AnnouncementWhereInput {
  const scope = announcementsForYou(actor);
  if (scope.all) return {};
  return scope.subteam ? { OR: [{ subteam: null }, { subteam: scope.subteam }] } : { subteam: null };
}

/** Where-clause: not posted by this person (announcements whose author was deleted count as someone else's). */
function notMineWhere(actor: ActorLike): Prisma.AnnouncementWhereInput {
  return { OR: [{ authorId: null }, { authorId: { not: actor.id } }] };
}

/** The list's "For" chip as a where-clause. */
function audienceFilterWhere(actor: ActorLike, filter: AnnouncementAudienceFilter | undefined): Prisma.AnnouncementWhereInput {
  if (!filter) return {};
  if (filter === "you") return announcementsForYouWhere(actor);
  if (filter === "team") return { subteam: null };
  return { subteam: filter };
}

// ---------- seen / unread ----------

/**
 * When this person last opened Announcements — or, if they never have, when their account was created (so a new
 * member doesn't start with every old announcement marked new). Null when the account doesn't exist.
 */
export async function getAnnouncementsSeenSince(actor: Pick<Actor, "id">, db: Db = prisma): Promise<Date | null> {
  const row = await db.user.findUnique({ where: { id: actor.id }, select: { announcementsSeenAt: true, createdAt: true } });
  return row ? (row.announcementsSeenAt ?? row.createdAt) : null;
}

/**
 * Nav badge: announcements for this person, not their own, posted after they last opened Announcements (never
 * opened: after their account was created). One query.
 */
export async function countUnreadAnnouncements(actor: Viewer, db: Db = prisma): Promise<number> {
  if (actor.status !== "ACTIVE") return 0;
  const scope = announcementsForYou(actor);
  const all = scope.all;
  const subteam = scope.all ? null : scope.subteam;
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM "Announcement" a, "User" u
    WHERE u.id = ${actor.id}
      AND a."createdAt" > COALESCE(u."announcementsSeenAt", u."createdAt")
      AND a."authorId" IS DISTINCT FROM ${actor.id}
      AND (${all}::boolean OR a.subteam IS NULL OR a.subteam::text = ${subteam}::text)`;
  return Number(rows[0]?.n ?? 0);
}

/** Where-clause: the announcements that are unread for this person, given when they last opened Announcements. */
export function unreadAnnouncementsWhere(actor: ActorLike, since: Date): Prisma.AnnouncementWhereInput {
  return { AND: [announcementsForYouWhere(actor), notMineWhere(actor), { createdAt: { gt: since } }] };
}

export interface UnreadAnnouncement {
  id: string;
  title: string;
  subteam: Subteam | null;
  /** Null when the author's account was deleted. */
  authorName: string | null;
  createdAt: Date;
}

/**
 * Today: the newest unread announcements for this person (up to `limit`) and how many are unread in all. One query
 * (the same rules as the nav badge's, plus the author's name; the total is counted before the limit).
 */
export async function listUnreadAnnouncements(
  actor: Viewer,
  limit = TODAY_ANNOUNCEMENTS_MAX,
  db: Db = prisma,
): Promise<{ items: UnreadAnnouncement[]; total: number }> {
  if (actor.status !== "ACTIVE") return { items: [], total: 0 };
  const scope = announcementsForYou(actor);
  const all = scope.all;
  const subteam = scope.all ? null : scope.subteam;
  const take = Math.max(1, Math.trunc(limit) || 1);
  const rows = await db.$queryRaw<
    { id: string; title: string; subteam: Subteam | null; createdAt: Date; authorName: string | null; total: number }[]
  >`
    SELECT a.id, a.title, a.subteam::text AS subteam, a."createdAt", author.name AS "authorName", count(*) OVER ()::int AS total
    FROM "Announcement" a
    JOIN "User" u ON u.id = ${actor.id}
    LEFT JOIN "User" author ON author.id = a."authorId"
    WHERE a."createdAt" > COALESCE(u."announcementsSeenAt", u."createdAt")
      AND a."authorId" IS DISTINCT FROM ${actor.id}
      AND (${all}::boolean OR a.subteam IS NULL OR a.subteam::text = ${subteam}::text)
    ORDER BY a."createdAt" DESC, a.id DESC
    LIMIT ${take}::int`;
  return {
    items: rows.map((r) => ({ id: r.id, title: r.title, subteam: r.subteam, authorName: r.authorName, createdAt: r.createdAt })),
    total: Number(rows[0]?.total ?? 0),
  };
}

// ---------- the list ----------

export interface AnnouncementAuthor {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
  isAdmin: boolean;
}

export interface AnnouncementItem {
  id: string;
  title: string;
  body: string;
  /** Who it's for (null = the whole team). */
  subteam: Subteam | null;
  pinned: boolean;
  /** Null when the author's account was deleted. */
  author: AnnouncementAuthor | null;
  createdAt: Date;
  /** Set when the title or text changed after it was posted. */
  editedAt: Date | null;
  /** The edit form's `version` (updatedAt, ISO). */
  version: string;
  /** The viewer posted it. */
  mine: boolean;
  /** It's for the viewer (the whole team's, their subteam's, or everything for all-scope staff). */
  forYou: boolean;
  /** The viewer may edit, pin, or remove it. */
  canEdit: boolean;
}

export interface AnnouncementList {
  items: AnnouncementItem[];
  /** Announcements matching the filter (all pages). */
  total: number;
  page: number;
  pageCount: number;
  /** There's at least one announcement (ignoring the filter) — tells "none yet" from "none match". */
  anyAtAll: boolean;
  /** Who the viewer can post for (null = the whole team); [] = they can't post. */
  audiences: (Subteam | null)[];
}

const itemSelect = {
  id: true,
  title: true,
  body: true,
  subteam: true,
  pinned: true,
  authorId: true,
  createdAt: true,
  editedAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, role: true, subteam: true, isAdmin: true } },
} as const satisfies Prisma.AnnouncementSelect;

type ItemRow = Prisma.AnnouncementGetPayload<{ select: typeof itemSelect }>;

function toItem(row: ItemRow, viewer: ActorLike): AnnouncementItem {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    subteam: row.subteam,
    pinned: row.pinned,
    author: row.author,
    createdAt: row.createdAt,
    editedAt: row.editedAt,
    version: row.updatedAt.toISOString(),
    mine: row.authorId !== null && row.authorId === viewer.id,
    forYou: isAnnouncementForYou(viewer, row.subteam),
    canEdit: canEditAnnouncement(viewer, { authorId: row.authorId }),
  };
}

const LIST_ORDER = [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }] satisfies Prisma.AnnouncementOrderByWithRelationInput[];

/** How many announcements come before this one in the list's order (pinned first, then newest). */
async function positionOf(db: Db, where: Prisma.AnnouncementWhereInput, id: string): Promise<number | null> {
  if (id.length > 64) return null;
  const row = await db.announcement.findFirst({ where: { AND: [where, { id }] }, select: { pinned: true, createdAt: true } });
  if (!row) return null;
  const pinnedBefore: Prisma.AnnouncementWhereInput = row.pinned ? { id: { in: [] } } : { pinned: true };
  return db.announcement.count({
    where: {
      AND: [
        where,
        {
          OR: [
            pinnedBefore,
            { pinned: row.pinned, createdAt: { gt: row.createdAt } },
            { pinned: row.pinned, createdAt: row.createdAt, id: { gt: id } },
          ],
        },
      ],
    },
  });
}

/**
 * One page of announcements, pinned first and then the newest, with the "For" chip applied. Without a `page`,
 * `focusId` opens the page that has that announcement (from Today, or after posting or editing it). Null for
 * accounts that aren't active.
 */
export async function listAnnouncements(
  viewer: Viewer,
  opts: { for?: AnnouncementAudienceFilter; page?: number; focusId?: string } = {},
  db: Db = prisma,
): Promise<AnnouncementList | null> {
  if (viewer.status !== "ACTIVE") return null;
  const where = audienceFilterWhere(viewer, opts.for);
  const [total, anyAtAll] = await Promise.all([
    db.announcement.count({ where }),
    opts.for ? db.announcement.count({ take: 1 }).then((n) => n > 0) : Promise.resolve(true),
  ]);
  const pageCount = Math.max(1, Math.ceil(total / ANNOUNCEMENTS_PAGE_SIZE));

  let page = opts.page ?? 1;
  if (opts.page === undefined && opts.focusId) {
    const index = await positionOf(db, where, opts.focusId);
    if (index !== null) page = Math.floor(index / ANNOUNCEMENTS_PAGE_SIZE) + 1;
  }
  page = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);

  const rows =
    total === 0
      ? []
      : await db.announcement.findMany({
          where,
          orderBy: LIST_ORDER,
          skip: (page - 1) * ANNOUNCEMENTS_PAGE_SIZE,
          take: ANNOUNCEMENTS_PAGE_SIZE,
          select: itemSelect,
        });
  return {
    items: rows.map((r) => toItem(r, viewer)),
    total,
    page,
    pageCount,
    anyAtAll: total > 0 || anyAtAll,
    audiences: announcementAudiences(viewer),
  };
}

/** One announcement (the edit page), or null when it doesn't exist or the viewer isn't active. */
export async function getAnnouncement(viewer: Viewer, id: string, db: Db = prisma): Promise<AnnouncementItem | null> {
  if (viewer.status !== "ACTIVE" || !id || id.length > 64) return null;
  const row = await db.announcement.findUnique({ where: { id }, select: itemSelect });
  return row ? toItem(row, viewer) : null;
}

/** An announcement as the edit form shows it (with its `version`), or null unless the viewer may edit it. */
export async function getAnnouncementFormValues(viewer: Viewer, id: string, db: Db = prisma): Promise<AnnouncementFormValues | null> {
  const item = await getAnnouncement(viewer, id, db);
  if (!item?.canEdit) return null;
  return {
    id: item.id,
    version: item.version,
    title: item.title,
    body: item.body,
    audience: audienceValue(item.subteam),
    pinned: item.pinned,
  };
}
