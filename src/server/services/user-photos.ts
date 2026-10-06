// Members' own photos (Settings → My photo; UserPhoto, one per account). Every ACTIVE person uploads, replaces, or
// removes their own; people who manage an account (canManageAccount: owners anyone, others the accounts below them)
// can remove its photo too (Admin → People), since it goes on the public website on its own — and then a new photo stays
// off the website until they allow it (a `removed` hold). They can also keep a photo off the website (`kept-off`, e.g.
// no photo release) and allow it again; a member who renames themselves is held too (`renamed`: the website matches
// photos by name) — see src/server/queries/website-photo-holds.ts. Two switches, your own account only: "Show my photo
// in the portal" (User.showPhotoInPortal; off = the team sees your initials) and "Show my photo on the team website"
// (User.showPhotoOnWebsite; on by default).
//
// Photos are checked by their contents like posters (./posters.ts), with tighter limits: only real, still PNG, JPG,
// or WebP pictures (no animations), ≤ USER_PHOTO_MAX_DIMENSION (1,024) pixels a side and ≤ USER_PHOTO_MAX_BYTES (1 MB)
// — every avatar in the portal and on the public website downloads and decodes the whole photo — stored with the
// matching type under a neutral name ("photo.jpg"), and without their metadata (Exif GPS position, camera, XMP,
// comments, and in strict mode colour profiles, thumbnails, and every PNG chunk the picture doesn't need:
// ../files/image-metadata.ts — they go public). A JPEG with a marker browsers can't draw is refused. The browser has
// already made them a 512 × 512 JPG (src/lib/user-photos.ts). Stored like every other upload (Postgres, or Cloudflare
// R2: ../files/stored.ts, kind "photos"), under the team's storage cap. A new photo is a new row (so a new id and
// address: nobody sees the old one from a cache); the old row is deleted in the same transaction (its R2 object is
// queued by the database trigger). Uploads and removals: USER_PHOTO_CHANGES_PER_HOUR (20) per person.
import { z } from "zod";
import {
  USER_PHOTO_ANIMATED_MESSAGE,
  USER_PHOTO_CHANGES_PER_HOUR,
  USER_PHOTO_HEIC_MESSAGE,
  USER_PHOTO_MAX_BYTES,
  USER_PHOTO_MAX_DIMENSION,
  USER_PHOTO_RATE_LIMITED_MESSAGE,
  USER_PHOTO_TYPES_MESSAGE,
  USER_PHOTO_UNREADABLE_MESSAGE,
  type WebsitePhotoHold,
  teamPhotoNameKey,
  userPhotoProblem,
  userPhotoTooBigMessage,
  userPhotoTooLargeMessage,
} from "@/lib/user-photos";
import { checkbox, idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ForbiddenError, NotFoundError, RateLimitError } from "../errors";
import { imageOrientation, isAnimatedImage, jpegMarkersDrawable, stripImageMetadata } from "../files/image-metadata";
import { assertFileStorageRoom, checkFileStorageRoom, type FileStorageUsage, posterCleanupSentence, storageFullSentence } from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { checkUploadedFile, type CleanUpload, fileError, readUpload, type UploadMessages } from "../files/upload";
import { canManageAccount, isOwner } from "../permissions";
import { consumeRateLimit } from "../rate-limit";
import { getWebsitePhotoHold, serializeWebsitePhotoHold, websitePhotoHoldKey } from "../queries/website-photo-holds";
import { isHeicLike, posterImageSize, sniffPosterFile } from "./posters";

const HOUR = 60 * 60 * 1000;

export const USER_PHOTO_NEEDS_FILE = "Choose a photo to upload.";
export const USER_PHOTO_NONE = "There's no photo to remove.";
export const USER_PHOTO_INACTIVE = "Your account isn't active, so you can't change photos.";
export const USER_PHOTO_CANT_REMOVE = "Only people who manage this account can remove its photo.";
export const USER_PHOTO_NO_ACCOUNT = "That account doesn't exist any more.";
export const USER_PHOTO_CANT_HOLD = "Only people who manage this account can keep its photo off the team website or allow it.";
export const USER_PHOTO_HOLD_OWN =
  "You can't change this for your own photo. Ask someone else who manages accounts (use your own switch to take it off the website).";
export const USER_PHOTO_NOT_HELD = "Their photo isn't being kept off the team website.";

const PHOTO_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

const UPLOAD_MESSAGES: UploadMessages = {
  tooBig: userPhotoTooBigMessage,
  blocked: () => USER_PHOTO_TYPES_MESSAGE,
};

/** A photo that passed the checks: the upload (real type, neutral name, no metadata) and the size it's shown at. */
export interface CheckedUserPhoto {
  upload: CleanUpload;
  width: number;
  height: number;
}

/**
 * Checks a picked photo: not empty, up to USER_PHOTO_MAX_BYTES (1 MB), really a PNG, JPG, or WebP (by its bytes, whatever
 * its name or the browser said; HEIC gets its own message), at most USER_PHOTO_MAX_DIMENSION (1,024) pixels a side, a
 * still picture (no APNG or animated WebP), and a JPEG only with markers browsers draw. Returns it without its metadata
 * (strict: no colour profile or thumbnail either), named "photo.<ext>", with the width and height it's shown at
 * (swapped for Exif orientations 5–8).
 */
export function checkUserPhoto(value: unknown): CheckedUserPhoto {
  const picked = readUpload(value);
  if (!picked) throw fileError(USER_PHOTO_NEEDS_FILE);
  const upload = checkUploadedFile(picked, UPLOAD_MESSAGES);
  if (upload.bytes.byteLength > USER_PHOTO_MAX_BYTES) throw fileError(userPhotoTooBigMessage(upload.bytes.byteLength));
  const kind = sniffPosterFile(upload.bytes);
  if (kind !== "png" && kind !== "jpg" && kind !== "webp") {
    // A HEIC photo gets the iPhone hint; a file that says it's a PNG/JPG/WebP but isn't one "couldn't be opened"; a
    // real GIF, PDF, SVG, or anything else, which pictures it can be.
    if (isHeicLike(upload.bytes)) throw fileError(USER_PHOTO_HEIC_MESSAGE);
    const claimsPhoto = kind === null && userPhotoProblem({ name: picked.name, type: picked.type, size: upload.bytes.byteLength }) === null;
    throw fileError(claimsPhoto ? USER_PHOTO_UNREADABLE_MESSAGE : USER_PHOTO_TYPES_MESSAGE);
  }
  const size = posterImageSize(upload.bytes, kind);
  if (!size || size.width < 1 || size.height < 1) throw fileError(USER_PHOTO_UNREADABLE_MESSAGE);
  if (size.width > USER_PHOTO_MAX_DIMENSION || size.height > USER_PHOTO_MAX_DIMENSION) {
    throw fileError(userPhotoTooLargeMessage(size.width, size.height));
  }
  if (isAnimatedImage(upload.bytes, kind)) throw fileError(USER_PHOTO_ANIMATED_MESSAGE);
  // It can go on the public website: without its Exif / XMP / IPTC (where and when it was taken, on what, by whom),
  // colour profile (it can name the phone), or thumbnail.
  const bytes = stripImageMetadata(upload.bytes, kind, { strict: true });
  // A marker browsers can't decode would leave a broken picture on every avatar.
  if (kind === "jpg" && !jpegMarkersDrawable(bytes)) throw fileError(USER_PHOTO_UNREADABLE_MESSAGE);
  const turned = imageOrientation(bytes, kind) >= 5;
  return {
    // Never the uploaded name (it can hold anything): nobody downloads it, and the public route has its own.
    upload: { filename: `photo.${kind}`, contentType: PHOTO_TYPES[kind], bytes },
    width: turned ? size.height : size.width,
    height: turned ? size.width : size.height,
  };
}

/** The "storage is full" message for photos. */
export function userPhotoStorageFullMessage(usage: FileStorageUsage): string {
  return `${storageFullSentence(usage)} Ask a leader, the captain, a mentor, or a teacher to clear out old files, then try again.${posterCleanupSentence(usage)}`;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function assertActive(ctx: ServiceContext): void {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(USER_PHOTO_INACTIVE);
}

/** Uploads and removals: USER_PHOTO_CHANGES_PER_HOUR per person (the photo's own message, not the file's). */
async function limitPhotoChanges(ctx: ServiceContext): Promise<void> {
  if (!(await consumeRateLimit(ctx.db, `user-photo:${ctx.actor.id}`, USER_PHOTO_CHANGES_PER_HOUR, HOUR, ctx.now))) {
    throw new RateLimitError(USER_PHOTO_RATE_LIMITED_MESSAGE);
  }
}

/**
 * Upload (or replace) your own photo (`file` is an UploadedFile, read from the form by the Server Action). The old one,
 * if any, is deleted in the same transaction: a new row, so a new id and address in the portal and on the website.
 */
export async function uploadUserPhoto(ctx: ServiceContext, raw: unknown): Promise<{ id: string; replaced: boolean }> {
  assertActive(ctx);
  const photo = checkUserPhoto(asRecord(raw).file);
  await limitPhotoChanges(ctx);
  const userId = ctx.actor.id;
  const existing = await ctx.db.userPhoto.findUnique({ where: { userId }, select: { size: true } });
  const adding = photo.upload.bytes.byteLength;
  const objectStorage = usesObjectStorage(ctx);

  return withStoredFiles(
    ctx,
    "photos",
    [photo.upload],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        // The storage lock first (like every upload): two uploads of yours take turns here too.
        const current = await tx.userPhoto.findUnique({ where: { userId }, select: { size: true } });
        await assertFileStorageRoom(tx, { adding, freeing: current?.size ?? 0 }, userPhotoStorageFullMessage, objectStorage);
        const active = await tx.user.count({ where: { id: userId, status: "ACTIVE" } });
        if (active === 0) throw new ForbiddenError(USER_PHOTO_INACTIVE);
        const replaced = (await tx.userPhoto.deleteMany({ where: { userId } })).count > 0;
        const row = await tx.userPhoto.create({
          data: { userId, ...file, width: photo.width, height: photo.height, createdAt: ctx.now },
          select: { id: true },
        });
        return { id: row.id, replaced };
      }),
    { precheck: () => checkFileStorageRoom(ctx.db, { adding, freeing: existing?.size ?? 0 }, userPhotoStorageFullMessage, objectStorage) },
  );
}

const removeInput = z.object({ userId: idSchema.optional() });

/**
 * Remove a photo: your own (no `userId`, or yours), or — for people who manage that account (canManageAccount) —
 * someone else's. It's gone everywhere at once: the portal shows initials, the website's JSON stops listing it, and its
 * public address answers 404. Someone else's: a new photo they upload stays off the website until someone who manages
 * their account allows it (a `removed` hold — otherwise they could put the same picture straight back up).
 */
export async function removeUserPhoto(ctx: ServiceContext, raw: unknown): Promise<{ userId: string; own: boolean }> {
  assertActive(ctx);
  const rec = asRecord(raw);
  const { userId: given } = parseInput(removeInput, { userId: rec.userId === "" ? undefined : rec.userId });
  const userId = given ?? ctx.actor.id;
  const own = userId === ctx.actor.id;
  if (!own) {
    const target = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true, isAdmin: true } });
    if (!target) throw new NotFoundError(USER_PHOTO_NO_ACCOUNT);
    if (!canManageAccount(ctx.actor, target)) throw new ForbiddenError(USER_PHOTO_CANT_REMOVE);
  }
  await limitPhotoChanges(ctx);
  const { count } = await ctx.db.$transaction(async (tx) => {
    const removed = await tx.userPhoto.deleteMany({ where: { userId } });
    if (removed.count > 0 && !own) await writeHold(tx, ctx, userId, { reason: "removed", at: ctx.now.toISOString(), byName: ctx.actor.name });
    return removed;
  });
  if (count === 0) throw new NotFoundError(USER_PHOTO_NONE);
  return { userId, own };
}

// ── Holds (kept off the website until allowed) ───────────────────────────────────────────────────────────────

type HoldDb = Pick<ServiceContext["db"], "teamNote">;

function writeHold(db: HoldDb, ctx: ServiceContext, userId: string, hold: WebsitePhotoHold) {
  const key = websitePhotoHoldKey(userId);
  const body = serializeWebsitePhotoHold(hold);
  return db.teamNote.upsert({
    where: { key },
    create: { key, body, updatedById: ctx.actor.id },
    update: { body, updatedById: ctx.actor.id },
  });
}

const holdInput = z.object({ userId: idSchema });

/** The account someone who manages it is changing a hold on (never their own, unless they're an owner). */
async function heldTarget(ctx: ServiceContext, raw: unknown): Promise<string> {
  assertActive(ctx);
  const { userId } = parseInput(holdInput, asRecord(raw));
  const target = await ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true, isAdmin: true } });
  if (!target) throw new NotFoundError(USER_PHOTO_NO_ACCOUNT);
  if (!canManageAccount(ctx.actor, target)) throw new ForbiddenError(USER_PHOTO_CANT_HOLD);
  // A leader who renamed themselves can't wave their own new name through.
  if (target.id === ctx.actor.id && !isOwner(ctx.actor)) throw new ForbiddenError(USER_PHOTO_HOLD_OWN);
  return target.id;
}

/**
 * Admin → People → a person: keep their photo off the team website (a `kept-off` hold — e.g. no photo release),
 * whatever their own switch says, until someone who manages their account allows it. Their photo (if any) stays in the
 * portal. For people who manage the account (canManageAccount; not your own unless you're an owner).
 */
export async function keepPhotoOffWebsite(ctx: ServiceContext, raw: unknown): Promise<{ userId: string }> {
  const userId = await heldTarget(ctx, raw);
  await writeHold(ctx.db, ctx, userId, { reason: "kept-off", at: ctx.now.toISOString(), byName: ctx.actor.name });
  return { userId };
}

/**
 * Admin → People → a person (or Approvals → Members' photos): lift a hold — after checking a new name (`renamed`), or
 * once a removed or kept-off photo may go public. Their own switch decides again.
 */
export async function allowWebsitePhoto(ctx: ServiceContext, raw: unknown): Promise<{ userId: string }> {
  const userId = await heldTarget(ctx, raw);
  const { count } = await ctx.db.teamNote.deleteMany({ where: { key: websitePhotoHoldKey(userId) } });
  if (count === 0) throw new NotFoundError(USER_PHOTO_NOT_HELD);
  return { userId };
}

/**
 * Called when you change your own name (Settings → Profile, services/settings.ts): the website finds photos by name,
 * so a new name — one the website would compare differently (teamPhotoNameKey) — holds your photo off the website
 * (`renamed`, keeping the name before) until someone who manages your account checks it. Changing it back to that name
 * lifts it again. A hold someone put on your photo (`removed`, `kept-off`) stays as it is. Written whether or not you
 * have a photo yet, so renaming first and uploading after doesn't skip the check. Returns whether a rename hold is on
 * afterwards.
 */
export async function holdWebsitePhotoAfterRename(ctx: ServiceContext, from: string, to: string): Promise<boolean> {
  const fromKey = teamPhotoNameKey(from);
  const toKey = teamPhotoNameKey(to);
  const key = websitePhotoHoldKey(ctx.actor.id);
  const existing = await getWebsitePhotoHold(ctx.actor.id, ctx.db);
  if (fromKey === toKey) return existing?.reason === "renamed";
  if (existing) {
    // Back to the name that was checked: the hold goes (only that one — the body must still be the same).
    if (existing.reason === "renamed" && existing.from !== undefined && teamPhotoNameKey(existing.from) === toKey) {
      await ctx.db.teamNote.deleteMany({ where: { key, body: serializeWebsitePhotoHold(existing) } });
      return false;
    }
    return existing.reason === "renamed";
  }
  const hold: WebsitePhotoHold = { reason: "renamed", at: ctx.now.toISOString(), from };
  // Two renames at once: the first one's hold (and its `from`) wins.
  await ctx.db.teamNote.createMany({ data: [{ key, body: serializeWebsitePhotoHold(hold), updatedById: ctx.actor.id }], skipDuplicates: true });
  return true;
}

export const PHOTO_SWITCHES = ["portal", "website"] as const;
export type PhotoSwitch = (typeof PHOTO_SWITCHES)[number];

const visibilityInput = z.object({
  which: z.enum(PHOTO_SWITCHES, { error: "Pick which switch to change." }),
  show: checkbox,
});

/**
 * One of your photo's switches (your own account only): `portal` = "Show my photo in the portal" (off: the team sees
 * your initials; people who manage your account still see it in Admin), `website` = "Show my photo on the team website"
 * (off: the website's JSON stops listing it and its public address answers 404 — the website shows it no more within a
 * few minutes, its caches included). `held`: the website switch is on, but a hold keeps the photo off the website.
 */
export async function updatePhotoVisibility(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ which: PhotoSwitch; show: boolean; held: boolean }> {
  const { which, show } = parseInput(visibilityInput, asRecord(raw));
  assertActive(ctx);
  const data = which === "portal" ? { showPhotoInPortal: show } : { showPhotoOnWebsite: show };
  const { count } = await ctx.db.user.updateMany({ where: { id: ctx.actor.id, status: "ACTIVE" }, data });
  if (count === 0) throw new ForbiddenError(USER_PHOTO_INACTIVE);
  const held = which === "website" && show && (await getWebsitePhotoHold(ctx.actor.id, ctx.db)) !== null;
  return { which, show, held };
}
