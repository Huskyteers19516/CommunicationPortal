// Meeting recaps (/meetings): the key points of team meetings, named and put in categories, with the transcript and,
// for 3 days, the recording. Everyone ACTIVE reads them (queries/meeting-recaps.ts); everyone with admin access
// (canManageMeetingRecaps) records, writes, edits, and deletes them.
//
// - The recorder (in the browser) saves the recap's text first (createMeetingRecap, which also says how big the
//   recording is and in how many parts it comes, with a request id so saving again never makes a second recap), then
//   uploads the recording one part at a time (addMeetingAudioPart: MEETING_AUDIO_PART_BYTES each, one Server Action
//   call each, under Vercel's 4.5 MB limit). A failed upload never loses the text, and an interrupted one can be
//   finished later (getMeetingAudioUploadState says which parts are in).
// - Parts are stored like every other upload (Postgres or Cloudflare R2: ../files/stored.ts, file kind
//   "meeting-audio") under the team's storage cap. No part upload ever writes the recap's row, so an open edit form
//   never goes stale because of one.
// - The recording is kept exactly 3 days (audioExpiresAt = saved + MEETING_AUDIO_KEEP_MS): from then on every read
//   treats it as deleted. purgeExpiredMeetingAudio deletes the parts afterwards (after() on the meeting pages and
//   actions, Vercel's daily cron, /api/cron/meeting-audio, and before a new recording is checked against the storage
//   cap); "Delete recording now" (deleteMeetingAudio) sooner.
//   Both set audioDeletedAt with raw SQL, so updatedAt (the edit form's version) never moves. The transcript and key
//   points stay.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb, dbToDateOnly, type DateOnly, todayInTimezone } from "@/lib/dates";
import { formatFileSize } from "@/lib/files";
import {
  MEETING_AUDIO_KEEP_MS,
  MEETING_AUDIO_MAX_BYTES,
  MEETING_AUDIO_PART_BYTES,
  MEETING_CATEGORIES_PER_RECAP_MAX,
  MEETING_DURATION_MAX_SEC,
  meetingAudioExtension,
  meetingAudioPartCount,
  type MeetingAudioType,
  type MeetingAudioUploadState,
  normalizeMeetingAudioType,
  parseMeetingRequestId,
  sniffMeetingAudioType,
} from "@/lib/meeting-recaps";
import { dateOnlySchema, idSchema, normalizeLineBreaks, stringArray, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import type { Db } from "../db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { assertFileStorageRoom, checkFileStorageRoom, type FileStorageUsage, storageFullSentence } from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { fileError, readUpload } from "../files/upload";
import { canManageMeetingRecaps } from "../permissions";
import { consumeRateLimit, enforceRateLimit } from "../rate-limit";

const HOUR = 60 * 60 * 1000;
/** New recaps per person per hour. */
export const MEETING_RECAP_RATE_LIMIT = { limit: 20, windowMs: HOUR } as const;
/** Edits and deletes (recaps and recordings) per person per hour. */
export const MEETING_RECAP_WRITES_PER_HOUR = 120;
/** Recording parts uploaded per person per hour (a 3-hour recording is about 20). */
export const MEETING_AUDIO_PARTS_PER_HOUR = 300;

export const MEETING_RECAP_FORBIDDEN = "Only people with admin access can record and change meeting recaps.";
export const MEETING_RECAP_NOT_FOUND = "That meeting recap was deleted.";
export const MEETING_RECAP_CHANGED =
  "Someone else changed this recap while you were editing. Your save didn't go through — check the newest version and save again.";
export const MEETING_RECAP_CHANGED_BEFORE_DELETE = "Someone changed this recap just now. Take a look, then delete it if you still want to.";
export const MEETING_CATEGORY_GONE = "One of the categories was removed — pick again.";
export const MEETING_AUDIO_NONE = "This recap was saved without a recording.";
export const MEETING_AUDIO_ALREADY_DELETED = "The recording is already deleted.";
export const MEETING_AUDIO_TOO_LATE = "This recording's 3 days are up, so the rest of it can't be uploaded anymore.";
export const MEETING_AUDIO_TYPE_REFUSED = "That kind of recording can't be kept (WebM, M4A, Ogg, WAV, or MP3 only). Save the recap without it.";
export const MEETING_AUDIO_TOO_BIG = `Recordings can be up to ${formatFileSize(MEETING_AUDIO_MAX_BYTES)}. Save the recap without it.`;
export const MEETING_AUDIO_PARTS_INVALID = "The recording's size and number of parts don't match. Try saving again.";
export const MEETING_AUDIO_PART_MISSING = "That part of the recording didn't arrive. Try again.";
export const MEETING_AUDIO_PART_WRONG_SIZE = "That part of the recording isn't the size it should be. Start the upload again.";
export const MEETING_AUDIO_PART_WRONG_TYPE = "That isn't the kind of recording this recap was saved with. Start the upload again.";
export const MEETING_AUDIO_POSITION_INVALID = "That part isn't one of this recording's parts.";
export const MEETING_AUDIO_SAVED_WITHOUT = "This recap was already saved without its recording, so the recording can't be added to it now.";

export type { MeetingAudioUploadState };

type Tx = Prisma.TransactionClient;

// ---------- input ----------

/** Postgres text can't hold NUL characters: drop them (before the length check). */
const withoutNul = (v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v);

/** Long optional text (key points, transcript): missing = "", line breaks saved as "\n" (and counted as one). */
function longText(label: string, max: number) {
  return z.preprocess(
    (v) => (v === undefined || v === null ? "" : withoutNul(v)),
    z
      .string({ error: `${label} must be text.` })
      .overwrite(normalizeLineBreaks)
      .trim()
      .max(max, `${label} can be at most ${max.toLocaleString("en-US")} characters.`),
  );
}

/** A whole number from a form (a string) or a call (a number); "" / missing = null. */
function wholeNumber(message: string) {
  return z.preprocess(
    (v) => (v === undefined || v === null || v === "" ? null : typeof v === "string" ? Number(v.trim()) : v),
    z.number({ error: message }).int(message).nullable(),
  );
}

const categoryIdsField = stringArray
  .transform((ids) => [...new Set(ids)])
  .refine((ids) => ids.length <= MEETING_CATEGORIES_PER_RECAP_MAX, `Pick up to ${MEETING_CATEGORIES_PER_RECAP_MAX} categories.`);

const DURATION_INVALID = "The meeting's length must be a number of seconds.";

const fields = z.object({
  title: z.preprocess(withoutNul, text("Title", LIMITS.meetingTitleMax)),
  meetingDate: dateOnlySchema,
  categoryIds: categoryIdsField,
  keyPoints: longText("Key points", LIMITS.meetingKeyPointsMax),
  transcript: longText("The transcript", LIMITS.meetingTranscriptMax),
  durationSec: wholeNumber(DURATION_INVALID)
    .refine((v) => v === null || v >= 0, DURATION_INVALID)
    .refine((v) => v === null || v <= MEETING_DURATION_MAX_SEC, `A meeting can be at most ${MEETING_DURATION_MAX_SEC / 3600} hours long.`),
});

type Fields = z.infer<typeof fields>;

/** The recording the browser is about to upload: its type, size, and how many parts (must match the size). */
const audioFields = z
  .object({
    audioType: z
      .string({ error: MEETING_AUDIO_TYPE_REFUSED })
      .transform(normalizeMeetingAudioType)
      .refine((t) => t !== null, MEETING_AUDIO_TYPE_REFUSED),
    audioBytes: wholeNumber(MEETING_AUDIO_PARTS_INVALID)
      .refine((v) => v !== null && v >= 1, MEETING_AUDIO_PARTS_INVALID)
      .refine((v) => v === null || v <= MEETING_AUDIO_MAX_BYTES, MEETING_AUDIO_TOO_BIG),
    audioParts: wholeNumber(MEETING_AUDIO_PARTS_INVALID),
  })
  .refine((a) => a.audioBytes !== null && a.audioParts === meetingAudioPartCount(a.audioBytes), {
    message: MEETING_AUDIO_PARTS_INVALID,
    path: ["audioParts"],
  });

interface AudioDeclaration {
  audioType: MeetingAudioType;
  audioBytes: number;
  audioParts: number;
}

const idInput = z.object({ recapId: idSchema });
const partInput = z.object({
  recapId: idSchema,
  position: wholeNumber(MEETING_AUDIO_POSITION_INVALID).refine((v) => v !== null && v >= 0, MEETING_AUDIO_POSITION_INVALID),
});

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function assertCanManage(ctx: ServiceContext): void {
  if (ctx.actor.status !== "ACTIVE" || !canManageMeetingRecaps(ctx.actor)) throw new ForbiddenError(MEETING_RECAP_FORBIDDEN);
}

/** The recording the form declares, or null when it has none (`audioType` empty or missing). */
function parseAudio(rec: Record<string, unknown>): AudioDeclaration | null {
  if (rec.audioType === undefined || rec.audioType === null || rec.audioType === "") return null;
  const a = parseInput(audioFields, rec);
  // The refinements above made sure none of them is null.
  return { audioType: a.audioType!, audioBytes: a.audioBytes!, audioParts: a.audioParts! };
}

function dateError(message: string): ValidationError {
  return new ValidationError(message, { meetingDate: message });
}

/** The meeting's day: from 5 years ago up to tomorrow (team timezone). */
function checkMeetingDate(ctx: ServiceContext, date: DateOnly): void {
  const today = todayInTimezone(ctx.config.teamTimezone, ctx.now);
  if (date > addDays(today, 1)) throw dateError("The meeting can't be after tomorrow. Pick the day it happened.");
  // Compared as text ("YYYY-MM-DD"), so Feb 29 five years back is still a fine bound.
  if (date < `${Number(today.slice(0, 4)) - 5}${today.slice(4)}`) throw dateError("That's more than 5 years ago. Pick the day of the meeting.");
}

function categoriesGone(): ValidationError {
  return new ValidationError(MEETING_CATEGORY_GONE, { categoryIds: MEETING_CATEGORY_GONE });
}

async function assertCategoriesExist(db: Db | Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if ((await db.meetingCategory.count({ where: { id: { in: ids } } })) !== ids.length) throw categoriesGone();
}

/** A category deleted between the check and the write (its join row's foreign key). */
function isMissingCategory(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
}

/** A unique violation: on a new recap, only its id can clash (a request id saved by another request meanwhile). */
function isTakenId(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** A recap's text as saved (what a save compares the form's fields with). */
interface SavedText {
  title: string;
  meetingDate: Date;
  keyPoints: string;
  transcript: string;
  durationSec: number | null;
  categories: { categoryId: string }[];
}

const savedTextSelect = {
  title: true,
  meetingDate: true,
  keyPoints: true,
  transcript: true,
  durationSec: true,
  categories: { select: { categoryId: true } },
} as const satisfies Prisma.MeetingRecapSelect;

/**
 * How the form's fields differ from a saved recap: `edited` when the title, date, categories, key points, or
 * transcript change; `changed` also when only the length does; and the categories it adds.
 */
function compareText(saved: SavedText, f: Fields) {
  const date = dbToDateOnly(saved.meetingDate);
  const before = saved.categories.map((c) => c.categoryId).sort();
  const after = [...f.categoryIds].sort();
  const categoriesChanged = before.length !== after.length || before.some((id, i) => id !== after[i]);
  const dateChanged = f.meetingDate !== date;
  const edited = categoriesChanged || dateChanged || f.title !== saved.title || f.keyPoints !== saved.keyPoints || f.transcript !== saved.transcript;
  return {
    edited,
    changed: edited || f.durationSec !== saved.durationSec,
    dateChanged,
    categoriesChanged,
    addedCategories: f.categoryIds.filter((id) => !before.includes(id)),
  };
}

/** The columns a save writes from the form's fields (the categories are their own rows: replaceCategories). */
function textData(f: Fields) {
  return {
    title: f.title,
    meetingDate: dateOnlyToDb(f.meetingDate),
    keyPoints: f.keyPoints,
    transcript: f.transcript,
    durationSec: f.durationSec,
  };
}

async function replaceCategories(tx: Tx, recapId: string, categoryIds: string[]): Promise<void> {
  await tx.meetingRecapCategory.deleteMany({ where: { recapId } });
  await tx.meetingRecapCategory.createMany({ data: categoryIds.map((categoryId) => ({ recapId, categoryId })) });
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

async function limitCreates(ctx: ServiceContext): Promise<void> {
  const { limit, windowMs } = MEETING_RECAP_RATE_LIMIT;
  if (!(await consumeRateLimit(ctx.db, `meeting-recap:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError("You've saved a lot of meeting recaps in the last hour. Please wait a bit and try again.");
  }
}

async function limitWrites(ctx: ServiceContext): Promise<void> {
  await enforceRateLimit(ctx.db, `meeting-recap-edit:${ctx.actor.id}`, MEETING_RECAP_WRITES_PER_HOUR, HOUR, ctx.now);
}

/** Whether a recording is past its 3 days (or was deleted): every read treats it as gone from then on. */
function audioGone(recap: { audioExpiresAt: Date | null; audioDeletedAt: Date | null }, now: Date): boolean {
  return !!recap.audioDeletedAt || !recap.audioExpiresAt || recap.audioExpiresAt.getTime() <= now.getTime();
}

// ---------- storage messages ----------

/** Saving a recap whose recording won't fit: the recap is saved without it, and this says why. */
export function meetingAudioRefusedMessage(usage: FileStorageUsage): string {
  return `${storageFullSentence(usage)} The recap was saved without its recording — ask an owner to clear out old files.`;
}

/** A part that doesn't fit anymore (the storage filled up during the upload). */
export function meetingAudioPartStorageFullMessage(usage: FileStorageUsage): string {
  return `${storageFullSentence(usage)} The rest of the recording can't be uploaded. The recap and its transcript are saved.`;
}

/** How long the purge before a storage check may take (Prisma's default): a slow one never holds up a save for long. */
const PURGE_FIRST_TIMEOUT_MS = 5_000;

/**
 * Recordings past their 3 days still count toward the storage cap until the purge deletes them (after a response, or
 * the daily cron). Before a new recording is checked against the cap, they go — one quick look when none are due — so
 * space every read already treats as freed never turns a recording away. Outside any transaction (the purge has its
 * own); the R2 objects it queues are drained after the response (the actions call scheduleFileCleanup()).
 * Best-effort: when it fails (a timeout, a dropped connection) it's only logged, and the storage check that follows
 * counts them as before — at worst a recap is saved without its recording, never not saved.
 */
async function purgeExpiredFirst(ctx: ServiceContext): Promise<void> {
  try {
    if (await hasExpiredMeetingAudio(ctx.db, ctx.now)) {
      await purgeExpiredMeetingAudio(ctx.db, ctx.now, { timeoutMs: PURGE_FIRST_TIMEOUT_MS });
    }
  } catch (e) {
    console.error("[meetings] couldn't delete expired recordings before the storage check (they still count this time)", e);
  }
}

/** Null when a recording of `bytes` fits in the team's file storage now (a first look, no lock), else why not. */
async function recordingWontFit(ctx: ServiceContext, bytes: number): Promise<string | null> {
  await purgeExpiredFirst(ctx);
  try {
    await checkFileStorageRoom(ctx.db, { adding: bytes }, meetingAudioRefusedMessage, usesObjectStorage(ctx));
    return null;
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    return e.userMessage;
  }
}

// ---------- recaps ----------

export interface CreateMeetingRecapResult {
  id: string;
  /**
   * Set when a recording was declared but won't fit in the team's file storage: the recap was saved without it (the
   * text matters more than the recording), and this says why (it starts with storageFullSentence). Null otherwise.
   */
  audioRefused: string | null;
  /** This save had gone through already (the same `requestId` again, e.g. after a lost answer): `id` is that recap. */
  duplicate: boolean;
  /**
   * A `duplicate` whose fields weren't put on the recap, though they differ from its text: it was edited since, or
   * it's someone else's save (a shared browser's copy) — see savedBefore. The recap's Edit adds them. False otherwise.
   */
  textKept: boolean;
}

/**
 * The text of a save that already went through, from its retry: while the recap is still that first save — the same
 * person's, never changed since (editedAt null, updatedAt still its createdAt) — the retry is that save, so its fields
 * are checked as for a new recap (a field error is thrown and nothing changes) and replace the first try's, in one
 * transaction conditional on the version read (editedAt stays null; the version moves, so an open edit form hears of
 * it). Otherwise the recap keeps its text. Returns whether the retry's fields differ from the text the recap keeps
 * (`textKept`), or null when the recap was deleted meanwhile.
 */
async function retryText(
  ctx: ServiceContext,
  id: string,
  first: SavedText & { createdById: string | null; createdAt: Date; updatedAt: Date; editedAt: Date | null },
  rec: Record<string, unknown>,
): Promise<boolean | null> {
  const stillFirstSave = first.createdById === ctx.actor.id && !first.editedAt && first.updatedAt.getTime() === first.createdAt.getTime();
  if (!stillFirstSave) {
    try {
      return compareText(first, parseInput(fields, rec)).changed;
    } catch (e) {
      // What it sent can't be saved as it is: it wasn't added either.
      if (e instanceof ValidationError) return true;
      throw e;
    }
  }
  const f: Fields = parseInput(fields, rec);
  const diff = compareText(first, f);
  if (!diff.changed) return false;
  if (diff.dateChanged) checkMeetingDate(ctx, f.meetingDate);
  if (diff.categoriesChanged) await assertCategoriesExist(ctx.db, diff.addedCategories);
  let applied: boolean;
  try {
    applied = await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.meetingRecap.updateMany({
        where: { id, updatedAt: first.updatedAt, editedAt: null },
        data: { ...textData(f), updatedAt: nextVersion(ctx, first.updatedAt) },
      });
      if (count === 0) return false;
      if (diff.categoriesChanged) await replaceCategories(tx, id, f.categoryIds);
      return true;
    });
  } catch (e) {
    if (isMissingCategory(e)) throw categoriesGone();
    throw e;
  }
  if (applied) return false;
  // Edited (or deleted) meanwhile: it keeps what it has now.
  const now = await ctx.db.meetingRecap.findUnique({ where: { id }, select: savedTextSelect });
  return now ? compareText(now, f).changed : null;
}

/**
 * A save that already went through: the recorder and the write-up form send the same `requestId` when they save again
 * (after an answer that never arrived, or from the recorder's copy after a reload), and get the first recap back
 * instead of a second one. Its text: retryText (the retry's fields while nobody changed the recap since; otherwise
 * `textKept` says they weren't added). Any admin may finish someone else's save (a shared browser's copy: they can
 * edit and delete the recap anyway), which never changes its text. Null when there's no such recap.
 * - This try keeps a recording but the first was saved without one (storage full then, or not kept): `audioRefused`
 *   again, saying why when it still won't fit.
 * - This try keeps none but the first declared one and none of it arrived: the declaration goes (raw SQL, so updatedAt
 *   stays), or the recap would say "still uploading" for 3 days.
 */
async function savedBefore(
  ctx: ServiceContext,
  id: string,
  rec: Record<string, unknown>,
  audio: AudioDeclaration | null,
): Promise<CreateMeetingRecapResult | null> {
  const first = await ctx.db.meetingRecap.findUnique({
    where: { id },
    select: {
      ...savedTextSelect,
      createdById: true,
      createdAt: true,
      updatedAt: true,
      editedAt: true,
      audioParts: true,
      audioDeletedAt: true,
      _count: { select: { audio: true } },
    },
  });
  if (!first) return null;
  const textKept = await retryText(ctx, id, first, rec);
  if (textKept === null) return null;
  let audioRefused: string | null = null;
  if (audio && first.audioParts === 0) {
    audioRefused = (await recordingWontFit(ctx, audio.audioBytes)) ?? MEETING_AUDIO_SAVED_WITHOUT;
  } else if (!audio && first.audioParts > 0 && first._count.audio === 0 && !first.audioDeletedAt) {
    await ctx.db.$executeRaw`
      UPDATE "MeetingRecap" SET "audioType" = NULL, "audioParts" = 0, "audioBytes" = 0, "audioExpiresAt" = NULL
      WHERE id = ${id} AND NOT EXISTS (SELECT 1 FROM "MeetingAudioPart" p WHERE p."recapId" = ${id})`;
  }
  return { id, audioRefused, duplicate: true, textKept };
}

/**
 * Save a new recap: title, the meeting's day, categories (0–5 from the team's list), key points, transcript, and how
 * long it was. With a recording declared (`audioType`, `audioBytes`, `audioParts` = ceil(bytes / part size)), the
 * recap is ready for its parts (addMeetingAudioPart), and the recording is kept until 3 days from now. `requestId` (a
 * UUID from the recorder or the write-up form, newMeetingRequestId; anything else is ignored) becomes the recap's id,
 * so saving again with it returns the first recap (`duplicate`, see savedBefore) — also when both arrive at once —
 * and doesn't count toward the rate limit.
 */
export async function createMeetingRecap(ctx: ServiceContext, raw: unknown): Promise<CreateMeetingRecapResult> {
  assertCanManage(ctx);
  const rec = asRecord(raw);
  const requestId = parseMeetingRequestId(rec.requestId);
  if (requestId) {
    // Before the rate limit: the recap is saved already (its fields are looked at there).
    const first = await savedBefore(ctx, requestId, rec, parseAudio(rec));
    if (first) return first;
  }
  const f: Fields = parseInput(fields, rec);
  let audio = parseAudio(rec);
  checkMeetingDate(ctx, f.meetingDate);
  await assertCategoriesExist(ctx.db, f.categoryIds);
  await limitCreates(ctx);

  // A first look (no lock): each part is checked again under the lock as it arrives.
  const audioRefused = audio ? await recordingWontFit(ctx, audio.audioBytes) : null;
  if (audioRefused) audio = null;

  try {
    const { id } = await ctx.db.meetingRecap.create({
      data: {
        ...(requestId ? { id: requestId } : {}),
        ...textData(f),
        createdById: ctx.actor.id,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        ...(audio ? { ...audio, audioExpiresAt: new Date(ctx.now.getTime() + MEETING_AUDIO_KEEP_MS) } : {}),
        categories: { create: f.categoryIds.map((categoryId) => ({ categoryId })) },
      },
      select: { id: true },
    });
    return { id, audioRefused, duplicate: false, textKept: false };
  } catch (e) {
    if (isMissingCategory(e)) throw categoriesGone();
    if (requestId && isTakenId(e)) {
      // The same save, arriving twice at once: the other one made it.
      const first = await savedBefore(ctx, requestId, rec, parseAudio(rec));
      if (first) return first;
    }
    throw e;
  }
}

/**
 * Save the edit form (the same fields; the recording isn't changed here). Conditional on the `version` the form
 * loaded (checked first): if the recap changed since, nothing is saved. A change to the title, date, categories, key
 * points, or transcript marks it edited (editedAt / editedBy); a save that changes nothing writes nothing.
 */
export async function updateMeetingRecap(ctx: ServiceContext, raw: unknown): Promise<{ id: string; changed: boolean }> {
  assertCanManage(ctx);
  const rec = asRecord(raw);
  const { recapId } = parseInput(idInput, rec);
  const existing = await ctx.db.meetingRecap.findUnique({
    where: { id: recapId },
    select: { ...savedTextSelect, updatedAt: true },
  });
  if (!existing) throw new NotFoundError(MEETING_RECAP_NOT_FOUND);
  // Before the fields: a stale form hears about the other change first.
  const version = parseVersion(rec.version, MEETING_RECAP_CHANGED);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(MEETING_RECAP_CHANGED);
  const f: Fields = parseInput(fields, rec);
  const diff = compareText(existing, f);
  if (diff.dateChanged) checkMeetingDate(ctx, f.meetingDate);
  if (diff.categoriesChanged) await assertCategoriesExist(ctx.db, diff.addedCategories);
  if (!diff.changed) return { id: recapId, changed: false };

  await limitWrites(ctx);
  try {
    await ctx.db.$transaction(async (tx) => {
      const { count } = await tx.meetingRecap.updateMany({
        where: { id: recapId, updatedAt: existing.updatedAt },
        data: {
          ...textData(f),
          updatedAt: nextVersion(ctx, existing.updatedAt),
          ...(diff.edited ? { editedAt: ctx.now, editedById: ctx.actor.id } : {}),
        },
      });
      if (count === 0) {
        const still = await tx.meetingRecap.count({ where: { id: recapId } });
        throw still ? new ConflictError(MEETING_RECAP_CHANGED) : new NotFoundError(MEETING_RECAP_NOT_FOUND);
      }
      if (diff.categoriesChanged) await replaceCategories(tx, recapId, f.categoryIds);
    });
  } catch (e) {
    if (isMissingCategory(e)) throw categoriesGone();
    throw e;
  }
  return { id: recapId, changed: true };
}

/**
 * Delete a recap with everything on it (its recording's parts go too; their R2 objects are queued — the action
 * calls scheduleFileCleanup()). With a `version` (what the page showed), only if nobody changed it since.
 */
export async function deleteMeetingRecap(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  assertCanManage(ctx);
  const rec = asRecord(raw);
  const { recapId } = parseInput(idInput, rec);
  const existing = await ctx.db.meetingRecap.findUnique({ where: { id: recapId }, select: { updatedAt: true } });
  if (!existing) throw new NotFoundError(MEETING_RECAP_NOT_FOUND);
  const version = parseVersion(rec.version, MEETING_RECAP_CHANGED_BEFORE_DELETE);
  if (version && existing.updatedAt.getTime() !== version.getTime()) throw new ConflictError(MEETING_RECAP_CHANGED_BEFORE_DELETE);
  await limitWrites(ctx);
  const { count } = await ctx.db.meetingRecap.deleteMany({ where: { id: recapId, updatedAt: existing.updatedAt } });
  if (count === 0) {
    const still = await ctx.db.meetingRecap.count({ where: { id: recapId } });
    throw still ? new ConflictError(MEETING_RECAP_CHANGED_BEFORE_DELETE) : new NotFoundError(MEETING_RECAP_NOT_FOUND);
  }
  return { id: recapId };
}

// ---------- the recording ----------

/** Locks the recap's row for the rest of the transaction (part uploads, deleting the recording) and reads its recording. */
async function lockRecapAudio(tx: Tx, recapId: string) {
  const rows = await tx.$queryRaw<
    { audioType: string | null; audioParts: number; audioBytes: number; audioExpiresAt: Date | null; audioDeletedAt: Date | null }[]
  >`
    SELECT "audioType", "audioParts", "audioBytes", "audioExpiresAt", "audioDeletedAt"
    FROM "MeetingRecap" WHERE id = ${recapId} FOR UPDATE`;
  return rows[0] ?? null;
}

/** "Delete recording now": deletes the parts (their R2 objects are queued) and marks it deleted. The text stays. */
export async function deleteMeetingAudio(ctx: ServiceContext, raw: unknown): Promise<{ id: string; parts: number }> {
  assertCanManage(ctx);
  const { recapId } = parseInput(idInput, asRecord(raw));
  await limitWrites(ctx);
  return ctx.db.$transaction(async (tx) => {
    const recap = await lockRecapAudio(tx, recapId);
    if (!recap) throw new NotFoundError(MEETING_RECAP_NOT_FOUND);
    if (recap.audioParts === 0 || !recap.audioType) throw new ConflictError(MEETING_AUDIO_NONE);
    // Past its 3 days counts as deleted already (the purge removes its parts).
    if (audioGone(recap, ctx.now)) throw new ConflictError(MEETING_AUDIO_ALREADY_DELETED);
    const { count } = await tx.meetingAudioPart.deleteMany({ where: { recapId } });
    // Raw SQL: updatedAt (the edit form's version) stays.
    await tx.$executeRaw`UPDATE "MeetingRecap" SET "audioDeletedAt" = ${ctx.now} WHERE id = ${recapId}`;
    return { id: recapId, parts: count };
  });
}

/** The bytes of a part from the service's raw input: an UploadedFile (from the Server Action) or a Blob/File. */
async function readPartBytes(value: unknown): Promise<Uint8Array<ArrayBuffer> | null> {
  const upload = readUpload(value);
  if (upload) return new Uint8Array(upload.bytes);
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    // Never read more than a part can be.
    if (value.size > MEETING_AUDIO_PART_BYTES) throw fileError(MEETING_AUDIO_PART_WRONG_SIZE);
    return new Uint8Array(await value.arrayBuffer());
  }
  return null;
}

/** Whether every declared part is in (and they add up to the declared size). */
async function audioComplete(db: Db | Tx, recapId: string, recap: { audioParts: number; audioBytes: number }): Promise<boolean> {
  const agg = await db.meetingAudioPart.aggregate({ where: { recapId }, _count: { _all: true }, _sum: { size: true } });
  return agg._count._all === recap.audioParts && (agg._sum.size ?? 0) === recap.audioBytes;
}

export interface AddMeetingAudioPartResult {
  /** Every part is in: the recording can be played. */
  complete: boolean;
  /** This part was already there (a retry after a lost answer): nothing new was saved. */
  duplicate: boolean;
}

/**
 * Upload one part of a recap's recording (`position` 0-based; `file` an UploadedFile or a Blob). Every part but the
 * last is exactly MEETING_AUDIO_PART_BYTES, the last is what's left of the declared size; the first one must really
 * be the declared kind of audio (by its bytes). A part that's already there is fine (`duplicate`: a retry). Refused
 * once the recording is past its 3 days or was deleted. Never writes the recap's row.
 */
export async function addMeetingAudioPart(ctx: ServiceContext, raw: unknown): Promise<AddMeetingAudioPartResult> {
  assertCanManage(ctx);
  const rec = asRecord(raw);
  const { recapId, position } = parseInput(partInput, rec);
  const bytes = await readPartBytes(rec.file);
  if (!bytes || bytes.byteLength === 0) throw fileError(MEETING_AUDIO_PART_MISSING);
  await enforceRateLimit(ctx.db, `meeting-audio:${ctx.actor.id}`, MEETING_AUDIO_PARTS_PER_HOUR, HOUR, ctx.now);

  const recap = await ctx.db.meetingRecap.findUnique({
    where: { id: recapId },
    select: { audioType: true, audioParts: true, audioBytes: true, audioExpiresAt: true, audioDeletedAt: true },
  });
  if (!recap) throw new NotFoundError(MEETING_RECAP_NOT_FOUND);
  const audioType = recap.audioType ? normalizeMeetingAudioType(recap.audioType) : null;
  if (recap.audioParts === 0 || !audioType) throw new ConflictError(MEETING_AUDIO_NONE);
  if (audioGone(recap, ctx.now)) throw new ConflictError(recap.audioDeletedAt ? MEETING_AUDIO_ALREADY_DELETED : MEETING_AUDIO_TOO_LATE);
  if (position! >= recap.audioParts) throw new ValidationError(MEETING_AUDIO_POSITION_INVALID, { position: MEETING_AUDIO_POSITION_INVALID });
  const index = position!;
  const expected = index < recap.audioParts - 1 ? MEETING_AUDIO_PART_BYTES : recap.audioBytes - MEETING_AUDIO_PART_BYTES * (recap.audioParts - 1);
  if (bytes.byteLength !== expected) throw fileError(MEETING_AUDIO_PART_WRONG_SIZE);
  if (index === 0 && sniffMeetingAudioType(bytes) !== audioType) throw fileError(MEETING_AUDIO_PART_WRONG_TYPE);

  // A retry of a part that made it (its answer was lost): nothing to upload.
  const existing = await ctx.db.meetingAudioPart.findUnique({ where: { recapId_position: { recapId, position: index } }, select: { id: true } });
  if (existing) return { complete: await audioComplete(ctx.db, recapId, recap), duplicate: true };

  // This recording isn't past its 3 days (checked above), so the purge leaves it alone.
  await purgeExpiredFirst(ctx);
  const adding = bytes.byteLength;
  const objectStorage = usesObjectStorage(ctx);
  const upload = { filename: `recording-${index + 1}.${meetingAudioExtension(audioType)}`, contentType: audioType, bytes };
  return withStoredFiles(
    ctx,
    "meeting-audio",
    [upload],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        await assertFileStorageRoom(tx, { adding }, meetingAudioPartStorageFullMessage, objectStorage);
        // With the recap's row locked, nothing else adds a part or deletes the recording meanwhile.
        const locked = await lockRecapAudio(tx, recapId);
        if (!locked) throw new NotFoundError(MEETING_RECAP_NOT_FOUND);
        if (audioGone(locked, ctx.now)) throw new ConflictError(locked.audioDeletedAt ? MEETING_AUDIO_ALREADY_DELETED : MEETING_AUDIO_TOO_LATE);
        const twin = await tx.meetingAudioPart.findUnique({ where: { recapId_position: { recapId, position: index } }, select: { id: true } });
        // Another request saved it first: this one's upload has no row and is deleted later (confirmStorageKeys).
        if (twin) return { complete: await audioComplete(tx, recapId, locked), duplicate: true };
        await tx.meetingAudioPart.create({ data: { recapId, position: index, ...file, createdAt: ctx.now } });
        return { complete: await audioComplete(tx, recapId, locked), duplicate: false };
      }),
    { precheck: () => checkFileStorageRoom(ctx.db, { adding }, meetingAudioPartStorageFullMessage, objectStorage) },
  );
}

/**
 * Which parts of a recap's recording are in, so the recorder can finish an interrupted upload (people who manage
 * recaps only; a recap saved without a recording has audioParts 0). NotFoundError only when the recap is gone.
 */
export async function getMeetingAudioUploadState(ctx: ServiceContext, raw: unknown): Promise<MeetingAudioUploadState> {
  assertCanManage(ctx);
  const { recapId } = parseInput(idInput, asRecord(raw));
  const recap = await ctx.db.meetingRecap.findUnique({
    where: { id: recapId },
    select: {
      audioType: true,
      audioParts: true,
      audioBytes: true,
      audioExpiresAt: true,
      audioDeletedAt: true,
      audio: { select: { position: true, size: true }, orderBy: { position: "asc" } },
    },
  });
  if (!recap) throw new NotFoundError(MEETING_RECAP_NOT_FOUND);
  const bytes = recap.audio.reduce((sum, p) => sum + p.size, 0);
  return {
    audioType: recap.audioType ? normalizeMeetingAudioType(recap.audioType) : null,
    audioParts: recap.audioParts,
    audioBytes: recap.audioBytes,
    present: recap.audio.map((p) => p.position),
    expired: recap.audioParts > 0 && audioGone(recap, ctx.now),
    complete: recap.audioParts > 0 && recap.audio.length === recap.audioParts && bytes === recap.audioBytes,
  };
}

/**
 * The system job that deletes recordings past their 3 days (no actor: the meeting pages' after(), the daily cron).
 * Up to `limit` recaps per run (skipping ones another request has locked); their parts are deleted (the trigger
 * queues their R2 objects — drain the queue afterwards) and audioDeletedAt is set with raw SQL, so updatedAt stays.
 * Uploads that never finished go the same way. Running it again finds nothing. `timeoutMs` (default 30 s: deleting
 * a few 100 MB recordings stored in Postgres takes a while; after the response and the daily job have the time).
 */
export async function purgeExpiredMeetingAudio(
  db: Db,
  now: Date,
  options: { limit?: number; timeoutMs?: number } = {},
): Promise<{ recaps: number; parts: number }> {
  const limit = Math.max(1, Math.trunc(options.limit ?? 200) || 1);
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "MeetingRecap"
        WHERE "audioExpiresAt" <= ${now} AND "audioDeletedAt" IS NULL
        ORDER BY "audioExpiresAt", id
        LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return { recaps: 0, parts: 0 };
      const ids = rows.map((r) => r.id);
      const { count } = await tx.meetingAudioPart.deleteMany({ where: { recapId: { in: ids } } });
      await tx.$executeRaw`UPDATE "MeetingRecap" SET "audioDeletedAt" = ${now} WHERE id = ANY(${ids}::text[])`;
      return { recaps: ids.length, parts: count };
    },
    { timeout: options.timeoutMs ?? 30_000 },
  );
}

/** Whether any recording is past its 3 days but not deleted yet (one cheap query, before purging). */
export async function hasExpiredMeetingAudio(db: Db, now: Date): Promise<boolean> {
  const rows = await db.$queryRaw<{ due: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "MeetingRecap" WHERE "audioExpiresAt" <= ${now} AND "audioDeletedAt" IS NULL) AS due`;
  return rows[0]?.due === true;
}
