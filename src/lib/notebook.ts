// Team notebook (client-safe): the standard notebooks, the date/time stamp, how entry text is split into
// paragraphs and "- " bullet lists (the page, the print view, and the Word export all use it), and the checks
// the entry editor runs on a picked picture before sending it (the server checks the contents again,
// src/server/services/notebook.ts).
import type { Subteam } from "@/generated/prisma/enums";
import { LIMITS, TEAM_NAME, TEAM_NUMBER } from "./constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "./files";

/** A notebook's description ("Build's engineering notebook: …"). */
export const NOTEBOOK_DESCRIPTION_MAX = 300;
/** The emoji shown before a notebook's title (a few characters: "🧑‍💻" is 5). */
export const NOTEBOOK_EMOJI_MAX = 16;
/** Shown for a notebook without its own emoji. */
export const NOTEBOOK_DEFAULT_EMOJI = "📓";

/** "FTC 19516 The Huskyteers" — the first line of every export. */
export const NOTEBOOK_TEAM_LINE = `FTC ${TEAM_NUMBER} ${TEAM_NAME}`;

export interface StandardNotebook {
  title: string;
  emoji: string;
  subteam: Subteam;
  description: string;
  pages: string[];
}

/** The team's notebook outline (from its Google Doc), made in one click by "Create the standard notebooks". */
export const STANDARD_NOTEBOOKS: readonly StandardNotebook[] = [
  {
    title: "Hardware Notebook",
    emoji: "👷",
    subteam: "BUILD",
    description: "Build's engineering notebook: designs, tests, and changes to the robot.",
    pages: ["Intake", "Outtake"],
  },
  {
    title: "Software Notebook",
    emoji: "🧑‍💻",
    subteam: "SOFTWARE",
    description: "Code, autonomous paths, and what we learned testing them.",
    pages: ["Competition", "Prototyping", "Transfer"],
  },
  {
    title: "Business Notebook",
    emoji: "🧑‍💼",
    subteam: "BUSINESS",
    description: "Outreach events, sponsors, and the team's journal.",
    pages: ["Outreach", "Sponsorships", "Engineering Journal"],
  },
];

/** "Sun, Sep 27, 2026, 3:42 PM" in the team timezone: the stamp on every entry and edit. */
export function formatStamp(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(value)
    .replace(/[  ]/g, " "); // some browsers put a narrow no-break space before "PM"
}

/** "Sun, Sep 27, 2026" (the export date on a title page). */
export function formatStampDay(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(value);
}

/** "Written by Ethan Chen · Sun, Sep 27, 2026, 3:42 PM" (someone whose account was removed: "a former member"). */
export function writtenByLine(name: string | null, at: Date, timeZone: string): string {
  return `Written by ${name ?? "a former member"} · ${formatStamp(at, timeZone)}`;
}

/** "Edited by Marcus Johnson · Sun, Sep 27, 2026, 4:10 PM". */
export function editedByLine(name: string | null, at: Date, timeZone: string): string {
  return `Edited by ${name ?? "a former member"} · ${formatStamp(at, timeZone)}`;
}

// ---------- entry text ----------

export type NotebookBlock = { kind: "text"; text: string } | { kind: "list"; items: string[] };

const BULLET_RE = /^\s*[-*•]\s+(.*)$/;

/**
 * An entry's text as blocks: runs of "- " (or "* ", "• ") lines become a bulleted list; everything else stays text
 * with its line breaks (blank lines at the edges of a run are dropped).
 */
export function notebookBlocks(body: string): NotebookBlock[] {
  const blocks: NotebookBlock[] = [];
  let text: string[] = [];
  let items: string[] = [];
  const flushText = () => {
    const joined = text.join("\n").replace(/^\n+|\n+$/g, "");
    if (joined.trim()) blocks.push({ kind: "text", text: joined });
    text = [];
  };
  const flushList = () => {
    if (items.length) blocks.push({ kind: "list", items });
    items = [];
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = BULLET_RE.exec(line);
    if (bullet && bullet[1].trim()) {
      flushText();
      items.push(bullet[1].trim());
    } else {
      flushList();
      text.push(line);
    }
  }
  flushText();
  flushList();
  return blocks;
}

// ---------- export ----------

/** A UTF-16 half of a character on its own (e.g. half an emoji): it can't be encoded, so it's dropped. */
const isLoneSurrogate = (ch: string) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff;

/**
 * A file name without characters Windows/macOS refuse: "Hardware Notebook 2026-09-27.docx". Cut to 100 whole
 * characters, so an emoji is never split in half (that would break the download's Content-Disposition header).
 */
export function notebookExportFilename(parts: string[], day: string, extension = "docx"): string {
  const joined = parts
    .map((p) =>
      Array.from(p)
        .filter((ch) => !isLoneSurrogate(ch))
        .join("")
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join(" - ");
  const base = Array.from(joined).slice(0, 100).join("").trim();
  return `${base || "Notebook"} ${day}.${extension}`;
}

/** The Export menu's width (w-60) and the room it keeps from the screen's edges. */
const EXPORT_MENU_WIDTH = 240;
const EXPORT_MENU_EDGE = 8;

/**
 * Which edge of its button the Export menu lines up with: the preferred one when the menu fits on screen that way, else
 * the other one (e.g. a phone whose page title leaves the button at the right edge), else whichever has more room.
 */
export function exportMenuSide(
  button: { left: number; right: number },
  viewportWidth: number,
  prefer: "start" | "end",
  menuWidth = EXPORT_MENU_WIDTH,
): "start" | "end" {
  const fitsStart = button.left + menuWidth <= viewportWidth - EXPORT_MENU_EDGE; // opens rightwards from the button's left edge
  const fitsEnd = button.right - menuWidth >= EXPORT_MENU_EDGE; // opens leftwards from the button's right edge
  if (prefer === "start" ? fitsStart : fitsEnd) return prefer;
  if (prefer === "start" ? fitsEnd : fitsStart) return prefer === "start" ? "end" : "start";
  return viewportWidth - button.left >= button.right ? "start" : "end";
}

// ---------- history ----------

/** An entry's title and text at one point in its history. */
export interface NotebookVersionText {
  title: string;
  body: string;
}

/** Where History loads an entry's earlier versions from (src/app/(app)/notebook/entries/[entryId]/history/route.ts). */
export function notebookHistoryHref(entryId: string): string {
  return `/notebook/entries/${encodeURIComponent(entryId)}/history`;
}

/** What that route sends: the newest earlier versions (dates as ISO strings). */
export interface NotebookHistoryJson {
  /** The entry as it is now. */
  title: string;
  body: string;
  versions: { id: string; editorName: string | null; editedAt: string; previousTitle: string; previousBody: string }[];
  /** Every earlier version (more than `versions` holds when it's been changed a lot). */
  historyCount: number;
  /** The viewer can take an old version's text out. */
  canClear: boolean;
}

/**
 * An old version whose text was taken out of the history (clearNotebookEntryVersion): its title and text are
 * empty, which a real version never is (an entry always has text).
 */
export function isClearedNotebookVersion(version: NotebookVersionText): boolean {
  return version.body === "";
}

/**
 * What one change did, from what the entry said before it and what it said right after (the next newer version, or
 * the entry as it is now): "changed the title", "changed the text", "changed the title and text", or — when the
 * words stayed the same — "changed the pictures". "changed it" when either side was taken out of the history.
 */
export function notebookChangeLabel(before: NotebookVersionText, after: NotebookVersionText | null): string {
  if (!after || isClearedNotebookVersion(before) || isClearedNotebookVersion(after)) return "changed it";
  const title = before.title !== after.title;
  const text = before.body !== after.body;
  if (title && text) return "changed the title and text";
  if (title) return "changed the title";
  if (text) return "changed the text";
  return "changed the pictures";
}

// ---------- pictures ----------

/**
 * The editor makes a picked photo at most this many pixels on its longest side (a JPG) before uploading: sharp on a
 * printed page (6.5" wide), and small (about 250 KB), since notebook pictures share the team's file storage.
 */
export const NOTEBOOK_PICTURE_MAX_SIDE = 1280;
/** Pictures up to this size that are already small enough in pixels are sent as they are (PNG screenshots stay sharp). */
export const NOTEBOOK_PICTURE_KEEP_BYTES = 1.5 * 1024 * 1024;

/** What the picture picker offers (the camera roll on phones). */
export const NOTEBOOK_PICTURE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

const PICTURE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const PICTURE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export const NOTEBOOK_PICTURE_TYPES_MESSAGE = "Pictures can be PNG, JPG, GIF, or WebP. Take a screenshot of it, or save it as a JPG.";
export const NOTEBOOK_PICTURE_HEIC_MESSAGE =
  "That's an iPhone photo format (HEIC) that browsers can't show. Take a screenshot of it, or save it as a JPG, and try again.";
export const NOTEBOOK_PICTURE_UNREADABLE_MESSAGE = "That picture couldn't be opened. Save it again as a PNG or JPG and try again.";

export function notebookPictureTooBigMessage(size: number): string {
  return `That picture is ${formatFileSize(size)}. Pictures can be up to ${RESOURCE_FILE_MAX_MB} MB — save a smaller copy and try again.`;
}

export function notebookPicturesFullMessage(): string {
  return `An entry can have up to ${LIMITS.notebookImagesPerEntry} pictures. Take one off first, or start another entry.`;
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The problem with a picked picture (checked in the browser before anything is sent), or null when it looks fine. */
export function notebookPictureProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty. Choose another one.";
  const ext = extensionOf(file.name);
  const type = file.type.toLowerCase();
  if (ext === "heic" || ext === "heif" || type === "image/heic" || type === "image/heif") return NOTEBOOK_PICTURE_HEIC_MESSAGE;
  if (!PICTURE_EXTENSIONS.has(ext) && !PICTURE_TYPES.has(type)) return NOTEBOOK_PICTURE_TYPES_MESSAGE;
  if (file.size > LIMITS.resourceFileMaxBytes) return notebookPictureTooBigMessage(file.size);
  return null;
}
