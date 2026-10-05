import "server-only";
// Cloudflare R2 (S3-compatible) for uploaded files, when the R2_* settings are set (env.r2). A tiny client of our
// own: AWS Signature Version 4 (region "auto", service "s3") with node:crypto, path-style URLs /<bucket>/<key>.
//
// - Object keys are made here only: "<kind>/<random>" (newStorageKey) — never a filename or anything a person typed.
// - The bucket stays private: files are always sent through our own routes (src/server/files/respond.ts) with the
//   same permission checks and headers as files in Postgres. Never redirect to R2 or hand out R2 URLs.
// - The endpoint comes only from the settings (never from a request), and errors never include the keys or the
//   signature (ObjectStoreError messages are safe to show an owner).
// - FileDeletion is the list of objects to delete. Database triggers add a file's key when its row is deleted
//   (including cascades) or its key changes; drainFileDeletions() deletes them from R2. New uploads are "reserved"
//   there first (due in an hour) so an upload whose row never gets saved (a crash, a timeout) is cleaned up too.
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "../db";
import { env, type R2Config } from "../env";

// ---------------------------------------------------------------------------------------------
// Signing (AWS Signature Version 4)
// ---------------------------------------------------------------------------------------------

export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** "20130524T000000Z". */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export interface SignInput {
  method: string;
  url: URL;
  /** Headers to sign besides host (lower- or mixed-case names). x-amz-date and x-amz-content-sha256 are added. */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body (EMPTY_PAYLOAD_SHA256 for none). */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
}

/**
 * The headers for a request signed with AWS Signature Version 4: the given ones plus x-amz-date,
 * x-amz-content-sha256, and Authorization. `host` is signed but not returned (fetch sets it from the URL).
 */
export function signV4(input: SignInput): Record<string, string> {
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) headers[name.toLowerCase()] = value;
  headers["x-amz-date"] = stamp;
  headers["x-amz-content-sha256"] = input.payloadHash;
  const signed: Record<string, string> = { ...headers, host: input.url.host };
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  // The path as sent (already encoded once, see objectUrl); S3 doesn't encode it again.
  const canonicalRequest = [input.method, input.url.pathname || "/", canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

/** Something went wrong talking to R2. The message is safe to show an owner (no keys, no signatures). */
export class ObjectStoreError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  constructor(message: string, options: { status?: number | null; code?: string | null } = {}) {
    super(message);
    this.name = "ObjectStoreError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** A file being read from R2: its bytes as a stream (send it on, or read it with readObjectBytes). */
export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  /** From R2's Content-Length, when it sent one. */
  contentLength: number | null;
}

export interface ObjectStore {
  /**
   * Saves bytes under `key`. R2 always gets them as `application/octet-stream` with `Content-Disposition: attachment`
   * (never the upload's type): we never serve R2's metadata (every header comes from the row, see respond.ts), and if
   * the bucket were ever made public by mistake, an uploaded HTML or SVG file still couldn't run as a page there.
   */
  putObject(key: string, bytes: Uint8Array): Promise<void>;
  /**
   * The object, or null when there's no object with this key. Its body errors if R2 stops sending for as long as the
   * timeout (only while we're waiting on R2: a slow reader downstream never trips it).
   */
  getObject(key: string): Promise<StoredObject | null>;
  /** The whole object in memory (files are at most a few MB), or null when there's none. */
  getObjectBytes(key: string): Promise<Uint8Array | null>;
  /** Deleting an object that isn't there is fine (R2 answers 204 either way). */
  deleteObject(key: string): Promise<void>;
  /** The same client with another timeout per request (the owners' tools use a shorter one, see file-storage.ts). */
  withTimeout(timeoutMs: number): ObjectStore;
}

export interface ObjectStoreOptions {
  /** For tests. */
  fetch?: typeof fetch;
  /**
   * How long to wait for R2 to answer (for a PUT: sending the file too; for a read: until the file starts arriving,
   * then for each next part of it). Default 20 s.
   */
  timeoutMs?: number;
  /** For tests. */
  now?: () => Date;
}

export const OBJECT_STORE_TIMEOUT_MS = 20_000;
const ERROR_BODY_MAX = 4096;

/** "<Code>AccessDenied</Code>" → "AccessDenied" (only a plain word, never the rest of the XML). */
function errorCode(xml: string): string | null {
  const m = /<Code>([A-Za-z0-9._-]{1,64})<\/Code>/.exec(xml);
  return m ? m[1] : null;
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const text = await res.text();
    return errorCode(text.slice(0, ERROR_BODY_MAX));
  } catch {
    return null;
  }
}

function seconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} ${s === 1 ? "second" : "seconds"}`;
}

/** A timeout or a failed connection: R2 never answered (status null), so an upload may still have been saved. */
function describeFetchError(e: unknown, timedOut: boolean, timeoutMs: number): ObjectStoreError {
  if (timedOut) return new ObjectStoreError(`Cloudflare R2 didn't answer within ${seconds(timeoutMs)}.`);
  const cause = e instanceof Error && e.cause && typeof e.cause === "object" ? (e.cause as { code?: unknown }).code : undefined;
  const code = typeof cause === "string" && /^[A-Z0-9_]{2,40}$/.test(cause) ? cause : null;
  return new ObjectStoreError(`Couldn't reach Cloudflare R2${code ? ` (${code})` : ""}.`, { code });
}

function refused(what: string, status: number, code: string | null): ObjectStoreError {
  const hint =
    status === 403 || code === "AccessDenied" || code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId"
      ? " Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and that the token can read and write this bucket."
      : code === "NoSuchBucket"
        ? " Check R2_BUCKET (the bucket's exact name)."
        : "";
  return new ObjectStoreError(`Cloudflare R2 refused to ${what}: ${code ?? "error"} (${status}).${hint}`, { status, code });
}

/**
 * An R2 object's body, passed on chunk by chunk. While we wait for R2's next chunk (only then: when whoever reads this
 * is slow, nothing is asked of R2 and no timer runs), R2 has `idleMs` to send it; otherwise the download is cut off
 * (`abort`) and the stream errors, so a stalled R2 can't hold a file route open until the server's time limit.
 * Cancelling this stream (the browser went away) cancels the download from R2.
 */
function idleTimeoutBody(body: ReadableStream<Uint8Array>, idleMs: number, abort: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ObjectStoreError(`Cloudflare R2 stopped sending the file for ${seconds(idleMs)}.`)), idleMs);
      });
      try {
        const chunk = await Promise.race([reader.read(), stalled]);
        if (cancelled) return; // the reader went away meanwhile
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (e) {
        abort();
        reader.cancel().catch(() => {});
        if (cancelled) return;
        const error = e instanceof ObjectStoreError ? e : describeFetchError(e, false, idleMs);
        console.error(`[files] a download from Cloudflare R2 stopped: ${error.message}`);
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason).catch(() => {});
    },
  });
}

/** A client for one bucket. Nothing is contacted until a method is called. */
export function createObjectStore(config: R2Config, options: ObjectStoreOptions = {}): ObjectStore {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? OBJECT_STORE_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const base = new URL(config.endpoint);

  function objectUrl(key: string): URL {
    if (!isStorageKey(key)) throw new ObjectStoreError("That isn't a file storage key.");
    const path = [config.bucket, ...key.split("/")].map(rfc3986).join("/");
    return new URL(`/${path}`, base);
  }

  /**
   * Sends a signed request. The timeout covers waiting for R2's answer (for a PUT, sending the file too); with
   * `holdTimeout` it keeps running until `done()` (while the caller reads the whole body). `abort()` cuts the request
   * (and its body) off.
   */
  async function send(
    method: string,
    key: string,
    body: Uint8Array | null,
    options: { signed?: Record<string, string>; unsigned?: Record<string, string>; holdTimeout?: boolean } = {},
  ): Promise<{ res: Response; done: () => void; timedOut: () => boolean; abort: () => void }> {
    const url = objectUrl(key);
    const headers = signV4({
      method,
      url,
      headers: options.signed ?? {},
      payloadHash: body ? sha256Hex(body) : EMPTY_PAYLOAD_SHA256,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      region: "auto",
      service: "s3",
      date: now(),
    });
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const done = () => clearTimeout(timer);
    try {
      const res = await doFetch(url, {
        method,
        headers: { ...options.unsigned, ...headers },
        body: body ? new Uint8Array(body) : undefined,
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!options.holdTimeout) done();
      return { res, done, timedOut: () => timedOut, abort: () => controller.abort() };
    } catch (e) {
      done();
      throw describeFetchError(e, timedOut, timeoutMs);
    }
  }

  /**
   * A 404 for the object means there's no such object; a missing bucket (wrong R2_BUCKET) is an error, so it's never
   * mistaken for "already deleted" or "missing file".
   */
  async function isNoSuchObject(res: Response): Promise<boolean> {
    if (res.status !== 404) return false;
    const code = await readErrorCode(res);
    if (code === "NoSuchBucket") throw refused("find the bucket", 404, code);
    return true;
  }

  /**
   * A 404 is "no such object"; anything else that isn't OK is an error. Asks for the bytes as they are
   * (`Accept-Encoding: identity`, otherwise fetch asks for gzip and unpacks it, and R2's Content-Length would then be
   * the packed size).
   */
  async function openObject(key: string, holdTimeout: boolean) {
    const sent = await send("GET", key, null, { unsigned: { "accept-encoding": "identity" }, holdTimeout });
    const { res } = sent;
    if (res.status === 404) {
      sent.done();
      if (await isNoSuchObject(res)) return null;
    }
    if (!res.ok || !res.body) {
      sent.done();
      throw refused("send a file", res.status, await readErrorCode(res));
    }
    return sent;
  }

  return {
    async putObject(key, bytes) {
      const { res } = await send("PUT", key, bytes, {
        signed: { "content-type": "application/octet-stream", "content-disposition": "attachment" },
      });
      if (!res.ok) throw refused("save a file", res.status, await readErrorCode(res));
      await res.body?.cancel().catch(() => {});
    },
    async getObject(key) {
      const sent = await openObject(key, false);
      if (!sent) return null;
      const { res } = sent;
      // R2's length is only the file's when the body wasn't packed on the way (unpacked by fetch, so longer).
      const encoding = res.headers.get("content-encoding")?.trim().toLowerCase();
      const plain = !encoding || encoding === "identity";
      const length = Number(res.headers.get("content-length"));
      return {
        body: idleTimeoutBody(res.body!, timeoutMs, sent.abort),
        contentLength: plain && res.headers.has("content-length") && Number.isSafeInteger(length) && length >= 0 ? length : null,
      };
    },
    async getObjectBytes(key) {
      const sent = await openObject(key, true);
      if (!sent) return null;
      try {
        return new Uint8Array(await sent.res.arrayBuffer());
      } catch (e) {
        throw describeFetchError(e, sent.timedOut(), timeoutMs);
      } finally {
        sent.done();
      }
    },
    async deleteObject(key) {
      const { res } = await send("DELETE", key, null);
      if (await isNoSuchObject(res)) return;
      if (!res.ok) throw refused("delete a file", res.status, await readErrorCode(res));
      await res.body?.cancel().catch(() => {});
    },
    withTimeout(ms) {
      return createObjectStore(config, { ...options, timeoutMs: ms });
    },
  };
}

/** The store for the R2_* settings, or null when they aren't all set (files then stay in Postgres). */
export function getObjectStore(): ObjectStore | null {
  const config = env.r2;
  return config ? createObjectStore(config) : null;
}

/** Whether new uploads go to Cloudflare R2 (all four R2_* settings are set). */
export function objectStorageEnabled(): boolean {
  return env.r2 !== null;
}

/** A short, safe description of what went wrong (for logs and owners). */
export function objectStoreErrorMessage(e: unknown): string {
  return e instanceof ObjectStoreError ? e.message : "Something went wrong talking to Cloudflare R2.";
}

// ---------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------

/** What a stored file is, which is also the first part of its key. */
export const FILE_KINDS = ["resources", "sponsors", "posters", "notebook", "strategy", "logos", "workshop-photos", "workshop-files"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** Keys we make: "<kind>/<24 random url-safe characters>" (plus "connection-test/…" for the owner's test). */
const KEY_RE = /^(resources|sponsors|posters|notebook|strategy|logos|workshop-photos|workshop-files|connection-test)\/[A-Za-z0-9_-]{24}$/;

export function isStorageKey(key: string): boolean {
  return KEY_RE.test(key);
}

/** A new, unguessable object key (144 random bits). Never contains a filename or anything a person typed. */
export function newStorageKey(kind: FileKind | "connection-test"): string {
  return `${kind}/${randomBytes(18).toString("base64url")}`;
}

// ---------------------------------------------------------------------------------------------
// The deletion queue (FileDeletion)
// ---------------------------------------------------------------------------------------------
//
// FileDeletion."createdAt" is when the object may be deleted. Triggers add rows due right away; reservations for
// uploads in progress are due in an hour, uploads that may still land (R2 didn't answer) in 10 minutes. Every time here
// comes from the database's clock (CURRENT_TIMESTAMP), in SQL, so it matches the triggers' rows whatever the server's
// time zone.

/**
 * Some file row still uses this key (then its object must never be deleted). `f` is the FileDeletion row.
 * Each check locks the row it finds (FOR KEY SHARE), so it waits for a delete (or key change) of that row that hasn't
 * committed yet, and then sees it gone. Without the lock it would see the row as still there and drop the queue entry,
 * while the delete's trigger found that entry already there (ON CONFLICT DO NOTHING) — and nothing would ever delete
 * the object.
 */
const KEY_IN_USE = Prisma.sql`(
  EXISTS (SELECT 1 FROM "ResourceFile" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
  OR EXISTS (SELECT 1 FROM "SponsorshipFile" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
  OR EXISTS (SELECT 1 FROM "PosterFile" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
  OR EXISTS (SELECT 1 FROM "NotebookImage" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
  OR EXISTS (SELECT 1 FROM "StrategyFile" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
  OR EXISTS (SELECT 1 FROM "SponsorshipLogo" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
  OR EXISTS (SELECT 1 FROM "WorkshopPhoto" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
  OR EXISTS (SELECT 1 FROM "WorkshopFile" x WHERE x."storageKey" = f."storageKey" FOR KEY SHARE)
)`;

/** How long an upload has to get its row saved before its object counts as left behind. */
const RESERVATION = Prisma.sql`interval '1 hour'`;

/**
 * How long to wait before deleting an upload R2 didn't answer (a timeout, a dropped connection): R2 may still save a
 * file it already received after we gave up, so it's deleted once that can no longer happen.
 */
const UNSETTLED = Prisma.sql`interval '10 minutes'`;

/**
 * Due for deletion. "createdAt" is stored to the millisecond (rounded, so a row added a moment ago can look a few
 * hundred microseconds in the future); a minute of slack covers that and still leaves reservations (an hour) and
 * unsettled uploads (10 minutes) out.
 */
const DUE = Prisma.sql`"createdAt" <= CURRENT_TIMESTAMP + interval '1 minute'`;

/**
 * Failed deletes after which a queued object is only tried again when an owner presses Clean up (not after every
 * delete or visit to the storage card), so one R2 keeps refusing isn't retried forever in the background.
 */
export const FILE_DELETION_MAX_AUTO_ATTEMPTS = 20;

/** Queue rows the automatic cleanups still try (`includeStuck`: the owner's Clean up, every due row). */
function tried(includeStuck: boolean): Prisma.Sql {
  return includeStuck ? Prisma.sql`TRUE` : Prisma.sql`"attempts" < ${FILE_DELETION_MAX_AUTO_ATTEMPTS}`;
}

/**
 * Before uploading: puts the new keys on the deletion list, due in an hour. confirmStorageKeys takes them off once
 * their rows are saved; if that never happens (a crash, a timeout), the object is deleted later like any other.
 */
export async function reserveStorageKeys(db: Db, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db.$executeRaw`
    INSERT INTO "FileDeletion" ("storageKey", "createdAt")
    SELECT k, CURRENT_TIMESTAMP + ${RESERVATION} FROM unnest(${keys}::text[]) AS k
    ON CONFLICT ("storageKey") DO NOTHING`;
}

/**
 * After the rows are saved: takes the keys that rows use off the deletion list. A key no row uses (its file was
 * removed meanwhile) becomes due now instead. Never throws: a leftover reservation is harmless (the drain skips
 * keys that are in use). One key per statement, so this never holds one file row's lock while it waits for another's
 * (a delete of several files at once locks them in its own order).
 */
export async function confirmStorageKeys(db: Db, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await db.$executeRaw`DELETE FROM "FileDeletion" f WHERE f."storageKey" = ${key} AND ${KEY_IN_USE}`;
      await db.$executeRaw`
        UPDATE "FileDeletion" SET "createdAt" = CURRENT_TIMESTAMP
        WHERE "storageKey" = ${key} AND NOT (${DUE})`;
    } catch (e) {
      console.error("[files] couldn't confirm a stored file (it stays on the deletion list, which skips files in use)", e);
    }
  }
}

/**
 * Deletes one queued object unless a file row still uses it, then takes it off the list. On failure the attempt is
 * counted and it stays for next time. Returns what happened.
 */
async function deleteQueuedObject(db: Db, store: ObjectStore, key: string): Promise<"deleted" | "kept" | "failed"> {
  const kept = await db.$executeRaw`DELETE FROM "FileDeletion" f WHERE f."storageKey" = ${key} AND ${KEY_IN_USE}`;
  if (kept > 0) return "kept";
  try {
    await store.deleteObject(key);
  } catch (e) {
    await db.$executeRaw`UPDATE "FileDeletion" SET "attempts" = "attempts" + 1 WHERE "storageKey" = ${key}`;
    throw e;
  }
  await db.$executeRaw`DELETE FROM "FileDeletion" WHERE "storageKey" = ${key}`;
  return "deleted";
}

/**
 * Uploaded objects whose rows weren't saved (the save failed, or R2 answered an upload with an error): due now, and
 * deleted right away when R2 answers (otherwise by the next drain). Only for uploads that are over (R2 answered them):
 * one still on its way could land after this delete — see settleFailedUploads. Never throws.
 */
export async function releaseStorageKeys(db: Db, store: ObjectStore, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await db.$executeRaw`
      INSERT INTO "FileDeletion" ("storageKey", "createdAt")
      SELECT k, CURRENT_TIMESTAMP FROM unnest(${keys}::text[]) AS k
      ON CONFLICT ("storageKey") DO UPDATE SET "createdAt" = CURRENT_TIMESTAMP`;
  } catch (e) {
    console.error("[files] couldn't queue unsaved uploads for deletion", e);
  }
  await Promise.all(
    keys.map((key) =>
      deleteQueuedObject(db, store, key).catch((e) => {
        console.error(`[files] couldn't delete an unsaved upload yet: ${objectStoreErrorMessage(e)}`);
      }),
    ),
  );
}

/**
 * Whether a failed upload may still end up in R2: R2 never answered (a timeout, a dropped connection), so it may save
 * the file after we gave up. When R2 answered (even with an error), the upload is over.
 */
export function uploadMayStillLand(error: unknown): boolean {
  return !(error instanceof ObjectStoreError && error.status !== null);
}

/**
 * Uploads that R2 didn't answer: due for deletion in 10 minutes rather than now, so the drain deletes whatever lands
 * (a delete sent now could arrive before the upload and leave it behind with nothing tracking it). Nothing is sent to
 * R2 here. Never throws.
 */
export async function deferStorageKeys(db: Db, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await db.$executeRaw`
      INSERT INTO "FileDeletion" ("storageKey", "createdAt")
      SELECT k, CURRENT_TIMESTAMP + ${UNSETTLED} FROM unnest(${keys}::text[]) AS k
      ON CONFLICT ("storageKey") DO UPDATE SET "createdAt" = CURRENT_TIMESTAMP + ${UNSETTLED}`;
  } catch (e) {
    console.error("[files] couldn't queue unfinished uploads for deletion (their reservations still expire in an hour)", e);
  }
}

/**
 * After uploads under `keys` (reserved first) didn't all succeed (`results`, same order): ones R2 didn't answer are
 * deferred (deferStorageKeys); every other one is over and released now (releaseStorageKeys). Never throws.
 */
export async function settleFailedUploads(db: Db, store: ObjectStore, keys: string[], results: PromiseSettledResult<unknown>[]): Promise<void> {
  const unsettled = keys.filter((_, i) => results[i]?.status === "rejected" && uploadMayStillLand((results[i] as PromiseRejectedResult).reason));
  await deferStorageKeys(db, unsettled);
  await releaseStorageKeys(
    db,
    store,
    keys.filter((k) => !unsettled.includes(k)),
  );
}

export interface DrainResult {
  /** Objects deleted from R2. */
  deleted: number;
  /** Queued keys that a file still uses: taken off the list, object kept. */
  kept: number;
  /** Deletes that failed this time (they stay queued, with one more attempt counted). */
  failed: number;
  /** Still due after this run (failed ones, and any past `limit` or the time budget). */
  remaining: number;
  /** What went wrong first, when something did (safe to show an owner). */
  error: string | null;
}

/**
 * How many queued deletions are due now. Without `includeStuck`, only the ones the automatic cleanups still try
 * (fewer than FILE_DELETION_MAX_AUTO_ATTEMPTS failed attempts).
 */
export async function countDueFileDeletions(db: Db, options: { includeStuck?: boolean } = {}): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint | number }[]>`
    SELECT count(*) AS n FROM "FileDeletion" WHERE ${DUE} AND ${tried(options.includeStuck ?? false)}`;
  return Number(rows[0]?.n ?? 0);
}

/** Due deletions that failed FILE_DELETION_MAX_AUTO_ATTEMPTS times: only tried again by the owner's Clean up. */
export async function countStuckFileDeletions(db: Db): Promise<number> {
  const rows = await db.$queryRaw<{ n: bigint | number }[]>`
    SELECT count(*) AS n FROM "FileDeletion" WHERE ${DUE} AND "attempts" >= ${FILE_DELETION_MAX_AUTO_ATTEMPTS}`;
  return Number(rows[0]?.n ?? 0);
}

/** Runs `fn` over `items`, `size` at a time. */
async function inBatches<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/**
 * Deletes due objects on the deletion list from R2 (up to `limit`, while `budgetMs` lasts), then takes them off the
 * list; keys a file still uses are only taken off. Never throws: a failed delete stays queued with its attempt
 * counted (ones that keep failing go last, and after FILE_DELETION_MAX_AUTO_ATTEMPTS only `includeStuck` — the owner's
 * Clean up — tries them), and a database error just ends the run.
 * `store` defaults to the R2_* settings; without them nothing is deleted.
 */
export async function drainFileDeletions(
  db: Db,
  options: { store?: ObjectStore | null; limit?: number; budgetMs?: number; includeStuck?: boolean } = {},
): Promise<DrainResult> {
  const store = options.store === undefined ? getObjectStore() : options.store;
  const limit = options.limit ?? 100;
  const includeStuck = options.includeStuck ?? false;
  const deadline = Date.now() + (options.budgetMs ?? 20_000);
  const result: DrainResult = { deleted: 0, kept: 0, failed: 0, remaining: 0, error: null };
  try {
    if (!store) {
      result.remaining = await countDueFileDeletions(db, { includeStuck });
      if (result.remaining > 0) result.error = "Cloudflare R2 isn't set up, so nothing can be deleted from it.";
      return result;
    }
    const due = await db.$queryRaw<{ storageKey: string }[]>`
      SELECT "storageKey" FROM "FileDeletion"
      WHERE ${DUE} AND ${tried(includeStuck)}
      ORDER BY "attempts" ASC, "createdAt" ASC
      LIMIT ${limit}`;
    await inBatches(due, 5, async ({ storageKey }) => {
      if (Date.now() > deadline) return;
      try {
        const outcome = await deleteQueuedObject(db, store, storageKey);
        result[outcome]++;
      } catch (e) {
        result.failed++;
        result.error ??= objectStoreErrorMessage(e);
      }
    });
    result.remaining = await countDueFileDeletions(db, { includeStuck });
  } catch (e) {
    console.error("[files] cleaning up deleted files failed", e);
    result.error ??= "The database didn't answer. Try again in a minute.";
  }
  return result;
}
