// A sponsor's brand logo for the team website's Sponsors page (SponsorshipLogo, one per sponsor). Whoever can use
// Sponsorships (the Business team and staff — everyone who can edit the sponsor) uploads, replaces, or removes it on
// the sponsor's page; the website shows it only while the sponsor is public (Accepted or Finished, "Thank them on the
// team website" on — see src/server/queries/public-sponsors.ts).
//
// Logos are checked by their contents like posters (src/server/services/posters.ts): only real PNG, JPG, or WebP
// pictures (never SVG, which can carry script, or GIF/PDF), with a readable pixel size a phone can draw, ≤ 4 MB, stored
// with the matching extension and type, and without their metadata (Exif, XMP, IPTC, comments: ../files/image-metadata.ts
// — they're public, and a phone's picture can say where it was taken and by whom). They're stored like every other upload (Postgres, or Cloudflare R2 when it's set
// up: ../files/stored.ts), count toward the team's storage cap, and toward each person's sponsor-upload allowance
// (SPONSOR_FILE_BYTES_PER_PERSON, shared with sponsor files). A replaced logo is a new row (so a new id and public
// address): the website's cached copy of the old one is never shown for the new one.
import { z } from "zod";
import { POSTER_HEIC_MESSAGE, POSTER_IMAGE_MAX_PIXELS, POSTER_IMAGE_MAX_SIDE } from "@/lib/posters";
import {
  claimsSponsorLogoType,
  SPONSOR_LOGO_TYPES_MESSAGE,
  SPONSOR_LOGO_UNREADABLE_MESSAGE,
  sponsorLogoTooBigMessage,
  sponsorLogoTooLargeMessage,
} from "@/lib/public-sponsors";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { NotFoundError } from "../errors";
import { stripImageMetadata } from "../files/image-metadata";
import { assertFileStorageRoom, checkFileStorageRoom, lockFileStorage } from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { checkUploadedFile, type CleanUpload, fileError, readUpload, type UploadMessages } from "../files/upload";
import { enforceRateLimit } from "../rate-limit";
import { isHeicLike, type PixelSize, type PosterFileKind, posterImageSize, sniffPosterFile, withKindExtension } from "./posters";
import { assertSponsorUploadAllowance, SPONSORSHIP_FILE_UPLOADS_PER_HOUR, sponsorStorageFullMessage } from "./sponsorship-files";
import { assertCanUseSponsorships, limitSponsorshipWrites, SPONSORSHIP_NOT_FOUND } from "./sponsorships";

const HOUR = 60 * 60 * 1000;

export const SPONSOR_LOGO_NEEDS_FILE = "Choose a logo to upload.";
export const SPONSOR_LOGO_NONE = "This sponsor has no logo to remove.";

const LOGO_INFO = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
} as const;

const UPLOAD_MESSAGES: UploadMessages = {
  tooBig: sponsorLogoTooBigMessage,
  blocked: () => SPONSOR_LOGO_TYPES_MESSAGE,
};

/** A logo that passed the checks: the upload (with the real type and a matching extension) and its pixel size. */
export interface CheckedLogo {
  upload: CleanUpload;
  size: PixelSize;
}

/**
 * Checks a picked logo: not empty, up to 4 MB, really a PNG, JPG, or WebP (by its bytes, whatever its name or the
 * browser said), and a picture a phone can draw (POSTER_IMAGE_MAX_SIDE / _PIXELS, read from its header). The upload
 * it returns has the metadata taken out (stripImageMetadata: the picture itself is unchanged).
 */
export function checkSponsorLogo(value: unknown): CheckedLogo {
  const picked = readUpload(value);
  if (!picked) throw fileError(SPONSOR_LOGO_NEEDS_FILE);
  const upload = checkUploadedFile(picked, UPLOAD_MESSAGES);
  const kind = sniffPosterFile(upload.bytes);
  if (kind !== "png" && kind !== "jpg" && kind !== "webp") throw fileError(notALogoMessage(picked, upload.bytes, kind));
  const size = posterImageSize(upload.bytes, kind);
  if (!size || size.width < 1 || size.height < 1) throw fileError(SPONSOR_LOGO_UNREADABLE_MESSAGE);
  if (size.width > POSTER_IMAGE_MAX_SIDE || size.height > POSTER_IMAGE_MAX_SIDE || size.width * size.height > POSTER_IMAGE_MAX_PIXELS) {
    throw fileError(sponsorLogoTooLargeMessage(size.width, size.height));
  }
  const filename = upload.filename === "file" ? `logo.${kind}` : withKindExtension(upload.filename, kind);
  // Published as it's stored: without its Exif / XMP / IPTC (where and when it was taken, on what, by whom).
  const bytes = stripImageMetadata(upload.bytes, kind);
  return { upload: { ...upload, bytes, filename, contentType: LOGO_INFO[kind] }, size };
}

/** An SVG (or XML) file, by its first bytes: never a logo, whatever it's called. */
function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, "").trimStart();
  return /^<(\?xml|svg|!--|!doctype\s+svg)/i.test(head) && /<svg[\s/>]/i.test(head);
}

/**
 * Why a picked file isn't a logo. A HEIC photo gets the iPhone hint; a real SVG, GIF, or PDF (or a file that doesn't
 * even say it's a picture) the "PNG, JPG, or WebP" message; a file named or typed as one of those that isn't really
 * one (damaged, or not a picture at all) "couldn't be opened" — the person did pick a PNG, as far as they know.
 */
function notALogoMessage(picked: { name: string; type: string }, bytes: Uint8Array, kind: PosterFileKind | null): string {
  if (isHeicLike(bytes)) return POSTER_HEIC_MESSAGE;
  if (kind !== null || looksLikeSvg(bytes) || !claimsSponsorLogoType(picked)) return SPONSOR_LOGO_TYPES_MESSAGE;
  return SPONSOR_LOGO_UNREADABLE_MESSAGE;
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const sponsorInput = z.object({ sponsorshipId: idSchema });

/**
 * Room for the logo: the uploader's allowance (sponsor files and logos together, not counting the logo it replaces)
 * and the team's cap (after freeing the replaced logo). `locked`: under the storage lock (the real check); otherwise
 * the quick look before uploading to Cloudflare R2.
 */
async function checkLogoRoom(
  db: Parameters<typeof checkFileStorageRoom>[0],
  ctx: ServiceContext,
  sponsorshipId: string,
  change: { adding: number; freeing: number },
  locked: boolean,
): Promise<void> {
  await assertSponsorUploadAllowance(db, ctx, change.adding, sponsorshipId);
  await (locked ? assertFileStorageRoom : checkFileStorageRoom)(db, change, sponsorStorageFullMessage, usesObjectStorage(ctx));
}

/**
 * Upload (or replace) a sponsor's logo (`file` is an UploadedFile, read from the form by the Server Action). The old
 * logo, if any, is removed in the same transaction (its R2 object is queued for deletion by the database trigger).
 * Shares the hourly upload allowance with sponsor files.
 */
export async function uploadSponsorshipLogo(ctx: ServiceContext, raw: unknown): Promise<{ id: string; replaced: boolean }> {
  assertCanUseSponsorships(ctx);
  const rec = asRecord(raw);
  const { sponsorshipId } = parseInput(sponsorInput, rec);
  const { upload, size } = checkSponsorLogo(rec.file);
  await enforceRateLimit(ctx.db, `sponsorship-file:${ctx.actor.id}`, SPONSORSHIP_FILE_UPLOADS_PER_HOUR, HOUR, ctx.now);
  const existing = await ctx.db.sponsorship.findUnique({ where: { id: sponsorshipId }, select: { logo: { select: { size: true } } } });
  if (!existing) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);

  const adding = upload.bytes.byteLength;
  return withStoredFiles(
    ctx,
    "logos",
    [upload],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        await lockFileStorage(tx);
        // Holds the sponsor until this commits: it can't be removed in between, and two uploads take turns.
        const sponsor = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Sponsorship" WHERE id = ${sponsorshipId} FOR UPDATE`;
        if (sponsor.length === 0) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);
        const current = await tx.sponsorshipLogo.findUnique({ where: { sponsorshipId }, select: { size: true } });
        await checkLogoRoom(tx, ctx, sponsorshipId, { adding, freeing: current?.size ?? 0 }, true);
        // A new row (and id), so the public address changes and nobody sees the old logo from a cache.
        if (current) await tx.sponsorshipLogo.deleteMany({ where: { sponsorshipId } });
        const row = await tx.sponsorshipLogo.create({
          data: { sponsorshipId, ...file, width: size.width, height: size.height, uploadedById: ctx.actor.id, createdAt: ctx.now },
          select: { id: true },
        });
        return { id: row.id, replaced: !!current };
      }),
    { precheck: () => checkLogoRoom(ctx.db, ctx, sponsorshipId, { adding, freeing: existing.logo?.size ?? 0 }, false) },
  );
}

/** Remove a sponsor's logo (the website then shows the sponsor's name without one). */
export async function removeSponsorshipLogo(ctx: ServiceContext, raw: unknown): Promise<{ sponsorshipId: string }> {
  assertCanUseSponsorships(ctx);
  const { sponsorshipId } = parseInput(sponsorInput, asRecord(raw));
  const sponsor = await ctx.db.sponsorship.count({ where: { id: sponsorshipId } });
  if (sponsor === 0) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);
  await limitSponsorshipWrites(ctx);
  const { count } = await ctx.db.sponsorshipLogo.deleteMany({ where: { sponsorshipId } });
  if (count === 0) throw new NotFoundError(SPONSOR_LOGO_NONE);
  return { sponsorshipId };
}
