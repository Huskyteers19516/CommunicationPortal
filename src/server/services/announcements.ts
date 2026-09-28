// Announcements (/announcements): news from leaders, the captain, mentors, teachers, and owners, for the whole team
// or one subteam. Everyone ACTIVE reads all of them (queries/announcements.ts).
// - Posting: canPostAnnouncement, for the whole team or one subteam, limited to announcementAudiences (a subteam
//   leader: the whole team or their own subteam). Creates are rate-limited (ANNOUNCEMENT_RATE_LIMIT).
// - Editing, pinning, removing: canEditAnnouncement (whoever posted it while they can still post, and all-scope
//   staff). An edit may keep the audience it has, or move it to one the editor can post for. Only a change to the
//   title or text marks it "edited" (editedAt). The edit form sends `version` (the updatedAt it loaded): a stale
//   save is a ConflictError.
// - Opening the list marks everything up to then as seen (markAnnouncementsSeen → User.announcementsSeenAt).
// No emails.
import { z } from "zod";
import { Subteam } from "@/generated/prisma/enums";
import { LIMITS, SUBTEAM_LABELS } from "@/lib/constants";
import { checkbox, idSchema, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError } from "../errors";
import { announcementAudiences, canEditAnnouncement, canPostAnnouncement } from "../permissions";
import { unreadAnnouncementsWhere } from "../queries/announcements";
import { consumeRateLimit, enforceRateLimit } from "../rate-limit";

const HOUR = 60 * 60 * 1000;
/** New announcements per person per hour. */
export const ANNOUNCEMENT_RATE_LIMIT = { limit: 20, windowMs: HOUR } as const;
/** Edits, pins, and removals per person per hour. */
export const ANNOUNCEMENT_WRITES_PER_HOUR = 120;

export const ANNOUNCEMENT_NOT_FOUND = "That announcement was removed.";
export const ANNOUNCEMENT_CHANGED =
  "Someone else changed this announcement while you were editing. Save again to replace their changes with yours, or cancel to see them.";
export const ANNOUNCEMENT_CHANGED_BEFORE_REMOVE = "Someone changed this announcement just now. Take a look, then remove it if you still want to.";
export const ANNOUNCEMENT_BUSY = "Someone is changing this announcement right now. Please try again.";
export const ANNOUNCEMENT_CANT_POST = "Only leaders, the captain, mentors, and teachers can post announcements.";
export const ANNOUNCEMENT_CANT_EDIT = "Only whoever posted it, or the captain, a mentor, or a teacher, can change this announcement.";
const INACTIVE = "Your account isn't active.";
const AUDIENCE_REQUIRED = "Pick who it's for.";

/** "You can post for the whole team or Build." */
function audienceNotAllowed(ctx: ServiceContext): string {
  const own = announcementAudiences(ctx.actor).filter((s): s is Subteam => s !== null);
  if (own.length === 1) return `You can post for the whole team or ${SUBTEAM_LABELS[own[0]]}.`;
  return "You can't post announcements for that subteam.";
}

// ---------- input ----------

/** Postgres text can't hold NUL characters: drop them (before the length check). */
const withoutNul = (v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v);

/** The form's "For" radio: "team" = the whole team (null), else one subteam. */
const audienceField = z
  .enum(["team", ...Object.values(Subteam)] as ["team", ...Subteam[]], { error: AUDIENCE_REQUIRED })
  .transform((v): Subteam | null => (v === "team" ? null : v));

const fields = z.object({
  title: z.preprocess(withoutNul, text("Title", LIMITS.announcementTitleMax)),
  body: z.preprocess(withoutNul, text("Message", LIMITS.announcementBodyMax)),
  audience: audienceField,
  pinned: checkbox,
});

type Fields = z.infer<typeof fields>;

const idInput = z.object({ announcementId: idSchema });
const pinInput = z.object({ announcementId: idSchema, pinned: checkbox });

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(INACTIVE);
}

/** A `version` from the edit form (the updatedAt it loaded, ISO), or null when none was sent. */
function parseVersion(value: unknown, message: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "string" && value.length <= 40 ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ConflictError(message);
  return date;
}

/** The next `version`: always later than the one just matched, even within the same millisecond. */
function nextVersion(ctx: ServiceContext, current: Date): Date {
  return new Date(Math.max(ctx.now.getTime(), current.getTime() + 1));
}

async function limitCreates(ctx: ServiceContext) {
  const { limit, windowMs } = ANNOUNCEMENT_RATE_LIMIT;
  if (!(await consumeRateLimit(ctx.db, `announcement:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError("You've posted a lot of announcements in the last hour. Please wait a bit and try again.");
  }
}

async function limitWrites(ctx: ServiceContext) {
  await enforceRateLimit(ctx.db, `announcement-edit:${ctx.actor.id}`, ANNOUNCEMENT_WRITES_PER_HOUR, HOUR, ctx.now);
}

async function findForChange(ctx: ServiceContext, id: string) {
  const existing = await ctx.db.announcement.findUnique({
    where: { id },
    select: { authorId: true, subteam: true, title: true, body: true, pinned: true, updatedAt: true },
  });
  if (!existing) throw new NotFoundError(ANNOUNCEMENT_NOT_FOUND);
  if (!canEditAnnouncement(ctx.actor, existing)) throw new ForbiddenError(ANNOUNCEMENT_CANT_EDIT);
  return existing;
}

// ---------- services ----------

/** Post an announcement for the whole team or one subteam (optionally pinned to the top). */
export async function createAnnouncement(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  if (!canPostAnnouncement(ctx.actor)) throw new ForbiddenError(ANNOUNCEMENT_CANT_POST);
  const f: Fields = parseInput(fields, asRecord(raw));
  if (!announcementAudiences(ctx.actor).includes(f.audience)) throw new ForbiddenError(audienceNotAllowed(ctx));
  await limitCreates(ctx);
  const { id } = await ctx.db.announcement.create({
    data: {
      title: f.title,
      body: f.body,
      subteam: f.audience,
      pinned: f.pinned,
      authorId: ctx.actor.id,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    },
    select: { id: true },
  });
  return { id };
}

/**
 * Save the edit form. Only an actual change is written; a change to the title or text also marks it "edited".
 * Conditional on the `version` the form loaded: if it changed since (an edit, a pin), nothing is saved.
 */
export async function updateAnnouncement(ctx: ServiceContext, raw: unknown): Promise<{ id: string; changed: boolean }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { announcementId } = parseInput(idInput, rec);
  const existing = await findForChange(ctx, announcementId);
  // Before the fields: a stale form hears about the other change first.
  const version = parseVersion(rec.version, ANNOUNCEMENT_CHANGED);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(ANNOUNCEMENT_CHANGED);
  const f: Fields = parseInput(fields, rec);
  // It may stay for whoever it's for; moving it needs being able to post for the new audience.
  if (f.audience !== existing.subteam && !announcementAudiences(ctx.actor).includes(f.audience)) {
    throw new ForbiddenError(audienceNotAllowed(ctx));
  }

  const textChanged = f.title !== existing.title || f.body !== existing.body;
  const changed = textChanged || f.audience !== existing.subteam || f.pinned !== existing.pinned;
  if (!changed) return { id: announcementId, changed: false };

  await limitWrites(ctx);
  const { count } = await ctx.db.announcement.updateMany({
    where: { id: announcementId, updatedAt: existing.updatedAt },
    data: {
      title: f.title,
      body: f.body,
      subteam: f.audience,
      pinned: f.pinned,
      updatedAt: nextVersion(ctx, existing.updatedAt),
      ...(textChanged ? { editedAt: ctx.now } : {}),
    },
  });
  if (count === 0) {
    const still = await ctx.db.announcement.count({ where: { id: announcementId } });
    throw still ? new ConflictError(ANNOUNCEMENT_CHANGED) : new NotFoundError(ANNOUNCEMENT_NOT_FOUND);
  }
  return { id: announcementId, changed: true };
}

/**
 * Pin to the top / unpin (whoever can edit it). Not an "edit": editedAt stays. It does move the version, so an
 * edit form opened before it asks before saving over it. Like every write, it's conditional on the version it read
 * (so the new one is always later than any other write's): if something changed in between, it reads again once.
 */
export async function setAnnouncementPinned(ctx: ServiceContext, raw: unknown): Promise<{ pinned: boolean; changed: boolean }> {
  requireActive(ctx);
  const { announcementId, pinned } = parseInput(pinInput, asRecord(raw));
  for (let attempt = 1; ; attempt++) {
    const existing = await findForChange(ctx, announcementId);
    if (existing.pinned === pinned) return { pinned, changed: false };
    if (attempt === 1) await limitWrites(ctx);
    const { count } = await ctx.db.announcement.updateMany({
      where: { id: announcementId, updatedAt: existing.updatedAt },
      data: { pinned, updatedAt: nextVersion(ctx, existing.updatedAt) },
    });
    if (count > 0) return { pinned, changed: true };
    // Changed (or removed: the next read says so) between the read and the write.
    if (attempt >= 2) throw new ConflictError(ANNOUNCEMENT_BUSY);
  }
}

/**
 * Remove an announcement (whoever can edit it). With a `version` (what the page showed), it's only removed if
 * nobody changed it since.
 */
export async function deleteAnnouncement(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { announcementId } = parseInput(idInput, rec);
  const existing = await findForChange(ctx, announcementId);
  const version = parseVersion(rec.version, ANNOUNCEMENT_CHANGED_BEFORE_REMOVE);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(ANNOUNCEMENT_CHANGED_BEFORE_REMOVE);
  await limitWrites(ctx);
  const { count } = await ctx.db.announcement.deleteMany({ where: { id: announcementId, updatedAt: existing.updatedAt } });
  if (count === 0) {
    const still = await ctx.db.announcement.count({ where: { id: announcementId } });
    throw still ? new ConflictError(ANNOUNCEMENT_CHANGED_BEFORE_REMOVE) : new NotFoundError(ANNOUNCEMENT_NOT_FOUND);
  }
  return { id: announcementId };
}

/**
 * How long before the list loaded something must have been posted to count as seen. A post is stamped when its
 * request starts and saved a moment later, so one stamped just before the page loaded may not have been on it yet:
 * it stays unread (still "New", and the next visit clears it) rather than being marked seen unshown.
 */
export const ANNOUNCEMENTS_SEEN_MARGIN_MS = 2000;

/**
 * The person opened Announcements: everything posted up to `upTo` (when the page they're looking at was loaded;
 * never later than now), minus ANNOUNCEMENTS_SEEN_MARGIN_MS, counts as seen. Only moves forward (never back before
 * when they joined, either). `cleared` = how many unread announcements for them this marked seen (0 = the nav badge
 * doesn't change).
 */
export async function markAnnouncementsSeen(ctx: ServiceContext, raw: unknown): Promise<{ cleared: number }> {
  requireActive(ctx);
  const upToRaw = asRecord(raw).upTo;
  const parsed = typeof upToRaw === "string" && upToRaw.length <= 40 ? new Date(upToRaw) : null;
  const loadedAt = parsed && !Number.isNaN(parsed.getTime()) && parsed.getTime() < ctx.now.getTime() ? parsed : ctx.now;
  const upTo = new Date(loadedAt.getTime() - ANNOUNCEMENTS_SEEN_MARGIN_MS);

  const user = await ctx.db.user.findUnique({ where: { id: ctx.actor.id }, select: { announcementsSeenAt: true, createdAt: true } });
  if (!user) return { cleared: 0 };
  const since = user.announcementsSeenAt ?? user.createdAt;
  if (upTo.getTime() <= since.getTime()) return { cleared: 0 };

  const cleared = await ctx.db.announcement.count({
    where: { AND: [unreadAnnouncementsWhere(ctx.actor, since), { createdAt: { lte: upTo } }] },
  });
  await ctx.db.user.updateMany({
    where: { id: ctx.actor.id, OR: [{ announcementsSeenAt: null }, { announcementsSeenAt: { lt: upTo } }] },
    data: { announcementsSeenAt: upTo },
  });
  return { cleared };
}
