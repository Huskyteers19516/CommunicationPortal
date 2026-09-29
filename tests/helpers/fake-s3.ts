// A tiny in-memory S3-compatible server (node:http) standing in for Cloudflare R2 in tests. It checks every request's
// AWS Signature Version 4 (recomputed with the test secret, so a wrong key, a changed body, or a wrong host is
// refused like R2 would), and can be told to fail, hang, stall mid-download, gzip, or run a hook when a request arrives.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import type { R2Config } from "@/server/env";
import { createObjectStore, type ObjectStore, type ObjectStoreOptions, sha256Hex, signV4 } from "@/server/files/object-store";

export interface FakeObject {
  body: Buffer;
  contentType: string;
  /** The Content-Disposition it was saved with, if any. */
  contentDisposition?: string | null;
}

export interface FakeRequest {
  method: string;
  /** The object key (without the bucket), "" when the path had none. */
  key: string;
  status: number;
  /** The request's headers (lower-case names). */
  headers: Record<string, string>;
}

type FailWhat = "all" | "put" | "get" | "delete";

export interface FakeS3 {
  /** http://127.0.0.1:<port> */
  endpoint: string;
  config: R2Config;
  /** Objects by key. */
  objects: Map<string, FakeObject>;
  /** Requests answered (or refused), with their status. */
  requests: FakeRequest[];
  /** Every request as it arrives, including ones never answered (`hang`). */
  arrived: { method: string; key: string }[];
  /** Answer these methods with `failStatus` (and an S3 error code). */
  fail: FailWhat | null;
  failStatus: number;
  /** Never answer (for timeouts). */
  hang: boolean;
  /** Wait this long before answering each request (a PUT is still saved afterwards, even if the client gave up). */
  delayMs: number;
  /** GET: send the headers and half the file, then nothing more (the connection stays open). */
  stallBody: boolean;
  /** GET: gzip the answer when the request accepts gzip ("if-asked"), or always ("always"). */
  gzip: "if-asked" | "always" | null;
  /** Runs when a request arrives, before it's handled (e.g. change the database mid-move). */
  onRequest: ((req: { method: string; key: string }) => Promise<void> | void) | null;
  /** A client for this server (short timeout by default). */
  store(options?: ObjectStoreOptions): ObjectStore;
  /** Sets process.env R2_* to point at this server (returns a function that removes them). */
  useEnv(): () => void;
  reset(): void;
  close(): Promise<void>;
}

export const FAKE_BUCKET = "huskyteers-test";
const ACCESS_KEY_ID = "test-access-key";
const SECRET = "test-secret-key-never-real";

function xmlError(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, { "Content-Type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** "20260924T190000Z" → Date. */
function parseAmzDate(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

/** Recomputes the request's signature with the test secret; true when it matches. */
function signatureMatches(req: IncomingMessage, url: URL, body: Buffer): boolean {
  const auth = req.headers.authorization ?? "";
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m || m[1] !== ACCESS_KEY_ID) return false;
  const amz = String(req.headers["x-amz-date"] ?? "");
  const date = parseAmzDate(amz);
  if (!date || amz.slice(0, 8) !== m[2]) return false;
  const payloadHash = String(req.headers["x-amz-content-sha256"] ?? "");
  if (payloadHash !== sha256Hex(body)) return false;
  const headers: Record<string, string> = {};
  for (const name of m[3].split(";")) {
    if (name === "host" || name === "x-amz-date" || name === "x-amz-content-sha256") continue;
    const v = req.headers[name];
    if (typeof v !== "string") return false;
    headers[name] = v;
  }
  if (!m[3].split(";").includes("host")) return false;
  const expected = signV4({
    method: req.method ?? "GET",
    url: new URL(url.pathname, `http://${req.headers.host}`),
    headers,
    payloadHash,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET,
    region: "auto",
    service: "s3",
    date,
  });
  return expected.authorization === auth;
}

/** Starts a fake R2 on a free local port. Close it in afterAll. */
export async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, FakeObject>();
  const requests: FakeRequest[] = [];
  const arrived: FakeS3["arrived"] = [];
  const fake = {
    objects,
    requests,
    arrived,
    fail: null as FailWhat | null,
    failStatus: 500,
    hang: false,
    delayMs: 0,
    stallBody: false,
    gzip: null as FakeS3["gzip"],
    onRequest: null as FakeS3["onRequest"],
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const [, bucket = "", ...rest] = url.pathname.split("/");
    const key = rest.map((p) => decodeURIComponent(p)).join("/");
    const method = req.method ?? "GET";
    arrived.push({ method, key });
    const body = await readBody(req);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
    const done = (status: number) => requests.push({ method, key, status, headers });
    if (fake.hang) return; // never answers
    if (fake.delayMs > 0) await new Promise((r) => setTimeout(r, fake.delayMs));
    if (fake.onRequest) await fake.onRequest({ method, key });

    if (!req.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) {
      done(403);
      return xmlError(res, 403, "AccessDenied");
    }
    if (!signatureMatches(req, url, body)) {
      done(403);
      return xmlError(res, 403, "SignatureDoesNotMatch");
    }
    if (decodeURIComponent(bucket) !== FAKE_BUCKET) {
      done(404);
      return xmlError(res, 404, "NoSuchBucket");
    }
    const failing =
      fake.fail === "all" ||
      (fake.fail === "put" && method === "PUT") ||
      (fake.fail === "get" && method === "GET") ||
      (fake.fail === "delete" && method === "DELETE");
    if (failing) {
      done(fake.failStatus);
      return xmlError(res, fake.failStatus, fake.failStatus === 403 ? "AccessDenied" : "InternalError");
    }
    if (method === "PUT") {
      objects.set(key, {
        body,
        contentType: String(req.headers["content-type"] ?? "application/octet-stream"),
        contentDisposition: typeof req.headers["content-disposition"] === "string" ? req.headers["content-disposition"] : null,
      });
      done(200);
      res.writeHead(200, { ETag: `"${sha256Hex(body).slice(0, 32)}"` });
      return res.end();
    }
    if (method === "GET") {
      const obj = objects.get(key);
      if (!obj) {
        done(404);
        return xmlError(res, 404, "NoSuchKey");
      }
      done(200);
      if (fake.stallBody) {
        res.writeHead(200, { "Content-Type": obj.contentType, "Content-Length": String(obj.body.byteLength) });
        res.write(obj.body.subarray(0, Math.floor(obj.body.byteLength / 2)));
        return; // never finishes
      }
      if (fake.gzip === "always" || (fake.gzip === "if-asked" && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")))) {
        const packed = gzipSync(obj.body);
        res.writeHead(200, { "Content-Type": obj.contentType, "Content-Encoding": "gzip", "Content-Length": String(packed.byteLength) });
        return res.end(packed);
      }
      res.writeHead(200, { "Content-Type": obj.contentType, "Content-Length": String(obj.body.byteLength) });
      return res.end(obj.body);
    }
    if (method === "DELETE") {
      objects.delete(key);
      done(204);
      res.writeHead(204);
      return res.end();
    }
    done(405);
    return xmlError(res, 405, "MethodNotAllowed");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${port}`;
  const config: R2Config = { accountId: "fakeaccount", accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET, bucket: FAKE_BUCKET, endpoint };

  return Object.assign(fake, {
    endpoint,
    config,
    store: (options: ObjectStoreOptions = {}) => createObjectStore(config, { timeoutMs: 2000, ...options }),
    useEnv() {
      process.env.R2_ACCOUNT_ID = config.accountId;
      process.env.R2_ACCESS_KEY_ID = config.accessKeyId;
      process.env.R2_SECRET_ACCESS_KEY = config.secretAccessKey;
      process.env.R2_BUCKET = config.bucket;
      process.env.R2_ENDPOINT = endpoint;
      return () => {
        for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"]) delete process.env[name];
      };
    },
    reset() {
      objects.clear();
      requests.length = 0;
      arrived.length = 0;
      fake.fail = null;
      fake.failStatus = 500;
      fake.hang = false;
      fake.delayMs = 0;
      fake.stallBody = false;
      fake.gzip = null;
      fake.onRequest = null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}
