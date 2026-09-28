import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { markThreadReadAction, updateReplyAction, updateThreadAction } from "@/app/(app)/discussion/actions";
import { LIMITS } from "@/lib/constants";
import {
  discussionListHref,
  firstNewReplyId,
  hasDiscussionFilters,
  newDiscussionHref,
  parseDiscussionFilters,
  repliesLabel,
} from "@/lib/discussion";
import type { Actor } from "@/server/actor";
import type { ServiceContext } from "@/server/context";
import type { Db } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { canEditDiscussionPost, canModerateDiscussion } from "@/server/permissions";
import { getUserDetail } from "@/server/queries/admin";
import {
  countUnreadDiscussions,
  discussionExists,
  getDiscussionThread,
  getDiscussionThreadForEdit,
  listDiscussionThreads,
} from "@/server/queries/discussion";
import { deleteUser, HAS_ACTIVITY_MESSAGE } from "@/server/services/admin";
import {
  createReply,
  createThread,
  DISCUSSION_CANT_DELETE,
  DISCUSSION_CANT_EDIT,
  DISCUSSION_CANT_MODERATE,
  DISCUSSION_CHANGED,
  DISCUSSION_HAS_REPLIES,
  DISCUSSION_INACTIVE,
  DISCUSSION_LOCKED,
  DISCUSSION_LOCKED_DELETE,
  DISCUSSION_LOCKED_EDIT,
  DISCUSSION_RATE_LIMITS,
  DISCUSSION_REPLY_CANT_DELETE,
  DISCUSSION_REPLY_CANT_EDIT,
  DISCUSSION_REPLY_CHANGED,
  DISCUSSION_REPLY_NOT_FOUND,
  deleteReply,
  deleteThread,
  markThreadRead,
  setThreadLocked,
  setThreadPinned,
  updateReply,
  updateThread,
} from "@/server/services/discussion";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW } from "./helpers/factories";

// The actions (only for which ones refresh the page): who's signed in, and what was refreshed.
const actions = vi.hoisted(() => ({ ctx: null as ServiceContext | null, refreshed: 0 }));
vi.mock("next/cache", () => ({
  revalidatePath: () => {
    actions.refreshed++;
  },
}));
vi.mock("@/server/context", () => ({
  getServiceContext: async () => {
    if (!actions.ctx) throw new Error("No signed-in person for this action.");
    return actions.ctx;
  },
}));

const MIN = 60 * 1000;
const at = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * MIN);

let t: TestDb;
let maya: Actor; // Software member
let ethan: Actor; // Build member
let ava: Actor; // Business member
let priya: Actor; // Software leader
let jordan: Actor; // Captain
let elena: Actor; // Mentor
let david: Actor; // Teacher
let olivia: Actor; // Owner (a Build member with the Owner flag)
let pending: Actor;
let disabled: Actor;
let rejected: Actor;
let pendingLeader: Actor;

/** A context for `actor` at TEST_NOW + `minutes`. */
function ctxAt(actor: Actor, minutes = 0) {
  return { ...contextFor(t.db, actor), now: at(minutes) };
}

async function startThread(actor: Actor, fields: Partial<{ title: string; body: string; category: string }> = {}, minutes = 0) {
  return createThread(ctxAt(actor, minutes), {
    title: fields.title ?? "Which intake wheels?",
    body: fields.body ?? "Compliant or mecanum?",
    category: fields.category ?? "BUILD",
  });
}

async function threadRow(id: string) {
  return t.db.discussionThread.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  t = await createTestDb();
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  ava = await makeUser(t.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  pending = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUILD", status: "PENDING" });
  disabled = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
  rejected = await makeUser(t.db, { name: "Rex Rejected", role: "MEMBER", subteam: "SOFTWARE", status: "REJECTED" });
  pendingLeader = await makeUser(t.db, { name: "Quinn Waiting", role: "BUILD_LEADER", status: "PENDING" });
  // Everyone joined a month before the fixed "now" (factories stamp the real clock).
  await t.db.user.updateMany({ data: { createdAt: at(-30 * 24 * 60) } });
});
afterAll(async () => {
  await t.drop();
});
// Tests start lots of discussions at one fixed "now"; the hourly limits have their own test.
beforeEach(async () => {
  await t.db.rateLimit.deleteMany();
});

describe("permissions", () => {
  it("moderation is for everyone with admin access; editing only for the author", () => {
    for (const a of [priya, jordan, elena, david, olivia]) expect(canModerateDiscussion(a), a.name).toBe(true);
    for (const a of [maya, ethan, ava]) expect(canModerateDiscussion(a), a.name).toBe(false);
    expect(canEditDiscussionPost(maya, { authorId: maya.id })).toBe(true);
    expect(canEditDiscussionPost(jordan, { authorId: maya.id })).toBe(false);
    expect(canEditDiscussionPost(maya, { authorId: null })).toBe(false);
  });

  it("every ACTIVE person starts discussions and replies; accounts that aren't active can't", async () => {
    for (const a of [maya, ethan, ava, priya, jordan, elena, david, olivia]) {
      const { id } = await startThread(a, { title: `From ${a.name}` });
      const reply = await createReply(ctxAt(a), { threadId: id, body: "Me too" });
      expect(reply.threadId).toBe(id);
    }
    const { id } = await startThread(maya);
    for (const a of [pending, disabled, rejected, pendingLeader]) {
      await expect(startThread(a), a.name).rejects.toThrow(new ForbiddenError(DISCUSSION_INACTIVE));
      await expect(createReply(ctxAt(a), { threadId: id, body: "Hi" }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(markThreadRead(ctxAt(a), { threadId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteThread(ctxAt(a), { threadId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setThreadPinned(ctxAt(a), { threadId: id, pinned: "on" }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      expect(await countUnreadDiscussions(a, t.db), a.name).toBe(0);
      expect(await listDiscussionThreads(a, { unread: false, mine: false }, 1, t.db), a.name).toBeNull();
      expect(await getDiscussionThread(a, id, t.db), a.name).toBeNull();
    }
    // A leader waiting for approval can't moderate either.
    await expect(setThreadLocked(ctxAt(pendingLeader), { threadId: id, locked: "on" })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("checks the fields: title, category, text, and their lengths (CRLF counts as one character)", async () => {
    const ctx = ctxAt(maya);
    await expect(createThread(ctx, { title: " ", body: "x", category: "BUILD" })).rejects.toMatchObject({
      fieldErrors: { title: "Title is required." },
    });
    await expect(createThread(ctx, { title: "Hi", body: "  ", category: "BUILD" })).rejects.toMatchObject({
      fieldErrors: { body: "Write a few words to get the discussion going." },
    });
    await expect(createThread(ctx, { title: "Hi", body: "x", category: "ROBOTS" })).rejects.toMatchObject({
      fieldErrors: { category: "Pick a category." },
    });
    await expect(createThread(ctx, { title: "x".repeat(LIMITS.discussionTitleMax + 1), body: "x", category: "BUILD" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(createThread(ctx, { title: "Hi", body: "x".repeat(LIMITS.discussionBodyMax + 1), category: "IDEAS" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // A textarea's CRLF line breaks count as one character each, like its maxLength.
    const lines = "a\r\n".repeat(LIMITS.discussionBodyMax / 2);
    const { id } = await createThread(ctx, { title: "  Long one  ", body: lines, category: "OFF_TOPIC" });
    const row = await threadRow(id);
    expect(row).toMatchObject({ title: "Long one", category: "OFF_TOPIC", authorId: maya.id, replyCount: 0, pinned: false, locked: false });
    expect(row.body).not.toContain("\r");
    expect(row.lastActivityAt).toEqual(TEST_NOW);
    expect(row.lastActivityById).toBe(maya.id);
    await expect(createReply(ctx, { threadId: id, body: "" })).rejects.toMatchObject({ fieldErrors: { body: "Write a reply first." } });
    await expect(createReply(ctx, { threadId: id, body: "x".repeat(LIMITS.discussionReplyMax + 1) })).rejects.toBeInstanceOf(ValidationError);
    await expect(createReply(ctx, { threadId: "nope", body: "Hi" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("editing and deleting", () => {
  it("only the author edits a discussion; editedAt is set, and saving it unchanged writes nothing", async () => {
    const { id } = await startThread(maya);
    const before = await threadRow(id);
    for (const a of [ethan, jordan, olivia]) {
      await expect(updateThread(ctxAt(a, 5), { threadId: id, title: "Mine now", body: "x", category: "BUILD" }), a.name).rejects.toThrow(
        new ForbiddenError(DISCUSSION_CANT_EDIT),
      );
    }
    const same = await updateThread(ctxAt(maya, 5), { threadId: id, title: before.title, body: before.body, category: "BUILD", version: before.updatedAt.toISOString() });
    expect(same.changed).toBe(false);
    expect((await threadRow(id)).editedAt).toBeNull();

    const saved = await updateThread(ctxAt(maya, 5), {
      threadId: id,
      title: "Which intake wheels? (updated)",
      body: "Compliant, 2 in.",
      category: "IDEAS",
      version: before.updatedAt.toISOString(),
    });
    expect(saved.changed).toBe(true);
    const after = await threadRow(id);
    expect(after).toMatchObject({ title: "Which intake wheels? (updated)", category: "IDEAS", editedAt: at(5) });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // Editing isn't activity: the list order and unread marks don't move.
    expect(after.lastActivityAt).toEqual(before.lastActivityAt);
  });

  it("a save based on an older version is refused (even with a field error), then saving again works", async () => {
    const { id } = await startThread(maya);
    const v0 = (await threadRow(id)).updatedAt.toISOString();
    await updateThread(ctxAt(maya, 1), { threadId: id, title: "Tab one", body: "One", category: "BUILD", version: v0 });
    await expect(updateThread(ctxAt(maya, 2), { threadId: id, title: "Tab two", body: "Two", category: "BUILD", version: v0 })).rejects.toThrow(
      new ConflictError(DISCUSSION_CHANGED),
    );
    await expect(updateThread(ctxAt(maya, 2), { threadId: id, title: "", body: "Two", category: "BUILD", version: v0 })).rejects.toThrow(
      new ConflictError(DISCUSSION_CHANGED),
    );
    await expect(updateThread(ctxAt(maya, 2), { threadId: id, title: "Tab two", body: "Two", category: "BUILD", version: "garbage" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await threadRow(id)).title).toBe("Tab one");
    const v1 = (await threadRow(id)).updatedAt.toISOString();
    await updateThread(ctxAt(maya, 2), { threadId: id, title: "Tab two", body: "Two", category: "BUILD", version: v1 });
    expect((await threadRow(id)).title).toBe("Tab two");
    // Two saves at the same moment still get different versions.
    const v2 = (await threadRow(id)).updatedAt.toISOString();
    await updateThread(ctxAt(maya, 2), { threadId: id, title: "Tab three", body: "Three", category: "BUILD", version: v2 });
    await expect(updateThread(ctxAt(maya, 2), { threadId: id, title: "Tab four", body: "Four", category: "BUILD", version: v2 })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("replies, pins, and locks don't change the version, so they never make the author's edit a conflict", async () => {
    const { id } = await startThread(maya);
    const v0 = (await threadRow(id)).updatedAt.toISOString();
    await createReply(ctxAt(ethan, 1), { threadId: id, body: "Compliant!" });
    await setThreadPinned(ctxAt(jordan, 2), { threadId: id, pinned: "on" });
    await setThreadLocked(ctxAt(jordan, 3), { threadId: id, locked: "on" });
    await setThreadLocked(ctxAt(jordan, 4), { threadId: id, locked: "" });
    const reply = await t.db.discussionReply.findFirstOrThrow({ where: { threadId: id } });
    await deleteReply(ctxAt(jordan, 5), { replyId: reply.id });
    expect((await threadRow(id)).updatedAt.toISOString()).toBe(v0);
    await expect(updateThread(ctxAt(maya, 6), { threadId: id, title: "Still fine", body: "Yes", category: "BUILD", version: v0 })).resolves.toMatchObject({
      changed: true,
    });
  });

  it("only the author edits a reply; with a version; editedAt set", async () => {
    const { id } = await startThread(maya);
    const { id: replyId } = await createReply(ctxAt(ethan, 1), { threadId: id, body: "Compliant!" });
    const v0 = (await t.db.discussionReply.findUniqueOrThrow({ where: { id: replyId } })).updatedAt.toISOString();
    for (const a of [maya, jordan, olivia]) {
      await expect(updateReply(ctxAt(a, 2), { replyId, body: "Hacked" }), a.name).rejects.toThrow(new ForbiddenError(DISCUSSION_REPLY_CANT_EDIT));
    }
    expect(await updateReply(ctxAt(ethan, 2), { replyId, body: "Compliant!", version: v0 })).toMatchObject({ changed: false });
    expect(await updateReply(ctxAt(ethan, 2), { replyId, body: "Compliant, 2 in.", version: v0 })).toEqual({ threadId: id, changed: true });
    const row = await t.db.discussionReply.findUniqueOrThrow({ where: { id: replyId } });
    expect(row).toMatchObject({ body: "Compliant, 2 in.", editedAt: at(2) });
    await expect(updateReply(ctxAt(ethan, 3), { replyId, body: "Other tab", version: v0 })).rejects.toThrow(new ConflictError(DISCUSSION_REPLY_CHANGED));
    await expect(updateReply(ctxAt(ethan, 3), { replyId: "nope", body: "x" })).rejects.toBeInstanceOf(NotFoundError);
    // Editing a reply isn't activity either.
    expect((await threadRow(id)).lastActivityAt).toEqual(at(1));
  });

  it("the author deletes a discussion until someone else replies; their own replies don't count", async () => {
    const { id } = await startThread(maya);
    await createReply(ctxAt(maya, 1), { threadId: id, body: "Adding a picture link" });
    await expect(deleteThread(ctxAt(ethan, 2), { threadId: id })).rejects.toThrow(new ForbiddenError(DISCUSSION_CANT_DELETE));
    expect(await deleteThread(ctxAt(maya, 2), { threadId: id })).toEqual({ title: "Which intake wheels?" });
    expect(await t.db.discussionThread.count({ where: { id } })).toBe(0);
    expect(await t.db.discussionReply.count({ where: { threadId: id } })).toBe(0);

    const { id: busy } = await startThread(maya);
    await createReply(ctxAt(ethan, 1), { threadId: busy, body: "Compliant!" });
    await expect(deleteThread(ctxAt(maya, 2), { threadId: busy })).rejects.toThrow(new ConflictError(DISCUSSION_HAS_REPLIES));
    // A reply from an account that was deleted counts as someone else's.
    const { id: orphaned } = await startThread(maya);
    await t.db.discussionReply.create({ data: { threadId: orphaned, body: "Old", authorId: null } });
    await expect(deleteThread(ctxAt(maya, 2), { threadId: orphaned })).rejects.toBeInstanceOf(ConflictError);
    // People with admin access delete any discussion, replies and all.
    for (const [a, tid] of [[priya, busy], [olivia, orphaned]] as const) {
      await deleteThread(ctxAt(a, 3), { threadId: tid });
      expect(await t.db.discussionThread.count({ where: { id: tid } }), a.name).toBe(0);
    }
    await expect(deleteThread(ctxAt(jordan, 4), { threadId: busy })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("replies are deleted by their author or people with admin access", async () => {
    const { id } = await startThread(maya);
    const { id: r1 } = await createReply(ctxAt(ethan, 1), { threadId: id, body: "One" });
    const { id: r2 } = await createReply(ctxAt(ethan, 2), { threadId: id, body: "Two" });
    const { id: r3 } = await createReply(ctxAt(ava, 3), { threadId: id, body: "Three" });
    // Not the discussion's author, not another member.
    for (const a of [maya, ava]) await expect(deleteReply(ctxAt(a, 4), { replyId: r1 }), a.name).rejects.toThrow(new ForbiddenError(DISCUSSION_REPLY_CANT_DELETE));
    expect(await deleteReply(ctxAt(ethan, 4), { replyId: r1 })).toEqual({ threadId: id });
    await deleteReply(ctxAt(david, 4), { replyId: r2 });
    await deleteReply(ctxAt(elena, 4), { replyId: r3 });
    await expect(deleteReply(ctxAt(elena, 4), { replyId: r3 })).rejects.toBeInstanceOf(NotFoundError);
    expect(await t.db.discussionReply.count({ where: { threadId: id } })).toBe(0);
  });
});

describe("pin and lock", () => {
  it("people with admin access pin and lock; members can't", async () => {
    const { id } = await startThread(maya);
    for (const a of [maya, ethan, ava]) {
      await expect(setThreadPinned(ctxAt(a), { threadId: id, pinned: "on" }), a.name).rejects.toThrow(new ForbiddenError(DISCUSSION_CANT_MODERATE));
      await expect(setThreadLocked(ctxAt(a), { threadId: id, locked: "on" }), a.name).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await setThreadPinned(ctxAt(priya), { threadId: id, pinned: "on" })).toEqual({ pinned: true });
    expect(await setThreadLocked(ctxAt(olivia), { threadId: id, locked: "on" })).toEqual({ locked: true });
    expect(await threadRow(id)).toMatchObject({ pinned: true, locked: true });
    expect(await setThreadPinned(ctxAt(david), { threadId: id })).toEqual({ pinned: false });
    await expect(setThreadPinned(ctxAt(david), { threadId: "nope", pinned: "on" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setThreadLocked(ctxAt(david), { threadId: "nope", locked: "on" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a locked discussion is frozen: no replies and no edits (from anyone); only people with admin access delete in it", async () => {
    const { id } = await startThread(maya);
    const { id: replyId } = await createReply(ctxAt(ethan, 1), { threadId: id, body: "Compliant!" });
    // Nobody else replied to Ava's, so she could delete it — until it's locked.
    const { id: avas } = await startThread(ava, { title: "Ava's vote" }, 1);
    await setThreadLocked(ctxAt(jordan, 2), { threadId: id, locked: "on" });
    await setThreadLocked(ctxAt(jordan, 2), { threadId: avas, locked: "on" });
    for (const a of [maya, ethan, jordan]) {
      await expect(createReply(ctxAt(a, 3), { threadId: id, body: "One more" }), a.name).rejects.toThrow(new ConflictError(DISCUSSION_LOCKED));
    }
    await expect(updateThread(ctxAt(maya, 3), { threadId: id, title: "New", body: "x", category: "BUILD" })).rejects.toThrow(
      new ConflictError(DISCUSSION_LOCKED_EDIT),
    );
    await expect(updateReply(ctxAt(ethan, 3), { replyId, body: "Changed" })).rejects.toThrow(new ConflictError(DISCUSSION_LOCKED_EDIT));
    expect(await getDiscussionThreadForEdit(maya, id, t.db)).toBeNull();
    const view = await getDiscussionThread(ethan, id, t.db);
    expect(view).toMatchObject({ locked: true, canReply: false, canEdit: false });
    expect(view?.replies[0]).toMatchObject({ mine: true, canEdit: false, canDelete: false });
    // Authors can't take their posts back (e.g. a vote that was locked to stay final).
    await expect(deleteReply(ctxAt(ethan, 3), { replyId })).rejects.toThrow(new ConflictError(DISCUSSION_LOCKED_DELETE));
    expect(await getDiscussionThread(ava, avas, t.db)).toMatchObject({ mine: true, canDelete: false });
    await expect(deleteThread(ctxAt(ava, 3), { threadId: avas })).rejects.toThrow(new ConflictError(DISCUSSION_LOCKED_DELETE));
    expect((await threadRow(id)).replyCount).toBe(1);

    // People with admin access still can.
    expect((await getDiscussionThread(priya, id, t.db))?.replies[0]).toMatchObject({ canDelete: true });
    await deleteReply(ctxAt(priya, 4), { replyId });
    expect((await threadRow(id)).replyCount).toBe(0);
    await deleteThread(ctxAt(elena, 4), { threadId: avas });
    expect(await t.db.discussionThread.count({ where: { id: avas } })).toBe(0);

    // Unlocked: replies, and authors delete their own again.
    await setThreadLocked(ctxAt(jordan, 5), { threadId: id });
    const { id: again } = await createReply(ctxAt(ethan, 6), { threadId: id, body: "Unlocked!" });
    await expect(deleteReply(ctxAt(ethan, 7), { replyId: again })).resolves.toEqual({ threadId: id });
  });
});

describe("counts and last activity", () => {
  it("each reply bumps the count and last activity; deleting recounts from what's left", async () => {
    const { id } = await startThread(maya, {}, 0);
    const { id: r1 } = await createReply(ctxAt(ethan, 10), { threadId: id, body: "One" });
    const { id: r2 } = await createReply(ctxAt(ava, 20), { threadId: id, body: "Two" });
    const { id: r3 } = await createReply(ctxAt(priya, 30), { threadId: id, body: "Three" });
    expect(await threadRow(id)).toMatchObject({ replyCount: 3, lastActivityAt: at(30), lastActivityById: priya.id });

    // Deleting the newest: back to the one before it.
    await deleteReply(ctxAt(priya, 40), { replyId: r3 });
    expect(await threadRow(id)).toMatchObject({ replyCount: 2, lastActivityAt: at(20), lastActivityById: ava.id });
    // Deleting an older one: the last activity stays.
    await deleteReply(ctxAt(ethan, 40), { replyId: r1 });
    expect(await threadRow(id)).toMatchObject({ replyCount: 1, lastActivityAt: at(20), lastActivityById: ava.id });
    // None left: the discussion itself.
    await deleteReply(ctxAt(jordan, 40), { replyId: r2 });
    expect(await threadRow(id)).toMatchObject({ replyCount: 0, lastActivityAt: at(0), lastActivityById: maya.id });
  });

  it("a reply's time is picked when it's saved, after the last activity, so a slow request can't hide behind a read mark", async () => {
    const { id } = await startThread(maya, { title: "Slow request race" }, 0);
    // Ethan's reply is saved first (+10), and Priya's page shows it and marks the discussion read up to it.
    const { id: first } = await createReply(ctxAt(ethan, 10), { threadId: id, body: "Saved first" });
    const shown = await getDiscussionThread(priya, id, t.db);
    expect(shown?.seen).toEqual(at(10));
    await markThreadRead(ctxAt(priya, 11), { threadId: id, seen: shown!.seen.toISOString() });
    // Ava's request took its "now" earlier (+5) but is saved after Ethan's: it's timed right after his.
    const { id: late } = await createReply(ctxAt(ava, 5), { threadId: id, body: "Saved second" });
    const row = await threadRow(id);
    const lateAt = new Date(at(10).getTime() + 1);
    expect(row).toMatchObject({ replyCount: 2, lastActivityAt: lateAt, lastActivityById: ava.id });
    expect((await t.db.discussionReply.findUniqueOrThrow({ where: { id: late } })).createdAt).toEqual(lateAt);
    // So it's new to Priya: listed as unread with 1 new reply, and on the page it comes after Ethan's, below the divider.
    const list = await listDiscussionThreads(priya, { unread: true, mine: false, q: "Slow request race" }, 1, t.db);
    expect(list?.items.map((i) => [i.id, i.newReplies])).toEqual([[id, 1]]);
    const view = await getDiscussionThread(priya, id, t.db);
    expect(view?.replies.map((r) => r.id)).toEqual([first, late]);
    expect(view?.newFromReplyId).toBe(late);
  });

  it("the page's counts and read mark come from the replies it loaded, even when a reply is saved while it loads", async () => {
    const { id } = await startThread(maya, { title: "Mid-load" });
    await createReply(ctxAt(ethan, 1), { threadId: id, body: "first" });
    // The page's reads run side by side: hold the discussion's row back until the replies were read and
    // another reply was saved in between.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let repliesRead!: () => void;
    const replies = new Promise<void>((r) => (repliesRead = r));
    const real = t.db;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === "discussionThread") {
          return { findUnique: (args: Parameters<Db["discussionThread"]["findUnique"]>[0]) => gate.then(() => real.discussionThread.findUnique(args)) };
        }
        if (prop === "discussionReply") {
          return {
            findMany: async (args: Parameters<Db["discussionReply"]["findMany"]>[0]) => {
              const found = await real.discussionReply.findMany(args);
              repliesRead();
              return found;
            },
            count: (args: Parameters<Db["discussionReply"]["count"]>[0]) => real.discussionReply.count(args),
          };
        }
        return Reflect.get(target, prop);
      },
    }) as Db;
    const loading = getDiscussionThread(priya, id, db);
    await replies;
    await createReply(ctxAt(ava, 2), { threadId: id, body: "second" });
    release();
    const view = await loading;
    expect(view?.replies.map((r) => r.body)).toEqual(["first"]);
    // Not "1 older one isn't shown" (it's newer), and the read mark stops at what the page shows.
    expect(view).toMatchObject({ replyCount: 1, olderHidden: 0, seen: at(1) });
    expect(view?.lastActivityAt).toEqual(at(2));
  });

  it("many replies and deletes at the same time keep the count right", async () => {
    const { id } = await startThread(maya);
    const people = [ethan, ava, priya, jordan, elena, david, olivia, maya];
    const made = await Promise.all(people.map((a, i) => createReply(ctxAt(a, i + 1), { threadId: id, body: `Reply ${i}` })));
    await Promise.all([
      ...made.slice(0, 4).map((r) => deleteReply(ctxAt(jordan, 20), { replyId: r.id })),
      ...people.slice(0, 4).map((a, i) => createReply(ctxAt(a, 10 + i), { threadId: id, body: `More ${i}` })),
    ]);
    const row = await threadRow(id);
    const actual = await t.db.discussionReply.count({ where: { threadId: id } });
    expect(actual).toBe(8);
    expect(row.replyCount).toBe(actual);
    const newest = await t.db.discussionReply.findFirstOrThrow({ where: { threadId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    expect(row.lastActivityAt).toEqual(newest.createdAt);
  });

  it("the page shows the newest replies, oldest first, with who wrote them and what the viewer may do", async () => {
    const { id } = await startThread(maya, { title: "Page view" });
    await createReply(ctxAt(ethan, 1), { threadId: id, body: "First" });
    await createReply(ctxAt(maya, 2), { threadId: id, body: "Second" });
    const view = await getDiscussionThread(maya, id, t.db);
    expect(view).toMatchObject({
      title: "Page view",
      replyCount: 2,
      olderHidden: 0,
      mine: true,
      canEdit: true,
      canDelete: false, // Ethan replied
      canModerate: false,
      canReply: true,
      author: { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE", isAdmin: false },
    });
    expect(view?.replies.map((r) => [r.body, r.author?.name, r.mine, r.canEdit, r.canDelete])).toEqual([
      ["First", "Ethan Chen", false, false, false],
      ["Second", "Maya Patel", true, true, true],
    ]);
    const asLeader = await getDiscussionThread(priya, id, t.db);
    expect(asLeader).toMatchObject({ canEdit: false, canDelete: true, canModerate: true });
    expect(asLeader?.replies.every((r) => r.canDelete && !r.canEdit)).toBe(true);
    expect(await getDiscussionThread(maya, "nope", t.db)).toBeNull();
    expect(await getDiscussionThreadForEdit(maya, id, t.db)).toMatchObject({ id, title: "Page view", category: "BUILD" });
    expect(await getDiscussionThreadForEdit(priya, id, t.db)).toBeNull();
    // The edit page sends everyone else to the discussion (a 404 only when it's gone).
    expect(await discussionExists(priya, id, t.db)).toBe(true);
    expect(await discussionExists(priya, "nope", t.db)).toBe(false);
    expect(await discussionExists(pending, id, t.db)).toBe(false);
  });
});

describe("unread", () => {
  // Their own database, so other tests' discussions don't count.
  let u: TestDb;
  let a: Actor;
  let b: Actor;
  let late: Actor;
  const ctxU = (actor: Actor, minutes: number) => ({ ...contextFor(u.db, actor), now: at(minutes) });
  beforeAll(async () => {
    u = await createTestDb();
    a = await makeUser(u.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
    b = await makeUser(u.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
    late = await makeUser(u.db, { name: "Late Joiner", role: "MEMBER", subteam: "BUILD" });
    await u.db.user.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { createdAt: at(-60 * 24) } });
    await u.db.user.update({ where: { id: late.id }, data: { createdAt: at(60) } });
  });
  afterAll(async () => {
    await u.drop();
  });

  it("counts discussions with someone else's activity since I last opened them", async () => {
    const { id } = await createThread(ctxU(a, 0), { title: "Autos", body: "Pedro?", category: "SOFTWARE" });
    // My own new discussion isn't unread for me; it is for everyone who joined before it.
    expect(await countUnreadDiscussions(a, u.db)).toBe(0);
    expect(await countUnreadDiscussions(b, u.db)).toBe(1);
    // Someone who joined later doesn't get the old discussion as unread.
    expect(await countUnreadDiscussions(late, u.db)).toBe(0);

    let list = await listDiscussionThreads(b, { unread: false, mine: false }, 1, u.db);
    expect(list?.items[0]).toMatchObject({ id, unread: true, isNew: true, newReplies: 0, authorName: "Maya Patel", mine: false });

    await markThreadRead(ctxU(b, 1), { threadId: id });
    expect(await countUnreadDiscussions(b, u.db)).toBe(0);

    // B replies (counts as reading it); A sees one unread, with one new reply.
    await createReply(ctxU(b, 5), { threadId: id, body: "Yes, Pedro." });
    expect(await countUnreadDiscussions(b, u.db)).toBe(0);
    expect(await countUnreadDiscussions(a, u.db)).toBe(1);
    list = await listDiscussionThreads(a, { unread: true, mine: false }, 1, u.db);
    expect(list?.items.map((i) => [i.id, i.unread, i.isNew, i.newReplies, i.lastActivityByName, i.lastActivityMine])).toEqual([
      [id, true, false, 1, "Ethan Chen", false],
    ]);
    // The reply came before the late joiner joined, so it isn't new to them either.
    expect(await countUnreadDiscussions(late, u.db)).toBe(0);

    // The page puts the "New" divider before that reply, then A opens it: read.
    let view = await getDiscussionThread(a, id, u.db);
    expect(view?.newFromReplyId).toBe(view?.replies[0]?.id);
    expect(view?.seen).toEqual(at(5));
    await markThreadRead(ctxU(a, 6), { threadId: id, seen: view!.seen.toISOString() });
    expect(await countUnreadDiscussions(a, u.db)).toBe(0);
    view = await getDiscussionThread(a, id, u.db);
    expect(view?.newFromReplyId).toBeNull();
    expect((await listDiscussionThreads(a, { unread: true, mine: false }, 1, u.db))?.total).toBe(0);
  });

  it("the read mark goes up to what the page showed, never past now, and never back", async () => {
    const { id } = await createThread(ctxU(a, 100), { title: "Paint", body: "Blue?", category: "OFF_TOPIC" });
    await createReply(ctxU(b, 110), { threadId: id, body: "Green" });
    // The page showed the discussion before B's reply landed: B's reply is still new.
    await markThreadRead(ctxU(a, 111), { threadId: id, seen: at(100).toISOString() });
    expect(await countUnreadDiscussions(a, u.db)).toBe(1);
    // A "seen" in the future is capped at now.
    await markThreadRead(ctxU(a, 112), { threadId: id, seen: at(10_000).toISOString() });
    const read = await u.db.discussionRead.findUniqueOrThrow({ where: { userId_threadId: { userId: a.id, threadId: id } } });
    expect(read.lastReadAt).toEqual(at(112));
    expect(await countUnreadDiscussions(a, u.db)).toBe(0);
    // An older mark never moves it back; garbage is "now".
    await markThreadRead(ctxU(a, 113), { threadId: id, seen: at(0).toISOString() });
    await markThreadRead(ctxU(a, 114), { threadId: id, seen: "not a date" });
    expect((await u.db.discussionRead.findUniqueOrThrow({ where: { userId_threadId: { userId: a.id, threadId: id } } })).lastReadAt).toEqual(at(114));
    await expect(markThreadRead(ctxU(a, 115), { threadId: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    // Late joiner: this discussion started after they joined, so it's new to them.
    expect(await countUnreadDiscussions(late, u.db)).toBe(1);
    const lateList = await listDiscussionThreads(late, { unread: true, mine: false }, 1, u.db);
    expect(lateList?.items.map((i) => [i.title, i.isNew, i.newReplies])).toEqual([["Paint", true, 1]]);
    // The whole discussion is new to them: no divider.
    expect((await getDiscussionThread(late, id, u.db))?.newFromReplyId).toBeNull();
  });

  it("deleting the unread reply takes the discussion off the unread count; a deleted account's activity counts", async () => {
    const { id } = await createThread(ctxU(a, 200), { title: "Sponsors", body: "Who's calling?", category: "BUSINESS" });
    await markThreadRead(ctxU(b, 201), { threadId: id });
    await createReply(ctxU(a, 202), { threadId: id, body: "Me" });
    const before = await countUnreadDiscussions(b, u.db);
    const reply = await u.db.discussionReply.findFirstOrThrow({ where: { threadId: id } });
    await deleteReply(ctxU(a, 203), { replyId: reply.id });
    expect(await countUnreadDiscussions(b, u.db)).toBe(before - 1);
    // A reply from an account that's gone (authorId null) is someone else's, even for the author of the discussion.
    await markThreadRead(ctxU(a, 204), { threadId: id });
    await u.db.discussionReply.create({ data: { threadId: id, body: "Ghost", authorId: null, createdAt: at(205) } });
    await u.db.discussionThread.update({ where: { id }, data: { lastActivityAt: at(205), lastActivityById: null, replyCount: 1 } });
    const list = await listDiscussionThreads(a, { unread: true, mine: false }, 1, u.db);
    expect(list?.items.map((i) => [i.title, i.newReplies, i.lastActivityByName])).toEqual([["Sponsors", 1, null]]);
  });

  it("the divider skips my own replies and falls on the first new one from someone else", () => {
    const r = (id: string, minutes: number, mine = false) => ({ id, createdAt: at(minutes), mine });
    const replies = [r("a", 1), r("b", 2, true), r("c", 3), r("d", 4)];
    expect(firstNewReplyId(replies, at(1))).toBe("c");
    expect(firstNewReplyId(replies, at(0))).toBe("a");
    expect(firstNewReplyId(replies, at(4))).toBeNull();
    expect(firstNewReplyId(replies, null)).toBeNull();
    expect(firstNewReplyId([r("x", 5, true)], at(0))).toBeNull();
  });

  it("says whether the mark moved, so opening a discussion that's already read doesn't refresh the page", async () => {
    const { id } = await createThread(ctxU(a, 300), { title: "Moved", body: "x", category: "IDEAS" });
    const seen = async (actor: Actor) => (await getDiscussionThread(actor, id, u.db))!.seen.toISOString();
    expect(await markThreadRead(ctxU(b, 301), { threadId: id, seen: await seen(b) })).toEqual({ moved: true });
    // Opened again with nothing new, or with an older `seen` (a reply was deleted): no change.
    expect(await markThreadRead(ctxU(b, 302), { threadId: id, seen: await seen(b) })).toEqual({ moved: false });
    expect(await markThreadRead(ctxU(b, 303), { threadId: id, seen: at(0).toISOString() })).toEqual({ moved: false });
    // Replying marks it read up to the reply, so opening the page right after posting changes nothing.
    await createReply(ctxU(b, 304), { threadId: id, body: "Mine" });
    expect(await markThreadRead(ctxU(b, 305), { threadId: id, seen: await seen(b) })).toEqual({ moved: false });
    // Someone else's reply: it moves.
    await createReply(ctxU(a, 306), { threadId: id, body: "Theirs" });
    expect(await markThreadRead(ctxU(b, 307), { threadId: id, seen: await seen(b) })).toEqual({ moved: true });
  });
});

describe("the list", () => {
  let l: TestDb;
  let a: Actor;
  let b: Actor;
  const ctxL = (actor: Actor, minutes: number) => ({ ...contextFor(l.db, actor), now: at(minutes) });
  beforeAll(async () => {
    l = await createTestDb();
    a = await makeUser(l.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
    b = await makeUser(l.db, { name: "Jordan Lee", role: "CAPTAIN" });
    await l.db.user.updateMany({ data: { createdAt: at(-60 * 24) } });
  });
  afterAll(async () => {
    await l.drop();
  });

  it("pinned first, then the latest activity; filters by category, mine, and a title search that escapes % and _", async () => {
    const make = (actor: Actor, title: string, category: string, minutes: number) =>
      createThread(ctxL(actor, minutes), { title, body: "Text", category });
    const old = await make(a, "100% autonomous", "SOFTWARE", 1);
    const mid = await make(b, "Rules Q_A", "GENERAL", 2);
    const recent = await make(a, "1000 autonomous runs", "SOFTWARE", 3);
    const back = await make(b, "Backslash \\ test", "OFF_TOPIC", 4);
    await createReply(ctxL(b, 10), { threadId: old.id, body: "Bump" });
    await setThreadPinned(ctxL(b, 11), { threadId: mid.id, pinned: "on" });

    const all = await listDiscussionThreads(a, { unread: false, mine: false }, 1, l.db);
    expect(all?.total).toBe(4);
    expect(all?.items.map((i) => i.id)).toEqual([mid.id, old.id, back.id, recent.id]);
    expect(all?.items[0]).toMatchObject({ pinned: true, authorName: "Jordan Lee", replyCount: 0 });
    expect(all?.items[1]).toMatchObject({ replyCount: 1, lastActivityByName: "Jordan Lee", lastActivityAt: at(10), mine: true });

    const ids = async (filters: Parameters<typeof listDiscussionThreads>[1]) =>
      (await listDiscussionThreads(a, filters, 1, l.db))?.items.map((i) => i.id);
    expect(await ids({ unread: false, mine: false, category: "SOFTWARE" })).toEqual([old.id, recent.id]);
    expect(await ids({ unread: false, mine: true })).toEqual([old.id, recent.id]);
    expect(await ids({ unread: false, mine: true, category: "GENERAL" })).toEqual([]);
    // "%" and "_" are literal, not wildcards; case doesn't matter.
    expect(await ids({ unread: false, mine: false, q: "100%" })).toEqual([old.id]);
    expect(await ids({ unread: false, mine: false, q: "q_a" })).toEqual([mid.id]);
    expect(await ids({ unread: false, mine: false, q: "Q%A" })).toEqual([]);
    expect(await ids({ unread: false, mine: false, q: "_" })).toEqual([mid.id]);
    expect(await ids({ unread: false, mine: false, q: "\\" })).toEqual([back.id]);
    expect(await ids({ unread: false, mine: false, q: "AUTONOMOUS" })).toEqual([old.id, recent.id]);
    // Control characters (a NUL byte would make Postgres fail the page) are dropped.
    expect(await ids({ unread: false, mine: false, q: "auto\u0000nomous" })).toEqual([old.id, recent.id]);
    // Unread for Maya: the pinned one and the backslash one (Jordan's) — her own are only unread with Jordan's reply.
    expect(await ids({ unread: true, mine: false })).toEqual([mid.id, old.id, back.id]);
  });

  it("paginates 30 a page and clamps the page number", async () => {
    for (let i = 0; i < 31; i++) {
      await l.db.rateLimit.deleteMany();
      await createThread(ctxL(b, 100 + i), { title: `Thread ${i}`, body: "x", category: "IDEAS" });
    }
    const first = await listDiscussionThreads(a, { unread: false, mine: false, category: "IDEAS" }, 1, l.db);
    expect(first).toMatchObject({ total: 31, page: 1, pageCount: 2 });
    expect(first?.items).toHaveLength(30);
    expect(first?.items[0].title).toBe("Thread 30");
    const last = await listDiscussionThreads(a, { unread: false, mine: false, category: "IDEAS" }, 99, l.db);
    expect(last).toMatchObject({ page: 2 });
    expect(last?.items.map((i) => i.title)).toEqual(["Thread 0"]);
  });
});

describe("rate limits", () => {
  it(`at most ${DISCUSSION_RATE_LIMITS.thread.limit} new discussions and ${DISCUSSION_RATE_LIMITS.reply.limit} replies an hour`, async () => {
    for (let i = 0; i < DISCUSSION_RATE_LIMITS.thread.limit; i++) await startThread(ava, { title: `Idea ${i}` });
    await expect(startThread(ava, { title: "One too many" })).rejects.toBeInstanceOf(RateLimitError);
    // A form with a mistake doesn't use up the allowance (checked first), and it's per person.
    await expect(startThread(ava, { title: "" })).rejects.toBeInstanceOf(ValidationError);
    const { id } = await startThread(ethan);
    for (let i = 0; i < DISCUSSION_RATE_LIMITS.reply.limit; i++) await createReply(ctxAt(ava), { threadId: id, body: `Reply ${i}` });
    await expect(createReply(ctxAt(ava), { threadId: id, body: "One too many" })).rejects.toBeInstanceOf(RateLimitError);
    expect((await threadRow(id)).replyCount).toBe(DISCUSSION_RATE_LIMITS.reply.limit);
    // An hour later it's fine again.
    await expect(createReply(ctxAt(ava, 61), { threadId: id, body: "Later" })).resolves.toMatchObject({ threadId: id });
  });

  it(`at most ${DISCUSSION_RATE_LIMITS.edit.limit} saved edits an hour, discussions and replies together`, async () => {
    const { id } = await startThread(ethan);
    const { id: replyId } = await createReply(ctxAt(ethan), { threadId: id, body: "v0" });
    let body = "v0";
    for (let i = 0; i < DISCUSSION_RATE_LIMITS.edit.limit; i++) {
      if (i % 2) {
        body = `v${i}`;
        await updateReply(ctxAt(ethan), { replyId, body });
      } else {
        await updateThread(ctxAt(ethan), { threadId: id, title: `Title ${i}`, body: "x", category: "BUILD" });
      }
    }
    // Saving it unchanged writes nothing, so it isn't counted (or refused).
    await expect(updateReply(ctxAt(ethan), { replyId, body })).resolves.toMatchObject({ changed: false });
    await expect(updateReply(ctxAt(ethan), { replyId, body: "One too many" })).rejects.toBeInstanceOf(RateLimitError);
    await expect(updateThread(ctxAt(ethan), { threadId: id, title: "One too many", body: "x", category: "BUILD" })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect((await t.db.discussionReply.findUniqueOrThrow({ where: { id: replyId } })).body).toBe(body);
    // Per person, and fine again an hour later.
    await expect(updateThread(ctxAt(maya), { threadId: (await startThread(maya)).id, title: "Mine", body: "x", category: "BUILD" })).resolves.toMatchObject({
      changed: true,
    });
    await expect(updateReply(ctxAt(ethan, 61), { replyId, body: "Later" })).resolves.toMatchObject({ changed: true });
  });
});

describe("accounts with posts", () => {
  it("can't be deleted (their posts would lose their author), and the People page offers no Delete", async () => {
    const poster = await makeUser(t.db, { name: "Pia Poster", role: "MEMBER", subteam: "BUSINESS" });
    const replier = await makeUser(t.db, { name: "Remy Replier", role: "MEMBER", subteam: "BUSINESS" });
    const { id } = await startThread(poster, { title: "Posted before being rejected" });
    await createReply(ctxAt(replier, 1), { threadId: id, body: "Me too" });
    await t.db.user.updateMany({ where: { id: { in: [poster.id, replier.id] } }, data: { status: "REJECTED" } });
    for (const who of [poster, replier]) {
      await expect(deleteUser(ctxAt(olivia), { userId: who.id }), who.name).rejects.toThrow(HAS_ACTIVITY_MESSAGE);
      expect(await getUserDetail(olivia, who.id, t.db, TEST_NOW), who.name).toMatchObject({ canDelete: false, hasActivity: true });
    }
    expect(await threadRow(id)).toMatchObject({ authorId: poster.id, lastActivityById: replier.id });
    // Someone who only read discussions is still a plain sign-up that can go.
    const reader = await makeUser(t.db, { name: "Rita Reader", role: "MEMBER", subteam: "BUSINESS" });
    await markThreadRead(ctxAt(reader, 2), { threadId: id });
    await t.db.user.update({ where: { id: reader.id }, data: { status: "REJECTED" } });
    await deleteUser(ctxAt(olivia), { userId: reader.id });
    expect(await t.db.user.count({ where: { id: reader.id } })).toBe(0);
  });
});

describe("list filters in the URL", () => {
  it("keeps only known values and builds links back", () => {
    const f = parseDiscussionFilters({ category: "SOFTWARE", unread: "1", mine: "yes", q: ["  pedro\u0000 ", "x"], page: "2" });
    expect(f).toEqual({ category: "SOFTWARE", unread: true, mine: false, q: "pedro" });
    expect(parseDiscussionFilters({ category: "ROBOTS", q: "   " })).toEqual({ category: undefined, unread: false, mine: false, q: undefined });
    expect(parseDiscussionFilters({ q: "x".repeat(500) }).q).toHaveLength(100);
    expect(hasDiscussionFilters({ unread: false, mine: false })).toBe(false);
    expect(hasDiscussionFilters(f)).toBe(true);
    expect(discussionListHref(f, 2)).toBe("/discussion?category=SOFTWARE&unread=1&q=pedro&page=2");
    expect(discussionListHref({ unread: false, mine: true, q: "a&b" })).toBe("/discussion?mine=1&q=a%26b");
    expect(discussionListHref({ unread: false, mine: false })).toBe("/discussion");
    expect(newDiscussionHref("BUILD")).toBe("/discussion/new?category=BUILD");
    expect(repliesLabel(0)).toBe("No replies yet");
    expect(repliesLabel(1)).toBe("1 reply");
    expect(repliesLabel(1200)).toBe("1,200 replies");
  });
});

describe("actions: what refreshes the page", () => {
  function form(fields: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  }
  /** Runs an action as `actor` and says how many times it refreshed the page. */
  async function run<T>(actor: Actor, minutes: number, action: () => Promise<T>): Promise<{ result: T; refreshed: number }> {
    actions.ctx = ctxAt(actor, minutes);
    actions.refreshed = 0;
    try {
      return { result: await action(), refreshed: actions.refreshed };
    } finally {
      actions.ctx = null;
    }
  }

  it("editing a reply that was just deleted says so and doesn't refresh (the box and the typed text stay)", async () => {
    const { id } = await startThread(maya);
    const { id: replyId } = await createReply(ctxAt(ethan, 1), { threadId: id, body: "Mine" });
    const version = (await t.db.discussionReply.findUniqueOrThrow({ where: { id: replyId } })).updatedAt.toISOString();
    // Saved: refreshed. Saved from an old tab: refreshed too, so saving again replaces it.
    const saved = await run(ethan, 2, () => updateReplyAction(null, form({ replyId, version, body: "Mine, edited" })));
    expect(saved).toEqual({ result: expect.objectContaining({ ok: true, message: "Reply updated." }), refreshed: 1 });
    const stale = await run(ethan, 3, () => updateReplyAction(null, form({ replyId, version, body: "Other tab" })));
    expect(stale).toEqual({ result: expect.objectContaining({ ok: false, message: DISCUSSION_REPLY_CHANGED }), refreshed: 1 });
    // A leader deletes it while Ethan edits.
    await deleteReply(ctxAt(jordan, 4), { replyId });
    const gone = await run(ethan, 5, () => updateReplyAction(null, form({ replyId, version, body: "Too late" })));
    expect(gone).toEqual({ result: expect.objectContaining({ ok: false, message: DISCUSSION_REPLY_NOT_FOUND }), refreshed: 0 });
    // The whole discussion gone: the same (not a refresh into a 404).
    const { id: replyId2 } = await createReply(ctxAt(ethan, 6), { threadId: id, body: "Again" });
    await deleteThread(ctxAt(jordan, 7), { threadId: id });
    const threadGone = await run(ethan, 8, () => updateReplyAction(null, form({ replyId: replyId2, body: "Too late" })));
    expect(threadGone.refreshed).toBe(0);
  });

  it("the edit page refreshes after a conflict, but not when the discussion is gone or was just locked", async () => {
    const { id } = await startThread(maya);
    const v0 = (await threadRow(id)).updatedAt.toISOString();
    await updateThread(ctxAt(maya, 1), { threadId: id, title: "Other tab", body: "x", category: "BUILD", version: v0 });
    const fields = { threadId: id, title: "This tab", body: "y", category: "BUILD", version: v0 };
    const stale = await run(maya, 2, () => updateThreadAction(null, form(fields)));
    expect(stale).toEqual({ result: expect.objectContaining({ ok: false, message: DISCUSSION_CHANGED }), refreshed: 1 });
    const v1 = (await threadRow(id)).updatedAt.toISOString();
    await setThreadLocked(ctxAt(jordan, 3), { threadId: id, locked: "on" });
    const locked = await run(maya, 4, () => updateThreadAction(null, form({ ...fields, version: v1 })));
    expect(locked).toEqual({ result: expect.objectContaining({ ok: false, message: DISCUSSION_LOCKED_EDIT }), refreshed: 0 });
    await deleteThread(ctxAt(jordan, 5), { threadId: id });
    const gone = await run(maya, 6, () => updateThreadAction(null, form({ ...fields, version: v1 })));
    expect(gone).toEqual({ result: expect.objectContaining({ ok: false, message: "That discussion no longer exists." }), refreshed: 0 });
  });

  it("opening a discussion refreshes the page only when that changes the read mark", async () => {
    const { id } = await startThread(maya, { title: "Open me" });
    const seen = (await getDiscussionThread(ethan, id, t.db))!.seen.toISOString();
    expect(await run(ethan, 1, () => markThreadReadAction(id, seen))).toEqual({ result: expect.objectContaining({ ok: true }), refreshed: 1 });
    // Already read: no second render.
    expect(await run(ethan, 2, () => markThreadReadAction(id, seen))).toEqual({ result: expect.objectContaining({ ok: true }), refreshed: 0 });
  });
});
