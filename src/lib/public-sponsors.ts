// The sponsors the team thanks on its website (huskyteers19516.github.io/sponsors), from GET /api/public/sponsors
// (src/app/api/public/sponsors/route.ts, built by src/server/queries/public-sponsors.ts). Client-safe: who's
// public, how sponsors are named and grouped, how a sponsor's year is worked out, the logo picker's checks, and the
// JSON's types. ("Logo needed" is worked out on the server: loadSponsorsNeedingLogo in queries/sponsorships.ts.)
//
// Only a sponsor's public name, website's homepage, years, and logo (without its metadata) ever leave the portal:
// never amounts, what we asked for, contacts, the person on it, notes, stages, or attached files.
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { LIMITS } from "./constants";
import { type DateOnly, dbToDateOnly, todayInTimezone } from "./dates";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "./files";
import { PUBLIC_SPONSOR_LOGOS_PREFIX } from "./public-api";
import { sponsorNameKey } from "./sponsorships";
import { parseHttpUrl } from "./urls";

/** Stages the team website thanks (when "Thank them on the team website" is on). */
export const PUBLIC_SPONSOR_STAGES: readonly SponsorshipStage[] = ["ACCEPTED", "FINISHED"];

/** Most sponsor rows one answer reads (newest first; a team has dozens). */
export const PUBLIC_SPONSORS_ROW_CAP = 1000;

/** On the team website now: Accepted or Finished, with "Thank them on the team website" on. */
export function isPublicSponsor(s: { stage: SponsorshipStage; showOnWebsite: boolean }): boolean {
  return s.showOnWebsite && PUBLIC_SPONSOR_STAGES.includes(s.stage);
}

/** The name the website shows: "Name on the website" when it's filled in, else the sponsor's name (spaces tidied). */
export function sponsorPublicName(s: { name: string; publicName: string }): string {
  const tidy = (v: string) => v.replace(/\s+/g, " ").trim();
  return tidy(s.publicName) || tidy(s.name);
}

/** How sponsors are grouped on the website: the public name, ignoring case and spacing. */
export function publicSponsorKey(s: { name: string; publicName: string }): string {
  return sponsorNameKey(sponsorPublicName(s));
}

/**
 * The year a sponsorship counts for: the year it was accepted, else submitted, else added (in the team's
 * timezone). Accepted / submitted are calendar days already.
 */
export function sponsorPublicYear(
  s: { acceptedOn: Date | DateOnly | null; submittedOn: Date | DateOnly | null; createdAt: Date },
  teamTimezone: string,
): number {
  const day = (v: Date | DateOnly | null): DateOnly | null => (v === null ? null : typeof v === "string" ? v : dbToDateOnly(v));
  const date = day(s.acceptedOn) ?? day(s.submittedOn) ?? todayInTimezone(teamTimezone, s.createdAt);
  return Number(date.slice(0, 4));
}

/**
 * The link the website shows for a sponsor: only the homepage of their http(s) website ("https://rev.example.com/"),
 * never its path, query, or #fragment — the Website field also holds application pages, and those can carry ids,
 * invite codes, or tokens. Null for anything that isn't an http(s) address (or has a user name or password in it).
 */
export function publicSponsorUrl(website: string): string | null {
  const href = parseHttpUrl(website);
  if (!href) return null;
  const { origin } = new URL(href);
  return origin && origin !== "null" ? `${origin}/` : null;
}

/**
 * Which spelling a group (the same public name, ignoring case and spacing) is shown with: the newest row's
 * (`namesNewestFirst`: every row's name, newest first) — unless it's all lower-case and another row's has capitals.
 * So a hasty "rev robotics" for a new year doesn't rename "REV Robotics", while a deliberate change to the capitals
 * on the newest row still shows.
 */
export function pickPublicSponsorName(namesNewestFirst: readonly string[]): string {
  const hasCapitals = (name: string) => name !== name.toLocaleLowerCase("en-US");
  return namesNewestFirst.find(hasCapitals) ?? namesNewestFirst[0] ?? "";
}

/** A logo's public address on this site (relative: the team website puts PUBLIC_PORTAL_URL in front). */
export function publicSponsorLogoPath(logoId: string): string {
  return `${PUBLIC_SPONSOR_LOGOS_PREFIX}${logoId}`;
}

// ── The JSON (GET /api/public/sponsors) ───────────────────────────────────────

export interface PublicSponsor {
  /** The public name (sponsors with the same one, ignoring case and spacing, are one entry). */
  name: string;
  /** Their website's homepage ("https://rev.example.com/": never a path, query, or #fragment), or null. */
  url: string | null;
  /** Every year they sponsored us, oldest first. */
  years: number[];
  /** "/api/public/sponsors/logos/<id>" (the newest logo of the group), or null. */
  logo: string | null;
}

export interface PublicSponsors {
  enabled: true;
  updatedAt: string;
  /** Latest year first, then by name. */
  sponsors: PublicSponsor[];
}

export type PublicSponsorsAnswer = PublicSponsors | { enabled: false };

// ── Logo files ───────────────────────────────────────────────────────────────

/** What the logo picker offers (no SVG: it can carry script). */
export const SPONSOR_LOGO_ACCEPT = "image/png,image/jpeg,image/webp";
export const SPONSOR_LOGO_TYPES_MESSAGE = "Logos can be a PNG, JPG, or WebP picture. Save it as one of those (not SVG or PDF) and try again.";
export const SPONSOR_LOGO_UNREADABLE_MESSAGE = "That picture couldn't be opened. Save it again as a PNG and try again.";

const LOGO_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);
const LOGO_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Whether a picked file says it's a PNG, JPG, or WebP (by its name or the browser's type) — not what it really is. */
export function claimsSponsorLogoType(file: { name: string; type: string }): boolean {
  return LOGO_EXTENSIONS.has(extensionOf(file.name)) || LOGO_TYPES.has(file.type.toLowerCase().split(";")[0].trim());
}

const LOGO_FILE_EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * The name a public logo is served under (Content-Disposition): "<public name>-logo.<ext>" in plain lower-case ASCII
 * ("rev-robotics-logo.png"), never the name it was uploaded with (which can hold someone's name or folders).
 */
export function publicSponsorLogoFilename(publicName: string, contentType: string): string {
  const slug = publicName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  const ext = LOGO_FILE_EXTENSIONS[contentType.toLowerCase().split(";")[0].trim()] ?? "png";
  return `${slug || "sponsor"}-logo.${ext}`;
}

/** e.g. "That file is 5.2 MB. Logos can be up to 4 MB — …" */
export function sponsorLogoTooBigMessage(size: number): string {
  return `That file is ${formatFileSize(size)}. Logos can be up to ${RESOURCE_FILE_MAX_MB} MB — save a smaller PNG or JPG and try again.`;
}

/** e.g. "That picture is 30,000 × 30,000 pixels — far bigger than a logo needs. …" (POSTER_IMAGE_MAX_SIDE / _PIXELS). */
export function sponsorLogoTooLargeMessage(width: number, height: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `That picture is ${n(width)} × ${n(height)} pixels — far bigger than a logo needs. Save a smaller copy (about 1,000 pixels across) and try again.`;
}

/** The problem with a picked logo, checked in the browser before it's sent; null when it looks fine. The server checks the contents. */
export function sponsorLogoProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty. Choose another one.";
  if (file.size > LIMITS.resourceFileMaxBytes) return sponsorLogoTooBigMessage(file.size);
  return claimsSponsorLogoType(file) ? null : SPONSOR_LOGO_TYPES_MESSAGE;
}
