// Website Coding (Admin → Website Coding): the team website's text, links, and pictures that admins change from the
// portal, with no rebuild of the site. Client-safe: the slot keys' rule, the link rule, the limits, the public JSON's
// types (GET /api/public/site-content, built by src/server/queries/site-content.ts), and the editor's postMessage
// protocol with the website (src/components/admin/website-editor/*). The website's side lives in its own repo
// (src/lib/site-content.ts and src/components/site-content/SiteContent.astro there) — keep the two in step.
//
// A "slot" is one editable thing on the website, marked there with data-edit-text / data-edit-link / data-edit-image
// = "<key>". What the website's own code says is the default; a saved value (SiteContent row) replaces it, and
// "Reset to original" deletes the saved value again.
import type { SiteContentKind } from "@/generated/prisma/enums";
import { LIMITS } from "./constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "./files";
import { PUBLIC_SITE_IMAGES_PREFIX } from "./public-api";

/** Slot keys: lower-case words joined by "." or "-", e.g. "season.2025-2026.team-photo". */
export const SITE_KEY_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const SITE_KEY_MAX = 120;
/** A text slot's most characters (plain text, never HTML). */
export const SITE_TEXT_MAX = 5000;
/** A link slot's longest address. */
export const SITE_LINK_MAX = 2000;
/** A picture's description (alt text). */
export const SITE_ALT_MAX = 300;
/** Most saved values at once (the website has a few hundred slots). */
export const SITE_CONTENT_MAX_ROWS = 3000;
/** Pictures kept per slot (the one shown plus earlier ones, so a change can be undone); older ones are deleted. */
export const SITE_IMAGES_KEPT_PER_SLOT = 5;
/** A picture's longest side in pixels (the browser makes bigger photos smaller before uploading). */
export const SITE_IMAGE_MAX_SIDE = 8000;
/** How many changes "Recent changes" lists. */
export const SITE_EDITS_SHOWN = 100;

export type SiteSlotKind = "text" | "link" | "image";
export const SITE_SLOT_KINDS: readonly SiteSlotKind[] = ["text", "link", "image"];

export const SITE_KIND_TO_DB: Record<SiteSlotKind, SiteContentKind> = { text: "TEXT", link: "LINK", image: "IMAGE" };
export const SITE_KIND_FROM_DB: Record<SiteContentKind, SiteSlotKind> = { TEXT: "text", LINK: "link", IMAGE: "image" };

/** A well-formed slot key. */
export function isSiteKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= SITE_KEY_MAX && SITE_KEY_RE.test(value);
}

export const SITE_KEY_INVALID = "That isn't one of the website's editable spots. Reload the editor and try again.";
export const SITE_LINK_INVALID =
  "Use a full web address (https://…), an email link (mailto:…), or a page on the team website starting with / (like /events).";
export const SITE_TEXT_EMPTY = "Type some text, or use “Reset to original” to go back to the website's own text.";

// Whitespace and control characters never belong in an address.
const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f-\u009f]/;

/**
 * A link that's safe to put in an href, else null — exactly the website's own rule (safeLink there):
 *   - https://… or http://… (no user:password@, with a host), normalised;
 *   - mailto:…;
 *   - a page on the website starting with exactly one "/" ("/events", "/about/team#mentors").
 * Never javascript:, data:, "//host" or "/\host" (protocol-relative), relative paths, spaces, or control characters.
 */
export function parseSiteLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > SITE_LINK_MAX || UNSAFE_URL_CHARS.test(raw)) return null;
  if (raw.startsWith("/")) {
    if (raw[1] === "/" || raw[1] === "\\" || raw.includes("\\")) return null;
    return raw;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    if (url.username || url.password || !url.hostname || !/^https?:\/\//i.test(raw)) return null;
    return url.href.length <= SITE_LINK_MAX ? url.href : null;
  }
  if (url.protocol === "mailto:") return /^mailto:[^/]/i.test(raw) ? raw : null;
  return null;
}

// Control characters other than line breaks and tabs (a NUL can't even be stored).
const TEXT_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Text as it's saved: "\n" line breaks, no control characters, trimmed. */
export function cleanSiteText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(TEXT_CONTROL_CHARS, "").trim();
}

/** A picture's public address on this site (relative: the website puts its PUBLIC_PORTAL_URL in front). */
export function publicSiteImagePath(imageId: string): string {
  return `${PUBLIC_SITE_IMAGES_PREFIX}${imageId}`;
}

// ── The JSON (GET /api/public/site-content) ──────────────────────────────────

export interface PublicSiteImage {
  /** "/api/public/site-images/<id>" (relative to the portal). */
  src: string;
  alt: string;
  /** The picture's size in pixels as it's shown (both or neither). */
  width?: number;
  height?: number;
}

export interface PublicSiteContent {
  enabled: true;
  updatedAt: string;
  /** Saved text per slot key (plain text). */
  texts: Record<string, string>;
  /** Saved addresses per slot key (parseSiteLink). */
  links: Record<string, string>;
  /** Saved pictures per slot key. */
  images: Record<string, PublicSiteImage>;
}

/** `{ enabled: false }` is allowed for parity with the other feeds; the portal always answers enabled. */
export type PublicSiteContentAnswer = PublicSiteContent | { enabled: false };

// ── Pictures ─────────────────────────────────────────────────────────────────

export const SITE_IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";
export const SITE_IMAGE_TYPES_MESSAGE = "Pictures can be a PNG, JPG, or WebP. Save it as one of those (not HEIC, SVG, GIF, or PDF) and try again.";
export const SITE_IMAGE_UNREADABLE_MESSAGE = "That picture couldn't be opened. Save it again as a JPG or PNG and try again.";
export const SITE_IMAGE_ANIMATED_MESSAGE = "Moving pictures can't go on the website here. Choose a still picture.";
export const SITE_IMAGE_NEEDS_FILE = "Choose a picture to upload.";

/** e.g. "That file is 5.2 MB. Pictures can be up to 4 MB — …" */
export function siteImageTooBigMessage(size: number): string {
  return `That file is ${formatFileSize(size)}. Pictures can be up to ${RESOURCE_FILE_MAX_MB} MB — save a smaller JPG and try again.`;
}

/** e.g. "That picture is 12,000 × 9,000 pixels — …" */
export function siteImageTooLargeMessage(width: number, height: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `That picture is ${n(width)} × ${n(height)} pixels — far bigger than a web page needs. Save a smaller copy (about 2,000 pixels across) and try again.`;
}

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);
const IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/** Whether a picked file says it's a PNG, JPG, or WebP (by its name or the browser's type) — not what it really is. */
export function claimsSiteImageType(file: { name: string; type: string }): boolean {
  const base = file.name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return IMAGE_EXTENSIONS.has(ext) || IMAGE_TYPES.has(file.type.toLowerCase().split(";")[0].trim());
}

/** The problem with a picked picture, checked in the browser before it's sent (after shrinking); null when fine. */
export function siteImageProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty. Choose another one.";
  if (!claimsSiteImageType(file)) return SITE_IMAGE_TYPES_MESSAGE;
  if (file.size > LIMITS.resourceFileMaxBytes) return siteImageTooBigMessage(file.size);
  return null;
}

// ── The editor (Admin → Website Coding) ──────────────────────────────────────

/** The pages offered in the editor's page menu (any other page can be reached by clicking links inside it). */
export const SITE_EDITOR_PAGES: readonly { path: string; label: string }[] = [
  { path: "/", label: "Home" },
  { path: "/about/team", label: "About — Our team" },
  { path: "/about/ftc", label: "About — What is FTC?" },
  { path: "/about/mentors", label: "About — Mentors" },
  { path: "/progress", label: "Progress" },
  { path: "/workshop", label: "Workshop" },
  { path: "/events", label: "Events" },
  { path: "/contact", label: "Contact" },
  { path: "/sponsors", label: "Sponsors" },
  { path: "/seasons/2021-2022", label: "Season 2021–2022" },
  { path: "/seasons/2022-2023", label: "Season 2022–2023" },
  { path: "/seasons/2023-2024", label: "Season 2023–2024" },
  { path: "/seasons/2024-2025", label: "Season 2024–2025" },
  { path: "/seasons/2025-2026", label: "Season 2025–2026" },
  { path: "/seasons/2026-2027", label: "Season 2026–2027" },
];

/** One editable spot on the page shown in the editor, as the website announced it ("ready"). */
export interface SiteSlot {
  key: string;
  kind: SiteSlotKind;
  /** What the website calls it ("Home: tagline"), else the key. */
  label: string;
  /** The website's own value: text, the link's address, or the picture's address ("" when there's none). */
  defaultValue: string;
  /** Text that may span several lines. */
  multiline: boolean;
}

/** Website → portal: a page (re)loaded in the editor and its slots. */
export interface SiteReadyMessage {
  type: "ready";
  path: string;
  title: string;
  slots: SiteSlot[];
}

/** Website → portal: someone clicked a slot in the editor frame. */
export interface SiteSelectMessage {
  type: "select";
  key: string;
}

/** Most slots one page may announce (more are ignored). */
export const SITE_SLOTS_MAX = 2000;
const LABEL_MAX = 200;
const PATH_MAX = 500;
const DEFAULT_MAX = SITE_TEXT_MAX + SITE_LINK_MAX;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A message from the website's editor frame (`{ source: "hk-site", type, … }`), checked field by field — or null when
 * it isn't one. Bad slots are dropped one by one; nothing in it is ever treated as HTML. The caller has already
 * checked the message's origin and that it came from the editor's own frame.
 */
export function parseSiteMessage(data: unknown): SiteReadyMessage | SiteSelectMessage | null {
  if (!isRecord(data) || data.source !== "hk-site") return null;
  if (data.type === "select") return isSiteKey(data.key) ? { type: "select", key: data.key } : null;
  if (data.type !== "ready") return null;
  const path = typeof data.path === "string" && data.path.startsWith("/") && data.path.length <= PATH_MAX ? data.path : "/";
  const title = typeof data.title === "string" ? data.title.slice(0, LABEL_MAX) : "";
  const slots: SiteSlot[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(data.slots) ? data.slots.slice(0, SITE_SLOTS_MAX) : []) {
    if (!isRecord(raw) || !isSiteKey(raw.key) || seen.has(raw.key)) continue;
    const kind = raw.kind;
    if (kind !== "text" && kind !== "link" && kind !== "image") continue;
    seen.add(raw.key);
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, LABEL_MAX) : raw.key;
    const defaultValue = typeof raw.defaultValue === "string" ? raw.defaultValue.slice(0, DEFAULT_MAX) : "";
    slots.push({ key: raw.key, kind, label, defaultValue, multiline: raw.multiline === true });
  }
  return { type: "ready", path, title, slots };
}

/** Portal → website: the full current content (image `src` may be absolute addresses on this portal). */
export interface SitePreviewMessage {
  source: "hk-portal";
  type: "preview";
  texts: Record<string, string>;
  links: Record<string, string>;
  images: Record<string, PublicSiteImage>;
}

/** Portal → website: scroll a slot into view and flash it. */
export interface SiteHighlightMessage {
  source: "hk-portal";
  type: "highlight";
  key: string;
}

/** Where a slot sits, for grouping the editor's list: its key without the last part ("home.hero.tagline" → "home.hero"). */
export function siteSlotGroup(key: string): string {
  const dot = key.lastIndexOf(".");
  return dot > 0 ? key.slice(0, dot) : key;
}
