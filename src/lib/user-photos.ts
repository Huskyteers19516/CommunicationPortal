// Members' own photos (client-safe): Settings → My photo. Each ACTIVE person can upload one square photo of
// themselves (UserPhoto, one per account). It's shown on their name around the portal while "Show my photo in the
// portal" is on (else everyone sees their initials), and on the team website's Our Team page while "Show my photo on
// the team website" is on (on by default — the site is public) and the team shows photos (Admin → Team website).
// The browser crops a picked picture to a centered square (zoom and move it if you like) and makes it a
// USER_PHOTO_SIDE × USER_PHOTO_SIDE JPG before it's sent; the server checks it like posters, with tighter limits of its
// own (src/server/services/user-photos.ts). The public JSON's shape is here too (GET /api/public/team-photos), and the
// holds that keep a photo off the website until someone who manages the account allows it (WebsitePhotoHold).
import { formatFileSize } from "./files";
import { POSTER_HEIC_MESSAGE } from "./posters";
import { PUBLIC_TEAM_PHOTOS_PREFIX } from "./public-api";

/** The square the browser makes (pixels a side): sharp on the website's cards, ~50 KB as a JPG. */
export const USER_PHOTO_SIDE = 512;
/** The JPG quality the browser saves it with. */
export const USER_PHOTO_QUALITY = 0.86;
/** How far the photo can be zoomed in, in the cropper (1 = the whole short side). */
export const USER_PHOTO_MAX_ZOOM = 4;

/** What the file picker offers (iPhones then hand over a JPG instead of a HEIC photo). */
export const USER_PHOTO_ACCEPT = "image/png,image/jpeg,image/webp";
const PHOTO_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);
const PHOTO_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/**
 * The most a photo may be, in bytes. The browser's 512 × 512 JPG is about 30–80 KB, so only a request made by hand
 * comes near it — and every avatar in the portal and on the public website downloads the photo.
 */
export const USER_PHOTO_MAX_BYTES = 1024 * 1024;
/**
 * The most pixels a photo may have a side (the browser sends USER_PHOTO_SIDE). Every avatar decodes the whole picture,
 * so a huge one (7,000 × 7,000 is ~200 MB once decoded) could blank or crash phones' tabs, on the public site too.
 */
export const USER_PHOTO_MAX_DIMENSION = 1024;

/** Uploads and removals per person per hour (the switches aren't limited). */
export const USER_PHOTO_CHANGES_PER_HOUR = 20;
export const USER_PHOTO_RATE_LIMITED_MESSAGE = `You've changed your photo ${USER_PHOTO_CHANGES_PER_HOUR} times in the last hour, the most there can be. Try again later.`;

export const USER_PHOTO_TYPES_MESSAGE = "Your photo can be a PNG, JPG, or WebP picture.";
/** iPhone photos (HEIC): browsers can't show them. */
export const USER_PHOTO_HEIC_MESSAGE = POSTER_HEIC_MESSAGE;
export const USER_PHOTO_UNREADABLE_MESSAGE = "That picture couldn't be opened. Save it again as a JPG or PNG and try again.";
/** Animated PNGs and WebPs: an avatar is a still photo. */
export const USER_PHOTO_ANIMATED_MESSAGE = "Your photo has to be a still picture, not an animation. Pick a PNG, JPG, or WebP photo.";

export function userPhotoTooBigMessage(size: number): string {
  return `That photo is ${formatFileSize(size)}. Photos can be up to ${USER_PHOTO_MAX_BYTES / (1024 * 1024)} MB — pick a smaller one.`;
}

/** e.g. "That picture is 7,000 × 7,000 pixels. Photos can be up to 1,024 pixels a side — pick a smaller one." */
export function userPhotoTooLargeMessage(width: number, height: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `That picture is ${n(width)} × ${n(height)} pixels. Photos can be up to ${n(USER_PHOTO_MAX_DIMENSION)} pixels a side — pick a smaller one.`;
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * The problem with a picked file before the browser even tries to read it (empty, HEIC, not a PNG/JPG/WebP by its
 * name or type), or null. Size isn't checked here: the browser makes it small before sending.
 */
export function userPhotoProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty. Choose another one.";
  const ext = extensionOf(file.name);
  const type = file.type.toLowerCase();
  if (ext === "heic" || ext === "heif" || type === "image/heic" || type === "image/heif") return USER_PHOTO_HEIC_MESSAGE;
  if (!PHOTO_EXTENSIONS.has(ext) && !PHOTO_TYPES.has(type)) return USER_PHOTO_TYPES_MESSAGE;
  return null;
}

/** Whether a made photo fits the upload limit (it always should: a 512 × 512 JPG is far smaller). */
export function userPhotoFits(size: number): boolean {
  return size > 0 && size <= USER_PHOTO_MAX_BYTES;
}

/** The signed-in address of a photo in the portal (src/app/(app)/people/photos/[id]/route.ts). */
export function portalPhotoPath(photoId: string): string {
  return `/people/photos/${photoId}`;
}

// ── Cropping (the Settings card's preview and the photo it sends) ───────────────────────────────────────────────

/** Where the square is: `zoom` ≥ 1 (1 = the whole short side), and its center as a share (0–1) of the width/height. */
export interface PhotoCrop {
  zoom: number;
  x: number;
  y: number;
}

export const CENTERED_CROP: PhotoCrop = { zoom: 1, x: 0.5, y: 0.5 };

/**
 * The square to cut out of a `width` × `height` picture for `crop`, in the picture's pixels: side = the short side
 * divided by the zoom, centered where the crop says but always inside the picture.
 */
export function photoCropRect(width: number, height: number, crop: PhotoCrop): { sx: number; sy: number; side: number } {
  const zoom = Math.min(USER_PHOTO_MAX_ZOOM, Math.max(1, Number.isFinite(crop.zoom) ? crop.zoom : 1));
  const side = Math.min(width, height) / zoom;
  const cx = (Number.isFinite(crop.x) ? crop.x : 0.5) * width;
  const cy = (Number.isFinite(crop.y) ? crop.y : 0.5) * height;
  const sx = Math.min(Math.max(cx - side / 2, 0), width - side);
  const sy = Math.min(Math.max(cy - side / 2, 0), height - side);
  return { sx, sy, side };
}

/** `crop` with its center pulled back so the square stays inside the picture (what photoCropRect would cut). */
export function clampPhotoCrop(width: number, height: number, crop: PhotoCrop): PhotoCrop {
  const { sx, sy, side } = photoCropRect(width, height, crop);
  const zoom = Math.min(width, height) / side;
  return { zoom, x: (sx + side / 2) / width, y: (sy + side / 2) / height };
}

/**
 * The crop moved by (dx, dy) pixels of a preview `previewSide` pixels wide (dragging the picture right shows more of
 * its left side), kept inside the picture.
 */
export function movePhotoCrop(width: number, height: number, crop: PhotoCrop, dx: number, dy: number, previewSide: number): PhotoCrop {
  const { side } = photoCropRect(width, height, crop);
  const scale = side / Math.max(1, previewSide);
  return clampPhotoCrop(width, height, { ...crop, x: crop.x - (dx * scale) / width, y: crop.y - (dy * scale) / height });
}

// ── The public JSON (GET /api/public/team-photos) ───────────────────────────────────────────────────────────────

/** Most photos in the answer (the team is ~40). */
export const PUBLIC_TEAM_PHOTOS_MAX = 300;

export interface PublicTeamPhoto {
  /**
   * Whose photo it is, without saying the name: the first TEAM_PHOTO_KEY_LENGTH hex characters of
   * SHA-256(TEAM_PHOTO_KEY_PREFIX + teamPhotoNameKey(full name)). The website works out the same key for each name it
   * already shows (its Our Team cards, the progress page's people) and matches them; the JSON itself never lists who is
   * on the team.
   */
  key: string;
  /** `/api/public/team-photos/<id>`, relative to the portal (the website puts its PUBLIC_PORTAL_URL in front). */
  photo: string;
}

export interface PublicTeamPhotos {
  enabled: true;
  updatedAt: string;
  /** By key. */
  photos: PublicTeamPhoto[];
}

/** `{ enabled: false }` while the team doesn't show members' photos (Admin → Team website). */
export type PublicTeamPhotosAnswer = PublicTeamPhotos | { enabled: false };

/** The public address of a published photo (relative to the portal). */
export function publicTeamPhotoPath(photoId: string): string {
  return `${PUBLIC_TEAM_PHOTOS_PREFIX}${photoId}`;
}

/** What's hashed in front of a name for its key (so the keys aren't plain SHA-256 of names). */
export const TEAM_PHOTO_KEY_PREFIX = "huskyteers-team-photo-v1:";
/** Hex characters of the hash kept (128 bits). */
export const TEAM_PHOTO_KEY_LENGTH = 32;
export const TEAM_PHOTO_KEY_RE = /^[0-9a-f]{32}$/;

const APOSTROPHES = /[‘’ʼ`´]/g;

/**
 * A name the way the team website compares names (`normalizeName` in its src/components/team/roster.ts — keep the two
 * identical): Unicode NFKD, accents removed, curly apostrophes straightened, lower-case, runs of spaces made one.
 * "José  O’Neil" → "jose o'neil". Two accounts with the same key are the same name to the website.
 */
export function teamPhotoNameKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(APOSTROPHES, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// ── Holds: kept off the website until someone who manages the account allows it ───────────────────────────────

/**
 * Why a photo is held off the team website (whatever the person's own switch says):
 * - `renamed`: they changed their own name in Settings. The website matches photos by name, so a new name waits for
 *   someone who manages their account to check it (`from` = the name before). Changing it back lifts it.
 * - `removed`: someone who manages their account removed their photo; a new one stays off the website until allowed.
 * - `kept-off`: someone who manages their account keeps it off (e.g. no photo release).
 */
export type WebsitePhotoHoldReason = "renamed" | "removed" | "kept-off";

export interface WebsitePhotoHold {
  reason: WebsitePhotoHoldReason;
  /** When (ISO). */
  at: string;
  /** `renamed`: the name before (the one that was checked). */
  from?: string;
  /** `removed` / `kept-off`: who did it (their name then). */
  byName?: string;
}

/** Admin → Approvals → Members' photos lists the photos that went on the website in this many days. */
export const WEBSITE_PHOTO_RECENT_DAYS = 7;

/** What Settings → My photo says about a hold (to the person themselves). */
export function websitePhotoHoldSentence(hold: WebsitePhotoHold): string {
  switch (hold.reason) {
    case "renamed":
      return "Your photo is off the team website until a leader, the captain, a mentor, or a teacher checks your new name (the website finds photos by name).";
    case "removed":
      return "Someone who manages your account removed your photo, so a new one stays off the team website until they allow it.";
    case "kept-off":
      return "Someone who manages your account is keeping your photo off the team website.";
  }
}
