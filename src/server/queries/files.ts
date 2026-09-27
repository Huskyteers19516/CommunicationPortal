import "server-only";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { type FileStorageUsage, fileStorageUsage } from "../files/storage";
import { canAdminister, canUseSponsorships } from "../permissions";

/**
 * How much of the team's file storage is used, and by what (Resources files, sponsor files, posters), for the
 * Admin page and the sponsor file card. Null for anyone who can't see either (and accounts that aren't active).
 */
export async function getFileStorageUsage(actor: Actor, db: Db = prisma): Promise<FileStorageUsage | null> {
  if (actor.status !== "ACTIVE" || !(canAdminister(actor) || canUseSponsorships(actor))) return null;
  return fileStorageUsage(db);
}
