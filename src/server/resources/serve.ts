// How uploaded files (Resources files, files attached to sponsors, and posters) are shown and served. Pure
// functions (no DB, no next/*), so the route handlers (src/app/(app)/{resources,sponsors,posters}/files/[id]/route.ts,
// via src/server/files/respond.ts), the queries, and tests share them.
//
// Uploaded files come from members, so they are never trusted:
// - only plain text, a few image types, and PDF are shown in the browser; everything else
//   (HTML, SVG, archives, CAD…) is always downloaded as application/octet-stream;
// - text is served as text/plain, never as its own type, so code can't run;
// - every response gets nosniff, a locked-down CSP, and no caching (poster files, whose address never shows
//   different bytes, may be kept by the viewer's browser: `immutable`).

/** Shown inline as text/plain (and previewed on the resource's page). */
const TEXT_EXTENSIONS = new Set([
  // code
  "java", "kt", "kts", "gradle", "groovy", "scala", "py", "js", "mjs", "cjs", "jsx", "ts", "tsx", "c", "h", "cc", "cpp",
  "cxx", "hpp", "hh", "cs", "go", "rs", "rb", "php", "swift", "dart", "lua", "r", "m", "sh", "bash", "zsh", "sql",
  "css", "scss", "less", "vue", "svelte", "cmake", "mk", "pro", "ino",
  // data & config
  "txt", "text", "md", "markdown", "rst", "tex", "csv", "tsv", "log", "json", "jsonc", "json5", "xml", "blk", "yml",
  "yaml", "toml", "ini", "cfg", "conf", "properties", "env", "gitignore", "gitattributes", "editorconfig", "patch", "diff",
]);

/** Extension-less files that are text. */
const TEXT_FILENAMES = new Set(["makefile", "dockerfile", "readme", "license", "gradlew", "procfile"]);

/** Never shown in the browser, even if the browser called them text (they can run script). */
const MARKUP_EXTENSIONS = new Set(["html", "htm", "xhtml", "shtml", "mht", "mhtml", "svg", "svgz", "xsl", "xslt"]);

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type FilePreviewKind = "text" | "image" | "pdf" | "other";

/** Lower-case extension without the dot ("TeleOp.JAVA" → "java"), or "" when there is none. */
export function fileExtension(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) {
    // ".gitignore" style names: the whole name is the extension.
    return dot === 0 && base.length > 1 ? base.slice(1).toLowerCase() : "";
  }
  return base.slice(dot + 1).toLowerCase();
}

/** How a file may be shown in the browser. Decided by its extension first; the browser-reported type is only a hint. */
export function previewKind(filename: string, contentType: string): FilePreviewKind {
  const ext = fileExtension(filename);
  if (MARKUP_EXTENSIONS.has(ext)) return "other";
  if (IMAGE_TYPES[ext]) return "image";
  if (ext === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(filename.toLowerCase())) return "text";
  if (contentType.toLowerCase().split(";")[0].trim() === "text/plain") return "text";
  return "other";
}

/** Text files up to this size are previewed on the resource's page. */
export const TEXT_PREVIEW_MAX_BYTES = 200 * 1024;

/**
 * The file as UTF-8 text for the preview, or null when it isn't clean text
 * (invalid UTF-8 or NUL bytes, i.e. really a binary file).
 */
export function decodeTextPreview(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\u0000")) return null;
  return text.replace(/\r\n?/g, "\n");
}

/** `Content-Disposition` with an ASCII fallback and an RFC 5987 UTF-8 name, e.g. for "Téléop.java". */
export function contentDisposition(disposition: "inline" | "attachment", filename: string): string {
  const fallback =
    filename
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\%]/g, "_")
      .trim() || "file";
  const encoded = encodeURIComponent(filename || "file").replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Locked down: no scripts, no plugins, no forms, a unique origin. */
export const FILE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";
/**
 * PDFs shown in the browser: the same policy minus `sandbox`, because Chrome's built-in PDF viewer
 * refuses to render sandboxed documents (it shows "This page has been blocked by Chrome").
 * PDF viewers run document scripts in their own sandbox, never with the portal's origin.
 */
export const PDF_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

export interface ServedFile {
  filename: string;
  contentType: string;
  /** Real length of the bytes being sent. */
  byteLength: number;
}

/** No caching: the default for uploaded files (Resources files and sponsor files can be replaced at the same address). */
export const NO_STORE = "private, no-store";
/**
 * For files whose address never shows different bytes (a poster file: a new file gets a new id, and a removed one
 * is a 404). Only the viewer's own browser keeps it, for a week, so the Posters grid isn't downloaded on every visit.
 */
export const IMMUTABLE_FILE_CACHE = "private, max-age=604800, immutable";

export interface FileResponseOptions {
  /** Force a download (the "Download" button). */
  download?: boolean;
  /** The bytes at this address never change: let the browser keep them when shown inline (downloads stay no-store). */
  immutable?: boolean;
}

/** Response headers for sending an uploaded file. */
export function fileResponseHeaders(file: ServedFile, options: FileResponseOptions = {}): Record<string, string> {
  const kind = previewKind(file.filename, file.contentType);
  const inline = !options.download && kind !== "other";
  let type = "application/octet-stream";
  if (inline && kind === "text") type = "text/plain; charset=utf-8";
  if (inline && kind === "image") type = IMAGE_TYPES[fileExtension(file.filename)];
  if (inline && kind === "pdf") type = "application/pdf";
  return {
    "Content-Type": type,
    "Content-Length": String(file.byteLength),
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", file.filename),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": inline && kind === "pdf" ? PDF_CSP : FILE_CSP,
    "Cache-Control": inline && options.immutable ? IMMUTABLE_FILE_CACHE : NO_STORE,
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}
