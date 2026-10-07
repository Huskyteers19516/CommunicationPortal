// Meeting recaps (/meetings), client-safe: the recording's limits and types (shared by the recorder in the browser and
// the services), the list's filters from the URL, links, and labels. Writes: src/server/services/meeting-recaps.ts.
import type { DateOnly } from "./dates";
import { cleanSearchText } from "./search";

/** How long a recording is kept (and can be played): 3 days from when the recap was saved. */
export const MEETING_AUDIO_KEEP_MS = 72 * 60 * 60 * 1000;
/**
 * A recording is uploaded (and played) in parts of this size, one Server Action call (or one GET) each, so no request
 * or response gets near Vercel's 4.5 MB limit. Every part but the last is exactly this size.
 */
export const MEETING_AUDIO_PART_BYTES = 3 * 1024 * 1024;
/** The biggest recording kept (about 3 hours of the recorder's Opus; Safari's AAC is bigger). */
export const MEETING_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
/** Parts in the biggest recording (34). */
export const MEETING_AUDIO_PARTS_MAX = Math.ceil(MEETING_AUDIO_MAX_BYTES / MEETING_AUDIO_PART_BYTES);
/** The longest recording the recorder makes (it stops by itself then). */
export const MEETING_RECORDING_MAX_MS = 3 * 60 * 60 * 1000;
/** The longest meeting a recap can say it was (6 hours, in seconds). */
export const MEETING_DURATION_MAX_SEC = 6 * 60 * 60;

/** The kinds of recording that are kept (by their bytes; see sniffMeetingAudioType). */
export const MEETING_AUDIO_TYPES = ["audio/webm", "audio/mp4", "audio/ogg", "audio/wav", "audio/mpeg"] as const;
export type MeetingAudioType = (typeof MEETING_AUDIO_TYPES)[number];

/** Categories in the team's list, and on one recap. */
export const MEETING_CATEGORIES_MAX = 30;
export const MEETING_CATEGORIES_PER_RECAP_MAX = 5;
/** Recaps per page of the list. */
export const MEETING_RECAPS_PAGE_SIZE = 20;
/** Today lists recaps saved in the last this many hours. */
export const MEETING_RECAP_TODAY_HOURS = 72;
/** Longest search (`?q=`). */
export const MEETING_SEARCH_MAX = 100;

/**
 * What a recording is, by its first bytes: WebM/Matroska (1A 45 DF A3), MP4/M4A ("ftyp" at byte 4), Ogg ("OggS"),
 * WAV ("RIFF" … "WAVE"), MP3 ("ID3", or an MPEG audio frame: FF Ex with a layer set — AAC's ADTS frames, layer 00,
 * aren't MP3). Null for anything else.
 */
export function sniffMeetingAudioType(bytes: Uint8Array): MeetingAudioType | null {
  const at = (i: number, ...expected: number[]) => expected.every((b, j) => bytes[i + j] === b);
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "audio/webm";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "audio/mp4"; // "ftyp"
  if (at(0, 0x4f, 0x67, 0x67, 0x53)) return "audio/ogg"; // "OggS"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x41, 0x56, 0x45)) return "audio/wav"; // "RIFF" … "WAVE"
  if (at(0, 0x49, 0x44, 0x33)) return "audio/mpeg"; // "ID3"
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0) return "audio/mpeg";
  return null;
}

const AUDIO_TYPE_ALIASES: Record<string, MeetingAudioType> = {
  "video/webm": "audio/webm",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "video/mp4": "audio/mp4",
  "audio/mp3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
};

/**
 * A browser's MIME type for a recording (MediaRecorder's `audio/webm;codecs=opus`, a picked file's `audio/x-m4a`…) as
 * one of MEETING_AUDIO_TYPES, or null when it isn't a kind that's kept.
 */
export function normalizeMeetingAudioType(mime: string): MeetingAudioType | null {
  const type = mime.split(";")[0].trim().toLowerCase();
  return MEETING_AUDIO_TYPES.find((t) => t === type) ?? AUDIO_TYPE_ALIASES[type] ?? null;
}

const AUDIO_EXTENSIONS: Record<MeetingAudioType, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

/** The file extension for a recording of this type ("webm", "m4a", …), without the dot. */
export function meetingAudioExtension(type: MeetingAudioType): string {
  return AUDIO_EXTENSIONS[type];
}

/** How many parts a recording of this size is uploaded in. */
export function meetingAudioPartCount(bytes: number): number {
  return Math.ceil(bytes / MEETING_AUDIO_PART_BYTES);
}

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A save's request id (newMeetingRequestId, from the recorder or the write-up form, sent as `requestId`), lower-cased,
 * or null when it isn't one. The new recap gets it as its id, so saving again after a lost answer finds the first one
 * instead of making a second.
 */
export function parseMeetingRequestId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return REQUEST_ID_RE.test(id) ? id : null;
}

/**
 * A new save's request id: a random (version 4) UUID — `crypto.randomUUID()` where the browser has it, else built
 * from `crypto.getRandomValues()`, which also works on a page that isn't a secure context (plain http to a LAN
 * address, e.g. `next dev` opened from a phone), where randomUUID doesn't exist.
 */
export function newMeetingRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // the RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A category as the pages show it. */
export interface MeetingCategoryOption {
  id: string;
  name: string;
}

/**
 * A recap's recording, as every read sees it at a given moment:
 * - `none`: saved without one;
 * - `deleted`: its 3 days are up, or it was deleted sooner (`early`: "Delete recording now"); `at` = when (ISO);
 * - `uploading`: some parts haven't arrived yet (`received` of `total`); playable from nobody's side until they do;
 * - `ready`: complete — the browser fetches `partIds` in order (meetingAudioPartHref) and joins them.
 */
export type MeetingAudioState =
  | { state: "none" }
  | { state: "deleted"; early: boolean; at: string }
  | { state: "uploading"; received: number; total: number; expiresAt: string }
  | { state: "ready"; partIds: string[]; audioType: MeetingAudioType; audioBytes: number; expiresAt: string };

/** Which parts of a recap's recording the portal has (the recorder finishing an interrupted upload). */
export interface MeetingAudioUploadState {
  audioType: MeetingAudioType | null;
  audioParts: number;
  audioBytes: number;
  /** The positions already uploaded (sorted). */
  present: number[];
  /** Past its 3 days, or deleted: nothing more can be uploaded. */
  expired: boolean;
  /** Every part is in. */
  complete: boolean;
}

/**
 * What getMeetingAudioUploadStateAction answers: the state, or why it can't say. `gone` only when the recap really was
 * deleted; anything else (signed out, no access anymore, the database or the network) is `message`, and the recording
 * may well still be waiting for its parts.
 */
export type MeetingAudioUploadStateResult =
  | { ok: true; state: MeetingAudioUploadState }
  | { ok: false; gone: true }
  | { ok: false; gone: false; message: string };

/** What the write-up / edit form shows (editing: also the id and the `version` — the updatedAt, ISO — it loaded). */
export interface MeetingRecapFormValues {
  id?: string;
  version?: string;
  title: string;
  meetingDate: DateOnly;
  categoryIds: string[];
  keyPoints: string;
  transcript: string;
  durationSec: number | null;
}

export interface MeetingRecapFilters {
  /** One category's recaps (`?category=<id>`). */
  category?: string;
  /** Words in the title, key points, or transcript (`?q=`). */
  q?: string;
  page?: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The list's filters from the URL (`?category=&q=&page=`); anything unexpected is dropped. */
export function parseMeetingRecapFilters(sp: SearchParams): MeetingRecapFilters {
  const category = first(sp.category)?.trim();
  const q = cleanSearchText(first(sp.q), MEETING_SEARCH_MAX);
  const n = Number(first(sp.page));
  const page = Number.isInteger(n) && n > 1 ? Math.min(n, 10_000) : undefined;
  return {
    ...(category && /^[A-Za-z0-9_-]{1,64}$/.test(category) ? { category } : {}),
    ...(q ? { q } : {}),
    ...(page ? { page } : {}),
  };
}

/** The list with these filters (and any `extra` params, e.g. `removed=1`). Page 1 and "All" stay out of the URL. */
export function meetingRecapsHref(filters: MeetingRecapFilters = {}, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams();
  if (filters.category) sp.set("category", filters.category);
  if (filters.q) sp.set("q", filters.q);
  if (filters.page && filters.page > 1) sp.set("page", String(filters.page));
  for (const [key, value] of Object.entries(extra)) sp.set(key, value);
  const qs = sp.toString();
  return qs ? `/meetings?${qs}` : "/meetings";
}

export function meetingRecapHref(id: string): string {
  return `/meetings/${encodeURIComponent(id)}`;
}

/** One part of a recording (GET, ≤ 3 MiB, signed-in ACTIVE people only; a 404 once it's deleted). */
export function meetingAudioPartHref(partId: string): string {
  return `/meetings/audio/${encodeURIComponent(partId)}`;
}

/** "1 h 05 min", "42 min", "under a minute". */
export function formatMeetingDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return "under a minute";
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "3 recaps" / "1 recap", with what the list is filtered to and the page. */
export function meetingRecapCountText(total: number, opts: { categoryName?: string; q?: string; page?: number; pageCount?: number } = {}): string {
  let text = `${total.toLocaleString("en-US")} ${total === 1 ? "recap" : "recaps"}`;
  if (opts.categoryName) text += ` in ${opts.categoryName}`;
  if (opts.q) text += ` matching “${opts.q}”`;
  if (opts.pageCount && opts.pageCount > 1) text += ` · page ${opts.page ?? 1} of ${opts.pageCount}`;
  return text;
}
