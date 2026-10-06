import "server-only";
// Members' own photos in the portal (src/server/services/user-photos.ts writes them):
// - getPortalPhotoMap(): who shows a photo on their name — ACTIVE accounts with a photo and "Show my photo in the
//   portal" on — as Map<userId, photoId>. One small read per page render (React cache()), used by the server avatar
//   (src/components/app/user-avatar.tsx); pages hand photo ids to client components (photoIdsFor) instead of every
//   query joining the photo.
// - getUserPhotoFile(): the signed-in route /people/photos/[id] (any ACTIVE viewer, while the owner is ACTIVE and shows
//   it in the portal; the owner themselves always — their Settings preview — and people who manage their account, who
//   decide what goes on the website).
// - getMyPhoto(): Settings → My photo. getManagedUserPhoto() / getManagedWebsitePhotoHold(): Admin → People → a person
//   (to remove it, keep it off the website, or allow it). getWebsitePhotoReview(): Admin → Approvals → Members' photos
//   (who's held off the website, and new photos on it).
import { cache } from "react";
import type { Prisma } from "@/generated/prisma/client";
import { portalPhotoPath, WEBSITE_PHOTO_RECENT_DAYS, type WebsitePhotoHold } from "@/lib/user-photos";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { STORED_FILE_SELECT, type StoredFileRow } from "../files/respond";
import { canAdminister, canManageAccount, canManagePublicProgress, isOwner } from "../permissions";
import { getPublicProgressConfig } from "./public-progress";
import { listPublishedTeamPhotos } from "./public-team-photos";
import { getWebsitePhotoHold, getWebsitePhotoHolds } from "./website-photo-holds";

/** Accounts whose photo shows on their name in the portal (they also need a photo). */
export const portalPhotoUsersWhere = { status: "ACTIVE", showPhotoInPortal: true } satisfies Prisma.UserWhereInput;

/** More than the team will ever have; a safety cap on the one read. */
const PORTAL_PHOTOS_MAX = 2000;

/** Who shows a photo in the portal: user id → photo id. */
export async function portalPhotoMap(db: Db): Promise<Map<string, string>> {
  const rows = await db.userPhoto.findMany({
    where: { user: portalPhotoUsersWhere },
    select: { id: true, userId: true },
    take: PORTAL_PHOTOS_MAX,
  });
  return new Map(rows.map((r) => [r.userId, r.id]));
}

/** portalPhotoMap for this page render (one read however many avatars it draws). */
export const getPortalPhotoMap = cache((): Promise<Map<string, string>> => portalPhotoMap(prisma));

/** The photo ids of these people (only those who show one), for a client component's props. */
export function photoIdsFor(map: Map<string, string>, userIds: Iterable<string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of userIds) {
    const photo = id ? map.get(id) : undefined;
    if (id && photo) out[id] = photo;
  }
  return out;
}

/**
 * A photo's bytes for the signed-in route, or null (missing, replaced, or not this viewer's to see): an ACTIVE viewer
 * sees it while its owner is ACTIVE with "Show my photo in the portal" on; the owner always (Settings shows it even
 * while it's off in the portal); and people who manage the owner's account (Admin → People and Approvals: they decide
 * what goes on the public website, so they see it even while it's hidden in the portal — Settings says so).
 */
export async function getUserPhotoFile(viewer: Actor, photoId: string, db: Db = prisma): Promise<StoredFileRow | null> {
  if (viewer.status !== "ACTIVE" || !photoId || photoId.length > 64) return null;
  const shown = await db.userPhoto.findFirst({
    where: { id: photoId, OR: [{ userId: viewer.id }, { user: portalPhotoUsersWhere }] },
    select: STORED_FILE_SELECT,
  });
  if (shown || !canAdminister(viewer)) return shown;
  const row = await db.userPhoto.findUnique({
    where: { id: photoId },
    select: { ...STORED_FILE_SELECT, user: { select: { id: true, role: true, status: true, isAdmin: true } } },
  });
  if (!row || !canManageAccount(viewer, row.user)) return null;
  return { filename: row.filename, contentType: row.contentType, size: row.size, data: row.data, storageKey: row.storageKey };
}

export interface MyPhoto {
  /** Null: no photo yet. */
  photo: { id: string; src: string; width: number | null; height: number | null; size: number; createdAt: Date } | null;
  showPhotoInPortal: boolean;
  showPhotoOnWebsite: boolean;
  /** Held off the team website by someone who manages the account (or after a rename), whatever the switch says. */
  websiteHold: WebsitePhotoHold | null;
}

/** Settings → My photo: your photo (if any), its two switches, and any hold. Null for an account that isn't ACTIVE. */
export async function getMyPhoto(actor: Pick<Actor, "id" | "status">, db: Db = prisma): Promise<MyPhoto | null> {
  if (actor.status !== "ACTIVE") return null;
  const row = await db.user.findUnique({
    where: { id: actor.id },
    select: {
      showPhotoInPortal: true,
      showPhotoOnWebsite: true,
      photo: { select: { id: true, width: true, height: true, size: true, createdAt: true } },
    },
  });
  if (!row) return null;
  return {
    photo: row.photo ? { ...row.photo, src: portalPhotoPath(row.photo.id) } : null,
    showPhotoInPortal: row.showPhotoInPortal,
    showPhotoOnWebsite: row.showPhotoOnWebsite,
    websiteHold: await getWebsitePhotoHold(actor.id, db),
  };
}

export interface ManagedUserPhoto {
  id: string;
  src: string;
  createdAt: Date;
  showPhotoInPortal: boolean;
  showPhotoOnWebsite: boolean;
}

/** Admin → People → a person: their photo, for people who manage their account (to remove it); else null. */
export async function getManagedUserPhoto(actor: Actor, userId: string, db: Db = prisma): Promise<ManagedUserPhoto | null> {
  if (actor.status !== "ACTIVE" || !userId || userId.length > 64) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      status: true,
      isAdmin: true,
      showPhotoInPortal: true,
      showPhotoOnWebsite: true,
      photo: { select: { id: true, createdAt: true } },
    },
  });
  if (!user?.photo || !canManageAccount(actor, user)) return null;
  return {
    id: user.photo.id,
    src: portalPhotoPath(user.photo.id),
    createdAt: user.photo.createdAt,
    showPhotoInPortal: user.showPhotoInPortal,
    showPhotoOnWebsite: user.showPhotoOnWebsite,
  };
}

export interface ManagedWebsitePhotoHold {
  hold: WebsitePhotoHold | null;
  /** Whether this viewer may keep it off / allow it (never their own unless they're an owner). */
  canChange: boolean;
}

/**
 * Admin → People → a person: whether their photo is held off the team website, for people who manage their account
 * (whether or not they have a photo: a hold can be set before one is uploaded); else null.
 */
export async function getManagedWebsitePhotoHold(actor: Actor, userId: string, db: Db = prisma): Promise<ManagedWebsitePhotoHold | null> {
  if (actor.status !== "ACTIVE" || !userId || userId.length > 64) return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true, isAdmin: true } });
  if (!user || !canManageAccount(actor, user)) return null;
  return { hold: await getWebsitePhotoHold(userId, db), canChange: user.id !== actor.id || isOwner(actor) };
}

export interface WebsitePhotoReviewItem {
  userId: string;
  name: string;
  /** For the avatar: their photo when this viewer may see it in the portal (else initials). */
  photoId: string | null;
  /** When the photo was uploaded. */
  uploadedAt: Date;
  /** `held` only. */
  hold: WebsitePhotoHold | null;
  /** Whether this viewer manages their account (links to Admin → People → them). */
  canManage: boolean;
}

export interface WebsitePhotoReview {
  /** Admin → Team website's "Show members' photos" (off: nothing is public whatever's listed here). */
  showPhotos: boolean;
  /** People with a photo held off the website (a new name waiting for a check first), oldest first. */
  held: WebsitePhotoReviewItem[];
  /** Photos that went on the website in the last WEBSITE_PHOTO_RECENT_DAYS days, newest first. */
  recent: WebsitePhotoReviewItem[];
}

const REVIEW_MAX = 30;

/**
 * Admin → Approvals → Members' photos (everyone with admin access): photos go on the public website on their own, so
 * this shows who's waiting (a member renamed themselves: check the new name, then allow it on their page), who's kept
 * off, and every photo that went up in the last week (to catch a picture that shouldn't be there). Null for everyone
 * else.
 */
export async function getWebsitePhotoReview(actor: Actor, now: Date, db: Db = prisma): Promise<WebsitePhotoReview | null> {
  if (actor.status !== "ACTIVE" || !canManagePublicProgress(actor)) return null;
  const { settings } = await getPublicProgressConfig(db);
  const holds = await getWebsitePhotoHolds(db);
  const userSelect = { id: true, name: true, role: true, status: true, isAdmin: true, showPhotoInPortal: true } as const;
  const item = (
    u: Prisma.UserGetPayload<{ select: typeof userSelect }>,
    photo: { id: string; createdAt: Date },
    hold: WebsitePhotoHold | null,
  ): WebsitePhotoReviewItem => {
    const canManage = canManageAccount(actor, u);
    return {
      userId: u.id,
      name: u.name,
      photoId: u.showPhotoInPortal || canManage ? photo.id : null,
      uploadedAt: photo.createdAt,
      hold,
      canManage,
    };
  };

  const heldRows =
    holds.size === 0
      ? []
      : await db.userPhoto.findMany({
          where: { userId: { in: [...holds.keys()] }, user: { status: "ACTIVE" } },
          select: { id: true, createdAt: true, user: { select: userSelect } },
          take: REVIEW_MAX,
        });
  const held = heldRows
    .map((r) => item(r.user, r, holds.get(r.user.id) ?? null))
    .sort((a, b) => (a.hold?.at ?? "").localeCompare(b.hold?.at ?? ""));

  const since = new Date(now.getTime() - WEBSITE_PHOTO_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const published = (await listPublishedTeamPhotos(db)).filter((p) => p.createdAt >= since);
  const users = published.length
    ? await db.user.findMany({ where: { id: { in: published.map((p) => p.userId) } }, select: userSelect })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const recent = published
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, REVIEW_MAX)
    .flatMap((p) => {
      const u = byId.get(p.userId);
      return u ? [item(u, { id: p.photoId, createdAt: p.createdAt }, null)] : [];
    });
  return { showPhotos: settings.showPhotos, held, recent };
}
