// Where a new file's bytes go, for every service that saves uploaded files (Resources, sponsor files, posters,
// notebook pictures, strategy files, sponsor logos, Workshop photos and files):
// - Cloudflare R2 when it's set up (ctx.objectStore): the bytes are uploaded first under a new key, then the row is
//   saved with `storageKey` (and `data` null);
// - otherwise Postgres, as before: the row gets `data` (and `storageKey` null).
// All checks (sizes, types, rate limits, the storage cap under its lock) stay in the services; this only moves bytes.
import type { Db } from "../db";
import {
  confirmStorageKeys,
  type FileKind,
  newStorageKey,
  type ObjectStore,
  objectStoreErrorMessage,
  releaseStorageKeys,
  reserveStorageKeys,
  settleFailedUploads,
} from "./object-store";
import { type CleanUpload, fileError } from "./upload";

/** What a service needs to store files: the database and, when Cloudflare R2 is set up, its client. */
export interface FileStoreContext {
  db: Db;
  objectStore?: ObjectStore | null;
}

/** The columns a file row gets for one upload (spread into the create/update). Exactly one of data/storageKey is set. */
export interface StoredFileColumns {
  filename: string;
  contentType: string;
  size: number;
  data: Uint8Array<ArrayBuffer> | null;
  storageKey: string | null;
}

/** Shown when R2 doesn't take the file (details go to the server log). */
export const FILE_UPLOAD_FAILED =
  "The file couldn't be saved to the team's file storage just now. Nothing was changed — try again in a minute.";

/** Whether new files go to Cloudflare R2 for this request (sets the storage cap and the per-person allowances). */
export function usesObjectStorage(ctx: FileStoreContext): boolean {
  return !!ctx.objectStore;
}

/**
 * Puts each upload's bytes where new files go, then runs `save` with the columns for each one (same order).
 * With Cloudflare R2: the objects are uploaded before `save` (never inside a transaction or under the storage lock).
 * - `precheck` (optional) runs first, only when uploading to R2: the same checks `save` makes under the lock (the cap,
 *   each person's allowance, how many files a sponsor or entry can have), without the lock, so an upload that's
 *   refused anyway (storage full…) isn't sent to R2 and deleted again. `save` still makes the real check.
 * - If an upload fails, `save` doesn't run and the person gets FILE_UPLOAD_FAILED on the `file` field (no row). What
 *   was uploaded is deleted; an upload R2 didn't answer (it may still land) is deleted 10 minutes later instead.
 * - If `save` throws (a check under the lock, the database…), the uploaded objects are deleted (or queued for
 *   deletion) and the error is thrown on.
 * Nothing is left behind in R2 either way.
 */
export async function withStoredFiles<T>(
  ctx: FileStoreContext,
  kind: FileKind,
  uploads: CleanUpload[],
  save: (files: StoredFileColumns[]) => Promise<T>,
  options: { precheck?: () => Promise<void> } = {},
): Promise<T> {
  const store = ctx.objectStore ?? null;
  const meta = (u: CleanUpload) => ({ filename: u.filename, contentType: u.contentType, size: u.bytes.byteLength });
  if (!store || uploads.length === 0) {
    return save(uploads.map((u) => ({ ...meta(u), data: u.bytes, storageKey: null })));
  }

  await options.precheck?.();
  const keys = uploads.map(() => newStorageKey(kind));
  await reserveStorageKeys(ctx.db, keys);
  // One request carries at most 4 MB of files, so these go up together. All of them finish (or fail) before anything
  // is cleaned up.
  const puts = await Promise.allSettled(uploads.map((u, i) => store.putObject(keys[i], u.bytes)));
  const failed = puts.find((p): p is PromiseRejectedResult => p.status === "rejected");
  if (failed) {
    console.error(`[files] upload to Cloudflare R2 failed: ${objectStoreErrorMessage(failed.reason)}`);
    await settleFailedUploads(ctx.db, store, keys, puts);
    throw fileError(FILE_UPLOAD_FAILED);
  }

  let result: T;
  try {
    result = await save(uploads.map((u, i) => ({ ...meta(u), data: null, storageKey: keys[i] })));
  } catch (e) {
    await releaseStorageKeys(ctx.db, store, keys);
    throw e;
  }
  await confirmStorageKeys(ctx.db, keys);
  return result;
}
