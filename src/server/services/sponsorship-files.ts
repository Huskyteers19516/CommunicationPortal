// Files attached to a sponsor: e.g. the sponsor's paper application form to print and fill out, or the
// filled-out (scanned) copy. Everyone who can use Sponsorships can see, add, and download them; removing one is
// for whoever uploaded it and everyone who can remove the sponsor (canDeleteSponsorshipFile).
// Stored like Resources files (Postgres, or Cloudflare R2 when it's set up: ../files/stored.ts), and counted toward the
// same storage cap (../files/storage.ts). Each person's uploads are capped too (SPONSOR_FILE_BYTES_PER_PERSON, 10×
// with R2), so one account can't fill the storage.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { LIMITS } from "@/lib/constants";
import { formatFileSize, sponsorFileTooBigMessage } from "@/lib/files";
import { idSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  assertFileStorageRoom,
  checkFileStorageRoom,
  type FileStorageUsage,
  lockFileStorage,
  perPersonFileCap,
  posterCleanupSentence,
  storageFullSentence,
} from "../files/storage";
import { usesObjectStorage, withStoredFiles } from "../files/stored";
import { checkUploadedFile, fileError, readUpload, type UploadMessages } from "../files/upload";
import { canDeleteSponsorshipFile, canManageSponsorships } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { assertCanUseSponsorships, limitSponsorshipWrites, SPONSORSHIP_NOT_FOUND } from "./sponsorships";

export const SPONSORSHIP_FILE_NOT_FOUND = "That file no longer exists.";

const HOUR = 60 * 60 * 1000;
/** Uploads per person per hour (each can be up to 4 MB). */
export const SPONSORSHIP_FILE_UPLOADS_PER_HOUR = 30;

/**
 * Sponsor files (and logos) one person can have uploaded (all sponsors together; removing files frees it up again),
 * so one account can't fill the team's storage (10× with Cloudflare R2: perPersonFileCap). The Business leader and
 * all-scope staff aren't limited (canManageSponsorships).
 */
export const SPONSOR_FILE_BYTES_PER_PERSON = 50 * 1024 * 1024;

const UPLOAD_MESSAGES: UploadMessages = {
  tooBig: sponsorFileTooBigMessage,
  blocked: (ext) => `.${ext} files can't be uploaded because they can run programs on a computer.`,
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

const uploadInput = z.object({ sponsorshipId: idSchema });

/** The "storage is full" message for sponsor files and logos. */
export function sponsorStorageFullMessage(usage: FileStorageUsage): string {
  return `${storageFullSentence(usage)} Remove sponsor files you don't need, or ask the Business leader, captain, or a mentor to clear out old ones. Admins can remove old Resources files.${posterCleanupSentence(usage)}`;
}

/**
 * The uploader's sponsor files and logos stay under SPONSOR_FILE_BYTES_PER_PERSON together (10× with Cloudflare R2),
 * unless they can manage Sponsorships. `exceptLogoOf`: a sponsor whose logo this upload replaces (its bytes don't
 * count).
 */
export async function assertSponsorUploadAllowance(
  db: Prisma.TransactionClient,
  ctx: ServiceContext,
  adding: number,
  exceptLogoOf?: string,
): Promise<void> {
  if (canManageSponsorships(ctx.actor)) return;
  const files = await db.sponsorshipFile.aggregate({ _sum: { size: true }, where: { uploadedById: ctx.actor.id } });
  const logos = await db.sponsorshipLogo.aggregate({
    _sum: { size: true },
    where: { uploadedById: ctx.actor.id, ...(exceptLogoOf ? { sponsorshipId: { not: exceptLogoOf } } : {}) },
  });
  const used = (files._sum.size ?? 0) + (logos._sum.size ?? 0);
  const allowance = perPersonFileCap(SPONSOR_FILE_BYTES_PER_PERSON, usesObjectStorage(ctx));
  if (used + adding > allowance) {
    throw fileError(
      `You've uploaded ${formatFileSize(used)} of sponsor files and logos, and each person can have up to ${formatFileSize(allowance)}. Remove ones you don't need, or ask the Business leader to add this one.`,
    );
  }
}

/**
 * Room for one more file on a sponsor: at most LIMITS.sponsorFilesMax files, the uploader's sponsor files (and logos)
 * under their allowance (unless they can manage Sponsorships), and every file under the team's cap. `locked`: in the
 * upload's transaction, after lockFileStorage (the real check); otherwise the quick look before uploading to
 * Cloudflare R2.
 */
async function checkSponsorFileRoom(db: Prisma.TransactionClient, ctx: ServiceContext, sponsorshipId: string, adding: number, locked: boolean) {
  const count = await db.sponsorshipFile.count({ where: { sponsorshipId } });
  if (count >= LIMITS.sponsorFilesMax) {
    throw fileError(`This sponsor already has ${LIMITS.sponsorFilesMax} files, the most it can have. Remove one you don't need first.`);
  }
  await assertSponsorUploadAllowance(db, ctx, adding);
  await (locked ? assertFileStorageRoom : checkFileStorageRoom)(db, { adding }, sponsorStorageFullMessage, usesObjectStorage(ctx));
}

/**
 * Attach a file to a sponsor (`file` is an UploadedFile, read from the form by the Server Action).
 * Checked like Resources uploads (not empty, up to 4 MB, a cleaned name, no runnable files); a sponsor holds at
 * most LIMITS.sponsorFilesMax files, each person's sponsor files stay under SPONSOR_FILE_BYTES_PER_PERSON (unless
 * they can manage Sponsorships), and all files together stay under the team's storage cap. All three are checked
 * under the storage lock, so uploads at the same moment can't go over any of them.
 */
export async function uploadSponsorshipFile(ctx: ServiceContext, raw: unknown): Promise<{ id: string; filename: string }> {
  assertCanUseSponsorships(ctx);
  const rec = asRecord(raw);
  const { sponsorshipId } = parseInput(uploadInput, rec);
  const picked = readUpload(rec.file);
  if (!picked) throw fileError("Choose a file to upload.");
  const upload = checkUploadedFile(picked, UPLOAD_MESSAGES);
  await enforceRateLimit(ctx.db, `sponsorship-file:${ctx.actor.id}`, SPONSORSHIP_FILE_UPLOADS_PER_HOUR, HOUR, ctx.now);

  const adding = upload.bytes.byteLength;
  return withStoredFiles(
    ctx,
    "sponsors",
    [upload],
    ([file]) =>
      ctx.db.$transaction(async (tx) => {
        await lockFileStorage(tx);
        // Holds the sponsor until this commits, so it can't be removed between this check and the insert.
        const sponsor = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Sponsorship" WHERE id = ${sponsorshipId} FOR KEY SHARE`;
        if (sponsor.length === 0) throw new NotFoundError(SPONSORSHIP_NOT_FOUND);
        await checkSponsorFileRoom(tx, ctx, sponsorshipId, adding, true);
        return tx.sponsorshipFile.create({
          data: { sponsorshipId, uploadedById: ctx.actor.id, createdAt: ctx.now, ...file },
          select: { id: true, filename: true },
        });
      }),
    { precheck: () => checkSponsorFileRoom(ctx.db, ctx, sponsorshipId, adding, false) },
  );
}

const deleteInput = z.object({ fileId: idSchema });

/** Remove a sponsor's file: whoever uploaded it, whoever added the sponsor, the Business leader, and all-scope staff. */
export async function deleteSponsorshipFile(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ filename: string; sponsorshipId: string }> {
  assertCanUseSponsorships(ctx);
  const { fileId } = parseInput(deleteInput, asRecord(raw));
  const file = await ctx.db.sponsorshipFile.findUnique({
    where: { id: fileId },
    select: { filename: true, sponsorshipId: true, uploadedById: true, sponsorship: { select: { createdById: true } } },
  });
  if (!file) throw new NotFoundError(SPONSORSHIP_FILE_NOT_FOUND);
  if (!canDeleteSponsorshipFile(ctx.actor, file)) {
    throw new ForbiddenError(
      "Only the person who uploaded this file, whoever added the sponsor, the Business leader, or the captain, mentors, and teachers can remove it.",
    );
  }
  await limitSponsorshipWrites(ctx);
  const { count } = await ctx.db.sponsorshipFile.deleteMany({ where: { id: fileId } });
  if (count === 0) throw new NotFoundError(SPONSORSHIP_FILE_NOT_FOUND);
  return { filename: file.filename, sponsorshipId: file.sponsorshipId };
}
