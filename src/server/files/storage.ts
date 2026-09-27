// The team's file storage: every uploaded file (Resources files, files attached to sponsors, and posters) lives
// in Postgres, so together they must stay under LIMITS.resourceStorageMaxBytes.
import type { Prisma } from "@/generated/prisma/client";
import { LIMITS } from "@/lib/constants";
import { formatFileSize } from "@/lib/files";
import { fileError } from "./upload";

type Tx = Prisma.TransactionClient;

/** How much of the team's file storage is used, and by what. */
export interface FileStorageUsage {
  /** Bytes of Resources files. */
  resources: number;
  /** Bytes of files attached to sponsors. */
  sponsors: number;
  /** Bytes of poster images and PDFs (the Posters page). */
  posters: number;
  /** All of them together. */
  used: number;
  /** The cap (LIMITS.resourceStorageMaxBytes). */
  max: number;
}

/**
 * Takes the storage lock for the rest of the transaction. Every upload takes it before checking for room,
 * so two uploads at the same moment (to either feature) can't both squeeze into the last bit of space.
 * (The key keeps its original name so it stays the same lock across deploys.)
 */
export async function lockFileStorage(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hk-resource-storage'))`;
}

/**
 * Bytes used by Resources files, sponsor files, and posters (never reads the bytes themselves). One after the
 * other, since `db` may be a transaction.
 */
export async function fileStorageUsage(db: Tx): Promise<FileStorageUsage> {
  const resources = await db.resourceFile.aggregate({ _sum: { size: true } });
  const sponsors = await db.sponsorshipFile.aggregate({ _sum: { size: true } });
  const posters = await db.posterFile.aggregate({ _sum: { size: true } });
  const r = resources._sum.size ?? 0;
  const s = sponsors._sum.size ?? 0;
  const p = posters._sum.size ?? 0;
  return { resources: r, sponsors: s, posters: p, used: r + s + p, max: LIMITS.resourceStorageMaxBytes };
}

/** Bytes used by every uploaded file together (Resources files, sponsor files, and posters). */
export async function usedFileStorageBytes(tx: Tx): Promise<number> {
  return (await fileStorageUsage(tx)).used;
}

/**
 * The first sentence of every "storage is full" message: where the space is going, so people know whom to ask
 * ("The team's file storage is full: 238 MB of Resources files and 62 MB of sponsor files."). Posters are only
 * named when there are some ("…: 200 MB of Resources files, 62 MB of sponsor files, and 38 MB of posters.").
 */
export function storageFullSentence(usage: FileStorageUsage): string {
  const resources = `${formatFileSize(usage.resources)} of Resources files`;
  const sponsors = `${formatFileSize(usage.sponsors)} of sponsor files`;
  if (usage.posters > 0) {
    return `The team's file storage is full: ${resources}, ${sponsors}, and ${formatFileSize(usage.posters)} of posters.`;
  }
  return `The team's file storage is full: ${resources} and ${sponsors}.`;
}

/**
 * Who can free poster space, for the end of the other features' "full" messages: " Old posters can be removed…",
 * or "" when there are no poster files.
 */
export function posterCleanupSentence(usage: FileStorageUsage): string {
  return usage.posters > 0
    ? " Old posters can be removed by whoever added them, or by leaders, the captain, mentors, and teachers."
    : "";
}

/**
 * Locks the storage (see lockFileStorage), then throws a ValidationError on the `file` field with
 * `fullMessage(usage)` when adding `adding` bytes (after freeing `freeing`, e.g. a replaced file) would go over the cap.
 */
export async function assertFileStorageRoom(
  tx: Tx,
  change: { adding: number; freeing?: number },
  fullMessage: (usage: FileStorageUsage) => string,
): Promise<void> {
  await lockFileStorage(tx);
  const usage = await fileStorageUsage(tx);
  if (usage.used - (change.freeing ?? 0) + change.adding > usage.max) throw fileError(fullMessage(usage));
}
