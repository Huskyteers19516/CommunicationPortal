// Uploaded files in Cloudflare R2 (src/server/files/stored.ts, respond.ts, storage.ts, services/file-storage.ts),
// against a fake R2 (tests/helpers/fake-s3.ts): every kind of file in both modes (Postgres when R2 isn't set up, R2
// when it is), serving through our routes with the same headers, deletes and cascades draining the queue, failed
// uploads and failed saves leaving nothing behind, moving files to R2, the Word export, the caps, and the owners'
// tools.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Queries and scheduleFileCleanup read through the app-wide `prisma`: point it at this file's database. `after()`
// is collected so the test can run what an action scheduled.
const holder = vi.hoisted(() => ({
  db: null as unknown as Record<string | symbol, unknown>,
  after: [] as (() => unknown)[],
  /** Who the file routes think is signed in. */
  user: null as unknown,
}));
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  const prisma = new Proxy(
    {},
    {
      get(_target, key) {
        const value = holder.db[key];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(holder.db) : value;
      },
    },
  );
  return { ...actual, prisma };
});
vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return { ...actual, getCurrentUser: async () => holder.user };
});
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      holder.after.push(fn);
    },
  };
});

import { NextRequest } from "next/server";
import type { Actor } from "@/server/actor";
import type { ServiceContext } from "@/server/context";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { scheduleFileCleanup } from "@/server/files/cleanup";
import { countDueFileDeletions, FILE_DELETION_MAX_AUTO_ATTEMPTS, type FileKind, type ObjectStore } from "@/server/files/object-store";
import {
  FILE_MISSING,
  FILE_STORAGE_NOT_SET_UP,
  FILE_UNAVAILABLE,
  type SendFileOptions,
  sendStoredFile,
  type StoredFileRow,
} from "@/server/files/respond";
import {
  fileStorageCapBytes,
  fileStorageUsage,
  OBJECT_STORAGE_CAP_BYTES,
  perPersonFileCap,
  storedFileTotals,
} from "@/server/files/storage";
import { FILE_UPLOAD_FAILED } from "@/server/files/stored";
import { LIMITS } from "@/lib/constants";
import { formatFileSize } from "@/lib/files";
import { buildNotebookDocxWithin } from "@/server/notebook/docx";
import { DEFAULT_PUBLIC_PROGRESS_SETTINGS, PUBLIC_PROGRESS_KEY, serializePublicProgressSettings } from "@/lib/public-progress";
import { PUBLIC_FILE_IMMUTABLE_CACHE, PUBLIC_FILE_UNAVAILABLE, publicSponsorLogoResponse } from "@/server/public-api";
import { getFileStorageOverview } from "@/server/queries/files";
import { getNotebookExport, getNotebookImage } from "@/server/queries/notebook";
import { getPosterFile } from "@/server/queries/posters";
import { getResourceDetail, getResourceFile } from "@/server/queries/resources";
import { getSponsorshipFile, getSponsorshipLogo } from "@/server/queries/sponsorships";
import { getStrategyFile, strategyFileHeaders } from "@/server/queries/strategy";
import { getWorkshopDownloadFile, getWorkshopPhotoFile } from "@/server/queries/workshop";
import {
  ADMIN_TOOL_TIMEOUT_MS,
  cleanUpFileStorage,
  cleanUpMessage,
  connectionTestMessage,
  FILE_STORAGE_OWNERS_ONLY,
  moveFilesToObjectStorage,
  moveResultMessage,
  R2_NOT_SET_UP,
  testFileStorage,
} from "@/server/services/file-storage";
import { deleteLeagueTeam } from "@/server/services/league-teams";
import {
  addNotebookImage,
  deleteNotebook,
  deleteNotebookEntry,
  deleteNotebookPage,
  NOTEBOOK_IMAGE_BYTES_PER_PERSON,
  removeNotebookImage,
} from "@/server/services/notebook";
import { createPoster, deletePoster, POSTER_FILE_BYTES_PER_PERSON, updatePoster } from "@/server/services/posters";
import { createResource, deleteResource, MEMBER_UNAPPROVED_FILE_BYTES, updateResource } from "@/server/services/resources";
import { deleteSponsorshipFile, uploadSponsorshipFile } from "@/server/services/sponsorship-files";
import { removeSponsorshipLogo, uploadSponsorshipLogo } from "@/server/services/sponsorship-logos";
import { deleteSponsorship, deleteSponsorships } from "@/server/services/sponsorships";
import { createStrategy, deleteStrategy, updateStrategy } from "@/server/services/strategy";
import { getUserPhotoFile } from "@/server/queries/user-photos";
import { removeUserPhoto, uploadUserPhoto } from "@/server/services/user-photos";
import { addWorkshopFile, addWorkshopPhoto, createWorkshopProject, deleteWorkshopProject, removeWorkshopFile } from "@/server/services/workshop";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser } from "./helpers/factories";
import { type FakeS3, startFakeS3 } from "./helpers/fake-s3";

let t: TestDb;
let s3: FakeS3;
let owner: Actor; // a Build member with the Owner flag
let captain: Actor;
let mentor: Actor;
let leader: Actor; // Software leader
let bizLeader: Actor;
let member: Actor;

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  s3 = await startFakeS3();
  owner = await makeUser(t.db, { name: "Olivia Owner", isAdmin: true });
  captain = await makeUser(t.db, { name: "Jordan Captain", role: "CAPTAIN" });
  mentor = await makeUser(t.db, { name: "Elena Mentor", role: "MENTOR" });
  leader = await makeUser(t.db, { name: "Priya Leader", role: "SOFTWARE_LEADER" });
  bizLeader = await makeUser(t.db, { name: "Amara Business", role: "BUSINESS_LEADER" });
  member = await makeUser(t.db, { name: "Maya Member", subteam: "SOFTWARE" });
});
afterAll(async () => {
  await s3.close();
  await t.drop();
});
afterEach(async () => {
  s3.reset();
  holder.after = [];
});

/** Postgres mode (R2 not set up), as every other test file runs. */
const pg = (a: Actor): ServiceContext => contextFor(t.db, a);
/** R2 mode: the fake is this request's object store. */
const r2 = (a: Actor): ServiceContext => ({ ...contextFor(t.db, a), objectStore: s3.store() });

const enc = (s: string) => new TextEncoder().encode(s);
const STL = enc("solid roller\nendsolid roller\n");
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const PDF = enc("%PDF-1.4\n% sponsor form\n");
const JAVA = "package org.firstinspires.ftc.teamcode;\n\npublic class TeleOpMain {}\n";
const PP = enc(
  JSON.stringify({
    startPoint: { x: 61.75, y: 8, heading: "linear", startDeg: 90, endDeg: 90 },
    lines: [{ id: "a", name: "Path 1", endPoint: { x: 61.75, y: 30, heading: "linear", startDeg: 90, endDeg: 90 }, controlPoints: [], color: "#ffc516" }],
    shapes: [],
    sequence: [{ kind: "path", lineId: "a" }],
    version: "1.2.1",
  }),
);

let n = 0;
const fresh = (input: Parameters<typeof makeUser>[1] = {}) => makeUser(t.db, { name: `Person ${++n}`, ...input });

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

const queued = async () => (await t.db.fileDeletion.findMany()).map((r) => r.storageKey).sort();
const drain = async () => (await import("@/server/files/object-store")).drainFileDeletions(t.db, { store: s3.store() });

/** A body's bytes. */
const bodyOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

// ── Every kind of file ─────────────────────────────────────────────────────────────────────────────────────────

interface Added {
  /** The file row's id. */
  fileId: string;
  /** What its route is addressed by (the resource id for Resources files, else the file id). */
  routeId: string;
  /** What the delete service takes. */
  parentId: string;
}

interface KindCase {
  kind: FileKind;
  bytes: Uint8Array;
  /** Who adds files (a fresh person each time, so rate limits never get in the way). */
  uploader(): Promise<Actor>;
  add(ctx: ServiceContext): Promise<Added>;
  row(fileId: string): Promise<StoredFileRow & { storageKey: string | null; size: number }>;
  get(actor: Actor, routeId: string): Promise<StoredFileRow | null>;
  /** Someone who must not get the file from the route's query. */
  outsider(): Promise<Actor>;
  options: SendFileOptions;
  remove(ctx: ServiceContext, added: Added): Promise<unknown>;
  /** The form field a file problem is reported on. */
  field: string;
}

const fileCols = { filename: true, contentType: true, size: true, data: true, storageKey: true } as const;

/** Members' photos are one per account: each upload is by a new person, kept here so their photo can be removed. */
const photoOwners = new Map<string, Actor>();

const KINDS: KindCase[] = [
  {
    kind: "resources",
    bytes: enc(JAVA),
    // A member's resource waits for approval: only they and reviewers can get the file.
    uploader: () => fresh({ subteam: "BUILD" }),
    async add(ctx) {
      const { id } = await createResource(ctx, {
        title: "TeleOp code",
        kind: "file",
        type: "CODE",
        group: "",
        description: "",
        pinned: "",
        links: "",
        file: { name: "TeleOpMain.java", type: "text/x-java", bytes: enc(JAVA) },
      });
      const f = await t.db.resourceFile.findUniqueOrThrow({ where: { resourceId: id }, select: { id: true } });
      return { fileId: f.id, routeId: id, parentId: id };
    },
    row: (id) => t.db.resourceFile.findUniqueOrThrow({ where: { id }, select: fileCols }),
    get: (a, id) => getResourceFile(a, id, t.db),
    outsider: () => fresh({ subteam: "BUILD" }),
    options: {},
    remove: (ctx, a) => deleteResource(ctx, { resourceId: a.parentId }),
    field: "file",
  },
  {
    kind: "sponsors",
    bytes: PDF,
    uploader: () => fresh({ subteam: "BUSINESS" }),
    async add(ctx) {
      const s = await t.db.sponsorship.create({ data: { name: `Acme ${++n}`, createdById: ctx.actor.id }, select: { id: true } });
      const { id } = await uploadSponsorshipFile(ctx, { sponsorshipId: s.id, file: { name: "form.pdf", type: "application/pdf", bytes: PDF } });
      return { fileId: id, routeId: id, parentId: s.id };
    },
    row: (id) => t.db.sponsorshipFile.findUniqueOrThrow({ where: { id }, select: fileCols }),
    get: (a, id) => getSponsorshipFile(a, id, t.db),
    outsider: () => fresh({ subteam: "BUILD" }), // outside Business: sponsor files look missing
    options: {},
    remove: (ctx, a) => deleteSponsorshipFile(ctx, { fileId: a.fileId }),
    field: "file",
  },
  {
    kind: "posters",
    bytes: PNG,
    uploader: () => fresh(),
    async add(ctx) {
      const { id } = await createPoster(ctx, {
        title: "Library demo flyer",
        description: "",
        link: "",
        event: "",
        eventDate: "",
        file: { name: "flyer.png", type: "image/png", bytes: PNG },
      });
      const f = await t.db.posterFile.findUniqueOrThrow({ where: { posterId: id }, select: { id: true } });
      return { fileId: f.id, routeId: f.id, parentId: id };
    },
    row: (id) => t.db.posterFile.findUniqueOrThrow({ where: { id }, select: fileCols }),
    get: (a, id) => getPosterFile(a, id, t.db),
    outsider: () => fresh({ status: "DISABLED" }),
    options: { immutable: true },
    remove: (ctx, a) => deletePoster(ctx, { posterId: a.parentId }),
    field: "file",
  },
  {
    kind: "notebook",
    bytes: PNG,
    uploader: () => fresh(),
    async add(ctx) {
      const notebook = await t.db.notebook.create({ data: { title: `Hardware ${++n}`, subteam: "BUILD" }, select: { id: true } });
      const page = await t.db.notebookPage.create({ data: { notebookId: notebook.id, title: "Intake" }, select: { id: true } });
      const entry = await t.db.notebookEntry.create({ data: { pageId: page.id, body: "Tested the roller.", authorId: ctx.actor.id }, select: { id: true } });
      const { id } = await addNotebookImage(ctx, { entryId: entry.id, file: { name: "intake.png", type: "image/png", bytes: PNG } });
      return { fileId: id, routeId: id, parentId: entry.id };
    },
    row: (id) => t.db.notebookImage.findUniqueOrThrow({ where: { id }, select: fileCols }),
    get: (a, id) => getNotebookImage(a, id, t.db),
    outsider: () => fresh({ status: "PENDING" }),
    options: { immutable: true },
    remove: (ctx, a) => removeNotebookImage(ctx, { imageId: a.fileId }),
    field: "file",
  },
  {
    kind: "strategy",
    bytes: PP,
    uploader: () => fresh(),
    async add(ctx) {
      const { id } = await createStrategy(ctx, {
        title: "Red audience-side auto",
        kind: "AUTO",
        description: "",
        link: "",
        files: [{ name: "red-auto.pp", type: "", bytes: PP }],
      });
      const f = await t.db.strategyFile.findFirstOrThrow({ where: { strategyId: id }, select: { id: true } });
      return { fileId: f.id, routeId: f.id, parentId: id };
    },
    row: (id) => t.db.strategyFile.findUniqueOrThrow({ where: { id }, select: fileCols }),
    get: (a, id) => getStrategyFile(a, id, t.db),
    outsider: () => fresh({ status: "REJECTED" }),
    options: { headers: strategyFileHeaders },
    remove: (ctx, a) => deleteStrategy(ctx, { strategyId: a.parentId }),
    field: "files",
  },
  {
    kind: "logos",
    bytes: PNG,
    uploader: () => fresh({ subteam: "BUSINESS" }),
    async add(ctx) {
      const s = await t.db.sponsorship.create({ data: { name: `Logo Co ${++n}`, stage: "ACCEPTED", createdById: ctx.actor.id }, select: { id: true } });
      const { id } = await uploadSponsorshipLogo(ctx, { sponsorshipId: s.id, file: { name: "logo.png", type: "image/png", bytes: PNG } });
      return { fileId: id, routeId: id, parentId: s.id };
    },
    row: (id) => t.db.sponsorshipLogo.findUniqueOrThrow({ where: { id }, select: fileCols }),
    // The signed-in preview on the sponsor's page (the public route is tested below).
    get: (a, id) => getSponsorshipLogo(a, id, t.db),
    outsider: () => fresh({ subteam: "BUILD" }), // outside Business: logos look missing here
    options: { immutable: true },
    remove: (ctx, a) => removeSponsorshipLogo(ctx, { sponsorshipId: a.parentId }),
    field: "file",
  },
  {
    kind: "workshop-photos",
    bytes: PNG,
    uploader: () => fresh(),
    async add(ctx) {
      const { id } = await createWorkshopProject(ctx, { kind: "PART", title: `Servo mount ${++n}`, summary: "Holds the claw servo." });
      const { photoId } = await addWorkshopPhoto(ctx, { projectId: id, label: "Version 1", file: { name: "mount.png", type: "image/png", bytes: PNG } });
      return { fileId: photoId, routeId: photoId, parentId: id };
    },
    row: (id) => t.db.workshopPhoto.findUniqueOrThrow({ where: { id }, select: fileCols }),
    get: (a, id) => getWorkshopPhotoFile(a, id, t.db),
    // A draft: someone else on the team can't see it yet.
    outsider: () => fresh(),
    options: { immutable: true },
    remove: (ctx, a) => deleteWorkshopProject(ctx, { projectId: a.parentId }),
    field: "file",
  },
  {
    kind: "workshop-files",
    bytes: STL,
    uploader: () => fresh(),
    async add(ctx) {
      const { id } = await createWorkshopProject(ctx, { kind: "PART", title: `Intake roller ${++n}`, summary: "Pulls game pieces in." });
      const { fileId } = await addWorkshopFile(ctx, { projectId: id, label: "", file: { name: "roller.stl", type: "", bytes: STL } });
      return { fileId, routeId: fileId, parentId: id };
    },
    row: (id) => t.db.workshopFile.findUniqueOrThrow({ where: { id }, select: fileCols }),
    get: (a, id) => getWorkshopDownloadFile(a, id, t.db),
    outsider: () => fresh(),
    options: {},
    remove: (ctx, a) => removeWorkshopFile(ctx, { fileId: a.fileId }),
    field: "file",
  },
  {
    kind: "photos",
    bytes: PNG,
    uploader: () => fresh(),
    // One photo per account (a second upload replaces the first): each upload is by a new person, with the same
    // request (Postgres or R2) as the uploader's.
    async add(ctx) {
      const owner = await fresh();
      const { id } = await uploadUserPhoto({ ...ctx, actor: owner }, { file: { name: "me.png", type: "image/png", bytes: PNG } });
      photoOwners.set(owner.id, owner);
      return { fileId: id, routeId: id, parentId: owner.id };
    },
    row: (id) => t.db.userPhoto.findUniqueOrThrow({ where: { id }, select: fileCols }),
    // Everyone ACTIVE sees photos shown in the portal (the default).
    get: (a, id) => getUserPhotoFile(a, id, t.db),
    outsider: () => fresh({ status: "DISABLED" }),
    options: { immutable: true },
    remove: (ctx, a) => removeUserPhoto({ ...ctx, actor: photoOwners.get(a.parentId)! }, {}),
    field: "file",
  },
];

const request = (path: string) => new NextRequest(`http://localhost${path}`);
const headersOf = (res: Response) => Object.fromEntries(res.headers.entries());

describe.each(KINDS)("$kind files", (k) => {
  it("without R2 (the default): the bytes stay in Postgres and nothing goes to R2", async () => {
    const who = await k.uploader();
    const added = await k.add(pg(who));
    const row = await k.row(added.fileId);
    expect(row.storageKey).toBeNull();
    expect(Buffer.from(row.data!).equals(Buffer.from(k.bytes))).toBe(true);
    expect(s3.requests).toHaveLength(0);
    const got = (await k.get(who, added.routeId))!;
    const res = await sendStoredFile(request("/f"), got, { ...k.options, store: null });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual(k.bytes);
  });

  it("with R2: uploaded under a new key (no bytes in Postgres), served through our route with the same headers", async () => {
    const who = await k.uploader();
    const inDb = await k.add(pg(who));
    const added = await k.add(r2(who));
    const row = await k.row(added.fileId);
    expect(row.data).toBeNull();
    expect(row.storageKey).toMatch(new RegExp(`^${k.kind}/[A-Za-z0-9_-]{24}$`));
    expect(row.size).toBe(k.bytes.byteLength);
    const object = s3.objects.get(row.storageKey!)!;
    expect(Buffer.from(object.body).equals(Buffer.from(k.bytes))).toBe(true);
    expect(object).toMatchObject({ contentType: "application/octet-stream", contentDisposition: "attachment" }); // never the upload's type
    expect(await queued()).toEqual([]); // the upload's reservation was taken off once the row was saved

    // The route's query still decides who may see it; then the same headers as a file in Postgres.
    expect(await k.get(await k.outsider(), added.routeId)).toBeNull();
    const got = (await k.get(who, added.routeId))!;
    for (const path of ["/f", "/f?download=1"]) {
      const fromR2 = await sendStoredFile(request(path), got, { ...k.options, store: s3.store() });
      const fromPg = await sendStoredFile(request(path), (await k.get(who, inDb.routeId))!, { ...k.options, store: null });
      expect(fromR2.status).toBe(200);
      expect(headersOf(fromR2)).toEqual(headersOf(fromPg));
      expect(await bodyOf(fromR2)).toEqual(k.bytes);
      if (path.includes("download")) expect(fromR2.headers.get("content-disposition")).toMatch(/^attachment;/);
    }
    expect(fromHeadersNoSniff(await sendStoredFile(request("/f"), got, { ...k.options, store: s3.store() }))).toBe(true);

    // R2 not set up here, the object gone, or R2 failing: a plain, uncached message — never a redirect.
    const notSetUp = await sendStoredFile(request("/f"), got, { ...k.options, store: null });
    expect([notSetUp.status, await notSetUp.text()]).toEqual([503, FILE_STORAGE_NOT_SET_UP]);
    s3.fail = "get";
    const failing = await sendStoredFile(request("/f"), got, { ...k.options, store: s3.store() });
    expect([failing.status, await failing.text(), failing.headers.get("cache-control")]).toEqual([502, FILE_UNAVAILABLE, "private, no-store"]);
    s3.fail = null;
    s3.objects.delete(row.storageKey!);
    const missing = await sendStoredFile(request("/f"), got, { ...k.options, store: s3.store() });
    expect([missing.status, await missing.text()]).toEqual([404, FILE_MISSING]);
  });

  it("removing it queues its object; the cleanup after the response deletes it from R2", async () => {
    const who = await k.uploader();
    const added = await k.add(r2(who));
    const { storageKey } = await k.row(added.fileId);
    await k.remove(r2(who), added);
    expect(await queued()).toEqual([storageKey]);
    expect(s3.objects.has(storageKey!)).toBe(true);
    expect(await drain()).toMatchObject({ deleted: 1, remaining: 0 });
    expect(s3.objects.has(storageKey!)).toBe(false);
    expect(await queued()).toEqual([]);
  });

  it("an upload R2 refuses: a friendly error on the file field, no row, nothing left behind", async () => {
    const who = await k.uploader();
    s3.fail = "put";
    const e = await errorOf(k.add(r2(who)));
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).fieldErrors[k.field]).toBe(FILE_UPLOAD_FAILED);
    expect(await t.db.fileDeletion.count()).toBe(0);
    expect(s3.objects.size).toBe(0);
  });

  it("a database failure after the upload deletes the uploaded object, or queues it when R2 can't delete it yet", async () => {
    const who = await k.uploader();
    const broken = (ctx: ServiceContext): ServiceContext => ({
      ...ctx,
      db: new Proxy(t.db, {
        get: (target, key) =>
          key === "$transaction" ? () => Promise.reject(new Error("database went away")) : Reflect.get(target, key, target),
      }),
    });
    await expect(k.add(broken(r2(who)))).rejects.toThrow();
    expect(s3.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    expect(s3.objects.size).toBe(0); // deleted right away
    expect(await queued()).toEqual([]);

    s3.fail = "delete";
    await expect(k.add(broken(r2(who)))).rejects.toThrow();
    const [left] = [...s3.objects.keys()];
    expect(await queued()).toEqual([left]); // due now, for the next cleanup
    expect((await t.db.fileDeletion.findUniqueOrThrow({ where: { storageKey: left } })).attempts).toBe(1);
    s3.fail = null;
    expect(await drain()).toMatchObject({ deleted: 1, remaining: 0 });
    expect(s3.objects.size).toBe(0);
  });
});

function fromHeadersNoSniff(res: Response): boolean {
  return res.headers.get("x-content-type-options") === "nosniff" && !!res.headers.get("content-security-policy");
}

// ── The routes themselves ──────────────────────────────────────────────────────────────────────────────────────

describe("the signed-in file routes (R2 from the settings, as on Vercel)", () => {
  it("stream an R2 file with the same checks and headers; never redirect; plain errors when R2 can't send it", async () => {
    const routes = {
      resources: (await import("@/app/(app)/resources/files/[id]/route")).GET,
      sponsors: (await import("@/app/(app)/sponsors/files/[id]/route")).GET,
      posters: (await import("@/app/(app)/posters/files/[id]/route")).GET,
      notebook: (await import("@/app/(app)/notebook/images/[id]/route")).GET,
      strategy: (await import("@/app/(app)/strategy/files/[id]/route")).GET,
      logos: (await import("@/app/(app)/sponsors/logos/[id]/route")).GET,
      "workshop-photos": (await import("@/app/(app)/workshop/photos/[id]/route")).GET,
      "workshop-files": (await import("@/app/(app)/workshop/files/[id]/route")).GET,
      photos: (await import("@/app/(app)/people/photos/[id]/route")).GET,
    };
    const call = (k: KindCase, id: string, query = "") =>
      routes[k.kind](request(`/x/${id}${query}`), { params: Promise.resolve({ id }) } as never) as Promise<Response>;
    const stop = s3.useEnv();
    try {
      for (const k of KINDS) {
        const who = await k.uploader();
        const inR2 = await k.add(r2(who));
        const inPg = await k.add(pg(who));
        holder.user = who;
        const res = await call(k, inR2.routeId);
        expect(res.status, k.kind).toBe(200);
        expect(await bodyOf(res), k.kind).toEqual(k.bytes);
        const fromPg = await call(k, inPg.routeId);
        expect(headersOf(res), k.kind).toEqual(headersOf(fromPg));
        expect((await call(k, inR2.routeId, "?download=1")).headers.get("content-disposition"), k.kind).toMatch(/^attachment;/);

        holder.user = await k.outsider(); // not allowed: looks missing (or not active)
        expect([403, 404], k.kind).toContain((await call(k, inR2.routeId)).status);
        holder.user = null; // signed out: to the sign-in page, never to R2
        const out = await call(k, inR2.routeId);
        expect(out.status, k.kind).toBe(307);
        expect(out.headers.get("location"), k.kind).toMatch(/\/login\?next=/);

        holder.user = who;
        s3.fail = "get";
        const failing = await call(k, inR2.routeId);
        expect([failing.status, await failing.text()], k.kind).toEqual([502, FILE_UNAVAILABLE]);
        s3.fail = null;
      }
      expect(s3.requests.every((r) => r.status !== 403)).toBe(true); // every request was signed right
    } finally {
      stop();
      holder.user = null;
    }
    // Settings removed later: files in R2 can't be sent, and the route says why.
    const who = await KINDS[2].uploader();
    const added = await KINDS[2].add(r2(who));
    holder.user = who;
    const res = await call(KINDS[2], added.routeId);
    expect([res.status, await res.text()]).toEqual([503, FILE_STORAGE_NOT_SET_UP]);
    holder.user = null;
  });
});

// ── Cascades and replacements ──────────────────────────────────────────────────────────────────────────────────

describe("everything that removes or replaces files queues their objects", () => {
  it("a sponsor with files, and several sponsors at once", async () => {
    const biz = await fresh({ subteam: "BUSINESS" });
    const keys: string[] = [];
    const sponsors: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await t.db.sponsorship.create({ data: { name: `Cascade ${++n}`, createdById: biz.id }, select: { id: true } });
      sponsors.push(s.id);
      for (let j = 0; j < 2; j++) {
        const { id } = await uploadSponsorshipFile(r2(biz), { sponsorshipId: s.id, file: { name: `f${j}.pdf`, type: "application/pdf", bytes: PDF } });
        keys.push((await t.db.sponsorshipFile.findUniqueOrThrow({ where: { id } })).storageKey!);
      }
    }
    await deleteSponsorship(r2(biz), { sponsorshipId: sponsors[0] });
    expect(await queued()).toEqual(keys.slice(0, 2).sort());
    await deleteSponsorships(r2(biz), { sponsorshipIds: sponsors.slice(1) });
    expect(await queued()).toEqual([...keys].sort());
    expect(await drain()).toMatchObject({ deleted: 6, remaining: 0 });
    for (const key of keys) expect(s3.objects.has(key)).toBe(false);
  });

  it("a whole notebook, a page, or an entry takes its pictures with it", async () => {
    const writer = await fresh({ subteam: "BUILD" });
    const notebook = await t.db.notebook.create({ data: { title: `Cascade notebook ${++n}`, subteam: "BUILD" }, select: { id: true } });
    const keys: string[] = [];
    const entries: string[] = [];
    const pages: string[] = [];
    for (let p = 0; p < 3; p++) {
      const page = await t.db.notebookPage.create({ data: { notebookId: notebook.id, title: `Page ${p}`, position: p }, select: { id: true } });
      pages.push(page.id);
      const entry = await t.db.notebookEntry.create({ data: { pageId: page.id, body: "Built it.", authorId: writer.id }, select: { id: true } });
      entries.push(entry.id);
      const { id } = await addNotebookImage(r2(writer), { entryId: entry.id, file: { name: "a.png", type: "image/png", bytes: PNG } });
      keys.push((await t.db.notebookImage.findUniqueOrThrow({ where: { id } })).storageKey!);
    }
    await deleteNotebookEntry(r2(writer), { entryId: entries[0] });
    expect(await queued()).toEqual([keys[0]]);
    await deleteNotebookPage(r2(captain), { pageId: pages[1] });
    expect(await queued()).toEqual([keys[0], keys[1]].sort());
    await deleteNotebook(r2(captain), { notebookId: notebook.id });
    expect(await queued()).toEqual([...keys].sort());
    expect(await drain()).toMatchObject({ deleted: 3, remaining: 0 });
  });

  it("a league team takes the strategies about it, and their files", async () => {
    const team = await t.db.leagueTeam.create({ data: { number: 90000 + ++n, name: "Cascade Bots" }, select: { id: true } });
    const who = await fresh();
    const { id } = await createStrategy(r2(who), {
      title: "Their auto",
      kind: "SCOUTING",
      description: "",
      link: "",
      teamId: team.id,
      files: [
        { name: "their.pp", type: "", bytes: PP },
        { name: "notes.txt", type: "text/plain", bytes: enc("fast intake") },
      ],
    });
    const keys = (await t.db.strategyFile.findMany({ where: { strategyId: id } })).map((f) => f.storageKey!).sort();
    expect(keys).toHaveLength(2);
    await deleteLeagueTeam(r2(captain), { teamId: team.id });
    expect(await queued()).toEqual(keys);
    await drain();
    expect(s3.objects.size).toBe(0);
  });

  it("replacing or removing a file on an edit (Resources, posters, strategies)", async () => {
    const who = await fresh({ role: "BUILD_LEADER" });
    const { id: resourceId } = await createResource(r2(who), {
      title: "Code",
      kind: "file",
      type: "CODE",
      group: "",
      description: "",
      pinned: "",
      links: "",
      file: { name: "A.java", type: "text/x-java", bytes: enc(JAVA) },
    });
    const first = (await t.db.resourceFile.findUniqueOrThrow({ where: { resourceId } })).storageKey!;
    const edit = (over: Record<string, unknown>) =>
      updateResource(r2(who), { resourceId, title: "Code", kind: "file", type: "CODE", group: "", description: "", pinned: "", links: "", ...over });
    await edit({ file: { name: "B.java", type: "text/x-java", bytes: enc(`${JAVA}// v2\n`) } });
    const second = await t.db.resourceFile.findUniqueOrThrow({ where: { resourceId } });
    expect(second.storageKey).not.toBe(first);
    expect(second.data).toBeNull();
    expect(await queued()).toEqual([first]);
    // R2 turned off later: the replacement goes to Postgres and the old object is queued (never served again).
    await updateResource(pg(who), { resourceId, title: "Code", kind: "file", type: "CODE", group: "", description: "", pinned: "", links: "", file: { name: "C.java", type: "text/x-java", bytes: enc(JAVA) } });
    const third = await t.db.resourceFile.findUniqueOrThrow({ where: { resourceId } });
    expect(third.storageKey).toBeNull();
    expect(new TextDecoder().decode(third.data!)).toBe(JAVA);
    expect(await queued()).toEqual([first, second.storageKey!].sort());
    await edit({ file: { name: "D.java", type: "text/x-java", bytes: enc(JAVA) } });
    const fourth = (await t.db.resourceFile.findUniqueOrThrow({ where: { resourceId } })).storageKey!;
    await edit({ kind: "link", url: "https://example.com/code" }); // switched to a link: the file goes
    expect(await t.db.resourceFile.count({ where: { resourceId } })).toBe(0);
    expect(await queued()).toEqual([first, second.storageKey!, fourth].sort());
    await drain();

    const poster = await createPoster(r2(who), { title: "Flyer", description: "", link: "", event: "", eventDate: "", file: { name: "a.png", type: "image/png", bytes: PNG } });
    const p1 = (await t.db.posterFile.findUniqueOrThrow({ where: { posterId: poster.id } })).storageKey!;
    const posterForm = { posterId: poster.id, title: "Flyer", description: "", link: "https://www.canva.com/design/x", event: "", eventDate: "" };
    await updatePoster(r2(who), { ...posterForm, file: { name: "b.png", type: "image/png", bytes: PNG } });
    const p2 = (await t.db.posterFile.findUniqueOrThrow({ where: { posterId: poster.id } })).storageKey!;
    expect(await queued()).toEqual([p1]);
    await updatePoster(r2(who), { ...posterForm, removeFile: "on" });
    expect(await queued()).toEqual([p1, p2].sort());
    await drain();

    const strategy = await createStrategy(r2(who), {
      title: "Plan",
      kind: "MATCH",
      description: "",
      link: "",
      files: [
        { name: "a.txt", type: "text/plain", bytes: enc("a") },
        { name: "b.txt", type: "text/plain", bytes: enc("b") },
      ],
    });
    const files = await t.db.strategyFile.findMany({ where: { strategyId: strategy.id }, orderBy: { filename: "asc" } });
    await updateStrategy(r2(who), { strategyId: strategy.id, title: "Plan", kind: "MATCH", description: "", link: "", removeFileIds: [files[0].id] });
    expect(await queued()).toEqual([files[0].storageKey!]);
    await drain();
    expect(s3.objects.has(files[1].storageKey!)).toBe(true);
    expect(s3.objects.has(files[0].storageKey!)).toBe(false);
  });

  it("an action that deletes files schedules the cleanup after the response (R2 from the settings)", async () => {
    const who = await fresh();
    const added = await KINDS[2].add(r2(who));
    const { storageKey } = await KINDS[2].row(added.fileId);
    await KINDS[2].remove(r2(who), added);
    scheduleFileCleanup(); // R2 isn't set up in the environment: nothing to schedule
    expect(holder.after).toHaveLength(0);
    const stop = s3.useEnv();
    try {
      scheduleFileCleanup();
      expect(holder.after).toHaveLength(1);
      expect(s3.objects.has(storageKey!)).toBe(true); // nothing happens before the response is sent
      await holder.after[0]();
      expect(s3.objects.has(storageKey!)).toBe(false);
      expect(await queued()).toEqual([]);
      // A failing cleanup never throws into the request.
      const again = await KINDS[2].add(r2(who));
      await KINDS[2].remove(r2(who), again);
      s3.fail = "all";
      scheduleFileCleanup();
      await expect(Promise.resolve(holder.after[1]())).resolves.toBeUndefined();
      expect(await queued()).toHaveLength(1);
      s3.fail = null;
      await drain();
    } finally {
      stop();
    }
  });
});

// ── Reading bytes on the server ────────────────────────────────────────────────────────────────────────────────

describe("reading files on the server", () => {
  it("the Resources text preview reads from R2 (and says when it can't)", async () => {
    const who = await fresh({ role: "BUILD_LEADER" });
    const added = await KINDS[0].add(r2(who));
    const detail = await getResourceDetail(who, added.routeId, t.db, s3.store());
    expect(detail?.preview).toMatchObject({ kind: "text", text: JAVA });
    s3.fail = "get";
    expect((await getResourceDetail(who, added.routeId, t.db, s3.store()))?.preview).toEqual({ kind: "none", reason: "unavailable" });
    expect((await getResourceDetail(who, added.routeId, t.db, null))?.preview).toEqual({ kind: "none", reason: "unavailable" });
  });

  it("the notebook's Word export includes pictures from R2 and from Postgres", async () => {
    const writer = await fresh({ subteam: "BUILD" });
    const notebook = await t.db.notebook.create({ data: { title: `Export ${++n}`, subteam: "BUILD" }, select: { id: true } });
    const page = await t.db.notebookPage.create({ data: { notebookId: notebook.id, title: "Intake" }, select: { id: true } });
    const entry = await t.db.notebookEntry.create({ data: { pageId: page.id, body: "Pictures.", authorId: writer.id }, select: { id: true } });
    await addNotebookImage(r2(writer), { entryId: entry.id, file: { name: "from-r2.png", type: "image/png", bytes: PNG } });
    // A different picture (Word files keep one copy of identical pictures): a PNG header claiming 2 × 1 pixels.
    const other = Uint8Array.from([...PNG.subarray(0, 16), 0, 0, 0, 2, 0, 0, 0, 1, ...PNG.subarray(24)]);
    await addNotebookImage(pg(writer), { entryId: entry.id, file: { name: "from-pg.png", type: "image/png", bytes: other } });
    const data = (await getNotebookExport(writer, { notebookId: notebook.id }, t.db))!;
    const opts = { timeZone: "America/Los_Angeles", now: new Date("2026-09-24T19:00:00Z") };

    // The pictures in the .docx (a zip): each is a word/media/… entry, named in the zip's directory.
    const pictures = (buf: Buffer) => new Set(buf.toString("latin1").match(/word\/media\/[A-Za-z0-9_.-]+\.png/g) ?? []).size;
    const withR2 = (await buildNotebookDocxWithin(data, { ...opts, store: s3.store() }, t.db))!;
    expect(pictures(withR2)).toBe(2);
    expect(s3.requests.filter((r) => r.method === "GET")).toHaveLength(1);

    // Without R2 the R2 picture can't be read: the export still works, with the Postgres one.
    const withoutR2 = (await buildNotebookDocxWithin(data, { ...opts, store: null }, t.db))!;
    expect(pictures(withoutR2)).toBe(1);
  });
});

// ── The caps ───────────────────────────────────────────────────────────────────────────────────────────────────

describe("the storage cap follows where files go", () => {
  it("300 MB in Postgres, 8 GB with R2; each person's allowance is 10× with R2", async () => {
    expect(fileStorageCapBytes(false)).toBe(LIMITS.resourceStorageMaxBytes);
    expect(fileStorageCapBytes(true)).toBe(OBJECT_STORAGE_CAP_BYTES);
    expect(formatFileSize(fileStorageCapBytes(false))).toBe("300 MB");
    expect(formatFileSize(fileStorageCapBytes(true))).toBe("8 GB");
    // Well under R2's free 10 GB however Cloudflare counts a GB (10^9 or 2^30 bytes): over 1 GB to spare either way.
    expect(OBJECT_STORAGE_CAP_BYTES).toBeLessThanOrEqual(10 * 1000 ** 3 - 1000 ** 3);
    expect(perPersonFileCap(POSTER_FILE_BYTES_PER_PERSON, false)).toBe(50 * 1024 * 1024);
    expect(formatFileSize(perPersonFileCap(POSTER_FILE_BYTES_PER_PERSON, true))).toBe("500 MB");
    expect((await fileStorageUsage(t.db, false)).max).toBe(LIMITS.resourceStorageMaxBytes);
    expect((await fileStorageUsage(t.db, true)).max).toBe(OBJECT_STORAGE_CAP_BYTES);
    expect((await fileStorageUsage(t.db)).max).toBe(LIMITS.resourceStorageMaxBytes); // no R2 settings here
  });

  it("a nearly full 300 MB refuses uploads to Postgres but not to R2; a full 8 GB refuses R2 too, without sending anything to R2", async () => {
    const who = await fresh();
    const used = (await fileStorageUsage(t.db, false)).used;
    const filler = await t.db.resource.create({
      data: { title: "Filler", file: { create: { filename: "big.bin", contentType: "application/octet-stream", size: LIMITS.resourceStorageMaxBytes - used - 10, data: new Uint8Array([1]) } } },
      select: { id: true },
    });
    const pgError = await errorOf(KINDS[2].add(pg(who)));
    expect((pgError as ValidationError).fieldErrors.file).toMatch(/^The team's file storage is full: /);
    const ok = await KINDS[2].add(r2(who));
    expect((await KINDS[2].row(ok.fileId)).storageKey).toBeTruthy();

    // Fill 8 GB (sizes only; a row's size is at most 2 GB).
    const now = (await fileStorageUsage(t.db, true)).used;
    let left = OBJECT_STORAGE_CAP_BYTES - now - 10;
    const fillers: string[] = [];
    while (left > 0) {
      const size = Math.min(left, 2_000_000_000);
      left -= size;
      const r = await t.db.resource.create({
        data: { title: "Filler", file: { create: { filename: "big.bin", contentType: "application/octet-stream", size, data: new Uint8Array([1]) } } },
        select: { id: true },
      });
      fillers.push(r.id);
    }
    const before = s3.objects.size;
    s3.requests.length = 0;
    const r2Error = await errorOf(KINDS[2].add(r2(who)));
    expect((r2Error as ValidationError).fieldErrors.file).toMatch(/^The team's file storage is full: /);
    expect(s3.requests).toEqual([]); // refused before uploading (the check before the upload)
    expect(s3.objects.size).toBe(before);
    expect(await queued()).toEqual([]);
    await t.db.resource.deleteMany({ where: { id: { in: [filler.id, ...fillers] } } });
  });

  it("a member's poster allowance: 50 MB in Postgres, 500 MB with R2 (and the message says so)", async () => {
    const who = await fresh();
    await t.db.poster.create({
      data: { title: "Old", createdById: who.id, file: { create: { filename: "old.png", contentType: "image/png", size: POSTER_FILE_BYTES_PER_PERSON, data: new Uint8Array([1]) } } },
    });
    const pgError = (await errorOf(KINDS[2].add(pg(who)))) as ValidationError;
    expect(pgError.fieldErrors.file).toContain("each person can have up to 50 MB");
    await KINDS[2].add(r2(who)); // fine with R2
    await t.db.poster.create({
      data: { title: "Older", createdById: who.id, file: { create: { filename: "old.png", contentType: "image/png", size: 9 * POSTER_FILE_BYTES_PER_PERSON, data: new Uint8Array([1]) } } },
    });
    s3.requests.length = 0;
    const r2Error = (await errorOf(KINDS[2].add(r2(who)))) as ValidationError;
    expect(r2Error.fieldErrors.file).toContain("each person can have up to 500 MB");
    expect(s3.requests).toEqual([]); // refused before uploading
    await t.db.poster.deleteMany({ where: { createdById: who.id } });
    await drain();
  });
});

// ── Uploads that can't be saved ─────────────────────────────────────────────────────────────────────────────────

describe("uploads that would be refused never reach R2 (checked before uploading, and again under the lock)", () => {
  it("a full sponsor, entry, or strategy, and people over their allowances", async () => {
    const one = new Uint8Array([1]);
    const tooBig = (base: number) => 10 * base; // over the allowance with R2 (10×)

    const biz = await fresh({ subteam: "BUSINESS" });
    const sponsor = await t.db.sponsorship.create({ data: { name: `Full ${++n}`, createdById: biz.id }, select: { id: true } });
    await t.db.sponsorshipFile.createMany({
      data: Array.from({ length: LIMITS.sponsorFilesMax }, (_, i) => ({ sponsorshipId: sponsor.id, filename: `f${i}.pdf`, contentType: "application/pdf", size: 1, data: one })),
    });
    const sponsorError = await errorOf(uploadSponsorshipFile(r2(biz), { sponsorshipId: sponsor.id, file: { name: "form.pdf", type: "application/pdf", bytes: PDF } }));
    expect((sponsorError as ValidationError).fieldErrors.file).toMatch(/^This sponsor already has \d+ files/);

    const writer = await fresh({ subteam: "BUILD" });
    const notebook = await t.db.notebook.create({ data: { title: `Full ${++n}`, subteam: "BUILD" }, select: { id: true } });
    const page = await t.db.notebookPage.create({ data: { notebookId: notebook.id, title: "Intake" }, select: { id: true } });
    const full = await t.db.notebookEntry.create({ data: { pageId: page.id, body: "Pictures.", authorId: writer.id }, select: { id: true } });
    await t.db.notebookImage.createMany({
      data: Array.from({ length: LIMITS.notebookImagesPerEntry }, (_, i) => ({ entryId: full.id, filename: `p${i}.png`, contentType: "image/png", size: 1, data: one, position: i })),
    });
    const fullError = await errorOf(addNotebookImage(r2(writer), { entryId: full.id, file: { name: "a.png", type: "image/png", bytes: PNG } }));
    expect(fullError).toBeInstanceOf(ValidationError);
    const other = await t.db.notebookEntry.create({ data: { pageId: page.id, body: "More.", authorId: writer.id }, select: { id: true } });
    await t.db.notebookImage.create({
      data: { entryId: other.id, filename: "huge.png", contentType: "image/png", size: tooBig(NOTEBOOK_IMAGE_BYTES_PER_PERSON), data: one },
    });
    const empty = await t.db.notebookEntry.create({ data: { pageId: page.id, body: "None yet.", authorId: writer.id }, select: { id: true } });
    const allowanceError = await errorOf(addNotebookImage(r2(writer), { entryId: empty.id, file: { name: "a.png", type: "image/png", bytes: PNG } }));
    expect((allowanceError as ValidationError).fieldErrors.file).toMatch(/^Your notebook pictures use /);

    const planner = await fresh();
    const plan = await t.db.strategy.create({
      data: {
        title: "Plan",
        kind: "MATCH",
        createdById: planner.id,
        files: { create: Array.from({ length: LIMITS.strategyFilesMax }, (_, i) => ({ filename: `f${i}.txt`, contentType: "text/plain", size: 1, data: one })) },
      },
      select: { id: true },
    });
    const strategyError = await errorOf(
      updateStrategy(r2(planner), { strategyId: plan.id, title: "Plan", kind: "MATCH", description: "", link: "", files: [{ name: "g.txt", type: "text/plain", bytes: enc("g") }] }),
    );
    expect(Object.keys((strategyError as ValidationError).fieldErrors)).toEqual(["files"]);

    const sharer = await fresh({ subteam: "BUILD" });
    const waiting = await t.db.resource.create({
      data: {
        title: "Waiting",
        createdById: sharer.id,
        status: "PENDING",
        file: { create: { filename: "big.bin", contentType: "application/octet-stream", size: tooBig(MEMBER_UNAPPROVED_FILE_BYTES), data: one } },
      },
      select: { id: true },
    });
    const resourceError = await errorOf(KINDS[0].add(r2(sharer)));
    expect((resourceError as ValidationError).fieldErrors.file).toMatch(/waiting for approval/);

    expect(s3.arrived).toEqual([]);
    expect(await queued()).toEqual([]);
    await t.db.sponsorship.delete({ where: { id: sponsor.id } });
    await t.db.notebook.delete({ where: { id: notebook.id } });
    await t.db.strategy.delete({ where: { id: plan.id } });
    await t.db.resource.delete({ where: { id: waiting.id } });
  });

  it("an upload R2 doesn't answer in time: no row, no delete sent now, and what lands later is deleted 10 minutes on", async () => {
    const who = await fresh();
    s3.delayMs = 400; // R2 gets the whole file but answers after we gave up (and saves it anyway)
    const ctx: ServiceContext = { ...contextFor(t.db, who), objectStore: s3.store({ timeoutMs: 150 }) };
    const e = await errorOf(KINDS[2].add(ctx));
    expect((e as ValidationError).fieldErrors.file).toBe(FILE_UPLOAD_FAILED);
    expect(await t.db.poster.count({ where: { createdById: who.id } })).toBe(0);
    await new Promise((r) => setTimeout(r, 700));
    s3.delayMs = 0;
    expect(s3.arrived.map((r) => r.method)).toEqual(["PUT"]); // a delete sent now could get there first
    const [landed] = [...s3.objects.keys()];
    expect(landed).toMatch(/^posters\//);
    expect(await queued()).toEqual([landed]);
    expect(await countDueFileDeletions(t.db)).toBe(0); // not yet
    await t.db.$executeRaw`UPDATE "FileDeletion" SET "createdAt" = CURRENT_TIMESTAMP - interval '1 minute'`;
    expect(await drain()).toMatchObject({ deleted: 1, remaining: 0 });
    expect(s3.objects.size).toBe(0);
  });
});

// ── Moving files to R2 ─────────────────────────────────────────────────────────────────────────────────────────

describe("moving files from Postgres to R2", () => {
  it("is for owners only, and needs R2 set up", async () => {
    for (const a of [captain, mentor, leader, bizLeader, member]) {
      for (const run of [moveFilesToObjectStorage, testFileStorage, cleanUpFileStorage] as const) {
        const e = await errorOf(run(r2(a)));
        expect(e, `${a.name} ${run.name}`).toBeInstanceOf(ForbiddenError);
        expect((e as ForbiddenError).userMessage).toBe(FILE_STORAGE_OWNERS_ONLY);
      }
    }
    const pendingOwner = await fresh({ isAdmin: true, status: "PENDING" });
    await expect(moveFilesToObjectStorage(r2(pendingOwner))).rejects.toBeInstanceOf(ForbiddenError);
    for (const run of [moveFilesToObjectStorage, testFileStorage, cleanUpFileStorage] as const) {
      const e = await errorOf(run(pg(owner)));
      expect(e).toBeInstanceOf(ConflictError);
      expect((e as ConflictError).userMessage).toBe(R2_NOT_SET_UP);
    }
    expect(s3.requests).toHaveLength(0);
  });

  it("moves every kind (bytes intact, still served), and running it again does nothing", async () => {
    const added: { k: KindCase; a: Added }[] = [];
    for (const k of KINDS) added.push({ k, a: await k.add(pg(await k.uploader())) });
    const before = await storedFileTotals(t.db);
    expect(before.database.count).toBeGreaterThanOrEqual(KINDS.length);

    const result = await moveFilesToObjectStorage(r2(owner));
    expect(result).toMatchObject({ moved: before.database.count, movedBytes: before.database.bytes, failed: 0, remaining: { count: 0, bytes: 0 }, error: null });
    expect(moveResultMessage(result)).toBe(
      `Moved ${before.database.count} files (${formatFileSize(before.database.bytes)}) to Cloudflare R2. Every file is in Cloudflare R2 now.`,
    );
    for (const { k, a } of added) {
      const row = await k.row(a.fileId);
      expect(row.data, k.kind).toBeNull();
      expect(row.storageKey, k.kind).toMatch(new RegExp(`^${k.kind}/`));
      expect(Buffer.from(s3.objects.get(row.storageKey!)!.body).equals(Buffer.from(k.bytes)), k.kind).toBe(true);
      const res = await sendStoredFile(request("/f"), (await k.get(readerFor(k), a.routeId))!, { ...k.options, store: s3.store() });
      expect(await bodyOf(res)).toEqual(k.bytes);
    }
    expect(await queued()).toEqual([]);
    const after = await storedFileTotals(t.db);
    expect(after.database).toEqual({ count: 0, bytes: 0 });

    const again = await moveFilesToObjectStorage(r2(owner));
    expect(again).toMatchObject({ moved: 0, failed: 0, remaining: { count: 0, bytes: 0 } });
    expect(s3.requests.filter((r) => r.method === "PUT")).toHaveLength(before.database.count);
  });

  it("stops before its time runs out and carries on where it stopped on the next click", async () => {
    for (let i = 0; i < 7; i++) await KINDS[2].add(pg(await fresh()));
    s3.delayMs = 40;
    const first = await moveFilesToObjectStorage(r2(owner), { budgetMs: 30 });
    expect(first.outOfTime).toBe(true);
    expect(first.moved).toBeGreaterThan(0);
    expect(first.remaining.count).toBe(7 - first.moved);
    expect(moveResultMessage(first)).toMatch(/are still in the database — click Move again to continue\.$/);
    let rounds = 0;
    let last = first;
    while (last.remaining.count > 0 && rounds++ < 10) last = await moveFilesToObjectStorage(r2(owner), { budgetMs: 30 });
    expect(last.remaining.count).toBe(0);
    expect(await queued()).toEqual([]);
  });

  it("never overwrites a file that changed or went away while it was being copied", async () => {
    const who = await fresh({ role: "BUILD_LEADER" });
    const changed = await KINDS[0].add(pg(who));
    const newBytes = enc(`${JAVA}// changed meanwhile\n`);
    s3.onRequest = async ({ method }) => {
      if (method !== "PUT") return;
      s3.onRequest = null;
      await t.db.resourceFile.update({ where: { id: changed.fileId }, data: { data: newBytes, size: newBytes.byteLength } });
    };
    const result = await moveFilesToObjectStorage(r2(owner));
    expect(result).toMatchObject({ moved: 0, failed: 0 });
    const row = await KINDS[0].row(changed.fileId);
    expect(row.storageKey).toBeNull();
    expect(new TextDecoder().decode(row.data!)).toBe(new TextDecoder().decode(newBytes));
    expect(s3.objects.size).toBe(0); // the copy of the old bytes was deleted again
    expect(await queued()).toEqual([]);

    // Removed meanwhile: nothing to update, the copy goes.
    s3.onRequest = async ({ method }) => {
      if (method !== "PUT") return;
      s3.onRequest = null;
      await t.db.resource.delete({ where: { id: changed.parentId } });
    };
    expect(await moveFilesToObjectStorage(r2(owner))).toMatchObject({ moved: 0, remaining: { count: 0 } });
    expect(s3.objects.size).toBe(0);
    expect(await queued()).toEqual([]);
  });

  it("gives R2 at most ADMIN_TOOL_TIMEOUT_MS per request, and sends nothing more after an upload R2 didn't answer", async () => {
    const timeouts: number[] = [];
    const store: ObjectStore = {
      ...s3.store(),
      withTimeout: (ms) => {
        timeouts.push(ms);
        return s3.store({ timeoutMs: 150 });
      },
    };
    const ctx: ServiceContext = { ...contextFor(t.db, owner), objectStore: store };
    for (let i = 0; i < 2; i++) await KINDS[2].add(pg(await fresh()));
    const inDb = (await storedFileTotals(t.db)).database.count;
    s3.hang = true;
    expect(await testFileStorage(ctx)).toEqual({ ok: false, step: "save", error: "Cloudflare R2 didn't answer within 1 second." });
    const started = Date.now();
    const result = await moveFilesToObjectStorage(ctx);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result).toMatchObject({ moved: 0, failed: Math.min(inDb, 3), error: "Cloudflare R2 didn't answer within 1 second." });
    expect(timeouts).toEqual([ADMIN_TOOL_TIMEOUT_MS, ADMIN_TOOL_TIMEOUT_MS]);
    // Only the uploads were sent; their keys are deleted in 10 minutes, in case they land after all.
    expect(s3.arrived.every((r) => r.method === "PUT")).toBe(true);
    expect(await t.db.fileDeletion.count()).toBe(s3.arrived.length);
    expect(await countDueFileDeletions(t.db)).toBe(0);
    s3.hang = false;
    await t.db.$executeRaw`UPDATE "FileDeletion" SET "createdAt" = CURRENT_TIMESTAMP - interval '1 minute'`;
    expect(await drain()).toMatchObject({ remaining: 0, failed: 0 });
    expect(await moveFilesToObjectStorage(r2(owner))).toMatchObject({ remaining: { count: 0 } });
  });

  it("when R2 refuses: nothing changes, it stops after a few errors, and says why", async () => {
    for (let i = 0; i < 5; i++) await KINDS[2].add(pg(await fresh()));
    s3.fail = "put";
    s3.failStatus = 403;
    const result = await moveFilesToObjectStorage(r2(owner));
    expect(result).toMatchObject({ moved: 0, failed: 3, remaining: { count: 5 } });
    expect(result.error).toMatch(/^Cloudflare R2 refused to save a file: AccessDenied \(403\)\. Check R2_ACCESS_KEY_ID/);
    expect(moveResultMessage(result)).toMatch(/^No files were moved\. 5 files \(.+\) are still in the database\. Cloudflare R2 refused/);
    expect(await t.db.posterFile.count({ where: { storageKey: null, data: { not: null } } })).toBe(5);
    expect(await queued()).toEqual([]);
    s3.fail = null;
    expect(await moveFilesToObjectStorage(r2(owner))).toMatchObject({ moved: 5, remaining: { count: 0 } });
  });
});

// ── The owners' other tools and the storage card ───────────────────────────────────────────────────────────────

describe("test connection, clean up, and the storage card", () => {
  it("Test connection saves, reads back, and deletes a tiny file, and says what failed", async () => {
    const ok = await testFileStorage(r2(owner));
    expect(ok.ok).toBe(true);
    expect(connectionTestMessage(ok)).toMatch(/^Connected\. Cloudflare R2 saved, read back, and deleted a test file \(\d+\.\d s\)\. New files go there now\.$/);
    expect(s3.requests.map((r) => r.method)).toEqual(["PUT", "GET", "DELETE"]);
    expect(s3.requests[0].key).toMatch(/^connection-test\/[A-Za-z0-9_-]{24}$/);
    expect(s3.objects.size).toBe(0);
    expect(await queued()).toEqual([]);

    s3.fail = "put";
    const save = await testFileStorage(r2(owner));
    expect(save).toEqual({ ok: false, step: "save", error: "Cloudflare R2 refused to save a file: InternalError (500)." });
    expect(connectionTestMessage(save)).toBe("Couldn't save a test file. Cloudflare R2 refused to save a file: InternalError (500).");
    s3.fail = "get";
    expect(await testFileStorage(r2(owner))).toMatchObject({ ok: false, step: "read" });
    expect(s3.objects.size).toBe(0); // the test file was deleted anyway
    s3.fail = "delete";
    expect(await testFileStorage(r2(owner))).toMatchObject({ ok: false, step: "delete" });
    expect(await queued()).toHaveLength(1); // left for the cleanup
    s3.fail = null;
    await drain();
  });

  it("Clean up deletes what's waiting and says what's left", async () => {
    const who = await fresh();
    for (let i = 0; i < 2; i++) {
      const a = await KINDS[2].add(r2(who));
      await KINDS[2].remove(r2(who), a);
    }
    const result = await cleanUpFileStorage(r2(owner));
    expect(result).toEqual({ deleted: 2, kept: 0, failed: 0, remaining: 0, error: null });
    expect(cleanUpMessage(result)).toBe("Cleaned up 2 files. Nothing is waiting.");
    const a = await KINDS[2].add(r2(who));
    await KINDS[2].remove(r2(who), a);
    s3.fail = "delete";
    const failed = await cleanUpFileStorage(r2(owner));
    expect(cleanUpMessage(failed)).toBe("Nothing was cleaned up. 1 file still waiting: Cloudflare R2 refused to delete a file: InternalError (500).");
    s3.fail = null;
    await drain();

    // One that failed too often for the automatic cleanups: counted apart on the card; Clean up still tries it.
    const b = await KINDS[2].add(r2(who));
    const { storageKey } = await KINDS[2].row(b.fileId);
    await KINDS[2].remove(r2(who), b);
    await t.db.fileDeletion.update({ where: { storageKey: storageKey! }, data: { attempts: FILE_DELETION_MAX_AUTO_ATTEMPTS } });
    expect((await getFileStorageOverview(owner, t.db, { state: "on", config: s3.config }))!.owner).toMatchObject({
      waitingDeletions: 0,
      stuckDeletions: 1,
    });
    expect(await drain()).toMatchObject({ deleted: 0, remaining: 0 }); // the automatic cleanup leaves it
    expect(await cleanUpFileStorage(r2(owner))).toEqual({ deleted: 1, kept: 0, failed: 0, remaining: 0, error: null });
    expect(s3.objects.has(storageKey!)).toBe(false);
  });

  it("everyone with admin access sees usage and where files are; owners also the settings and what's waiting; members nothing", async () => {
    const on = { state: "on" as const, config: s3.config };
    const ownerView = (await getFileStorageOverview(owner, t.db, on))!;
    expect(ownerView.usage.max).toBe(OBJECT_STORAGE_CAP_BYTES);
    expect(ownerView.location).toBe("r2");
    expect(ownerView.owner).toEqual({ r2: "on", r2Problem: null, waitingDeletions: 0, stuckDeletions: 0 });
    const totals = await storedFileTotals(t.db);
    expect(ownerView.inDatabase).toEqual(totals.database);
    expect(ownerView.inObjectStorage).toEqual(totals.objectStorage);

    const off = (await getFileStorageOverview(owner, t.db, { state: "off" }))!;
    expect(off.usage.max).toBe(LIMITS.resourceStorageMaxBytes);
    expect(off.location).toBe("database");
    expect(off.owner).toMatchObject({ r2: "off", r2Problem: null });
    const partial = (await getFileStorageOverview(owner, t.db, { state: "partial", missing: ["R2_BUCKET"] }))!;
    expect(partial.owner!.r2Problem).toBe(
      "Cloudflare R2 is only partly set up: R2_BUCKET is missing in Vercel (all four of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET are needed). Until then, files stay in the database.",
    );
    expect(JSON.stringify(ownerView)).not.toContain(s3.config.secretAccessKey);

    // The Business leader and every other admin see where new files go and how many are where, but not the settings'
    // state or the tools.
    for (const a of [captain, mentor, leader, bizLeader]) {
      const view = (await getFileStorageOverview(a, t.db, on))!;
      expect(view.owner, a.name).toBeNull();
      expect(view.usage.max, a.name).toBe(OBJECT_STORAGE_CAP_BYTES);
      expect(view.location, a.name).toBe("r2");
      expect(view.inDatabase, a.name).toEqual(totals.database);
      expect(view.inObjectStorage, a.name).toEqual(totals.objectStorage);
      expect((await getFileStorageOverview(a, t.db, { state: "off" }))!.location, a.name).toBe("database");
    }
    expect(await getFileStorageOverview(member, t.db, on)).toBeNull();
  });
});

// ── Sponsor logos: replaced, removed with their sponsor, and served publicly ──────────────────────────────────

describe("sponsor logos in R2", () => {
  it("replacing a logo queues the old object (a new row and key); removing the sponsor queues the new one", async () => {
    const who = await fresh({ subteam: "BUSINESS" });
    const first = await KINDS[5].add(r2(who));
    const old = await KINDS[5].row(first.fileId);
    const replaced = await uploadSponsorshipLogo(r2(who), { sponsorshipId: first.parentId, file: { name: "new.png", type: "image/png", bytes: PNG } });
    expect(replaced.replaced).toBe(true);
    expect(replaced.id).not.toBe(first.fileId);
    const now = await t.db.sponsorshipLogo.findUniqueOrThrow({ where: { id: replaced.id } });
    expect(now.storageKey).toMatch(/^logos\//);
    expect(now.storageKey).not.toBe(old.storageKey);
    expect(await queued()).toEqual([old.storageKey]);
    expect(await drain()).toMatchObject({ deleted: 1, remaining: 0 });
    await deleteSponsorship(r2(bizLeader), { sponsorshipId: first.parentId });
    expect(await queued()).toEqual([now.storageKey]);
    expect(await drain()).toMatchObject({ deleted: 1, remaining: 0 });
    expect(s3.objects.size).toBe(0);
  });

  it("the public route streams a public sponsor's R2 logo with the public headers (as from Postgres), else a 404", async () => {
    // The website's Sponsors page is off until an admin turns it on.
    const body = serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showSponsors: true });
    await t.db.teamNote.upsert({ where: { key: PUBLIC_PROGRESS_KEY }, create: { key: PUBLIC_PROGRESS_KEY, body }, update: { body } });
    const who = await fresh({ subteam: "BUSINESS" });
    const inR2 = await KINDS[5].add(r2(who));
    const inPg = await KINDS[5].add(pg(who));
    const ask = (id: string, method = "GET") =>
      publicSponsorLogoResponse(new NextRequest(`http://localhost/api/public/sponsors/logos/${id}`, { method }), { db: t.db, id, store: s3.store() });
    const fromR2 = await ask(inR2.fileId);
    const fromPg = await ask(inPg.fileId);
    expect(fromR2.status).toBe(200);
    expect(await bodyOf(fromR2)).toEqual(PNG);
    // The same headers, but each under its sponsor's public name ("Logo Co 7" → logo-co-7-logo.png).
    const named = (res: Response) => ({ ...headersOf(res), "content-disposition": "" });
    expect(named(fromR2)).toEqual(named(fromPg));
    expect(fromR2.headers.get("content-disposition")).toMatch(/^inline; filename="logo-co-\d+-logo\.png"/);
    expect(fromR2.headers.get("content-type")).toBe("image/png");
    expect(fromR2.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(fromR2.headers.get("cache-control")).toBe(PUBLIC_FILE_IMMUTABLE_CACHE);
    const head = await ask(inR2.fileId, "HEAD");
    expect([head.status, await head.text()]).toEqual([200, ""]);

    // R2 not answering: a plain 503 for guests (never the team's message about R2's settings).
    s3.fail = "get";
    const down = await ask(inR2.fileId);
    expect([down.status, await down.text()]).toEqual([503, PUBLIC_FILE_UNAVAILABLE]);
    s3.fail = null;
    // Off the website (stage moved back): a plain, uncached 404 — R2 isn't even asked.
    await t.db.sponsorship.update({ where: { id: inR2.parentId }, data: { stage: "SUBMITTED" } });
    const before = s3.requests.length;
    const hidden = await ask(inR2.fileId);
    expect([hidden.status, hidden.headers.get("cache-control")]).toEqual([404, "private, no-store"]);
    expect(s3.requests.length).toBe(before);
  });
});

/** Someone who may read files of kind `k` (Resources waiting for approval: a reviewer; sponsor files and logos: Business). */
function readerFor(k: KindCase): Actor {
  if (k.kind === "sponsors" || k.kind === "logos") return bizLeader;
  if (k.kind === "resources") return captain;
  // Workshop drafts: the people who can change them, and reviewers.
  if (k.kind === "workshop-photos" || k.kind === "workshop-files") return captain;
  return member;
}
