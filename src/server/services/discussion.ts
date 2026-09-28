// Discussion (/discussion): the team-wide forum. Everyone ACTIVE reads, starts discussions, and replies (unlike
// Questions, which stay private member → leader threads).
// - A discussion ("thread"): title, text, category. Only whoever started it changes the text (canEditDiscussionPost);
//   a change sets editedAt and is conditional on the version the form loaded (`version` = updatedAt). Only text edits
//   move updatedAt: replies, pins, and locks write with raw SQL, which leaves it alone, so a reply that lands while
//   the author edits isn't a conflict.
// - Deleting one: whoever started it while nobody else has replied; everyone with admin access any time
//   (canModerateDiscussion). Its replies and read marks go with it (cascade).
// - Replies: never on a locked discussion. Locked = frozen: nothing in it is edited, and only people with admin
//   access delete posts in it. Every reply write updates the discussion's replyCount and lastActivityAt/By in the
//   same transaction, with the discussion's row locked first, so they stay right under races; a new reply's time is
//   picked under that lock (never before the last activity), so replies are timed in the order they're saved.
//   Deleting a reply recounts both from what's left.
// - Pin / lock: canModerateDiscussion.
// - Read marks: DiscussionRead(lastReadAt) per person and discussion — set after the page opens (markThreadRead,
//   called by the page, never by loading it) and when you reply. The nav badge and the Unread filter compare it
//   with lastActivityAt (queries/discussion.ts).
// Creates and edits are rate-limited. No emails.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { DiscussionCategory } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { checkbox, normalizeLineBreaks, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import type { Db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError } from "../errors";
import { canEditDiscussionPost, canModerateDiscussion } from "../permissions";
import { consumeRateLimit } from "../rate-limit";

type Tx = Prisma.TransactionClient;

const HOUR = 60 * 60 * 1000;

/** Per person: new discussions, replies, and saved edits (discussions and replies together) an hour. Nobody hits these by hand. */
export const DISCUSSION_RATE_LIMITS = {
  thread: { limit: 10, windowMs: HOUR },
  reply: { limit: 60, windowMs: HOUR },
  edit: { limit: 120, windowMs: HOUR },
} as const;

export const DISCUSSION_NOT_FOUND = "That discussion no longer exists.";
export const DISCUSSION_REPLY_NOT_FOUND = "That reply no longer exists.";
export const DISCUSSION_INACTIVE = "Your account isn't active, so you can't post in Discussion.";
export const DISCUSSION_LOCKED = "This discussion is locked, so it can't take new replies.";
export const DISCUSSION_LOCKED_EDIT = "This discussion is locked, so posts in it can't be changed.";
export const DISCUSSION_LOCKED_DELETE =
  "This discussion is locked, so only a leader, the captain, a mentor, or a teacher can delete posts in it.";
export const DISCUSSION_CANT_EDIT = "Only the person who started this discussion can change it.";
export const DISCUSSION_REPLY_CANT_EDIT = "Only the person who wrote this reply can change it.";
export const DISCUSSION_CANT_DELETE =
  "Only the person who started this discussion, or a leader, the captain, a mentor, or a teacher, can delete it.";
export const DISCUSSION_HAS_REPLIES =
  "Other people have replied, so you can't delete this discussion anymore. Ask a leader if it needs to go.";
export const DISCUSSION_REPLY_CANT_DELETE =
  "Only the person who wrote this reply, or a leader, the captain, a mentor, or a teacher, can delete it.";
export const DISCUSSION_CANT_MODERATE = "Only leaders, the captain, mentors, and teachers can pin or lock discussions.";
export const DISCUSSION_CHANGED =
  "You changed this discussion somewhere else (another tab or device) since this page opened. Your text is still here: save again to replace that version.";
export const DISCUSSION_REPLY_CHANGED =
  "You changed this reply somewhere else (another tab or device) since this page opened. Your text is still here: save again to replace that version.";

// ---------- input ----------

function idField(message: string) {
  return z.string({ error: message }).trim().min(1, message).max(64, message);
}

const threadIdField = idField(DISCUSSION_NOT_FOUND);
const replyIdField = idField(DISCUSSION_REPLY_NOT_FOUND);

const n = (v: number) => v.toLocaleString("en-US");

const threadFields = z.object({
  title: text("Title", LIMITS.discussionTitleMax),
  category: z.enum(DiscussionCategory, { error: "Pick a category." }),
  // A textarea: CRLF line breaks become "\n" before the length check, so text typed up to its maxLength fits.
  body: z
    .string({ error: "Write a few words to get the discussion going." })
    .overwrite(normalizeLineBreaks)
    .trim()
    .min(1, "Write a few words to get the discussion going.")
    .max(LIMITS.discussionBodyMax, `The text can be at most ${n(LIMITS.discussionBodyMax)} characters.`),
});

const replyBody = z
  .string({ error: "Write a reply first." })
  .overwrite(normalizeLineBreaks)
  .trim()
  .min(1, "Write a reply first.")
  .max(LIMITS.discussionReplyMax, `Replies can be at most ${n(LIMITS.discussionReplyMax)} characters.`);

const threadIdInput = z.object({ threadId: threadIdField });
const replyIdInput = z.object({ replyId: replyIdField });
const createReplyInput = z.object({ threadId: threadIdField, body: replyBody });
const updateReplyInput = z.object({ replyId: replyIdField, body: replyBody });
const pinInput = z.object({ threadId: threadIdField, pinned: checkbox });
const lockInput = z.object({ threadId: threadIdField, locked: checkbox });
const readInput = z.object({ threadId: threadIdField, seen: z.string().max(40).optional() });

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(DISCUSSION_INACTIVE);
}

/** The edit form's `version`: the updatedAt it loaded (ISO), or missing (no check). Garbage is a conflict. */
function parseVersion(value: unknown, message: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "string" && value.length <= 40 ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ConflictError(message);
  return date;
}

/** The next version (updatedAt) after `previous`: now, but always later, so every save gets a new one. */
function nextVersion(now: Date, previous: Date): Date {
  return new Date(Math.max(now.getTime(), previous.getTime() + 1));
}

async function throttle(ctx: ServiceContext, kind: keyof typeof DISCUSSION_RATE_LIMITS, message: string) {
  const { limit, windowMs } = DISCUSSION_RATE_LIMITS[kind];
  if (!(await consumeRateLimit(ctx.db, `discussion-${kind}:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError(message);
  }
}

/** Saved edits (counted only when something actually changes). */
function throttleEdits(ctx: ServiceContext) {
  return throttle(ctx, "edit", "You've made a lot of changes in the last hour. Please wait a bit before saving again.");
}

/** Replies written by anyone else (including accounts that were deleted). */
function othersReplies(userId: string): Prisma.DiscussionReplyWhereInput {
  return { OR: [{ authorId: null }, { authorId: { not: userId } }] };
}

/**
 * Locks a discussion's row until the transaction ends (reply writes and deletes take it first) and says whether
 * it's locked (as of now, so a lock that just landed counts). Null: it's gone.
 */
async function lockThread(tx: Tx, threadId: string): Promise<{ locked: boolean } | null> {
  const rows = await tx.$queryRaw<{ locked: boolean }[]>`SELECT "locked" FROM "DiscussionThread" WHERE id = ${threadId} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Recount a discussion's replies and its last activity (the newest reply left, else the discussion itself) from
 * what's in the database. Raw SQL, so updatedAt (the text's version) doesn't move.
 */
async function recountThread(tx: Tx, threadId: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE "DiscussionThread" t SET
      "replyCount" = (SELECT count(*)::int FROM "DiscussionReply" r WHERE r."threadId" = t."id"),
      "lastActivityAt" = COALESCE((SELECT max(r."createdAt") FROM "DiscussionReply" r WHERE r."threadId" = t."id"), t."createdAt"),
      "lastActivityById" = CASE
        WHEN EXISTS (SELECT 1 FROM "DiscussionReply" r WHERE r."threadId" = t."id")
        THEN (SELECT r."authorId" FROM "DiscussionReply" r WHERE r."threadId" = t."id" ORDER BY r."createdAt" DESC, r."id" DESC LIMIT 1)
        ELSE t."authorId"
      END
    WHERE t."id" = ${threadId}`;
}

/** Marks a discussion read up to `at` for this person (never moves an existing mark back). True if the mark moved. */
async function upsertRead(db: Db | Tx, userId: string, threadId: string, at: Date): Promise<boolean> {
  const count = await db.$executeRaw`
    INSERT INTO "DiscussionRead" ("userId", "threadId", "lastReadAt") VALUES (${userId}, ${threadId}, ${at})
    ON CONFLICT ("userId", "threadId") DO UPDATE SET "lastReadAt" = EXCLUDED."lastReadAt"
    WHERE "DiscussionRead"."lastReadAt" < EXCLUDED."lastReadAt"`;
  return count > 0;
}

// ---------- discussions ----------

/** Start a discussion (anyone ACTIVE). */
export async function createThread(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const data = parseInput(threadFields, asRecord(raw));
  // Counted only once the form is valid, so fixing a typo never uses up the allowance.
  await throttle(ctx, "thread", "You've started a lot of discussions in the last hour. Please wait a bit before starting another.");
  const { id } = await ctx.db.discussionThread.create({
    data: {
      ...data,
      authorId: ctx.actor.id,
      lastActivityAt: ctx.now,
      lastActivityById: ctx.actor.id,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    },
    select: { id: true },
  });
  return { id };
}

/**
 * Change a discussion's title, category, or text (whoever started it; not while it's locked). With `version`
 * (the updatedAt the form loaded) the save is refused if it changed since. Saving it unchanged writes nothing.
 */
export async function updateThread(ctx: ServiceContext, raw: unknown): Promise<{ id: string; changed: boolean }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { threadId } = parseInput(threadIdInput, rec);
  const existing = await ctx.db.discussionThread.findUnique({
    where: { id: threadId },
    select: { authorId: true, locked: true, title: true, category: true, body: true, updatedAt: true },
  });
  if (!existing) throw new NotFoundError(DISCUSSION_NOT_FOUND);
  if (!canEditDiscussionPost(ctx.actor, existing)) throw new ForbiddenError(DISCUSSION_CANT_EDIT);
  if (existing.locked) throw new ConflictError(DISCUSSION_LOCKED_EDIT);
  // The version before the fields: a stale form with a field error must still hear that it's stale.
  const version = parseVersion(rec.version, DISCUSSION_CHANGED);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(DISCUSSION_CHANGED);
  const data = parseInput(threadFields, rec);
  if (data.title === existing.title && data.category === existing.category && data.body === existing.body) {
    return { id: threadId, changed: false };
  }
  await throttleEdits(ctx);
  const { count } = await ctx.db.discussionThread.updateMany({
    where: { id: threadId, authorId: ctx.actor.id, locked: false, updatedAt: existing.updatedAt },
    data: { ...data, editedAt: ctx.now, updatedAt: nextVersion(ctx.now, existing.updatedAt) },
  });
  if (count === 0) {
    const now = await ctx.db.discussionThread.findUnique({ where: { id: threadId }, select: { locked: true } });
    if (!now) throw new NotFoundError(DISCUSSION_NOT_FOUND);
    throw new ConflictError(now.locked ? DISCUSSION_LOCKED_EDIT : DISCUSSION_CHANGED);
  }
  return { id: threadId, changed: true };
}

/**
 * Delete a discussion with its replies. Whoever started it, while nobody else has replied and it isn't locked
 * (checked with the row locked, so a reply landing at the same moment isn't deleted with it); people with admin
 * access, any time.
 */
export async function deleteThread(ctx: ServiceContext, raw: unknown): Promise<{ title: string }> {
  requireActive(ctx);
  const { threadId } = parseInput(threadIdInput, asRecord(raw));
  const thread = await ctx.db.discussionThread.findUnique({ where: { id: threadId }, select: { title: true, authorId: true } });
  if (!thread) throw new NotFoundError(DISCUSSION_NOT_FOUND);
  const moderator = canModerateDiscussion(ctx.actor);
  if (!moderator && !canEditDiscussionPost(ctx.actor, thread)) throw new ForbiddenError(DISCUSSION_CANT_DELETE);
  await ctx.db.$transaction(async (tx) => {
    const row = await lockThread(tx, threadId);
    if (!row) throw new NotFoundError(DISCUSSION_NOT_FOUND);
    if (!moderator && row.locked) throw new ConflictError(DISCUSSION_LOCKED_DELETE);
    if (!moderator && (await tx.discussionReply.count({ where: { threadId, ...othersReplies(ctx.actor.id) } })) > 0) {
      throw new ConflictError(DISCUSSION_HAS_REPLIES);
    }
    await tx.discussionThread.delete({ where: { id: threadId } });
  });
  return { title: thread.title };
}

/** Pin to the top of the list, or unpin (people with admin access). */
export async function setThreadPinned(ctx: ServiceContext, raw: unknown): Promise<{ pinned: boolean }> {
  requireActive(ctx);
  const { threadId, pinned } = parseInput(pinInput, asRecord(raw));
  if (!canModerateDiscussion(ctx.actor)) throw new ForbiddenError(DISCUSSION_CANT_MODERATE);
  // Raw SQL: Prisma would move updatedAt (the text's version).
  const count = await ctx.db.$executeRaw`UPDATE "DiscussionThread" SET "pinned" = ${pinned} WHERE "id" = ${threadId}`;
  if (count === 0) throw new NotFoundError(DISCUSSION_NOT_FOUND);
  return { pinned };
}

/** Lock (no new replies or edits) or unlock (people with admin access). */
export async function setThreadLocked(ctx: ServiceContext, raw: unknown): Promise<{ locked: boolean }> {
  requireActive(ctx);
  const { threadId, locked } = parseInput(lockInput, asRecord(raw));
  if (!canModerateDiscussion(ctx.actor)) throw new ForbiddenError(DISCUSSION_CANT_MODERATE);
  const count = await ctx.db.$executeRaw`UPDATE "DiscussionThread" SET "locked" = ${locked} WHERE "id" = ${threadId}`;
  if (count === 0) throw new NotFoundError(DISCUSSION_NOT_FOUND);
  return { locked };
}

/**
 * Remember that I've read a discussion (its page calls this once it's open; loading the page never writes).
 * `seen` = the last activity the page showed (ISO): the mark goes up to it (never past now), so a reply that
 * landed while the page was loading still counts as new. Without it, up to now. `moved`: the mark changed (only
 * then can the nav badge or the list's markers change, so only then does the page need a refresh).
 */
export async function markThreadRead(ctx: ServiceContext, raw: unknown): Promise<{ moved: boolean }> {
  requireActive(ctx);
  const { threadId, seen } = parseInput(readInput, asRecord(raw));
  const seenAt = seen ? new Date(seen) : null;
  const at = seenAt && !Number.isNaN(seenAt.getTime()) && seenAt < ctx.now ? seenAt : ctx.now;
  const thread = await ctx.db.discussionThread.findUnique({ where: { id: threadId }, select: { id: true } });
  if (!thread) throw new NotFoundError(DISCUSSION_NOT_FOUND);
  try {
    return { moved: await upsertRead(ctx.db, ctx.actor.id, threadId, at) };
  } catch (e) {
    // Deleted in the meantime (the mark's foreign key fails): nothing to remember.
    if (!(await ctx.db.discussionThread.count({ where: { id: threadId } }))) throw new NotFoundError(DISCUSSION_NOT_FOUND);
    throw e;
  }
}

// ---------- replies ----------

/** Reply to a discussion that isn't locked. Counts as reading it up to the reply. */
export async function createReply(ctx: ServiceContext, raw: unknown): Promise<{ id: string; threadId: string }> {
  requireActive(ctx);
  const { threadId, body } = parseInput(createReplyInput, asRecord(raw));
  const thread = await ctx.db.discussionThread.findUnique({ where: { id: threadId }, select: { locked: true } });
  if (!thread) throw new NotFoundError(DISCUSSION_NOT_FOUND);
  if (thread.locked) throw new ConflictError(DISCUSSION_LOCKED);
  await throttle(ctx, "reply", "You've posted a lot of replies in the last hour. Please wait a bit before sending another.");
  const reply = await ctx.db.$transaction(async (tx) => {
    // Locks the row (a delete, recount, or other reply waits for this one) and checks "not locked" in the same step.
    // The reply's time is picked here, under the lock: now, but always after the last activity. So on a discussion
    // replies are timed in the order they're saved, and a slower request (its "now" taken earlier) can't land
    // behind a read mark that already covers a later reply, where nobody would ever see it as new.
    const rows = await tx.$queryRaw<{ at: Date }[]>`
      UPDATE "DiscussionThread" SET
        "replyCount" = "replyCount" + 1,
        "lastActivityAt" = GREATEST(${ctx.now}, "lastActivityAt" + interval '1 millisecond'),
        "lastActivityById" = ${ctx.actor.id}
      WHERE "id" = ${threadId} AND NOT "locked"
      RETURNING "lastActivityAt" AS "at"`;
    const at = rows[0]?.at;
    if (!at) {
      const still = await tx.discussionThread.findUnique({ where: { id: threadId }, select: { locked: true } });
      throw still ? new ConflictError(DISCUSSION_LOCKED) : new NotFoundError(DISCUSSION_NOT_FOUND);
    }
    const created = await tx.discussionReply.create({
      data: { threadId, body, authorId: ctx.actor.id, createdAt: at, updatedAt: at },
      select: { id: true },
    });
    await upsertRead(tx, ctx.actor.id, threadId, at);
    return created;
  });
  return { id: reply.id, threadId };
}

/**
 * Change a reply's text (whoever wrote it; not while the discussion is locked). With `version` (the reply's
 * updatedAt the form loaded) the save is refused if it changed since. Saving it unchanged writes nothing.
 */
export async function updateReply(ctx: ServiceContext, raw: unknown): Promise<{ threadId: string; changed: boolean }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { replyId } = parseInput(replyIdInput, rec);
  const existing = await ctx.db.discussionReply.findUnique({
    where: { id: replyId },
    select: { threadId: true, authorId: true, body: true, updatedAt: true, thread: { select: { locked: true } } },
  });
  if (!existing) throw new NotFoundError(DISCUSSION_REPLY_NOT_FOUND);
  if (!canEditDiscussionPost(ctx.actor, existing)) throw new ForbiddenError(DISCUSSION_REPLY_CANT_EDIT);
  if (existing.thread.locked) throw new ConflictError(DISCUSSION_LOCKED_EDIT);
  const version = parseVersion(rec.version, DISCUSSION_REPLY_CHANGED);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(DISCUSSION_REPLY_CHANGED);
  const { body } = parseInput(updateReplyInput, rec);
  if (body === existing.body) return { threadId: existing.threadId, changed: false };
  await throttleEdits(ctx);
  const { count } = await ctx.db.discussionReply.updateMany({
    where: { id: replyId, authorId: ctx.actor.id, updatedAt: existing.updatedAt, thread: { locked: false } },
    data: { body, editedAt: ctx.now, updatedAt: nextVersion(ctx.now, existing.updatedAt) },
  });
  if (count === 0) {
    const now = await ctx.db.discussionReply.findUnique({ where: { id: replyId }, select: { thread: { select: { locked: true } } } });
    if (!now) throw new NotFoundError(DISCUSSION_REPLY_NOT_FOUND);
    throw new ConflictError(now.thread.locked ? DISCUSSION_LOCKED_EDIT : DISCUSSION_REPLY_CHANGED);
  }
  return { threadId: existing.threadId, changed: true };
}

/**
 * Delete a reply: whoever wrote it (not while the discussion is locked), or people with admin access (any time).
 * The discussion's reply count and last activity are recounted in the same transaction.
 */
export async function deleteReply(ctx: ServiceContext, raw: unknown): Promise<{ threadId: string }> {
  requireActive(ctx);
  const { replyId } = parseInput(replyIdInput, asRecord(raw));
  const reply = await ctx.db.discussionReply.findUnique({ where: { id: replyId }, select: { threadId: true, authorId: true } });
  if (!reply) throw new NotFoundError(DISCUSSION_REPLY_NOT_FOUND);
  const moderator = canModerateDiscussion(ctx.actor);
  if (!moderator && !canEditDiscussionPost(ctx.actor, reply)) throw new ForbiddenError(DISCUSSION_REPLY_CANT_DELETE);
  await ctx.db.$transaction(async (tx) => {
    // The discussion's row first (like createReply), so the recount sees every reply committed before it.
    const thread = await lockThread(tx, reply.threadId);
    if (!thread) throw new NotFoundError(DISCUSSION_REPLY_NOT_FOUND);
    if (!moderator && thread.locked) throw new ConflictError(DISCUSSION_LOCKED_DELETE);
    const { count } = await tx.discussionReply.deleteMany({ where: { id: replyId } });
    if (count === 0) throw new NotFoundError(DISCUSSION_REPLY_NOT_FOUND);
    await recountThread(tx, reply.threadId);
  });
  return { threadId: reply.threadId };
}
