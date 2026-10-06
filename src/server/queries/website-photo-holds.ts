import "server-only";
// Holds that keep a member's photo off the team website until someone who manages their account allows it (whatever
// their own "Show my photo on the team website" switch says) — WebsitePhotoHold in src/lib/user-photos.ts:
// - `renamed`: they changed their own name in Settings (the website matches photos by name, so a new name is checked
//   first — otherwise anyone could rename themselves to put a picture on someone else's card);
// - `removed`: someone who manages their account removed their photo (so a new upload doesn't go straight back up);
// - `kept-off`: someone who manages their account keeps it off (e.g. no photo release).
// One TeamNote row per held account, key `website-photo-hold:<userId>`, body the hold as JSON (no schema change; rows
// are written and deleted whole, so two writers never merge into one body). Written by src/server/services/user-photos.ts
// and services/settings.ts (a rename); read by the public JSON and photo route, Settings, and Admin.
import type { WebsitePhotoHold, WebsitePhotoHoldReason } from "@/lib/user-photos";
import { type Db, prisma } from "../db";

export const WEBSITE_PHOTO_HOLD_PREFIX = "website-photo-hold:";

/** The TeamNote key of an account's hold. */
export function websitePhotoHoldKey(userId: string): string {
  return `${WEBSITE_PHOTO_HOLD_PREFIX}${userId}`;
}

const REASONS: ReadonlySet<string> = new Set<WebsitePhotoHoldReason>(["renamed", "removed", "kept-off"]);
const text = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/**
 * A stored hold, or null for nothing stored. A body that can't be read still holds (`kept-off`): a row exists only
 * because someone meant to keep the photo off, so a damaged one never lets it out.
 */
export function parseWebsitePhotoHold(body: string | null | undefined): WebsitePhotoHold | null {
  if (body === null || body === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    raw = null;
  }
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const reason = typeof r.reason === "string" && REASONS.has(r.reason) ? (r.reason as WebsitePhotoHoldReason) : "kept-off";
  const at = text(r.at, 40) ?? new Date(0).toISOString();
  const hold: WebsitePhotoHold = { reason, at };
  const from = text(r.from);
  const byName = text(r.byName);
  if (reason === "renamed" && from !== undefined) hold.from = from;
  if (reason !== "renamed" && byName !== undefined) hold.byName = byName;
  return hold;
}

export function serializeWebsitePhotoHold(hold: WebsitePhotoHold): string {
  return JSON.stringify(hold);
}

/** Every hold, by account id (one read; the team has a few dozen people). */
export async function getWebsitePhotoHolds(db: Db = prisma): Promise<Map<string, WebsitePhotoHold>> {
  const rows = await db.teamNote.findMany({
    where: { key: { startsWith: WEBSITE_PHOTO_HOLD_PREFIX } },
    select: { key: true, body: true },
    take: 5000,
  });
  const out = new Map<string, WebsitePhotoHold>();
  for (const row of rows) {
    const hold = parseWebsitePhotoHold(row.body);
    if (hold) out.set(row.key.slice(WEBSITE_PHOTO_HOLD_PREFIX.length), hold);
  }
  return out;
}

/** One account's hold, or null. */
export async function getWebsitePhotoHold(userId: string, db: Db = prisma): Promise<WebsitePhotoHold | null> {
  const row = await db.teamNote.findUnique({ where: { key: websitePhotoHoldKey(userId) }, select: { body: true } });
  return parseWebsitePhotoHold(row?.body);
}
