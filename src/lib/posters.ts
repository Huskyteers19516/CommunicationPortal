// Posters (client-safe): which files a poster can be, and what to say about the ones it can't. The add/edit
// form checks a picked file right away with these; the server checks again, by the file's actual contents
// (src/server/services/posters.ts).
import { LIMITS } from "./constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "./files";

/** What the file picker offers: pictures (the camera roll on phones) and PDFs. */
export const POSTER_FILE_ACCEPT = "image/*,application/pdf";

/** Extensions a poster file can have (lower case, no dot). */
export const POSTER_FILE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf"]);

/** Browser-reported types a poster file can have. */
export const POSTER_FILE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

export const POSTER_FILE_TYPES_MESSAGE =
  "Posters can be a picture (PNG, JPG, GIF, or WebP) or a PDF. Save it as one of those, or add a link to the design instead.";

/** iPhone photos (HEIC) and similar: browsers can't show them. */
export const POSTER_HEIC_MESSAGE =
  "That's an iPhone photo format (HEIC) that browsers can't show. Take a screenshot of it, or save it as a JPG, and try again.";

/** e.g. "That file is 5.2 MB. Posters can be up to 4 MB — …" */
export function posterFileTooBigMessage(size: number): string {
  return `That file is ${formatFileSize(size)}. Posters can be up to ${RESOURCE_FILE_MAX_MB} MB — save a smaller JPG or PDF, or add a link to the design instead.`;
}

/**
 * The biggest picture a poster can be, in pixels (a side, and in all). Every phone that opens Posters draws it, and
 * a small file can claim an enormous picture that freezes the page. A 3000 × 4000 phone photo is 12 million.
 */
export const POSTER_IMAGE_MAX_SIDE = 12_000;
export const POSTER_IMAGE_MAX_PIXELS = 50_000_000;

/** e.g. "That picture is 30,000 × 30,000 pixels — too big to show on phones. …" */
export function posterImageTooLargeMessage(width: number, height: number): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return `That picture is ${n(width)} × ${n(height)} pixels — too big to show on phones. Save a smaller copy (about 3,000 pixels on the longest side) and try again.`;
}

/** A file that says it's a picture but can't be read (damaged, or not really a picture). */
export const POSTER_UNREADABLE_MESSAGE =
  "That picture couldn't be opened. Save it again as a PNG or JPG and try again, or add a link to the design instead.";

/** Pictures the browser can make smaller before uploading (not GIFs: they'd lose their animation). */
const SHRINKABLE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const SHRINKABLE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "webp"]);

/** Whether the form can shrink this picked file (a PNG, JPG, or WebP) into a JPG that fits. */
export function canShrinkPosterFile(file: { name: string; type: string }): boolean {
  const type = file.type.toLowerCase();
  return SHRINKABLE_TYPES.has(type) || (!type && SHRINKABLE_EXTENSIONS.has(extensionOf(file.name)));
}

/** Width and height that fit within `maxSide` on the longest side, keeping the shape (never made bigger). */
export function fitWithin(width: number, height: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "IMG_1234.PNG" → "IMG_1234.jpg" (the name of a picture the form made smaller). */
export function jpgName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return `${(dot > 0 ? base.slice(0, dot) : base) || "poster"}.jpg`;
}

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * The problem with a picked file, checked in the browser before anything is sent (size, and a type by its
 * name or the browser's type), or null when it looks fine. The server checks the contents too.
 */
export function posterFileProblem(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return "That file is empty. Choose another one.";
  if (file.size > LIMITS.resourceFileMaxBytes) return posterFileTooBigMessage(file.size);
  const ext = extensionOf(file.name);
  const type = file.type.toLowerCase();
  if (ext === "heic" || ext === "heif" || type === "image/heic" || type === "image/heif") return POSTER_HEIC_MESSAGE;
  if (POSTER_FILE_EXTENSIONS.has(ext) || POSTER_FILE_TYPES.has(type)) return null;
  return POSTER_FILE_TYPES_MESSAGE;
}

/** "Library demo · Sat, Oct 4" / "Library demo" / "Sat, Oct 4" / "" — what a poster is for, and when. */
export function posterWhen(event: string, dateLabel: string | null): string {
  return [event.trim(), dateLabel ?? ""].filter(Boolean).join(" · ");
}
