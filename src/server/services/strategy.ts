// Strategy page (/strategy): the team's game plans — autonomous paths, TeleOp and endgame plans, match plans,
// scouting notes — next to the embedded Pedro Pathing planner (src/components/strategy/path-planner.tsx).
// - Everyone ACTIVE adds strategies; whoever added one, and everyone with admin access, changes or removes it
//   (canEditStrategy). Pinning (pinned ones are listed first) is for everyone with admin access (canAdminister).
// - A strategy is one of ours (teamId null), or about another team in the league (teamId set; Strategy → Other
//   teams, ./league-teams.ts). Which one it is is set when it's added and never changes.
// - A strategy has up to LIMITS.strategyFilesMax files: Pedro Pathing .pp paths (checked: JSON the planner can
//   open), pictures (checked: a real picture a phone can draw), PDFs, and anything else that can't run programs.
//   Up to 4 MB each, counted toward the team's storage cap (../files/storage.ts, under its lock).
//   Each person's strategy files stay under STRATEGY_FILE_BYTES_PER_PERSON (10× with Cloudflare R2) unless they have
//   admin access. Files are stored like every upload (Postgres, or R2 when it's set up: ../files/stored.ts).
// Files are served only by src/app/(app)/strategy/files/[id]/route.ts (.pp files always download). No emails.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { LIMITS, StrategyKind } from "@/lib/constants";
import { formatFileSize } from "@/lib/files";
import { POSTER_IMAGE_MAX_PIXELS, POSTER_IMAGE_MAX_SIDE } from "@/lib/posters";
import { withHttps } from "@/lib/sponsorships";
import { isPedroPathFile, pedroPathProblem, strategyFileTooBigMessage, tooManyStrategyFilesMessage } from "@/lib/strategy";
import { parseHttpUrl } from "@/lib/urls";
import { checkbox, idSchema, optionalText, stringArray, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  assertFileStorageRoom,
  checkFileStorageRoom,
  lockFileStorage,
  perPersonFileCap,
  posterCleanupSentence,
  storageFullSentence,
} from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { checkUploadedFile, type CleanUpload, cleanFilename, readUpload } from "../files/upload";
import { canAdminister, canEditStrategy } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { previewKind } from "../resources/serve";
import { posterImageSize, sniffPosterFile } from "./posters";

type Tx = Prisma.TransactionClient;

export const STRATEGY_NOT_FOUND = "That strategy no longer exists.";
export const STRATEGY_INACTIVE = "Your account isn't active, so you can't change strategies.";
export const STRATEGY_CANT_EDIT =
  "Only the person who added this strategy, or a leader, captain, mentor, or teacher, can change or remove it.";
export const STRATEGY_CANT_PIN = "Only leaders, the captain, mentors, and teachers can pin strategies.";
export const STRATEGY_TEAM_NOT_FOUND = "That team is no longer on the Other teams list.";
const LINK_MESSAGE = "Enter a web link, like https://youtu.be/…";
const KIND_MESSAGE = "Pick what kind of strategy this is.";

const HOUR = 60 * 60 * 1000;
/** New strategies (and edits that add files) per person per hour; each save can carry up to 4 MB. */
export const STRATEGY_RATE_LIMIT = { limit: 30, windowMs: HOUR } as const;

/**
 * Strategy files one person can have (on all the strategies they added; removing files frees it up again), so
 * one account can't fill the team's storage (10× with Cloudflare R2: perPersonFileCap). Everyone with admin access
 * isn't limited.
 */
export const STRATEGY_FILE_BYTES_PER_PERSON = 50 * 1024 * 1024;

/** Stored type of a .pp path (JSON). Never shown in the browser: the file route always downloads it. */
export const PEDRO_PATH_CONTENT_TYPE = "application/json";

// ---------- files ----------

/** A ValidationError on the form's `files` field (the file picker). */
function filesError(message: string): ValidationError {
  return new ValidationError(message, { files: message });
}

/** Runs `fn`, moving a problem it reports on the `file` field (the shared upload checks) to `files`. */
async function onFilesField<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ValidationError && e.fieldErrors.file) throw filesError(e.fieldErrors.file);
    throw e;
  }
}

/** A picture shown on the strategy's page must really be one, and small enough (in pixels) for a phone to draw. */
function checkPicture(upload: CleanUpload): void {
  const kind = sniffPosterFile(upload.bytes);
  const size = kind && kind !== "pdf" ? posterImageSize(upload.bytes, kind) : null;
  if (!size || size.width < 1 || size.height < 1) {
    throw filesError(
      `“${upload.filename}” couldn't be opened as a picture. Save it again as a PNG or JPG and try again.`,
    );
  }
  if (size.width > POSTER_IMAGE_MAX_SIDE || size.height > POSTER_IMAGE_MAX_SIDE || size.width * size.height > POSTER_IMAGE_MAX_PIXELS) {
    const n = (v: number) => v.toLocaleString("en-US");
    throw filesError(
      `“${upload.filename}” is ${n(size.width)} × ${n(size.height)} pixels — too big to show on phones. Save a smaller copy (about 3,000 pixels on the longest side) and try again.`,
    );
  }
}

/**
 * Checks one picked file: not empty, up to 4 MB, a cleaned name, not a runnable Windows file; a .pp path must be
 * one the planner can open (stored as JSON), and a picture (PNG, JPG, GIF, WebP) must really be one.
 */
function checkStrategyFile(value: unknown): CleanUpload | null {
  const picked = readUpload(value);
  if (!picked) return null;
  const name = cleanFilename(picked.name);
  if (picked.bytes.byteLength === 0) throw filesError(`“${name}” is empty. Choose another file.`);
  let upload: CleanUpload;
  try {
    upload = checkUploadedFile(picked, {
      tooBig: (size) => strategyFileTooBigMessage(name, size),
      blocked: (ext) => `“${name}” can't be added: .${ext} files can run programs on a computer. Share it as a link instead.`,
    });
  } catch (e) {
    if (e instanceof ValidationError && e.fieldErrors.file) throw filesError(e.fieldErrors.file);
    throw e;
  }
  if (isPedroPathFile(upload.filename)) {
    const problem = pedroPathProblem(upload.bytes, upload.filename);
    if (problem) throw filesError(problem);
    return { ...upload, contentType: PEDRO_PATH_CONTENT_TYPE };
  }
  if (previewKind(upload.filename, upload.contentType) === "image") checkPicture(upload);
  return upload;
}

/** The form's `files`: one picked file, several, or none (names only, e.g. from formDataToObject, don't count). */
function checkStrategyFiles(value: unknown): CleanUpload[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const uploads = list.map(checkStrategyFile).filter((u): u is CleanUpload => u !== null);
  if (uploads.length > LIMITS.strategyFilesMax) throw filesError(tooManyStrategyFilesMessage(0));
  return uploads;
}

const bytesOf = (files: { size: number }[] | CleanUpload[]) =>
  files.reduce((sum, f) => sum + ("bytes" in f ? f.bytes.byteLength : f.size), 0);

/**
 * Room for new strategy files (under the storage lock): the person's own strategy files stay under
 * STRATEGY_FILE_BYTES_PER_PERSON (unless they have admin access), and all files together under the team's cap.
 * `freeing` = files this save removes (they no longer count).
 * `locked: false`: the same checks without the lock, as the quick look before uploading to Cloudflare R2
 * (withStoredFiles' precheck); saving checks again under the lock.
 */
async function assertStrategyRoom(tx: Tx, ctx: ServiceContext, change: { adding: number; freeing: number }, locked = true): Promise<void> {
  if (locked) await lockFileStorage(tx);
  const objectStorage = usesObjectStorage(ctx);
  if (!canAdminister(ctx.actor)) {
    const mine = await tx.strategyFile.aggregate({ _sum: { size: true }, where: { strategy: { createdById: ctx.actor.id } } });
    const used = Math.max(0, (mine._sum.size ?? 0) - change.freeing);
    const allowance = perPersonFileCap(STRATEGY_FILE_BYTES_PER_PERSON, objectStorage);
    if (used + change.adding > allowance) {
      throw filesError(
        `Your strategy files use ${formatFileSize(used)}, and each person can have up to ${formatFileSize(allowance)}. Remove files you don't need, add a link instead, or ask a leader to add this one.`,
      );
    }
  }
  await onFilesField(() =>
    (locked ? assertFileStorageRoom : checkFileStorageRoom)(
      tx,
      change,
      (usage) =>
        `${storageFullSentence(usage)} Remove strategy files you don't need, or add a link instead. Leaders, the captain, mentors, and teachers can clear out old files.${posterCleanupSentence(usage)}`,
      objectStorage,
    ),
  );
}

// ---------- input ----------

/** "" = no link; otherwise an http(s) link (https:// added to a bare "youtu.be/…"). */
const linkField = z.preprocess(
  (v) => (typeof v === "string" ? v : ""),
  z.string().transform((v, ctx) => {
    if (!v.trim()) return "";
    const url = parseHttpUrl(withHttps(v));
    if (!url) {
      ctx.addIssue({ code: "custom", message: LINK_MESSAGE });
      return z.NEVER;
    }
    return url;
  }),
);

const strategyFields = z.object({
  title: text("Title", LIMITS.strategyTitleMax),
  kind: z.enum(StrategyKind, { error: KIND_MESSAGE }),
  // optionalText turns the CRLF line breaks browsers send into "\n", so text typed up to the box's maxLength fits.
  description: optionalText("Description", LIMITS.strategyDescriptionMax),
});
// Checked on its own, so a problem elsewhere doesn't hide a bad link.
const linkInput = z.object({ link: linkField });

interface ParsedStrategy {
  data: { title: string; kind: StrategyKind; description: string; link: string };
  uploads: CleanUpload[];
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(STRATEGY_INACTIVE);
}

/** Checks the whole form at once (fields, link, and files), so every problem is shown in one go. */
function parseStrategyForm(rec: Record<string, unknown>): ParsedStrategy {
  const errors: Record<string, string> = {};
  const failures: ValidationError[] = [];
  const attempt = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e;
      failures.push(e);
      const entries = Object.entries(e.fieldErrors);
      if (entries.length === 0) errors._form ??= e.userMessage;
      for (const [key, message] of entries) errors[key] ??= message;
      return undefined;
    }
  };

  const fields = attempt(() => parseInput(strategyFields, rec));
  const link = attempt(() => parseInput(linkInput, rec).link);
  const uploads = attempt(() => checkStrategyFiles(rec.files)) ?? [];

  if (failures.length > 0 || !fields || link === undefined) {
    // One failing check keeps its own message; several get a general one.
    const message = failures.length === 1 && Object.keys(errors).length === 1 ? failures[0].userMessage : "Please fix the highlighted fields.";
    throw new ValidationError(message, errors);
  }
  return {
    data: {
      title: fields.title,
      kind: fields.kind,
      description: fields.description ?? "",
      link,
    },
    uploads,
  };
}

// ---------- mutations ----------

/** "" / missing = one of our strategies; otherwise the id of the other team (LeagueTeam) it's about. */
const teamInput = z.object({
  teamId: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), idSchema.optional()),
});

/**
 * Add a strategy (with any files). The whole team sees it right away. With `teamId` it's about that other team
 * in the league (Strategy → Other teams) instead of one of ours; anyone ACTIVE can add those too.
 */
export async function createStrategy(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { teamId } = parseInput(teamInput, rec);
  const { data, uploads } = parseStrategyForm(rec);
  await enforceRateLimit(ctx.db, `strategy:${ctx.actor.id}`, STRATEGY_RATE_LIMIT.limit, STRATEGY_RATE_LIMIT.windowMs, ctx.now);

  const change = { adding: bytesOf(uploads), freeing: 0 };
  return onFilesField(() =>
    withStoredFiles(
      ctx,
      "strategy",
      uploads,
      (files) =>
        ctx.db.$transaction(async (tx) => {
          if (teamId) {
            // Holds the team until this commits, so it can't be removed between this check and the insert.
            const team = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "LeagueTeam" WHERE id = ${teamId} FOR KEY SHARE`;
            if (team.length === 0) throw new NotFoundError(STRATEGY_TEAM_NOT_FOUND);
          }
          if (uploads.length > 0) await assertStrategyRoom(tx, ctx, change);
          return tx.strategy.create({
            data: {
              ...data,
              teamId: teamId ?? null,
              createdById: ctx.actor.id,
              createdAt: ctx.now,
              updatedAt: ctx.now,
              files: { create: files.map((f) => ({ ...f, createdAt: ctx.now })) },
            },
            select: { id: true },
          });
        }),
      { precheck: () => assertStrategyRoom(ctx.db, ctx, change, false) },
    ),
  );
}

const strategyIdInput = z.object({ strategyId: idSchema });
const removeFilesInput = z.object({ removeFileIds: stringArray });

/** Loads a strategy for a change and checks the actor may make it (missing → NotFound, not theirs → Forbidden). */
async function loadEditableStrategy(ctx: ServiceContext, strategyId: string) {
  const strategy = await ctx.db.strategy.findUnique({
    where: { id: strategyId },
    select: { id: true, title: true, createdById: true, team: { select: { number: true } } },
  });
  if (!strategy) throw new NotFoundError(STRATEGY_NOT_FOUND);
  if (!canEditStrategy(ctx.actor, strategy)) throw new ForbiddenError(STRATEGY_CANT_EDIT);
  return strategy;
}

/**
 * Change a strategy: its fields, plus files to add (`files`) and files to remove (`removeFileIds`, ids of its
 * own files; ones already gone are skipped). Last save wins.
 */
export async function updateStrategy(ctx: ServiceContext, raw: unknown): Promise<{ id: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { strategyId } = parseInput(strategyIdInput, rec);
  await loadEditableStrategy(ctx, strategyId);
  const { removeFileIds } = parseInput(removeFilesInput, rec);
  const { data, uploads } = parseStrategyForm(rec);
  // New files are uploads like a new strategy: they share the allowance.
  if (uploads.length > 0) {
    await enforceRateLimit(ctx.db, `strategy:${ctx.actor.id}`, STRATEGY_RATE_LIMIT.limit, STRATEGY_RATE_LIMIT.windowMs, ctx.now);
  }

  /**
   * The files this save keeps and removes, checked for room: how many a strategy can have, then the allowance and
   * the cap. `locked`: in the save's transaction (the real check); otherwise the quick look before uploading to R2.
   */
  const checkFiles = async (db: Tx, locked: boolean) => {
    const current = await db.strategyFile.findMany({ where: { strategyId }, select: { id: true, size: true } });
    const removing = current.filter((f) => removeFileIds.includes(f.id));
    const keeping = current.length - removing.length;
    if (keeping + uploads.length > LIMITS.strategyFilesMax) throw filesError(tooManyStrategyFilesMessage(keeping));
    if (uploads.length > 0) await assertStrategyRoom(db, ctx, { adding: bytesOf(uploads), freeing: bytesOf(removing) }, locked);
    return removing;
  };

  await onFilesField(() =>
    withStoredFiles(
      ctx,
      "strategy",
      uploads,
      (files) =>
        ctx.db.$transaction(async (tx) => {
          // Holds the strategy until this commits, so a removal (or another save) can't slip in between.
          const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Strategy" WHERE id = ${strategyId} FOR UPDATE`;
          if (locked.length === 0) throw new NotFoundError(STRATEGY_NOT_FOUND);
          const removing = await checkFiles(tx, true);

          await tx.strategy.update({ where: { id: strategyId }, data: { ...data, updatedAt: ctx.now } });
          if (removing.length > 0) {
            await tx.strategyFile.deleteMany({ where: { strategyId, id: { in: removing.map((f) => f.id) } } });
          }
          if (files.length > 0) {
            await tx.strategyFile.createMany({ data: files.map((f) => ({ strategyId, ...f, createdAt: ctx.now })) });
          }
        }),
      { precheck: async () => void (await checkFiles(ctx.db, false)) },
    ),
  );
  return { id: strategyId };
}

/**
 * Remove a strategy and its files: whoever added it, and everyone with admin access. `teamNumber`: the other team
 * it was about (so the page goes back there), or null for one of ours.
 */
export async function deleteStrategy(ctx: ServiceContext, raw: unknown): Promise<{ title: string; teamNumber: number | null }> {
  requireActive(ctx);
  const { strategyId } = parseInput(strategyIdInput, asRecord(raw));
  const strategy = await loadEditableStrategy(ctx, strategyId);
  const { count } = await ctx.db.strategy.deleteMany({ where: { id: strategyId } });
  if (count === 0) throw new NotFoundError(STRATEGY_NOT_FOUND);
  return { title: strategy.title, teamNumber: strategy.team?.number ?? null };
}

const pinInput = z.object({ strategyId: idSchema, pinned: checkbox });

/**
 * Pin a strategy (listed first for everyone) or unpin it: everyone with admin access. Pinning isn't a change to
 * the strategy, so its "updated" time stays as it was.
 */
export async function setStrategyPinned(ctx: ServiceContext, raw: unknown): Promise<{ title: string; pinned: boolean }> {
  requireActive(ctx);
  const { strategyId, pinned } = parseInput(pinInput, asRecord(raw));
  if (!canAdminister(ctx.actor)) throw new ForbiddenError(STRATEGY_CANT_PIN);
  const strategy = await ctx.db.strategy.findUnique({ where: { id: strategyId }, select: { title: true } });
  if (!strategy) throw new NotFoundError(STRATEGY_NOT_FOUND);
  // Raw SQL: Prisma would set updatedAt.
  const count = await ctx.db.$executeRaw`UPDATE "Strategy" SET "pinned" = ${pinned} WHERE "id" = ${strategyId}`;
  if (count === 0) throw new NotFoundError(STRATEGY_NOT_FOUND);
  return { title: strategy.title, pinned };
}
