import "server-only";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { env, R2_REQUIRED_VARS, type R2Status } from "../env";
import { countDueFileDeletions, countStuckFileDeletions } from "../files/object-store";
import { type FileStorageUsage, fileStorageUsage, type StoredFileTotals, storedFileTotals } from "../files/storage";
import { canAdminister, canManageFileStorage, canUseSponsorships } from "../permissions";

/**
 * How much of the team's file storage is used, and by what (Resources files, sponsor files, posters), for the
 * Admin page and the sponsor file card. Null for anyone who can't see either (and accounts that aren't active).
 * The cap follows where new files go (300 MB in Postgres, 8 GB with Cloudflare R2).
 */
export async function getFileStorageUsage(actor: Actor, db: Db = prisma): Promise<FileStorageUsage | null> {
  if (actor.status !== "ACTIVE" || !(canAdminister(actor) || canUseSponsorships(actor))) return null;
  return fileStorageUsage(db);
}

/** What only owners see on the storage card: the R2 settings' state and what the tools have to do. */
export interface FileStorageOwnerView {
  /** The R2_* settings: on, not set (off), some missing (partial), or set but unusable (invalid). */
  r2: R2Status["state"];
  /** What's wrong with the settings (variable names only, never values), or null. */
  r2Problem: string | null;
  /** Removed files whose R2 objects are waiting to be deleted (the automatic cleanups still try these). */
  waitingDeletions: number;
  /**
   * Waiting ones whose delete failed FILE_DELETION_MAX_AUTO_ATTEMPTS times: only tried again by Clean up.
   * Not part of `waitingDeletions`.
   */
  stuckDeletions: number;
}

export interface FileStorageOverview {
  usage: FileStorageUsage;
  /** Where new uploads go (everyone who sees the card). */
  location: "r2" | "database";
  inDatabase: StoredFileTotals;
  inObjectStorage: StoredFileTotals;
  /** The settings and the tools: owners only (canManageFileStorage), null for everyone else. */
  owner: FileStorageOwnerView | null;
}

function r2Problem(status: R2Status): string | null {
  if (status.state === "partial") {
    const names = status.missing.join(", ");
    return `Cloudflare R2 is only partly set up: ${names} ${status.missing.length === 1 ? "is" : "are"} missing in Vercel (all four of ${R2_REQUIRED_VARS.join(", ")} are needed). Until then, files stay in the database.`;
  }
  if (status.state === "invalid") return `Cloudflare R2 isn't used: ${status.problem} Until then, files stay in the database.`;
  return null;
}

/**
 * The Admin → Approvals storage card: usage against the current cap, where new files go, and how many files are in
 * each place, for everyone with admin access; plus the settings' state and what's waiting for owners (who get the
 * tools). Null for everyone else.
 */
export async function getFileStorageOverview(
  actor: Actor,
  db: Db = prisma,
  status: R2Status = env.r2Status,
): Promise<FileStorageOverview | null> {
  if (actor.status !== "ACTIVE" || !canAdminister(actor)) return null;
  const on = status.state === "on";
  const usage = await fileStorageUsage(db, on);
  const totals = await storedFileTotals(db);
  const overview: FileStorageOverview = {
    usage,
    location: on ? "r2" : "database",
    inDatabase: totals.database,
    inObjectStorage: totals.objectStorage,
    owner: null,
  };
  if (!canManageFileStorage(actor)) return overview;
  overview.owner = {
    r2: status.state,
    r2Problem: r2Problem(status),
    waitingDeletions: await countDueFileDeletions(db),
    stuckDeletions: await countStuckFileDeletions(db),
  };
  return overview;
}
