// The Cloudflare R2 client (src/server/files/object-store.ts): AWS Signature V4, the R2_* settings, talking to a
// fake R2 (tests/helpers/fake-s3.ts), object keys, and the deletion queue (FileDeletion + drainFileDeletions).
import { NextRequest } from "next/server";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, readR2Status } from "@/server/env";
import {
  confirmStorageKeys,
  countDueFileDeletions,
  countStuckFileDeletions,
  deferStorageKeys,
  drainFileDeletions,
  EMPTY_PAYLOAD_SHA256,
  FILE_DELETION_MAX_AUTO_ATTEMPTS,
  getObjectStore,
  isStorageKey,
  newStorageKey,
  ObjectStoreError,
  objectStorageEnabled,
  reserveStorageKeys,
  sha256Hex,
  signV4,
  uploadMayStillLand,
} from "@/server/files/object-store";
import { sendStoredFile } from "@/server/files/respond";
import { createTestDb, type TestDb } from "./helpers/db";
import { FAKE_BUCKET, type FakeS3, startFakeS3 } from "./helpers/fake-s3";

let t: TestDb;
let s3: FakeS3;

beforeAll(async () => {
  t = await createTestDb();
  s3 = await startFakeS3();
});
afterAll(async () => {
  await s3.close();
  await t.drop();
});
afterEach(() => s3.reset());

describe("AWS Signature Version 4", () => {
  // The worked examples from Amazon's S3 documentation ("Signature Calculations for the Authorization Header").
  const creds = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const date = new Date("2013-05-24T00:00:00Z");

  it("matches Amazon's GET Object example", () => {
    const headers = signV4({
      ...creds,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9" },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: "us-east-1",
      service: "s3",
      date,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(headers["x-amz-date"]).toBe("20130524T000000Z");
    expect(headers["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
    expect(headers.host).toBeUndefined(); // fetch sets it from the URL
  });

  it("matches Amazon's PUT Object example (an encoded key and a body)", () => {
    const body = "Welcome to Amazon S3.";
    expect(sha256Hex(body)).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const headers = signV4({
      ...creds,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      headers: { Date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: sha256Hex(body),
      region: "us-east-1",
      service: "s3",
      date,
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });
});

describe("the R2_* settings", () => {
  const all = { R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "huskyteers-portal-files" };

  it("are on only when all four are set; the endpoint is the account's R2 address", () => {
    expect(readR2Status({})).toEqual({ state: "off" });
    expect(readR2Status({ R2_ACCOUNT_ID: " ", R2_BUCKET: "" })).toEqual({ state: "off" });
    expect(readR2Status(all)).toEqual({
      state: "on",
      config: {
        accountId: all.R2_ACCOUNT_ID,
        accessKeyId: "key",
        secretAccessKey: "secret",
        bucket: "huskyteers-portal-files",
        endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      },
    });
  });

  it("partly set = off, naming what's missing (never the values)", () => {
    const status = readR2Status({ ...all, R2_SECRET_ACCESS_KEY: "", R2_BUCKET: "  " });
    expect(status).toEqual({ state: "partial", missing: ["R2_SECRET_ACCESS_KEY", "R2_BUCKET"] });
    expect(JSON.stringify(status)).not.toContain("key");
  });

  it("set but unusable = off with the reason: a bad account id, bucket name, or endpoint", () => {
    expect(readR2Status({ ...all, R2_ACCOUNT_ID: "evil.com/x" })).toMatchObject({ state: "invalid" });
    expect(readR2Status({ ...all, R2_BUCKET: "My Bucket" })).toMatchObject({ state: "invalid" });
    // No SSRF: the endpoint only ever comes from settings, https (plain http only for this computer), no path.
    expect(readR2Status({ ...all, R2_ENDPOINT: "http://example.com" })).toMatchObject({ state: "invalid" });
    expect(readR2Status({ ...all, R2_ENDPOINT: "https://example.com/other" })).toMatchObject({ state: "invalid" });
    expect(readR2Status({ ...all, R2_ENDPOINT: "https://u:p@example.com" })).toMatchObject({ state: "invalid" });
    expect(readR2Status({ ...all, R2_ENDPOINT: "not a url" })).toMatchObject({ state: "invalid" });
    expect(readR2Status({ ...all, R2_ENDPOINT: "http://127.0.0.1:9000" })).toMatchObject({ state: "on", config: { endpoint: "http://127.0.0.1:9000" } });
    expect(readR2Status({ ...all, R2_ENDPOINT: "https://r2.example.com/" })).toMatchObject({ state: "on", config: { endpoint: "https://r2.example.com" } });
  });

  it("on the live site (production), R2_ENDPOINT can only be an https Cloudflare R2 address", () => {
    const live = { ...all, NODE_ENV: "production" };
    expect(readR2Status(live)).toMatchObject({ state: "on", config: { endpoint: `https://${all.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` } });
    const eu = `https://${all.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`;
    expect(readR2Status({ ...live, R2_ENDPOINT: eu })).toMatchObject({ state: "on", config: { endpoint: eu } });
    for (const other of [
      "https://r2.example.com",
      "https://r2.cloudflarestorage.com",
      "https://abc.r2.cloudflarestorage.com.example.com",
      "http://abc.r2.cloudflarestorage.com",
      "http://127.0.0.1:9000",
    ]) {
      const status = readR2Status({ ...live, R2_ENDPOINT: other });
      expect(status, other).toEqual({
        state: "invalid",
        problem: "R2_ENDPOINT should be left empty in Vercel (on the live site it can only be a Cloudflare R2 address, https://….r2.cloudflarestorage.com).",
      });
    }
    // Tests and development still take a local fake.
    expect(readR2Status({ ...all, NODE_ENV: "test", R2_ENDPOINT: "http://127.0.0.1:9000" })).toMatchObject({ state: "on" });
  });

  it("the app reads them from the environment on every call; partly set means files stay in Postgres", () => {
    expect(getObjectStore()).toBeNull();
    expect(objectStorageEnabled()).toBe(false);
    const stop = s3.useEnv();
    try {
      expect(objectStorageEnabled()).toBe(true);
      expect(getObjectStore()).not.toBeNull();
      expect(env.r2?.bucket).toBe(FAKE_BUCKET);
      delete process.env.R2_SECRET_ACCESS_KEY;
      expect(objectStorageEnabled()).toBe(false);
      expect(getObjectStore()).toBeNull();
      expect(env.r2Status).toEqual({ state: "partial", missing: ["R2_SECRET_ACCESS_KEY"] });
    } finally {
      stop();
    }
    expect(env.r2Status).toEqual({ state: "off" });
  });
});

describe("keys", () => {
  it("are made by the server only: the kind plus 24 random url-safe characters", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newStorageKey("posters")));
    expect(keys.size).toBe(200);
    for (const k of keys) {
      expect(k).toMatch(/^posters\/[A-Za-z0-9_-]{24}$/);
      expect(isStorageKey(k)).toBe(true);
    }
    for (const bad of ["", "posters/", "posters/../../etc", "flyer.png", "posters/short", `other/${"a".repeat(24)}`, `posters/${"a".repeat(24)}/x`]) {
      expect(isStorageKey(bad), bad).toBe(false);
    }
  });

  it("the client refuses anything else (no filenames, no paths)", async () => {
    await expect(s3.store().putObject("../secret.txt", new Uint8Array([1]))).rejects.toThrow(ObjectStoreError);
    expect(s3.requests).toHaveLength(0);
  });
});

describe("the client, against a fake R2", () => {
  it("saves, reads (stream and bytes), and deletes, with signed requests to /<bucket>/<key>", async () => {
    const store = s3.store();
    const key = newStorageKey("resources");
    const bytes = new TextEncoder().encode("public class TeleOp {}");
    await store.putObject(key, bytes);
    // Never the upload's type: R2 only ever holds opaque bytes, as a download (defense in depth for a bucket made
    // public by mistake; we never serve R2's metadata).
    expect(s3.objects.get(key)).toMatchObject({ contentType: "application/octet-stream", contentDisposition: "attachment" });
    expect(Buffer.from(s3.objects.get(key)!.body).equals(Buffer.from(bytes))).toBe(true);

    const object = await store.getObject(key);
    expect(object?.contentLength).toBe(bytes.byteLength);
    expect(new Uint8Array(await new Response(object!.body).arrayBuffer())).toEqual(bytes);
    expect(await store.getObjectBytes(key)).toEqual(bytes);

    await store.deleteObject(key);
    expect(s3.objects.has(key)).toBe(false);
    expect(await store.getObject(key)).toBeNull(); // no such object
    expect(await store.getObjectBytes(key)).toBeNull();
    await store.deleteObject(key); // already gone is fine
    expect(s3.requests.map((r) => [r.method, r.status])).toEqual([
      ["PUT", 200],
      ["GET", 200],
      ["GET", 200],
      ["DELETE", 204],
      ["GET", 404],
      ["GET", 404],
      ["DELETE", 204],
    ]);
  });

  it("a wrong secret is refused (the fake checks the signature), with a safe message and a hint", async () => {
    const store = (await import("@/server/files/object-store")).createObjectStore({ ...s3.config, secretAccessKey: "wrong" }, { timeoutMs: 2000 });
    const error = await store.putObject(newStorageKey("posters"), new Uint8Array([1, 2])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ObjectStoreError);
    expect((error as ObjectStoreError).message).toBe(
      "Cloudflare R2 refused to save a file: SignatureDoesNotMatch (403). Check R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, and that the token can read and write this bucket.",
    );
    expect((error as ObjectStoreError).message).not.toContain("wrong");
    expect((error as ObjectStoreError).message).not.toContain(s3.config.secretAccessKey);
  });

  it("errors, a wrong bucket, timeouts, and an unreachable endpoint are ObjectStoreErrors", async () => {
    const store = s3.store();
    const key = newStorageKey("sponsors");
    s3.fail = "put";
    await expect(store.putObject(key, new Uint8Array([1]))).rejects.toThrow("Cloudflare R2 refused to save a file: InternalError (500).");
    s3.fail = "get";
    await expect(store.getObject(key)).rejects.toThrow("Cloudflare R2 refused to send a file: InternalError (500).");
    s3.fail = "delete";
    s3.failStatus = 403;
    await expect(store.deleteObject(key)).rejects.toThrow(/refused to delete a file: AccessDenied \(403\)\. Check R2_ACCESS_KEY_ID/);
    s3.fail = null;

    const { createObjectStore } = await import("@/server/files/object-store");
    // A wrong bucket is an error everywhere — never "no such file" or "already deleted" (the queue would lose track).
    const otherBucket = createObjectStore({ ...s3.config, bucket: "not-ours" }, { timeoutMs: 2000 });
    await expect(otherBucket.putObject(key, new Uint8Array([1]))).rejects.toThrow("NoSuchBucket (404). Check R2_BUCKET");
    await expect(otherBucket.getObject(key)).rejects.toThrow("Cloudflare R2 refused to find the bucket: NoSuchBucket (404). Check R2_BUCKET");
    await expect(otherBucket.getObjectBytes(key)).rejects.toThrow("NoSuchBucket (404)");
    await expect(otherBucket.deleteObject(key)).rejects.toThrow("NoSuchBucket (404)");

    s3.hang = true;
    await expect(s3.store({ timeoutMs: 150 }).putObject(key, new Uint8Array([1]))).rejects.toThrow(
      "Cloudflare R2 didn't answer within 1 second.",
    );
    await expect(s3.store({ timeoutMs: 1000 }).getObjectBytes(key)).rejects.toThrow("Cloudflare R2 didn't answer within 1 second.");
    s3.hang = false;

    const closed = createObjectStore({ ...s3.config, endpoint: "http://127.0.0.1:1" }, { timeoutMs: 2000 });
    await expect(closed.getObject(key)).rejects.toThrow(/^Couldn't reach Cloudflare R2( \(ECONNREFUSED\))?\.$/);
  });

  it("requests without a signature are refused by the fake (it's a real check)", async () => {
    const res = await fetch(`${s3.endpoint}/${FAKE_BUCKET}/${newStorageKey("posters")}`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("<Code>AccessDenied</Code>");
  });
});

describe("the deletion queue", () => {
  const due = async () => (await t.db.fileDeletion.findMany({ orderBy: { storageKey: "asc" } })).map((r) => r.storageKey);

  /** A resource whose file is stored in the fake R2 under `key`. */
  async function r2File(key = newStorageKey("resources")) {
    s3.objects.set(key, { body: Buffer.from("x"), contentType: "text/plain" });
    const r = await t.db.resource.create({
      data: { title: "T", file: { create: { filename: "a.txt", contentType: "text/plain", size: 1, storageKey: key } } },
      select: { id: true },
    });
    return { id: r.id, key };
  }

  it("deleting a row (or changing its key) queues the old object; drain deletes it and empties the queue", async () => {
    const a = await r2File();
    const b = await r2File();
    await t.db.resource.delete({ where: { id: a.id } }); // cascades to the file row
    const newKey = newStorageKey("resources");
    s3.objects.set(newKey, { body: Buffer.from("y"), contentType: "text/plain" });
    await t.db.resourceFile.update({ where: { resourceId: b.id }, data: { storageKey: newKey } });
    expect(await due()).toEqual([a.key, b.key].sort());
    expect(await countDueFileDeletions(t.db)).toBe(2);

    const result = await drainFileDeletions(t.db, { store: s3.store() });
    expect(result).toEqual({ deleted: 2, kept: 0, failed: 0, remaining: 0, error: null });
    expect(s3.objects.has(a.key)).toBe(false);
    expect(s3.objects.has(b.key)).toBe(false);
    expect(s3.objects.has(newKey)).toBe(true);
    expect(await due()).toEqual([]);
    await t.db.resource.delete({ where: { id: b.id } });
    await drainFileDeletions(t.db, { store: s3.store() });
  });

  it("a failed delete stays queued with its attempts counted, goes last, and succeeds on a later run; it never throws", async () => {
    const a = await r2File();
    await t.db.resource.delete({ where: { id: a.id } });
    s3.fail = "delete";
    const first = await drainFileDeletions(t.db, { store: s3.store() });
    expect(first).toMatchObject({ deleted: 0, failed: 1, remaining: 1 });
    expect(first.error).toBe("Cloudflare R2 refused to delete a file: InternalError (500).");
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toMatchObject({ failed: 1 });
    expect((await t.db.fileDeletion.findUniqueOrThrow({ where: { storageKey: a.key } })).attempts).toBe(2);

    // A newer one goes first; the one that keeps failing waits at the back.
    const b = await r2File();
    await t.db.resource.delete({ where: { id: b.id } });
    s3.fail = null;
    s3.requests.length = 0;
    expect(await drainFileDeletions(t.db, { store: s3.store(), limit: 1 })).toMatchObject({ deleted: 1, remaining: 1 });
    expect(s3.requests.map((r) => r.key)).toEqual([b.key]);
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toEqual({ deleted: 1, kept: 0, failed: 0, remaining: 0, error: null });
    expect(s3.objects.has(a.key)).toBe(false);

    s3.hang = true;
    const c = await r2File();
    await t.db.resource.delete({ where: { id: c.id } });
    await expect(drainFileDeletions(t.db, { store: s3.store({ timeoutMs: 100 }) })).resolves.toMatchObject({ failed: 1, remaining: 1 });
    s3.hang = false;
    await drainFileDeletions(t.db, { store: s3.store() });
  });

  it("never deletes an object a file still uses; reservations for uploads in progress wait an hour", async () => {
    const used = await r2File();
    // A stray queue entry for a key in use (e.g. a leftover reservation that became due): only taken off the list.
    await t.db.$executeRaw`INSERT INTO "FileDeletion" ("storageKey") VALUES (${used.key})`;
    const reserved = newStorageKey("posters");
    s3.objects.set(reserved, { body: Buffer.from("z"), contentType: "image/png" });
    const { reserveStorageKeys } = await import("@/server/files/object-store");
    await reserveStorageKeys(t.db, [reserved]);
    expect(await countDueFileDeletions(t.db)).toBe(1);
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toEqual({ deleted: 0, kept: 1, failed: 0, remaining: 0, error: null });
    expect(s3.objects.has(used.key)).toBe(true);
    expect(s3.objects.has(reserved)).toBe(true);
    expect(await due()).toEqual([reserved]); // still reserved (due later)
    // An hour later it's due, and — no row uses it — deleted.
    await t.db.$executeRaw`UPDATE "FileDeletion" SET "createdAt" = CURRENT_TIMESTAMP - interval '1 minute' WHERE "storageKey" = ${reserved}`;
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toMatchObject({ deleted: 1, remaining: 0 });
    expect(s3.objects.has(reserved)).toBe(false);
    await t.db.resource.delete({ where: { id: used.id } });
    await drainFileDeletions(t.db, { store: s3.store() });
  });

  it("without R2 set up nothing is deleted: the queue waits, and the result says why", async () => {
    const a = await r2File();
    await t.db.resource.delete({ where: { id: a.id } });
    expect(await drainFileDeletions(t.db, { store: null })).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0,
      remaining: 1,
      error: "Cloudflare R2 isn't set up, so nothing can be deleted from it.",
    });
    // The default store comes from the settings (none in tests).
    expect(await drainFileDeletions(t.db)).toMatchObject({ remaining: 1, deleted: 0 });
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toMatchObject({ deleted: 1, remaining: 0 });
  });
});

describe("downloads from R2", () => {
  const row = (key: string, size: number) => ({ filename: "a.bin", contentType: "application/octet-stream", size, data: null, storageKey: key });

  it("a download R2 stops sending is cut off after the timeout, instead of holding the route open", async () => {
    const store = s3.store({ timeoutMs: 300 });
    const key = newStorageKey("resources");
    await store.putObject(key, new Uint8Array(1000).fill(7));
    s3.stallBody = true; // headers and half the file, then nothing
    const res = await sendStoredFile(new NextRequest("http://localhost/f"), row(key, 1000), { store });
    expect(res.status).toBe(200);
    const started = Date.now();
    await expect(res.arrayBuffer()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    // The same with the client directly: its stream errors with a clear message.
    const object = (await store.getObject(key))!;
    await expect(new Response(object.body).arrayBuffer()).rejects.toThrow();
  });

  it("a reader that goes away (the browser closed) cancels the download quietly", async () => {
    const store = s3.store({ timeoutMs: 300 });
    const key = newStorageKey("resources");
    await store.putObject(key, new Uint8Array(1000).fill(7));
    s3.stallBody = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reader = (await store.getObject(key))!.body.getReader();
      let got = 0;
      while (got < 500) got += (await reader.read()).value!.byteLength; // the half R2 sent
      const waiting = reader.read(); // waiting on R2 for the rest
      await reader.cancel();
      await expect(waiting).resolves.toMatchObject({ done: true });
      await new Promise((r) => setTimeout(r, 500)); // past the timeout: nothing fires
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("only waiting on R2 counts: a reader slower than the timeout still gets the whole file", async () => {
    const store = s3.store({ timeoutMs: 200 });
    const key = newStorageKey("resources");
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    await store.putObject(key, bytes);
    const object = (await store.getObject(key))!;
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      await new Promise((r) => setTimeout(r, 250)); // longer than the timeout between reads
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
  });

  it("asks R2 for the bytes as they are; if an answer comes packed anyway, R2's (packed) length isn't sent on", async () => {
    const store = s3.store();
    const key = newStorageKey("resources");
    const text = "x".repeat(10_000);
    await store.putObject(key, new TextEncoder().encode(text));
    s3.gzip = "if-asked";
    const plain = (await store.getObject(key))!;
    expect(s3.requests.at(-1)?.headers["accept-encoding"]).toBe("identity");
    expect(plain.contentLength).toBe(10_000);
    await plain.body.cancel();

    s3.gzip = "always";
    const packed = (await store.getObject(key))!;
    expect(packed.contentLength).toBeNull();
    expect(new TextDecoder().decode(await new Response(packed.body).arrayBuffer())).toBe(text);
    const res = await sendStoredFile(new NextRequest("http://localhost/f"), row(key, 10_000), { store });
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(10_000);
    expect(res.headers.get("content-length")).toBe("10000"); // the row's size, not the packed length
  });

  it("withTimeout gives the same client a different timeout", async () => {
    const key = newStorageKey("posters");
    s3.hang = true;
    const started = Date.now();
    await expect(s3.store({ timeoutMs: 20_000 }).withTimeout(150).putObject(key, new Uint8Array([1]))).rejects.toThrow(
      "Cloudflare R2 didn't answer within 1 second.",
    );
    expect(Date.now() - started).toBeLessThan(2000);
    s3.hang = false;
  });
});

describe("the deletion queue, over time", () => {
  async function r2File(key = newStorageKey("resources")) {
    s3.objects.set(key, { body: Buffer.from("x"), contentType: "application/octet-stream" });
    const r = await t.db.resource.create({
      data: { title: "T", file: { create: { filename: "a.txt", contentType: "text/plain", size: 1, storageKey: key } } },
      select: { id: true },
    });
    return { id: r.id, key };
  }

  it("a delete that failed FILE_DELETION_MAX_AUTO_ATTEMPTS times is left to the owner's Clean up (includeStuck)", async () => {
    const a = await r2File();
    await t.db.resource.delete({ where: { id: a.id } });
    await t.db.fileDeletion.update({ where: { storageKey: a.key }, data: { attempts: FILE_DELETION_MAX_AUTO_ATTEMPTS } });
    expect(await countDueFileDeletions(t.db)).toBe(0);
    expect(await countDueFileDeletions(t.db, { includeStuck: true })).toBe(1);
    expect(await countStuckFileDeletions(t.db)).toBe(1);
    // The automatic cleanups (after a delete, on the storage card) don't try it any more…
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toEqual({ deleted: 0, kept: 0, failed: 0, remaining: 0, error: null });
    expect(s3.requests).toHaveLength(0);
    // …the owner's Clean up does.
    expect(await drainFileDeletions(t.db, { store: s3.store(), includeStuck: true })).toEqual({ deleted: 1, kept: 0, failed: 0, remaining: 0, error: null });
    expect(s3.objects.has(a.key)).toBe(false);
    expect(await countStuckFileDeletions(t.db)).toBe(0);
  });

  it("an upload R2 didn't answer may still land: it's deleted 10 minutes later, not now", async () => {
    expect(uploadMayStillLand(new ObjectStoreError("Cloudflare R2 didn't answer within 20 seconds."))).toBe(true);
    expect(uploadMayStillLand(new ObjectStoreError("Couldn't reach Cloudflare R2 (ECONNRESET).", { code: "ECONNRESET" }))).toBe(true);
    expect(uploadMayStillLand(new Error("something else"))).toBe(true);
    expect(uploadMayStillLand(new ObjectStoreError("Cloudflare R2 refused to save a file: InternalError (500).", { status: 500 }))).toBe(false);

    const key = newStorageKey("posters");
    await reserveStorageKeys(t.db, [key]); // due in an hour
    await deferStorageKeys(t.db, [key]); // now due in 10 minutes
    const [{ minutes }] = await t.db.$queryRaw<{ minutes: number }[]>`
      SELECT (EXTRACT(EPOCH FROM ("createdAt" - CURRENT_TIMESTAMP)) / 60)::float8 AS minutes FROM "FileDeletion" WHERE "storageKey" = ${key}`;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThan(10.1); // stored to the millisecond, so a hair either way
    expect(await countDueFileDeletions(t.db)).toBe(0);
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toMatchObject({ deleted: 0, remaining: 0 });
    // It landed after all; 10 minutes later the drain deletes it.
    s3.objects.set(key, { body: Buffer.from("late"), contentType: "application/octet-stream" });
    await t.db.$executeRaw`UPDATE "FileDeletion" SET "createdAt" = CURRENT_TIMESTAMP - interval '1 minute' WHERE "storageKey" = ${key}`;
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toMatchObject({ deleted: 1, remaining: 0 });
    expect(s3.objects.has(key)).toBe(false);
  });
});

// Two connections: one deletes (or re-keys) a file row in a transaction that hasn't committed yet, while the other
// confirms an upload or drains the queue. The delete's trigger finds the key already queued (ON CONFLICT DO NOTHING),
// so if the "still in use?" check didn't wait for that delete, it would drop the only queue entry and the object would
// stay in R2 forever.
describe("the in-use check waits for deletes that haven't committed yet", () => {
  let other: Client;
  beforeAll(async () => {
    other = new Client({ connectionString: `postgresql://postgres:postgres@localhost:54329/${t.name}` });
    await other.connect();
  });
  afterAll(async () => {
    await other.end();
  });

  async function r2File(key = newStorageKey("resources")) {
    s3.objects.set(key, { body: Buffer.from("x"), contentType: "application/octet-stream" });
    const r = await t.db.resource.create({
      data: { title: "T", file: { create: { filename: "a.txt", contentType: "text/plain", size: 1, storageKey: key } } },
      select: { id: true, file: { select: { id: true } } },
    });
    return { id: r.id, fileId: r.file!.id, key };
  }

  /** Starts `fn`, checks it's still waiting a moment later, then commits `other`'s transaction and waits for `fn`. */
  async function whileUncommitted<T>(fn: () => Promise<T>): Promise<T> {
    let finished = false;
    const running = fn().finally(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    const waited = !finished;
    await other.query("COMMIT");
    const result = await running;
    expect(waited).toBe(true);
    return result;
  }

  it("confirming an upload whose row is being deleted leaves its key queued, due now", async () => {
    const key = newStorageKey("resources");
    await reserveStorageKeys(t.db, [key]); // the upload in progress
    const file = await r2File(key); // its row saved
    await other.query("BEGIN");
    await other.query(`DELETE FROM "Resource" WHERE id = $1`, [file.id]); // cascades to the file row
    await whileUncommitted(() => confirmStorageKeys(t.db, [key]));
    expect((await t.db.fileDeletion.findMany({ where: { storageKey: key } })).map((r) => r.storageKey)).toEqual([key]);
    expect(await countDueFileDeletions(t.db)).toBe(1);
    expect(await drainFileDeletions(t.db, { store: s3.store() })).toMatchObject({ deleted: 1, remaining: 0 });
    expect(s3.objects.has(key)).toBe(false);
  });

  it("draining a queued key whose row is being deleted deletes the object once the row is gone", async () => {
    const file = await r2File();
    // A queued key a row still uses (e.g. a reservation left over when confirming failed, now due).
    await t.db.$executeRaw`INSERT INTO "FileDeletion" ("storageKey") VALUES (${file.key})`;
    await other.query("BEGIN");
    await other.query(`DELETE FROM "Resource" WHERE id = $1`, [file.id]);
    const result = await whileUncommitted(() => drainFileDeletions(t.db, { store: s3.store() }));
    expect(result).toMatchObject({ deleted: 1, kept: 0, remaining: 0 });
    expect(s3.objects.has(file.key)).toBe(false);
    expect(await t.db.fileDeletion.count({ where: { storageKey: file.key } })).toBe(0);
  });

  it("the same for a key being replaced (a new file on an edit)", async () => {
    const file = await r2File();
    const newKey = newStorageKey("resources");
    s3.objects.set(newKey, { body: Buffer.from("y"), contentType: "application/octet-stream" });
    await t.db.$executeRaw`INSERT INTO "FileDeletion" ("storageKey") VALUES (${file.key})`;
    await other.query("BEGIN");
    await other.query(`UPDATE "ResourceFile" SET "storageKey" = $1 WHERE id = $2`, [newKey, file.fileId]);
    const result = await whileUncommitted(() => drainFileDeletions(t.db, { store: s3.store() }));
    expect(result).toMatchObject({ deleted: 1, kept: 0, remaining: 0 });
    expect(s3.objects.has(file.key)).toBe(false);
    expect(s3.objects.has(newKey)).toBe(true);
    await t.db.resource.delete({ where: { id: file.id } });
    await drainFileDeletions(t.db, { store: s3.store() });
  });

  it("a row that stays (the other transaction rolls back) keeps its object", async () => {
    const file = await r2File();
    await t.db.$executeRaw`INSERT INTO "FileDeletion" ("storageKey") VALUES (${file.key})`;
    await other.query("BEGIN");
    await other.query(`DELETE FROM "Resource" WHERE id = $1`, [file.id]);
    let finished = false;
    const draining = drainFileDeletions(t.db, { store: s3.store() }).finally(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(finished).toBe(false);
    await other.query("ROLLBACK");
    expect(await draining).toMatchObject({ deleted: 0, kept: 1, remaining: 0 });
    expect(s3.objects.has(file.key)).toBe(true);
    await t.db.resource.delete({ where: { id: file.id } });
    await drainFileDeletions(t.db, { store: s3.store() });
  });
});
