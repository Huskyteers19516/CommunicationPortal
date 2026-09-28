// Meeting updates: after every meeting, each subteam (Software, Build, Business) writes what it did, what's
// next, and any problems. Several people may write for the same subteam and day; each update shows who
// wrote it (and who last edited it).
// - Writing: for your own subteam (the captain, mentors, teachers, and owners: any) — meetingUpdateSubteams.
// - Editing / removing: whoever wrote it, that subteam's leader, and all-scope staff — canEditMeetingUpdate.
//   Moving an update to another subteam also needs being able to write for that subteam.
// - Every ACTIVE person reads them all (queries/meeting-updates.ts).
// The edit form sends `version` (the updatedAt it loaded), so a stale form can't undo someone else's edit.
import { z } from "zod";
import { Subteam } from "@/generated/prisma/enums";
import { LIMITS, SUBTEAM_LABELS } from "@/lib/constants";
import { type DateOnly, dateOnlyToDb, dbToDateOnly, isDateOnly, todayInTimezone } from "@/lib/dates";
import { meetingDateProblem } from "@/lib/meeting-updates";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canEditMeetingUpdate, canWriteMeetingUpdate, meetingUpdateSubteams } from "../permissions";
import { consumeRateLimit, enforceRateLimit } from "../rate-limit";

const HOUR = 60 * 60 * 1000;
/** New updates per person per hour. */
export const MEETING_UPDATE_RATE_LIMIT = { limit: 30, windowMs: HOUR } as const;
/** Edits and removals per person per hour. */
export const MEETING_UPDATE_WRITES_PER_HOUR = 120;

export const MEETING_UPDATE_NOT_FOUND = "That update was removed.";
export const MEETING_UPDATE_CHANGED =
  "Someone else changed this update while you were editing. Save again to replace their changes with yours, or cancel to see them.";
export const MEETING_UPDATE_CHANGED_BEFORE_REMOVE = "Someone changed this update just now. Take a look, then remove it if you still want to.";
const INACTIVE = "Your account isn't active.";
const NO_SUBTEAM = "Meeting updates are written by subteam members. Ask a leader to set your subteam.";
const BODY_REQUIRED = "Write what the subteam did.";
const SUBTEAM_REQUIRED = "Pick the subteam this update is for.";

function tooLong(label: string, max: number) {
  return `“${label}” can be at most ${max.toLocaleString("en-US")} characters.`;
}

function cannotWriteFor(subteam: Subteam) {
  return `You can't write ${SUBTEAM_LABELS[subteam]} updates — only your own subteam's.`;
}

// ---------- input ----------

/**
 * Browsers send line breaks as \r\n; count them as one character, like the textarea's maxLength does.
 * NUL characters are dropped (Postgres text can't store them).
 */
const normalized = (v: unknown) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/\u0000/g, "") : v);

const bodyField = z.preprocess(
  (v) => normalized(v ?? ""),
  z
    .string({ error: BODY_REQUIRED })
    .trim()
    .min(1, BODY_REQUIRED)
    .max(LIMITS.meetingUpdateBodyMax, tooLong("What we did", LIMITS.meetingUpdateBodyMax)),
);

function optionalField(label: string, max: number) {
  return z.preprocess((v) => normalized(v ?? ""), z.string({ error: tooLong(label, max) }).trim().max(max, tooLong(label, max)));
}

/** "YYYY-MM-DD" (the date field); an empty one asks for the date. */
const meetingDateField = z.preprocess(
  (v) => (v === undefined || v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
  z.string({ error: "Pick the meeting date." }).trim().refine(isDateOnly, "Pick a valid date."),
);

const fields = z.object({
  meetingDate: meetingDateField,
  subteam: z.enum(Subteam, { error: SUBTEAM_REQUIRED }),
  body: bodyField,
  nextSteps: optionalField("Next time", LIMITS.meetingUpdateNextMax),
  blockers: optionalField("Problems or help needed", LIMITS.meetingUpdateBlockersMax),
});

type Fields = z.infer<typeof fields>;

const idInput = z.object({ updateId: idSchema });

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(INACTIVE);
}

function today(ctx: ServiceContext): DateOnly {
  return todayInTimezone(ctx.config.teamTimezone, ctx.now);
}

/**
 * Check the whole form at once (fields and the date's range), so every problem shows in one go.
 * `keepDate`: an edit may leave the meeting date as it was, however long ago it is.
 */
function parseForm(ctx: ServiceContext, rec: Record<string, unknown>, keepDate: DateOnly | null = null): Fields {
  const errors: Record<string, string> = {};
  let parsed: Fields | undefined;
  try {
    parsed = parseInput(fields, rec);
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    Object.assign(errors, e.fieldErrors);
  }
  // Format problems ("Pick a valid date.") come from the fields above; the range only for a real date.
  const date = meetingDateField.safeParse(rec.meetingDate);
  if (date.success && date.data !== keepDate) {
    const problem = meetingDateProblem(date.data, today(ctx));
    if (problem) errors.meetingDate ??= problem;
  }
  const messages = Object.values(errors);
  if (messages.length > 0 || !parsed) {
    throw new ValidationError(messages.length === 1 ? messages[0] : "Please fix the highlighted fields.", errors);
  }
  return parsed;
}

/** The edit form's `version`: the update's updatedAt when the form was opened (ISO), or missing. */
function parseVersion(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = typeof value === "string" && value.length <= 40 ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ConflictError(MEETING_UPDATE_CHANGED);
  return date;
}

async function limitCreates(ctx: ServiceContext) {
  const { limit, windowMs } = MEETING_UPDATE_RATE_LIMIT;
  if (!(await consumeRateLimit(ctx.db, `meeting-update:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError("You've posted a lot of updates in the last hour. Please wait a bit and try again.");
  }
}

async function limitWrites(ctx: ServiceContext) {
  await enforceRateLimit(ctx.db, `meeting-update-edit:${ctx.actor.id}`, MEETING_UPDATE_WRITES_PER_HOUR, HOUR, ctx.now);
}

// ---------- services ----------

/** Write an update for one subteam's meeting. */
export async function createMeetingUpdate(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  if (meetingUpdateSubteams(ctx.actor).length === 0) throw new ForbiddenError(NO_SUBTEAM);
  const f = parseForm(ctx, asRecord(raw));
  if (!canWriteMeetingUpdate(ctx.actor, f.subteam)) throw new ForbiddenError(cannotWriteFor(f.subteam));
  await limitCreates(ctx);
  const { id } = await ctx.db.meetingUpdate.create({
    data: {
      meetingDate: dateOnlyToDb(f.meetingDate),
      subteam: f.subteam,
      body: f.body,
      nextSteps: f.nextSteps,
      blockers: f.blockers,
      authorId: ctx.actor.id,
    },
    select: { id: true },
  });
  return { id };
}

/**
 * Save the edit form. Only an actual change is written (and marked "edited by … "). Conditional on the
 * `version` the form loaded: if the update changed since, nothing is saved (ConflictError).
 */
export async function updateMeetingUpdate(ctx: ServiceContext, raw: unknown): Promise<{ id: string; changed: boolean }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { updateId } = parseInput(idInput, rec);
  const existing = await ctx.db.meetingUpdate.findUnique({
    where: { id: updateId },
    select: { authorId: true, subteam: true, meetingDate: true, body: true, nextSteps: true, blockers: true, updatedAt: true },
  });
  if (!existing) throw new NotFoundError(MEETING_UPDATE_NOT_FOUND);
  if (!canEditMeetingUpdate(ctx.actor, existing)) throw new ForbiddenError("Only whoever wrote it, their subteam's leader, and the captain or mentors can change this update.");
  const version = parseVersion(rec.version);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(MEETING_UPDATE_CHANGED);
  const savedDate = dbToDateOnly(existing.meetingDate);
  const f = parseForm(ctx, rec, savedDate);
  if (f.subteam !== existing.subteam && !canWriteMeetingUpdate(ctx.actor, f.subteam)) {
    throw new ForbiddenError(cannotWriteFor(f.subteam));
  }

  const changed =
    f.meetingDate !== savedDate ||
    f.subteam !== existing.subteam ||
    f.body !== existing.body ||
    f.nextSteps !== existing.nextSteps ||
    f.blockers !== existing.blockers;
  if (!changed) return { id: updateId, changed: false };

  await limitWrites(ctx);
  const { count } = await ctx.db.meetingUpdate.updateMany({
    where: { id: updateId, updatedAt: version ?? existing.updatedAt },
    data: {
      // The next `version`: always later than the one just matched, even within the same millisecond (or when
      // this server's clock is behind the last writer's), so a form loaded before this save can't match it.
      updatedAt: new Date(Math.max(ctx.now.getTime(), existing.updatedAt.getTime() + 1)),
      meetingDate: dateOnlyToDb(f.meetingDate),
      subteam: f.subteam,
      body: f.body,
      nextSteps: f.nextSteps,
      blockers: f.blockers,
      lastEditedAt: ctx.now,
      lastEditedById: ctx.actor.id,
    },
  });
  if (count === 0) {
    const still = await ctx.db.meetingUpdate.count({ where: { id: updateId } });
    throw still ? new ConflictError(MEETING_UPDATE_CHANGED) : new NotFoundError(MEETING_UPDATE_NOT_FOUND);
  }
  return { id: updateId, changed: true };
}

/**
 * Remove an update (whoever wrote it, that subteam's leader, all-scope staff). Conditional on the update being
 * as it was when permission was checked: if it moved subteam, changed author, or was edited meanwhile, nothing
 * is removed (ConflictError).
 */
export async function deleteMeetingUpdate(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ subteam: Subteam; meetingDate: DateOnly }> {
  requireActive(ctx);
  const { updateId } = parseInput(idInput, asRecord(raw));
  const existing = await ctx.db.meetingUpdate.findUnique({
    where: { id: updateId },
    select: { authorId: true, subteam: true, meetingDate: true, updatedAt: true },
  });
  if (!existing) throw new NotFoundError(MEETING_UPDATE_NOT_FOUND);
  if (!canEditMeetingUpdate(ctx.actor, existing)) throw new ForbiddenError("Only whoever wrote it, their subteam's leader, and the captain or mentors can remove this update.");
  await limitWrites(ctx);
  const { count } = await ctx.db.meetingUpdate.deleteMany({
    where: { id: updateId, authorId: existing.authorId, subteam: existing.subteam, updatedAt: existing.updatedAt },
  });
  if (count === 0) {
    const still = await ctx.db.meetingUpdate.count({ where: { id: updateId } });
    throw still ? new ConflictError(MEETING_UPDATE_CHANGED_BEFORE_REMOVE) : new NotFoundError(MEETING_UPDATE_NOT_FOUND);
  }
  return { subteam: existing.subteam, meetingDate: dbToDateOnly(existing.meetingDate) };
}
