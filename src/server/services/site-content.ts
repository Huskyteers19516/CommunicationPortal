// Website Coding (Admin → Website Coding): everyone with admin access changes the team website's text, links, and
// pictures — slot by slot, by key (src/lib/public-site-content.ts) — resets a slot to the website's own content, and
// undoes changes. The website reads the saved values from GET /api/public/site-content (src/server/public-api.ts).
//
// - Every change writes a SiteContentEdit row (before → after; null = the website's own content) in the same
//   transaction, so "Recent changes" and Undo always match what happened. Saving what's already there changes nothing.
// - All writes take one advisory lock ("hk-site-content"), so two admins saving at once take turns and the
//   before/after of each edit is exact.
// - Pictures are checked like sponsor logos and members' photos (PNG, JPG, or WebP by their bytes, a still picture,
//   metadata stripped in strict mode — they're public), stored like every other upload (Postgres or Cloudflare R2:
//   ../files/stored.ts, file kind "site-images") under the team's storage cap. Each upload is a new SiteImage row (a
//   new public address); a slot keeps its SITE_IMAGES_KEPT_PER_SLOT most recent pictures for Undo, and older ones
//   (never the one shown) are deleted — the action then calls scheduleFileCleanup().
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { SiteContentKind } from "@/generated/prisma/enums";
import { POSTER_IMAGE_MAX_PIXELS } from "@/lib/posters";
import {
  cleanSiteText,
  claimsSiteImageType,
  isSiteKey,
  parseSiteLink,
  SITE_ALT_MAX,
  SITE_CONTENT_MAX_ROWS,
  SITE_IMAGE_ANIMATED_MESSAGE,
  SITE_IMAGE_MAX_SIDE,
  SITE_IMAGE_NEEDS_FILE,
  SITE_IMAGE_TYPES_MESSAGE,
  SITE_IMAGE_UNREADABLE_MESSAGE,
  SITE_IMAGES_KEPT_PER_SLOT,
  SITE_KEY_INVALID,
  SITE_LINK_INVALID,
  SITE_TEXT_EMPTY,
  SITE_TEXT_MAX,
  siteImageTooBigMessage,
  siteImageTooLargeMessage,
} from "@/lib/public-site-content";
import { POSTER_HEIC_MESSAGE } from "@/lib/posters";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { imageOrientation, isAnimatedImage, jpegMarkersDrawable, stripImageMetadata } from "../files/image-metadata";
import {
  assertFileStorageRoom,
  checkFileStorageRoom,
  type FileStorageUsage,
  posterCleanupSentence,
  storageFullSentence,
} from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { checkUploadedFile, type CleanUpload, fileError, readUpload, type UploadMessages } from "../files/upload";
import { canEditWebsite } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { isHeicLike, posterImageSize, sniffPosterFile } from "./posters";

const HOUR = 60 * 60 * 1000;
/** Saves, resets, and undos per person per hour. */
export const SITE_CONTENT_CHANGES_PER_HOUR = 300;
/** Picture uploads per person per hour. */
export const SITE_IMAGE_UPLOADS_PER_HOUR = 60;

export const SITE_CONTENT_FORBIDDEN = "Only people with admin access can change the team website.";
export const SITE_CONTENT_FULL = `The website already has ${SITE_CONTENT_MAX_ROWS.toLocaleString("en-US")} changed spots — reset some to the original first.`;
export const SITE_EDIT_NOT_FOUND = "That change isn't in the list anymore. Reload the page.";
export const SITE_IMAGE_GONE =
  "That picture was removed to save space (each spot keeps its last few), so this change can't be undone. Upload it again instead.";
export const SITE_IMAGE_NONE = "This spot shows the website's own picture. Upload a picture first, then describe it.";

type Tx = Prisma.TransactionClient;

const PICTURE_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

const UPLOAD_MESSAGES: UploadMessages = {
  tooBig: siteImageTooBigMessage,
  blocked: () => SITE_IMAGE_TYPES_MESSAGE,
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function assertCanEdit(ctx: ServiceContext): void {
  if (ctx.actor.status !== "ACTIVE" || !canEditWebsite(ctx.actor)) throw new ForbiddenError(SITE_CONTENT_FORBIDDEN);
}

const keySchema = z.string({ error: SITE_KEY_INVALID }).trim().refine(isSiteKey, SITE_KEY_INVALID);

const altSchema = z.preprocess(
  (v) => (v === undefined || v === null ? "" : v),
  z
    .string()
    .transform((v) => cleanSiteText(v).replace(/\s+/g, " "))
    .pipe(z.string().max(SITE_ALT_MAX, `The description must be at most ${SITE_ALT_MAX} characters.`)),
);

const textInput = z.object({
  key: keySchema,
  value: z
    .string({ error: SITE_TEXT_EMPTY })
    .transform(cleanSiteText)
    .pipe(z.string().min(1, SITE_TEXT_EMPTY).max(SITE_TEXT_MAX, `Text can be at most ${SITE_TEXT_MAX.toLocaleString("en-US")} characters.`)),
});
const linkInput = z.object({ key: keySchema, value: z.string({ error: SITE_LINK_INVALID }) });
const keyInput = z.object({ key: keySchema });
const altInput = z.object({ key: keySchema, alt: altSchema });
const imageInput = z.object({ key: keySchema, alt: altSchema });
const editInput = z.object({ editId: idSchema });

/** One writer at a time (every Website Coding change), so each edit's before/after is exact. */
async function lockSiteContent(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hk-site-content'))`;
}

async function limitChanges(ctx: ServiceContext): Promise<void> {
  await enforceRateLimit(ctx.db, `site-content:${ctx.actor.id}`, SITE_CONTENT_CHANGES_PER_HOUR, HOUR, ctx.now);
}

export interface SiteChangeResult {
  /** False when nothing changed (the same value was saved again, or a reset of a spot that wasn't changed). */
  changed: boolean;
}

/**
 * Puts `value` (null = the website's own content) into the slot, under the lock, with an edit row. A value of another
 * kind than the saved one (the website changed what the spot is) counts as "original" in the edit's `before`.
 */
async function writeSlot(
  tx: Tx,
  ctx: ServiceContext,
  key: string,
  kind: SiteContentKind,
  value: string | null,
): Promise<SiteChangeResult> {
  const current = await tx.siteContent.findUnique({ where: { key }, select: { kind: true, value: true } });
  const before = current && current.kind === kind ? current.value : null;
  if (current ? current.kind === kind && current.value === value : value === null) return { changed: false };
  if (value === null) {
    await tx.siteContent.delete({ where: { key } });
  } else if (current) {
    await tx.siteContent.update({ where: { key }, data: { kind, value, updatedById: ctx.actor.id, updatedAt: ctx.now } });
  } else {
    if ((await tx.siteContent.count()) >= SITE_CONTENT_MAX_ROWS) throw new ConflictError(SITE_CONTENT_FULL);
    await tx.siteContent.create({ data: { key, kind, value, updatedById: ctx.actor.id, updatedAt: ctx.now } });
  }
  await tx.siteContentEdit.create({ data: { key, kind, before, after: value, editedById: ctx.actor.id, createdAt: ctx.now } });
  return { changed: true };
}

async function change(ctx: ServiceContext, key: string, kind: SiteContentKind, value: string | null): Promise<SiteChangeResult> {
  await limitChanges(ctx);
  return ctx.db.$transaction(async (tx) => {
    await lockSiteContent(tx);
    return writeSlot(tx, ctx, key, kind, value);
  });
}

/** Save a text slot (plain text, never HTML; line breaks kept). */
export async function setSiteText(ctx: ServiceContext, raw: unknown): Promise<SiteChangeResult> {
  assertCanEdit(ctx);
  const { key, value } = parseInput(textInput, asRecord(raw));
  return change(ctx, key, "TEXT", value);
}

/** Save a link slot: https/http/mailto, or a page on the website starting with one "/" (parseSiteLink). */
export async function setSiteLink(ctx: ServiceContext, raw: unknown): Promise<SiteChangeResult> {
  assertCanEdit(ctx);
  const { key, value } = parseInput(linkInput, asRecord(raw));
  const href = parseSiteLink(value);
  if (!href) throw new ValidationError(SITE_LINK_INVALID, { value: SITE_LINK_INVALID });
  return change(ctx, key, "LINK", href);
}

/** "Reset to original": the website shows its own content for this slot again (a no-op when nothing was saved). */
export async function resetSiteContent(ctx: ServiceContext, raw: unknown): Promise<SiteChangeResult> {
  assertCanEdit(ctx);
  const { key } = parseInput(keyInput, asRecord(raw));
  await limitChanges(ctx);
  return ctx.db.$transaction(async (tx) => {
    await lockSiteContent(tx);
    const current = await tx.siteContent.findUnique({ where: { key }, select: { kind: true } });
    if (!current) return { changed: false };
    return writeSlot(tx, ctx, key, current.kind, null);
  });
}

/**
 * Undo one change from "Recent changes": puts back what the slot had before it (`before`; null = the website's own
 * content), as a new change of its own. A picture that has been deleted since (each slot keeps its last few) can't
 * come back: a ConflictError says so.
 */
export async function revertSiteContentEdit(ctx: ServiceContext, raw: unknown): Promise<SiteChangeResult & { key: string }> {
  assertCanEdit(ctx);
  const { editId } = parseInput(editInput, asRecord(raw));
  await limitChanges(ctx);
  return ctx.db.$transaction(async (tx) => {
    await lockSiteContent(tx);
    const edit = await tx.siteContentEdit.findUnique({ where: { id: editId }, select: { key: true, kind: true, before: true } });
    if (!edit) throw new NotFoundError(SITE_EDIT_NOT_FOUND);
    if (edit.kind === "IMAGE" && edit.before !== null) {
      const image = await tx.siteImage.count({ where: { id: edit.before, key: edit.key } });
      if (image === 0) throw new ConflictError(SITE_IMAGE_GONE);
    }
    if (edit.before === null) {
      // Back to the website's own content — whatever kind the slot holds now.
      const current = await tx.siteContent.findUnique({ where: { key: edit.key }, select: { kind: true } });
      if (!current) return { changed: false, key: edit.key };
      return { ...(await writeSlot(tx, ctx, edit.key, current.kind, null)), key: edit.key };
    }
    return { ...(await writeSlot(tx, ctx, edit.key, edit.kind, edit.before)), key: edit.key };
  });
}

/** Change the description (alt text) of the picture a slot shows now. Not an undoable change (the picture stays). */
export async function setSiteImageAlt(ctx: ServiceContext, raw: unknown): Promise<SiteChangeResult> {
  assertCanEdit(ctx);
  const { key, alt } = parseInput(altInput, asRecord(raw));
  await limitChanges(ctx);
  return ctx.db.$transaction(async (tx) => {
    await lockSiteContent(tx);
    const current = await tx.siteContent.findUnique({ where: { key }, select: { kind: true, value: true } });
    if (!current || current.kind !== "IMAGE") throw new NotFoundError(SITE_IMAGE_NONE);
    const image = await tx.siteImage.findFirst({ where: { id: current.value, key }, select: { id: true, alt: true } });
    if (!image) throw new NotFoundError(SITE_IMAGE_NONE);
    if (image.alt === alt) return { changed: false };
    await tx.siteImage.update({ where: { id: image.id }, data: { alt } });
    return { changed: true };
  });
}

// ── Pictures ─────────────────────────────────────────────────────────────────

/** A picture that passed the checks: the upload (metadata stripped, a neutral name) and its size as it's shown. */
export interface CheckedSiteImage {
  upload: CleanUpload;
  width: number;
  height: number;
}

/**
 * Checks a picked picture: not empty, ≤ 4 MB, really a PNG, JPG, or WebP by its bytes (HEIC gets the iPhone hint), a
 * readable size up to SITE_IMAGE_MAX_SIDE a side, a still picture, and a JPEG browsers can draw. It goes on the public
 * website, so its metadata is stripped in strict mode (GPS, camera, author, colour profile, thumbnail).
 */
export function checkSiteImage(value: unknown): CheckedSiteImage {
  const picked = readUpload(value);
  if (!picked) throw fileError(SITE_IMAGE_NEEDS_FILE);
  const upload = checkUploadedFile(picked, UPLOAD_MESSAGES);
  const kind = sniffPosterFile(upload.bytes);
  if (kind !== "png" && kind !== "jpg" && kind !== "webp") {
    if (isHeicLike(upload.bytes)) throw fileError(POSTER_HEIC_MESSAGE);
    throw fileError(kind === null && claimsSiteImageType(picked) ? SITE_IMAGE_UNREADABLE_MESSAGE : SITE_IMAGE_TYPES_MESSAGE);
  }
  const size = posterImageSize(upload.bytes, kind);
  if (!size || size.width < 1 || size.height < 1) throw fileError(SITE_IMAGE_UNREADABLE_MESSAGE);
  if (size.width > SITE_IMAGE_MAX_SIDE || size.height > SITE_IMAGE_MAX_SIDE || size.width * size.height > POSTER_IMAGE_MAX_PIXELS) {
    throw fileError(siteImageTooLargeMessage(size.width, size.height));
  }
  if (isAnimatedImage(upload.bytes, kind)) throw fileError(SITE_IMAGE_ANIMATED_MESSAGE);
  const bytes = stripImageMetadata(upload.bytes, kind, { strict: true });
  if (kind === "jpg" && !jpegMarkersDrawable(bytes)) throw fileError(SITE_IMAGE_UNREADABLE_MESSAGE);
  const turned = imageOrientation(bytes, kind) >= 5;
  return {
    // Never the uploaded name (it can hold anything); the public route has its own neutral one.
    upload: { filename: `picture.${kind}`, contentType: PICTURE_TYPES[kind], bytes },
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
  };
}

/** The "storage is full" message for website pictures. */
export function siteImageStorageFullMessage(usage: FileStorageUsage): string {
  return `${storageFullSentence(usage)} Ask an owner to clear out old files, then try again.${posterCleanupSentence(usage)}`;
}

export interface SiteImageUploadResult extends SiteChangeResult {
  id: string;
  /** Older pictures of this slot deleted to keep SITE_IMAGES_KEPT_PER_SLOT (their R2 objects are queued). */
  pruned: number;
}

/**
 * Upload a picture for an image slot (`file` is an UploadedFile, read from the form by the Server Action) with its
 * description, and show it there. Older pictures of the slot past SITE_IMAGES_KEPT_PER_SLOT are deleted (never the one
 * shown).
 */
export async function uploadSiteImage(ctx: ServiceContext, raw: unknown): Promise<SiteImageUploadResult> {
  assertCanEdit(ctx);
  const rec = asRecord(raw);
  const { key, alt } = parseInput(imageInput, rec);
  const { upload, width, height } = checkSiteImage(rec.file);
  await enforceRateLimit(ctx.db, `site-image:${ctx.actor.id}`, SITE_IMAGE_UPLOADS_PER_HOUR, HOUR, ctx.now);
  const adding = upload.bytes.byteLength;
  const objectStorage = usesObjectStorage(ctx);

  return withStoredFiles(
    ctx,
    "site-images",
    [upload],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        await assertFileStorageRoom(tx, { adding }, siteImageStorageFullMessage, objectStorage);
        await lockSiteContent(tx);
        const image = await tx.siteImage.create({
          data: { key, ...file, width, height, alt, uploadedById: ctx.actor.id, createdAt: ctx.now },
          select: { id: true },
        });
        const result = await writeSlot(tx, ctx, key, "IMAGE", image.id);
        // Keep the newest few (the new one among them) plus whatever the slot shows; delete the rest.
        const older = await tx.siteImage.findMany({
          where: { key },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true },
          skip: SITE_IMAGES_KEPT_PER_SLOT,
        });
        const drop = older.map((r) => r.id).filter((id) => id !== image.id);
        if (drop.length > 0) await tx.siteImage.deleteMany({ where: { id: { in: drop } } });
        return { ...result, id: image.id, pruned: drop.length };
      }),
    { precheck: () => checkFileStorageRoom(ctx.db, { adding }, siteImageStorageFullMessage, objectStorage) },
  );
}
