// Checks for files people upload (Resources files, files attached to sponsors, posters, notebook pictures, strategy
// files): every upload is size-checked, gets a safe name, and runnable Windows files are refused. Where the bytes
// go (Postgres or Cloudflare R2) is ./stored.ts; serving them safely is src/server/resources/serve.ts and
// ./respond.ts; the shared storage cap is ./storage.ts.
import { LIMITS } from "@/lib/constants";
import { ValidationError } from "../errors";
import { fileExtension } from "../resources/serve";

/** A file picked in a form. The Server Action reads it from FormData (formDataToObject only keeps its name). */
export interface UploadedFile {
  name: string;
  /** Type reported by the browser (may be empty or wrong). */
  type: string;
  bytes: Uint8Array;
}

/** An upload that passed the checks, ready to store. */
export interface CleanUpload {
  filename: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Programs, scripts, and shortcuts that run on Windows when opened. Never accepted. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe", "msi", "msp", "msix", "msixbundle", "appx", "appxbundle", "bat", "cmd", "com", "scr", "pif", "cpl", "dll",
  "sys", "drv", "ocx", "ps1", "ps1xml", "ps2", "psm1", "psd1", "psc1", "vb", "vbs", "vbe", "jse", "wsf", "wsh", "ws",
  "wsc", "sct", "hta", "lnk", "url", "reg", "inf", "scf", "msc", "gadget", "application", "chm", "iso", "img", "vhd",
  "vhdx", "appref-ms", "settingcontent-ms", "library-ms", "xll", "xbap",
  // Run on double-click too (Windows Script Host / Java). Share JavaScript as a link or a .txt instead.
  "js", "jar",
]);

/** C0/C1 controls, line/paragraph separators, BOM, and bidi overrides (which can disguise "exe.txt" as "txt.exe"). */
function isUnsafeFilenameChar(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code < 0xa0) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * A safe display/download name: the base name only (no folders), no control or bidi characters,
 * no trailing dots/spaces, at most LIMITS.resourceFilenameMax characters (keeping the extension),
 * and "file" when nothing usable is left.
 */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  let out = "";
  for (const ch of base) if (!isUnsafeFilenameChar(ch.codePointAt(0) ?? 0)) out += ch;
  out = out
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, ""); // Windows drops these, which could turn "x.exe." into "x.exe"
  if (!out || /^\.+$/.test(out)) return "file";
  const chars = Array.from(out);
  const max = LIMITS.resourceFilenameMax;
  if (chars.length <= max) return out;
  const ext = fileExtension(out);
  const tail = ext && ext.length <= 16 ? `.${ext}` : "";
  return `${chars.slice(0, max - tail.length).join("").trimEnd()}${tail}`;
}

/** The browser's MIME type if it looks like one, else application/octet-stream. Only a hint for serving. */
export function cleanContentType(type: string): string {
  const t = type.trim().toLowerCase().split(";")[0].trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(t) ? t : "application/octet-stream";
}

/** A service's raw `file` input → an UploadedFile, or null when there isn't one (e.g. only a name). */
export function readUpload(value: unknown): UploadedFile | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<Record<keyof UploadedFile, unknown>>;
  if (!(v.bytes instanceof Uint8Array)) return null;
  return { name: typeof v.name === "string" ? v.name : "", type: typeof v.type === "string" ? v.type : "", bytes: v.bytes };
}

/** A problem with the picked file, shown next to the form's `file` field. */
export function fileError(message: string): ValidationError {
  return new ValidationError(message, { file: message });
}

/** What each feature says when a file is too big or can run programs (the first sentence is shared). */
export interface UploadMessages {
  /** e.g. `That file is 5.2 MB. Files can be up to 4 MB, …` */
  tooBig(size: number): string;
  /** e.g. `.exe files can't be uploaded because they can run programs on a computer. …` */
  blocked(ext: string): string;
}

/**
 * Checks an uploaded file: not empty, at most LIMITS.resourceFileMaxBytes, a cleaned name, and not a
 * runnable Windows file. Problems are ValidationErrors on the `file` field.
 */
export function checkUploadedFile(upload: UploadedFile, messages: UploadMessages): CleanUpload {
  const size = upload.bytes.byteLength;
  if (size === 0) throw fileError("That file is empty. Choose another one.");
  if (size > LIMITS.resourceFileMaxBytes) throw fileError(messages.tooBig(size));
  const filename = cleanFilename(upload.name);
  const ext = fileExtension(filename);
  if (BLOCKED_EXTENSIONS.has(ext)) throw fileError(messages.blocked(ext));
  return { filename, contentType: cleanContentType(upload.type), bytes: new Uint8Array(upload.bytes) };
}

/**
 * The file picked in a form's file input (for Server Actions; formDataToObject only keeps its name).
 * An empty file input arrives as a nameless 0-byte File: that means "no file chosen".
 */
export async function readFormFile(formData: FormData, name = "file"): Promise<UploadedFile | undefined> {
  const file = formData.get(name);
  if (!(file instanceof File) || (file.size === 0 && !file.name)) return undefined;
  return { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) };
}
