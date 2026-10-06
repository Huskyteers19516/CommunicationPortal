import "server-only";
// Members' photos for the team website's Our Team page (GET /api/public/team-photos, no sign-in) and the photos
// themselves (GET /api/public/team-photos/[id]). A photo is published while its owner is ACTIVE (any position:
// students, leaders, the captain, mentors, teachers) with "Show my photo on the team website" on, nobody who manages
// their account holds it off the website (queries/website-photo-holds.ts: a self-rename waiting for a check, a photo
// someone removed, or kept off), and the team shows photos (Admin → Team website, `showPhotos`, on by default). Each
// entry is a **key** — a hash of the person's normalized full name, never the name itself — and the photo's address:
// the website works out the same key for the names it already shows and matches them, so the JSON isn't a list of who
// is on the team. Never emails, positions, account ids, or anything else. See "Public API for the team website" in
// docs/CONVENTIONS.md.
import { createHash } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import {
  PUBLIC_TEAM_PHOTOS_MAX,
  type PublicTeamPhoto,
  type PublicTeamPhotosAnswer,
  publicTeamPhotoPath,
  TEAM_PHOTO_KEY_LENGTH,
  TEAM_PHOTO_KEY_PREFIX,
  teamPhotoNameKey,
} from "@/lib/user-photos";
import { type Db, prisma } from "../db";
import { STORED_FILE_SELECT, type StoredFileRow } from "../files/respond";
import { getPublicProgressConfig } from "./public-progress";
import { getWebsitePhotoHolds } from "./website-photo-holds";

/** Accounts whose photo may be on the website (holds and whether the team shows photos are checked separately). */
export const publicTeamPhotoUsersWhere = { status: "ACTIVE", showPhotoOnWebsite: true } satisfies Prisma.UserWhereInput;

/**
 * The key the public JSON lists a name under: the first TEAM_PHOTO_KEY_LENGTH hex characters of
 * SHA-256(TEAM_PHOTO_KEY_PREFIX + teamPhotoNameKey(name)) — the team website computes the same for its own names
 * (src/components/team/portal-photos.ts there). Null for a name that's empty once normalized.
 */
export function publicTeamPhotoKey(name: string): string | null {
  const normalized = teamPhotoNameKey(name);
  if (!normalized) return null;
  return createHash("sha256").update(TEAM_PHOTO_KEY_PREFIX + normalized, "utf8").digest("hex").slice(0, TEAM_PHOTO_KEY_LENGTH);
}

/** A published photo with whose it is (Admin → Approvals lists them; the JSON keeps only `key` and `photo`). */
export interface ListedTeamPhoto extends PublicTeamPhoto {
  userId: string;
  name: string;
  photoId: string;
  createdAt: Date;
}

/**
 * The photos the Our Team page may show — whether or not the team shows photos (the answer checks that; Admin → Team
 * website counts these and Approvals lists them). Left out: anyone held off the website, and a name two ACTIVE accounts
 * share as the website compares names (teamPhotoNameKey): matching by name could put one person's photo on the other's
 * card. Someone held because they renamed themselves counts under the name that was checked (`from`), so renaming to
 * someone else's name can't knock that person's photo off.
 */
export async function listPublishedTeamPhotos(db: Db): Promise<ListedTeamPhoto[]> {
  const holds = await getWebsitePhotoHolds(db);
  const rows = await db.userPhoto.findMany({
    where: { user: publicTeamPhotoUsersWhere, ...(holds.size > 0 ? { userId: { notIn: [...holds.keys()] } } : {}) },
    select: { id: true, userId: true, createdAt: true, user: { select: { name: true } } },
    orderBy: { id: "asc" },
    take: PUBLIC_TEAM_PHOTOS_MAX,
  });
  if (rows.length === 0) return [];
  const active = await db.user.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true } });
  const accountsByName = new Map<string, number>();
  for (const u of active) {
    const hold = holds.get(u.id);
    const key = teamPhotoNameKey(hold?.reason === "renamed" && hold.from !== undefined ? hold.from : u.name);
    accountsByName.set(key, (accountsByName.get(key) ?? 0) + 1);
  }
  const out: ListedTeamPhoto[] = [];
  for (const r of rows) {
    const key = publicTeamPhotoKey(r.user.name);
    if (!key || (accountsByName.get(teamPhotoNameKey(r.user.name)) ?? 0) > 1) continue;
    out.push({ key, photo: publicTeamPhotoPath(r.id), userId: r.userId, name: r.user.name, photoId: r.id, createdAt: r.createdAt });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.photo < b.photo ? -1 : 1));
}

/** The JSON's entries: only each photo's key and address. */
export async function listPublicTeamPhotos(db: Db): Promise<PublicTeamPhoto[]> {
  return (await listPublishedTeamPhotos(db)).map(({ key, photo }) => ({ key, photo }));
}

/** GET /api/public/team-photos: `{ enabled: false }` while the team doesn't show photos. */
export async function getPublicTeamPhotos(db: Db, options: { now: Date }): Promise<PublicTeamPhotosAnswer> {
  const { settings } = await getPublicProgressConfig(db);
  if (!settings.showPhotos) return { enabled: false };
  return { enabled: true, updatedAt: options.now.toISOString(), photos: await listPublicTeamPhotos(db) };
}

/**
 * One published photo with its bytes (GET /api/public/team-photos/[id]), or null: the team doesn't show photos, or
 * this one isn't published (replaced or removed, its owner turned the website switch off or isn't ACTIVE, or it's held
 * off the website). The settings, the holds, then one read with the checks in its WHERE.
 */
export async function getPublicTeamPhoto(db: Db, id: string): Promise<StoredFileRow | null> {
  if (!id || id.length > 64) return null;
  const { settings } = await getPublicProgressConfig(db);
  if (!settings.showPhotos) return null;
  const holds = await getWebsitePhotoHolds(db);
  return db.userPhoto.findFirst({
    where: { id, user: publicTeamPhotoUsersWhere, ...(holds.size > 0 ? { userId: { notIn: [...holds.keys()] } } : {}) },
    select: STORED_FILE_SELECT,
  });
}

/** Whether the team shows members' photos on the website right now (Settings → My photo says so). */
export async function publicTeamPhotosShown(db: Db = prisma): Promise<boolean> {
  return (await getPublicProgressConfig(db)).settings.showPhotos;
}

/** The name a public photo is served under: neutral (never the person's name or the uploaded file's). */
export function publicTeamPhotoFilename(file: Pick<StoredFileRow, "contentType">): string {
  const ext = file.contentType === "image/png" ? "png" : file.contentType === "image/webp" ? "webp" : "jpg";
  return `team-photo.${ext}`;
}
