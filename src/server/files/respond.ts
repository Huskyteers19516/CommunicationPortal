// Responses for the routes that send uploaded files (Resources files, sponsor files, posters, notebook pictures,
// strategy files, sponsor logos, Workshop photos and files). The bytes come from Postgres (`data`) or Cloudflare R2 (`storageKey`, streamed through here —
// never a redirect to R2, whose bucket stays private); the headers are the same either way.
import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { fileResponseHeaders, type ServedFile } from "../resources/serve";
import { getObjectStore, type ObjectStore, objectStoreErrorMessage } from "./object-store";

/** A short plain-text answer (errors), never cached or sniffed. */
export function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

/** Not signed in: to /login, coming back to this file afterwards. */
export function redirectToLogin(request: NextRequest): NextResponse {
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

/** A stored file row as the file routes load it: its bytes are in `data` (Postgres) or at `storageKey` (R2). */
export interface StoredFileRow {
  filename: string;
  contentType: string;
  /** The row's size, used when R2 doesn't say how long the file is. */
  size?: number;
  data: Uint8Array<ArrayBuffer> | null;
  storageKey?: string | null;
}

/** The columns the file routes select (never more). */
export const STORED_FILE_SELECT = { filename: true, contentType: true, size: true, data: true, storageKey: true } as const;

export const FILE_UNAVAILABLE = "This file couldn't be loaded just now. Try again in a minute.";
export const FILE_STORAGE_NOT_SET_UP = "This file is in Cloudflare R2, but R2 isn't set up on this site. Ask an owner to check the R2 settings.";
export const FILE_MISSING = "This file is missing from the team's file storage.";

export interface SendFileOptions {
  /** The bytes at this address never change (poster files, notebook pictures): the browser may keep them. */
  immutable?: boolean;
  /** Headers other than the default fileResponseHeaders() (e.g. strategy files: a .pp is always a download). */
  headers?: (file: ServedFile, options: { download: boolean }) => Record<string, string>;
  /** For tests; defaults to the R2_* settings. */
  store?: ObjectStore | null;
}

/**
 * Sends a stored file with the locked-down headers from fileResponseHeaders(): shown in the browser only
 * for safe types (text, a few images, PDF), downloaded otherwise; `?download=1` always downloads.
 * `immutable`: the bytes at this address never change (poster files), so the browser may keep them.
 * A file in Cloudflare R2 is streamed through this response with the same headers.
 */
export async function sendStoredFile(request: NextRequest, file: StoredFileRow, options: SendFileOptions = {}): Promise<Response> {
  const download = request.nextUrl.searchParams.get("download") === "1";
  const headersFor = (byteLength: number) =>
    options.headers
      ? options.headers({ filename: file.filename, contentType: file.contentType, byteLength }, { download })
      : fileResponseHeaders({ filename: file.filename, contentType: file.contentType, byteLength }, { download, immutable: options.immutable });

  if (file.data) return new Response(file.data, { status: 200, headers: headersFor(file.data.byteLength) });
  if (!file.storageKey) return plainResponse(404, FILE_MISSING);

  const store = options.store === undefined ? getObjectStore() : options.store;
  if (!store) return plainResponse(503, FILE_STORAGE_NOT_SET_UP);
  let object;
  try {
    object = await store.getObject(file.storageKey);
  } catch (e) {
    console.error(`[files] couldn't read a file from Cloudflare R2: ${objectStoreErrorMessage(e)}`);
    return plainResponse(502, FILE_UNAVAILABLE);
  }
  if (!object) return plainResponse(404, FILE_MISSING);
  // R2's length is the body's (asked for unpacked, and dropped by getObject if it came packed anyway); else the row's.
  if (object.contentLength !== null && file.size !== undefined && object.contentLength !== file.size) {
    console.warn(`[files] Cloudflare R2 has ${object.contentLength} bytes for a file saved as ${file.size} bytes`);
  }
  const length = object.contentLength ?? file.size ?? null;
  const headers = headersFor(length ?? 0);
  // Without a length from R2 or the row, let the response be chunked rather than send a wrong one.
  if (length === null) delete headers["Content-Length"];
  return new Response(object.body, { status: 200, headers });
}

/**
 * A stored file's bytes in memory (for the resource text preview and the notebook's Word export), from Postgres or
 * Cloudflare R2. Null when they can't be had (missing, R2 not set up or not answering).
 */
export async function readStoredBytes(file: Pick<StoredFileRow, "data" | "storageKey">, store: ObjectStore | null = getObjectStore()): Promise<Uint8Array | null> {
  if (file.data) return file.data;
  if (!file.storageKey || !store) return null;
  try {
    return await store.getObjectBytes(file.storageKey);
  } catch (e) {
    console.error(`[files] couldn't read a file from Cloudflare R2: ${objectStoreErrorMessage(e)}`);
    return null;
  }
}
