// Admin → Approvals → File storage, the owners' tools (canManageFileStorage):
// - testFileStorage: saves, reads back, and deletes a tiny test file in Cloudflare R2 (after setting it up);
// - moveFilesToObjectStorage: moves files still stored in Postgres to R2, a batch per click (resumable: each click
//   continues where the last stopped, and stops itself before the server's time limit);
// - cleanUpFileStorage: deletes R2 objects of removed files that are still waiting (normally done after each delete).
// Everyone else with admin access sees how full the storage is and where new files go (queries/files.ts).
//
// Time: the Admin page (whose Server Actions these are) may run for maxDuration = 60 s. Each R2 request here gets at
// most ADMIN_TOOL_TIMEOUT_MS, and the move and the clean-up stop starting new work after 25 s, so even an R2 that
// answers as slowly as it's allowed to (a request in flight at the deadline, plus one delete) ends well inside it.
import { formatFileSize } from "@/lib/files";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError } from "../errors";
import {
  confirmStorageKeys,
  deferStorageKeys,
  drainFileDeletions,
  type DrainResult,
  FILE_KINDS,
  type FileKind,
  newStorageKey,
  type ObjectStore,
  ObjectStoreError,
  objectStoreErrorMessage,
  releaseStorageKeys,
  reserveStorageKeys,
  settleFailedUploads,
  sha256Hex,
  uploadMayStillLand,
} from "../files/object-store";
import { fileTable, type StoredFileTotals, storedFileTotals } from "../files/storage";
import { canManageFileStorage } from "../permissions";
import { enforceRateLimit } from "../rate-limit";

export const FILE_STORAGE_OWNERS_ONLY = "Only owners can manage where the team's files are stored.";
export const R2_NOT_SET_UP =
  "Cloudflare R2 isn't set up yet. Add R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET in Vercel, then redeploy.";

const MINUTE = 60 * 1000;

/** How long one R2 request may take in the owners' tools (uploads are at most 4 MB). */
export const ADMIN_TOOL_TIMEOUT_MS = 10_000;
/** The owners' tools stop starting new work after this long (see the note at the top). */
const ADMIN_TOOL_BUDGET_MS = 25_000;

function assertOwner(ctx: ServiceContext): void {
  if (ctx.actor.status !== "ACTIVE" || !canManageFileStorage(ctx.actor)) throw new ForbiddenError(FILE_STORAGE_OWNERS_ONLY);
}

/** R2, with the owners' tools' shorter timeout per request. */
function requireStore(ctx: ServiceContext): ObjectStore {
  if (!ctx.objectStore) throw new ConflictError(R2_NOT_SET_UP);
  return ctx.objectStore.withTimeout(ADMIN_TOOL_TIMEOUT_MS);
}

// ---------- test connection ----------

export type ConnectionTest =
  | { ok: true; ms: number }
  | { ok: false; step: "save" | "read" | "delete"; error: string };

/**
 * Saves a tiny file in R2 under a new "connection-test/…" key, reads it back, and deletes it. Says which step failed
 * and why (R2's error code, never the keys). A test file that can't be deleted is left on the deletion list: deleted
 * now when R2 answered, or in 10 minutes when it didn't (it may still land; nothing more is sent to R2 now).
 */
export async function testFileStorage(ctx: ServiceContext): Promise<ConnectionTest> {
  assertOwner(ctx);
  const store = requireStore(ctx);
  await enforceRateLimit(ctx.db, `file-storage-test:${ctx.actor.id}`, 10, 10 * MINUTE, ctx.now);

  const started = Date.now();
  const key = newStorageKey("connection-test");
  const body = new TextEncoder().encode(`Huskyteers Portal connection test, ${new Date().toISOString()}`);
  await reserveStorageKeys(ctx.db, [key]);
  let step: "save" | "read" | "delete" = "save";
  try {
    await store.putObject(key, body);
    step = "read";
    const back = await store.getObjectBytes(key);
    if (!back || Buffer.compare(Buffer.from(back), Buffer.from(body)) !== 0) {
      throw new ObjectStoreError("Cloudflare R2 sent back something different from the test file.");
    }
    step = "delete";
    await store.deleteObject(key);
  } catch (e) {
    if (uploadMayStillLand(e)) await deferStorageKeys(ctx.db, [key]);
    else await releaseStorageKeys(ctx.db, store, [key]);
    return { ok: false, step, error: objectStoreErrorMessage(e) };
  }
  await ctx.db.fileDeletion.deleteMany({ where: { storageKey: key } });
  return { ok: true, ms: Date.now() - started };
}

/** What the owner sees after "Test connection". */
export function connectionTestMessage(result: ConnectionTest): string {
  if (result.ok) {
    return `Connected. Cloudflare R2 saved, read back, and deleted a test file (${(result.ms / 1000).toFixed(1)} s). New files go there now.`;
  }
  const what = { save: "save a test file", read: "read the test file back", delete: "delete the test file" }[result.step];
  return `Couldn't ${what}. ${result.error}`;
}

// ---------- files still in the database ----------

export interface MoveResult {
  moved: number;
  movedBytes: number;
  /** Files that couldn't be moved this time (they stay in the database; the next click tries again). */
  failed: number;
  /** Still in the database afterwards. */
  remaining: StoredFileTotals;
  /** Stopped because time ran out (click again to continue). */
  outOfTime: boolean;
  /** The first error from R2, when there was one (safe to show an owner). */
  error: string | null;
}

/** Stop starting new files after this long, so one click stays well inside the server's time limit. */
export const MOVE_TIME_BUDGET_MS = ADMIN_TOOL_BUDGET_MS;
/** R2 errors in a row that stop a click early (R2 is probably not set up right). */
const MOVE_MAX_ERRORS_IN_A_ROW = 3;
const MOVE_PARALLEL = 3;

/**
 * Moves one file row from Postgres to R2: uploads its bytes under a new key, then — only if the row is still in the
 * database with the same bytes — sets storageKey and clears data in one conditional update. If the row changed or
 * went away meanwhile, the new object is deleted again (an upload R2 didn't answer: 10 minutes later, since it may
 * still land). Returns the bytes moved (0 = not moved, nothing to do).
 */
async function moveOne(ctx: ServiceContext, store: ObjectStore, kind: FileKind, id: string): Promise<number> {
  const rows = await ctx.db.$queryRaw<{ data: Uint8Array | null }[]>`
    SELECT "data" FROM ${fileTable(kind)} WHERE "id" = ${id} AND "storageKey" IS NULL`;
  const row = rows[0];
  if (!row?.data) return 0;
  const bytes = new Uint8Array(row.data);
  const key = newStorageKey(kind);
  await reserveStorageKeys(ctx.db, [key]);
  try {
    await store.putObject(key, bytes);
  } catch (e) {
    await settleFailedUploads(ctx.db, store, [key], [{ status: "rejected", reason: e }]);
    throw e;
  }
  let updated = 0;
  try {
    updated = await ctx.db.$executeRaw`
      UPDATE ${fileTable(kind)} SET "storageKey" = ${key}, "data" = NULL
      WHERE "id" = ${id} AND "storageKey" IS NULL AND "data" IS NOT NULL AND encode(sha256("data"), 'hex') = ${sha256Hex(bytes)}`;
  } catch (e) {
    await releaseStorageKeys(ctx.db, store, [key]);
    throw e;
  }
  if (updated === 0) {
    await releaseStorageKeys(ctx.db, store, [key]);
    return 0;
  }
  await confirmStorageKeys(ctx.db, [key]);
  return bytes.byteLength;
}

/**
 * Moves files stored in Postgres to Cloudflare R2 (owners only): every kind, in id order, a few at a time,
 * until they're all moved or `budgetMs` runs out. Safe to run again (and at the same time as uploads): each file is
 * switched over by a conditional update, so a file replaced or removed meanwhile is never overwritten.
 */
export async function moveFilesToObjectStorage(ctx: ServiceContext, options: { budgetMs?: number } = {}): Promise<MoveResult> {
  assertOwner(ctx);
  const store = requireStore(ctx);
  await enforceRateLimit(ctx.db, `file-storage-move:${ctx.actor.id}`, 60, 60 * MINUTE, ctx.now);

  const deadline = Date.now() + (options.budgetMs ?? MOVE_TIME_BUDGET_MS);
  const result: MoveResult = { moved: 0, movedBytes: 0, failed: 0, remaining: { count: 0, bytes: 0 }, outOfTime: false, error: null };
  let errorsInARow = 0;

  outer: for (const kind of FILE_KINDS) {
    let after = "";
    for (;;) {
      if (Date.now() > deadline) {
        result.outOfTime = true;
        break outer;
      }
      // Each row is tried once per click (ids in order), so one that keeps failing can't hold up the rest.
      const batch = await ctx.db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM ${fileTable(kind)} WHERE "storageKey" IS NULL AND "data" IS NOT NULL AND "id" > ${after}
        ORDER BY "id" LIMIT ${MOVE_PARALLEL}`;
      if (batch.length === 0) break;
      after = batch[batch.length - 1].id;
      const outcomes = await Promise.all(
        batch.map((r) =>
          moveOne(ctx, store, kind, r.id).then(
            (bytes) => ({ bytes, error: null as string | null }),
            (e: unknown) => ({ bytes: 0, error: objectStoreErrorMessage(e) }),
          ),
        ),
      );
      for (const o of outcomes) {
        if (o.error) {
          result.failed++;
          result.error ??= o.error;
          errorsInARow++;
        } else {
          errorsInARow = 0;
          if (o.bytes > 0) {
            result.moved++;
            result.movedBytes += o.bytes;
          }
        }
      }
      if (errorsInARow >= MOVE_MAX_ERRORS_IN_A_ROW) break outer;
    }
  }
  result.remaining = (await storedFileTotals(ctx.db)).database;
  return result;
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** What the owner sees after "Move files". */
export function moveResultMessage(r: MoveResult): string {
  const parts: string[] = [];
  parts.push(r.moved > 0 ? `Moved ${files(r.moved)} (${formatFileSize(r.movedBytes)}) to Cloudflare R2.` : "No files were moved.");
  if (r.remaining.count === 0) parts.push("Every file is in Cloudflare R2 now.");
  else if (r.error) parts.push(`${files(r.remaining.count)} (${formatFileSize(r.remaining.bytes)}) are still in the database. ${r.error}`);
  else parts.push(`${files(r.remaining.count)} (${formatFileSize(r.remaining.bytes)}) are still in the database — click Move again to continue.`);
  return parts.join(" ");
}

// ---------- clean up ----------

/**
 * Deletes R2 objects of removed files that are still waiting (owners only), as many as fit in the time budget —
 * including ones that failed too often for the automatic cleanups (FILE_DELETION_MAX_AUTO_ATTEMPTS).
 */
export async function cleanUpFileStorage(ctx: ServiceContext): Promise<DrainResult> {
  assertOwner(ctx);
  const store = requireStore(ctx);
  await enforceRateLimit(ctx.db, `file-storage-cleanup:${ctx.actor.id}`, 30, 10 * MINUTE, ctx.now);
  return drainFileDeletions(ctx.db, { store, limit: 1000, budgetMs: ADMIN_TOOL_BUDGET_MS, includeStuck: true });
}

/** What the owner sees after "Clean up". */
export function cleanUpMessage(r: DrainResult): string {
  const done = r.deleted + r.kept;
  const first = done > 0 ? `Cleaned up ${files(done)}.` : "Nothing was cleaned up.";
  if (r.remaining === 0) return `${first} Nothing is waiting.`;
  return `${first} ${files(r.remaining)} still waiting${r.error ? `: ${r.error}` : " — click Clean up again."}`;
}
