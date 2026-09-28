import "server-only";
// Discussion (/discussion), read side: the nav badge, the list, one discussion's page, and its edit form.
// Everyone ACTIVE sees every discussion. "Unread" for me = its last activity is newer than my read mark (or, if I
// never opened it, than when my account was made) and wasn't mine — the same rule for the badge and the list.
import { Prisma } from "@/generated/prisma/client";
import type { DiscussionCategory, Role, Subteam } from "@/generated/prisma/enums";
import {
  DISCUSSION_PAGE_SIZE,
  DISCUSSION_REPLIES_SHOWN_MAX,
  DISCUSSION_SEARCH_MAX,
  type DiscussionFilters,
  firstNewReplyId,
} from "@/lib/discussion";
import { cleanSearchText, escapeLike } from "@/lib/search";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canEditDiscussionPost, canModerateDiscussion } from "../permissions";

type Viewer = Pick<Actor, "id" | "status" | "role" | "subteam" | "isAdmin">;

/**
 * The unread rule over `t` (DiscussionThread), `r` (my DiscussionRead, LEFT JOINed) and `u` (my User row).
 * A deleted account's activity (lastActivityById null) counts as someone else's.
 */
const UNREAD = Prisma.sql`(t."lastActivityAt" > COALESCE(r."lastReadAt", u."createdAt") AND t."lastActivityById" IS DISTINCT FROM u."id")`;

/** Nav badge: discussions with activity from someone else since I last opened them. One query. */
export async function countUnreadDiscussions(actor: Pick<Actor, "id" | "status">, db: Db = prisma): Promise<number> {
  if (actor.status !== "ACTIVE") return 0;
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM "DiscussionThread" t
    JOIN "User" u ON u."id" = ${actor.id}
    LEFT JOIN "DiscussionRead" r ON r."threadId" = t."id" AND r."userId" = u."id"
    WHERE ${UNREAD}`;
  return rows[0]?.n ?? 0;
}

// ---------- the list ----------

export interface DiscussionThreadCard {
  id: string;
  title: string;
  category: DiscussionCategory;
  pinned: boolean;
  locked: boolean;
  replyCount: number;
  /** Who started it (null: an account that was deleted). */
  authorName: string | null;
  /** I started it. */
  mine: boolean;
  createdAt: Date;
  lastActivityAt: Date;
  lastActivityByName: string | null;
  lastActivityMine: boolean;
  /** Something new from someone else since I last opened it. */
  unread: boolean;
  /** Unread, and someone else started it after I joined and I've never opened it: the whole discussion is new to me. */
  isNew: boolean;
  /** Unread replies by others (0 when read). */
  newReplies: number;
}

export interface DiscussionThreadList {
  items: DiscussionThreadCard[];
  /** Discussions matching the filters (all pages). */
  total: number;
  page: number;
  pageCount: number;
}

type ThreadRow = {
  id: string;
  title: string;
  category: DiscussionCategory;
  pinned: boolean;
  locked: boolean;
  replyCount: number;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  lastActivityById: string | null;
  lastActivityByName: string | null;
  readAt: Date | null;
  joinedAt: Date;
  unread: boolean;
  newReplies: number;
};

/**
 * One page of discussions, pinned first and then the latest activity, filtered by category, unread, mine, and a
 * title search (`%` and `_` match themselves). Null for accounts that aren't active.
 */
export async function listDiscussionThreads(
  actor: Pick<Actor, "id" | "status">,
  filters: DiscussionFilters,
  pageWanted = 1,
  db: Db = prisma,
): Promise<DiscussionThreadList | null> {
  if (actor.status !== "ACTIVE") return null;
  const conditions: Prisma.Sql[] = [];
  if (filters.category) conditions.push(Prisma.sql`t."category" = ${filters.category}::"DiscussionCategory"`);
  if (filters.mine) conditions.push(Prisma.sql`t."authorId" = u."id"`);
  if (filters.unread) conditions.push(UNREAD);
  const q = cleanSearchText(filters.q, DISCUSSION_SEARCH_MAX);
  // LIKE's escape character is "\" by default, which is what escapeLike uses.
  if (q) conditions.push(Prisma.sql`t."title" ILIKE ${`%${escapeLike(q)}%`}`);
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}` : Prisma.empty;
  const from = Prisma.sql`
    FROM "DiscussionThread" t
    JOIN "User" u ON u."id" = ${actor.id}
    LEFT JOIN "DiscussionRead" r ON r."threadId" = t."id" AND r."userId" = u."id"`;

  const [{ n: total }] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n ${from} ${where}`;
  const pageCount = Math.max(1, Math.ceil(total / DISCUSSION_PAGE_SIZE));
  const page = Math.min(Math.max(1, pageWanted), pageCount);
  const rows = await db.$queryRaw<ThreadRow[]>`
    SELECT t."id", t."title", t."category", t."pinned", t."locked", t."replyCount",
      t."authorId", a."name" AS "authorName", t."createdAt", t."lastActivityAt",
      t."lastActivityById", la."name" AS "lastActivityByName",
      r."lastReadAt" AS "readAt", u."createdAt" AS "joinedAt",
      ${UNREAD} AS "unread",
      CASE WHEN ${UNREAD} THEN (
        SELECT count(*)::int FROM "DiscussionReply" x
        WHERE x."threadId" = t."id" AND x."createdAt" > COALESCE(r."lastReadAt", u."createdAt")
          AND x."authorId" IS DISTINCT FROM u."id"
      ) ELSE 0 END AS "newReplies"
    ${from}
    LEFT JOIN "User" a ON a."id" = t."authorId"
    LEFT JOIN "User" la ON la."id" = t."lastActivityById"
    ${where}
    ORDER BY t."pinned" DESC, t."lastActivityAt" DESC, t."id" DESC
    LIMIT ${DISCUSSION_PAGE_SIZE} OFFSET ${(page - 1) * DISCUSSION_PAGE_SIZE}`;

  const items = rows.map(
    (r): DiscussionThreadCard => ({
      id: r.id,
      title: r.title,
      category: r.category,
      pinned: r.pinned,
      locked: r.locked,
      replyCount: r.replyCount,
      authorName: r.authorName,
      mine: r.authorId === actor.id,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      lastActivityByName: r.lastActivityByName,
      lastActivityMine: r.lastActivityById === actor.id,
      unread: r.unread,
      isNew: r.unread && r.readAt === null && r.createdAt > r.joinedAt && r.authorId !== actor.id,
      newReplies: r.newReplies,
    }),
  );
  return { items, total, page, pageCount };
}

// ---------- one discussion ----------

export interface DiscussionAuthor {
  name: string;
  role: Role;
  subteam: Subteam | null;
  isAdmin: boolean;
}

export interface DiscussionReplyView {
  id: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  /** The reply's updatedAt (ISO), sent back by its edit form. */
  version: string;
  /** Null: an account that was deleted. */
  author: DiscussionAuthor | null;
  mine: boolean;
  /** Change its text: whoever wrote it, while the discussion isn't locked. */
  canEdit: boolean;
  /** Whoever wrote it (while the discussion isn't locked), and people with admin access. */
  canDelete: boolean;
}

export interface DiscussionThreadView {
  id: string;
  title: string;
  body: string;
  category: DiscussionCategory;
  pinned: boolean;
  locked: boolean;
  /** Replies (all of them: when some are left out, the discussion's count). */
  replyCount: number;
  createdAt: Date;
  editedAt: Date | null;
  /** The discussion's updatedAt (ISO): its edit form's version. */
  version: string;
  lastActivityAt: Date;
  /**
   * The newest activity this page shows (the newest reply on it, else the discussion itself): what opening the page
   * marks read. Taken from what was loaded, never from the discussion's lastActivityAt, which is read separately
   * and may already include a reply that isn't on the page.
   */
  seen: Date;
  author: DiscussionAuthor | null;
  mine: boolean;
  /** Oldest first: the newest DISCUSSION_REPLIES_SHOWN_MAX. */
  replies: DiscussionReplyView[];
  /** Older replies left out (only when the page is full). */
  olderHidden: number;
  /** The reply the "New" divider goes before (the first one by someone else since I last opened it), or null. */
  newFromReplyId: string | null;
  canEdit: boolean;
  canDelete: boolean;
  /** Pin, lock, and delete anything (people with admin access). */
  canModerate: boolean;
  canReply: boolean;
}

const authorSelect = { select: { name: true, role: true, subteam: true, isAdmin: true } } as const;

/** One discussion with its (latest) replies for its page, or null (missing, or an account that isn't active). */
export async function getDiscussionThread(actor: Viewer, id: string, db: Db = prisma): Promise<DiscussionThreadView | null> {
  if (actor.status !== "ACTIVE" || !id || id.length > 64) return null;
  const [thread, latest, read, me, othersReplies] = await Promise.all([
    db.discussionThread.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        body: true,
        category: true,
        pinned: true,
        locked: true,
        replyCount: true,
        createdAt: true,
        editedAt: true,
        updatedAt: true,
        lastActivityAt: true,
        authorId: true,
        author: authorSelect,
      },
    }),
    db.discussionReply.findMany({
      where: { threadId: id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: DISCUSSION_REPLIES_SHOWN_MAX,
      select: { id: true, body: true, createdAt: true, editedAt: true, updatedAt: true, authorId: true, author: authorSelect },
    }),
    db.discussionRead.findUnique({ where: { userId_threadId: { userId: actor.id, threadId: id } }, select: { lastReadAt: true } }),
    db.user.findUnique({ where: { id: actor.id }, select: { createdAt: true } }),
    db.discussionReply.count({ where: { threadId: id, OR: [{ authorId: null }, { authorId: { not: actor.id } }] } }),
  ]);
  if (!thread) return null;
  const moderator = canModerateDiscussion(actor);
  const mine = canEditDiscussionPost(actor, thread);
  // The reads above aren't one snapshot: a reply saved between them can be in the discussion's count but not in
  // `latest`. So the counts and `seen` come from what was loaded whenever every reply fit on the page.
  const full = latest.length >= DISCUSSION_REPLIES_SHOWN_MAX;
  const newest = latest[0]?.createdAt ?? thread.createdAt;
  const replies = [...latest].reverse().map(
    (r): DiscussionReplyView => {
      const own = canEditDiscussionPost(actor, r);
      return {
        id: r.id,
        body: r.body,
        createdAt: r.createdAt,
        editedAt: r.editedAt,
        version: r.updatedAt.toISOString(),
        author: r.author,
        mine: own,
        canEdit: own && !thread.locked,
        canDelete: moderator || (own && !thread.locked),
      };
    },
  );
  // When I last opened it. Never opened: my own discussion as I wrote it; someone else's since I joined, unless the
  // whole discussion is newer than that (then there's nothing to mark).
  const joinedAt = me?.createdAt ?? thread.createdAt;
  const since = read?.lastReadAt ?? (mine ? thread.createdAt : thread.createdAt <= joinedAt ? joinedAt : null);
  return {
    id: thread.id,
    title: thread.title,
    body: thread.body,
    category: thread.category,
    pinned: thread.pinned,
    locked: thread.locked,
    replyCount: full ? Math.max(thread.replyCount, replies.length) : replies.length,
    createdAt: thread.createdAt,
    editedAt: thread.editedAt,
    version: thread.updatedAt.toISOString(),
    lastActivityAt: thread.lastActivityAt,
    seen: newest,
    author: thread.author,
    mine,
    replies,
    olderHidden: full ? Math.max(0, thread.replyCount - replies.length) : 0,
    newFromReplyId: firstNewReplyId(replies, since),
    canEdit: mine && !thread.locked,
    canDelete: moderator || (mine && !thread.locked && othersReplies === 0),
    canModerate: moderator,
    canReply: !thread.locked,
  };
}

export interface DiscussionThreadForEdit {
  id: string;
  title: string;
  body: string;
  category: DiscussionCategory;
  version: string;
}

/** A discussion for its edit form, or null when I can't change it (not mine, locked, or gone: see discussionExists). */
export async function getDiscussionThreadForEdit(
  actor: Viewer,
  id: string,
  db: Db = prisma,
): Promise<DiscussionThreadForEdit | null> {
  if (actor.status !== "ACTIVE" || !id || id.length > 64) return null;
  const t = await db.discussionThread.findUnique({
    where: { id },
    select: { id: true, title: true, body: true, category: true, updatedAt: true, authorId: true, locked: true },
  });
  if (!t || t.locked || !canEditDiscussionPost(actor, t)) return null;
  return { id: t.id, title: t.title, body: t.body, category: t.category, version: t.updatedAt.toISOString() };
}

/** Whether a discussion is there (for accounts that are active): the edit page sends people to it instead of a 404. */
export async function discussionExists(actor: Pick<Actor, "status">, id: string, db: Db = prisma): Promise<boolean> {
  if (actor.status !== "ACTIVE" || !id || id.length > 64) return false;
  return (await db.discussionThread.count({ where: { id } })) > 0;
}
