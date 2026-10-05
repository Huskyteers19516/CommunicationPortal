// The team's file storage: every uploaded file (Resources files, files attached to sponsors, posters, team
// notebook pictures, strategy files, sponsors' logos, and Workshop photos and design files) counts toward one cap,
// wherever its bytes live:
// - in Postgres (the default): LIMITS.resourceStorageMaxBytes (300 MB), because Neon's free plan gives the whole
//   database 0.5 GB;
// - in Cloudflare R2 (when the R2_* settings are set, see ./object-store.ts): OBJECT_STORAGE_CAP_BYTES (8 GB, well under
//   R2's free 10 GB), and each person's allowances are OBJECT_STORAGE_PER_PERSON_FACTOR times bigger.
// Sizes come from the rows' `size`, so files still in Postgres and files in R2 are counted the same way.
import { Prisma } from "@/generated/prisma/client";
import { LIMITS } from "@/lib/constants";
import { formatFileSize } from "@/lib/files";
import { FILE_KINDS, type FileKind, objectStorageEnabled } from "./object-store";
import { fileError } from "./upload";

/**
 * The cap with Cloudflare R2: 8 GB (8 GiB, shown as "8 GB"), leaving real headroom under R2's free 10 GB however
 * Cloudflare counts a GB (10^9 or 2^30 bytes). R2 bills the day's peak, and a replaced or removed file still counts
 * there until its object is deleted (usually right after the response, see cleanup.ts).
 */
export const OBJECT_STORAGE_CAP_BYTES = 8 * 1024 * 1024 * 1024;
/** Each person's allowances (posters, sponsor files, …) are this many times bigger with Cloudflare R2. */
export const OBJECT_STORAGE_PER_PERSON_FACTOR = 10;

/** The team's file storage cap: 300 MB while files live in Postgres, 8 GB with Cloudflare R2. */
export function fileStorageCapBytes(objectStorage: boolean): number {
  return objectStorage ? OBJECT_STORAGE_CAP_BYTES : LIMITS.resourceStorageMaxBytes;
}

/** A per-person allowance (e.g. POSTER_FILE_BYTES_PER_PERSON) as it applies now: 10× with Cloudflare R2. */
export function perPersonFileCap(baseBytes: number, objectStorage: boolean): number {
  return objectStorage ? baseBytes * OBJECT_STORAGE_PER_PERSON_FACTOR : baseBytes;
}

type Tx = Prisma.TransactionClient;

/** How much of the team's file storage is used, and by what. */
export interface FileStorageUsage {
  /** Bytes of Resources files. */
  resources: number;
  /** Bytes of files attached to sponsors. */
  sponsors: number;
  /** Bytes of poster images and PDFs (the Posters page). */
  posters: number;
  /** Bytes of pictures on Team notebook entries. */
  notebook: number;
  /** Bytes of files on the Strategy page (.pp paths, diagrams, PDFs). */
  strategy: number;
  /** Bytes of sponsors' logos (for the team website's Sponsors page). */
  logos: number;
  /** Bytes of Workshop photos and design files (shown on the team website once approved). */
  workshop: number;
  /** All of them together. */
  used: number;
  /** The cap (fileStorageCapBytes: 300 MB in Postgres, 8 GB with Cloudflare R2). */
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
 * Bytes used by every kind of uploaded file (from the rows' sizes; never reads the bytes themselves), and the cap
 * for where new files go (`objectStorage`: Cloudflare R2 is set up; by default from the R2_* settings). One after the
 * other, since `db` may be a transaction.
 */
export async function fileStorageUsage(db: Tx, objectStorage: boolean = objectStorageEnabled()): Promise<FileStorageUsage> {
  const resources = await db.resourceFile.aggregate({ _sum: { size: true } });
  const sponsors = await db.sponsorshipFile.aggregate({ _sum: { size: true } });
  const posters = await db.posterFile.aggregate({ _sum: { size: true } });
  const notebook = await db.notebookImage.aggregate({ _sum: { size: true } });
  const strategy = await db.strategyFile.aggregate({ _sum: { size: true } });
  const logos = await db.sponsorshipLogo.aggregate({ _sum: { size: true } });
  const workshopPhotos = await db.workshopPhoto.aggregate({ _sum: { size: true } });
  const workshopFiles = await db.workshopFile.aggregate({ _sum: { size: true } });
  const r = resources._sum.size ?? 0;
  const s = sponsors._sum.size ?? 0;
  const p = posters._sum.size ?? 0;
  const n = notebook._sum.size ?? 0;
  const g = strategy._sum.size ?? 0;
  const l = logos._sum.size ?? 0;
  const w = (workshopPhotos._sum.size ?? 0) + (workshopFiles._sum.size ?? 0);
  return {
    resources: r,
    sponsors: s,
    posters: p,
    notebook: n,
    strategy: g,
    logos: l,
    workshop: w,
    used: r + s + p + n + g + l + w,
    max: fileStorageCapBytes(objectStorage),
  };
}

/** Bytes used by every uploaded file together (all the kinds in FileStorageUsage). */
export async function usedFileStorageBytes(tx: Tx): Promise<number> {
  return (await fileStorageUsage(tx, false)).used;
}

/**
 * The first sentence of every "storage is full" message: where the space is going, so people know whom to ask
 * ("The team's file storage is full: 238 MB of Resources files and 62 MB of sponsor files."). Posters are only
 * named when there are some ("…: 200 MB of Resources files, 62 MB of sponsor files, and 38 MB of posters.").
 */
export function storageFullSentence(usage: FileStorageUsage): string {
  // Resources and sponsor files are always named; the newer kinds only when there are some.
  const parts = [`${formatFileSize(usage.resources)} of Resources files`, `${formatFileSize(usage.sponsors)} of sponsor files`];
  if (usage.posters > 0) parts.push(`${formatFileSize(usage.posters)} of posters`);
  if (usage.notebook > 0) parts.push(`${formatFileSize(usage.notebook)} of notebook pictures`);
  if (usage.strategy > 0) parts.push(`${formatFileSize(usage.strategy)} of strategy files`);
  if (usage.logos > 0) parts.push(`${formatFileSize(usage.logos)} of sponsor logos`);
  if (usage.workshop > 0) parts.push(`${formatFileSize(usage.workshop)} of Workshop photos and designs`);
  const list = parts.length === 2 ? `${parts[0]} and ${parts[1]}` : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
  return `The team's file storage is full: ${list}.`;
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
 * `objectStorage`: new files go to Cloudflare R2 (services pass `!!ctx.objectStore`), which sets the cap.
 */
export async function assertFileStorageRoom(
  tx: Tx,
  change: { adding: number; freeing?: number },
  fullMessage: (usage: FileStorageUsage) => string,
  objectStorage: boolean,
): Promise<void> {
  await lockFileStorage(tx);
  await checkFileStorageRoom(tx, change, fullMessage, objectStorage);
}

/**
 * The same check as assertFileStorageRoom without the lock: for the quick look before uploading to Cloudflare R2
 * (withStoredFiles' `precheck`), so an upload that can't fit isn't sent. Never the final word: saving checks again
 * under the lock.
 */
export async function checkFileStorageRoom(
  db: Tx,
  change: { adding: number; freeing?: number },
  fullMessage: (usage: FileStorageUsage) => string,
  objectStorage: boolean,
): Promise<void> {
  const usage = await fileStorageUsage(db, objectStorage);
  if (usage.used - (change.freeing ?? 0) + change.adding > usage.max) throw fileError(fullMessage(usage));
}

/** The table of each kind of stored file (fixed names, never from input). */
const FILE_TABLES: Record<FileKind, string> = {
  resources: "ResourceFile",
  sponsors: "SponsorshipFile",
  posters: "PosterFile",
  notebook: "NotebookImage",
  strategy: "StrategyFile",
  logos: "SponsorshipLogo",
  "workshop-photos": "WorkshopPhoto",
  "workshop-files": "WorkshopFile",
};

/** A kind's table for raw SQL (a fixed identifier, never from input). */
export function fileTable(kind: FileKind): Prisma.Sql {
  return Prisma.raw(`"${FILE_TABLES[kind]}"`);
}

export interface StoredFileTotals {
  count: number;
  bytes: number;
}

/** How many files (and bytes, from the rows' sizes) are stored in Postgres and in Cloudflare R2, over every kind. */
export async function storedFileTotals(db: Tx): Promise<{ database: StoredFileTotals; objectStorage: StoredFileTotals }> {
  const database = { count: 0, bytes: 0 };
  const objectStorage = { count: 0, bytes: 0 };
  for (const kind of FILE_KINDS) {
    const rows = await db.$queryRaw<{ inR2: boolean; n: bigint | number; bytes: bigint | number | null }[]>`
      SELECT ("storageKey" IS NOT NULL) AS "inR2", count(*) AS n, sum("size") AS bytes FROM ${fileTable(kind)} GROUP BY 1`;
    for (const r of rows) {
      const into = r.inR2 ? objectStorage : database;
      into.count += Number(r.n);
      into.bytes += Number(r.bytes ?? 0);
    }
  }
  return { database, objectStorage };
}
