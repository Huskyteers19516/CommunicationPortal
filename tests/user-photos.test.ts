// Members' own photos: Settings → My photo (src/server/services/user-photos.ts — checks and limits, metadata,
// replace/remove, switches, permissions per position and account status, the rate limit, storage), holds that keep a
// photo off the website (a self-rename, a removal by someone who manages the account, "Keep off"), avatars in the
// portal (getPortalPhotoMap, the server avatar, src/components/app/user-avatar.tsx, and a photo that fails to load),
// the signed-in route /people/photos/[id], Admin → Approvals → Members' photos, and the team website's GET
// /api/public/team-photos (+ /[id]): privacy (name keys, never names), the switches, CORS, caching, search engines, and
// the proxy's allowlist. Cloudflare R2 for this kind is also covered by tests/file-storage-r2.test.ts.
import { crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Routes and getPortalPhotoMap read through the app-wide `prisma`: point it at this file's database. The signed-in
// route asks who is signed in.
const holder = vi.hoisted(() => ({
  db: null as unknown as Record<string | symbol, unknown>,
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

import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as signedInRoute from "@/app/(app)/people/photos/[id]/route";
import * as photoRoute from "@/app/api/public/team-photos/[id]/route";
import * as photosRoute from "@/app/api/public/team-photos/route";
import { UserAvatar, UserChipWithPhoto } from "@/components/app/user-avatar";
import { TeamMemberList } from "@/components/people/team-member-list";
import { Avatar } from "@/components/ui/avatar";
import { AvatarPhoto, imageFailed } from "@/components/ui/avatar-photo";
import { LIMITS } from "@/lib/constants";
import { POSTER_HEIC_MESSAGE } from "@/lib/posters";
import { isPublicApiPath, PUBLIC_API_FILE_PREFIXES, PUBLIC_API_PATHS, PUBLIC_TEAM_PHOTOS_PATH, PUBLIC_TEAM_PHOTOS_PREFIX } from "@/lib/public-api";
import {
  DEFAULT_PUBLIC_PROGRESS_SETTINGS,
  PUBLIC_PROGRESS_KEY,
  type PublicProgressSettings,
  serializePublicProgressSettings,
  TEAM_SITE_ORIGIN,
} from "@/lib/public-progress";
import {
  CENTERED_CROP,
  clampPhotoCrop,
  movePhotoCrop,
  photoCropRect,
  portalPhotoPath,
  type PublicTeamPhotos,
  publicTeamPhotoPath,
  TEAM_PHOTO_KEY_RE,
  teamPhotoNameKey,
  USER_PHOTO_ANIMATED_MESSAGE,
  USER_PHOTO_CHANGES_PER_HOUR,
  USER_PHOTO_HEIC_MESSAGE,
  USER_PHOTO_MAX_BYTES,
  USER_PHOTO_MAX_DIMENSION,
  USER_PHOTO_MAX_ZOOM,
  USER_PHOTO_RATE_LIMITED_MESSAGE,
  USER_PHOTO_TYPES_MESSAGE,
  USER_PHOTO_UNREADABLE_MESSAGE,
  userPhotoFits,
  userPhotoProblem,
  userPhotoTooLargeMessage,
  websitePhotoHoldSentence,
} from "@/lib/user-photos";
import { proxy } from "@/proxy";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { fileStorageUsage, storageFullSentence } from "@/server/files/storage";
import {
  PUBLIC_CACHE_CONTROL,
  PUBLIC_FILE_IMMUTABLE_CACHE,
  PUBLIC_FILE_REDIRECT_CACHE,
  PUBLIC_NO_INDEX_HEADERS,
  PUBLIC_TEAM_PHOTO_NOT_FOUND,
  PUBLIC_TEAM_PHOTOS_UNAVAILABLE,
  publicTeamPhotoResponse,
  publicTeamPhotosResponse,
} from "@/server/public-api";
import { getPublicTeamPhotos, listPublicTeamPhotos, publicTeamPhotoKey, publicTeamPhotosShown } from "@/server/queries/public-team-photos";
import { getTeamWebsitePreview } from "@/server/queries/team-website";
import {
  getManagedUserPhoto,
  getManagedWebsitePhotoHold,
  getMyPhoto,
  getPortalPhotoMap,
  getUserPhotoFile,
  getWebsitePhotoReview,
  photoIdsFor,
  portalPhotoMap,
} from "@/server/queries/user-photos";
import { getWebsitePhotoHold, parseWebsitePhotoHold, websitePhotoHoldKey } from "@/server/queries/website-photo-holds";
import { IMMUTABLE_FILE_CACHE } from "@/server/resources/serve";
import { updatePublicProgressSettings } from "@/server/services/public-progress";
import { updateProfile } from "@/server/services/settings";
import {
  allowWebsitePhoto,
  checkUserPhoto,
  keepPhotoOffWebsite,
  removeUserPhoto,
  updatePhotoVisibility,
  uploadUserPhoto,
  USER_PHOTO_CANT_HOLD,
  USER_PHOTO_CANT_REMOVE,
  USER_PHOTO_HOLD_OWN,
  USER_PHOTO_INACTIVE,
  USER_PHOTO_NEEDS_FILE,
  USER_PHOTO_NO_ACCOUNT,
  USER_PHOTO_NONE,
  USER_PHOTO_NOT_HELD,
} from "@/server/services/user-photos";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TZ } from "./helpers/factories";
import { startFakeS3 } from "./helpers/fake-s3";

let t: TestDb;
let owner: Actor; // a Build member with the Owner flag
let captain: Actor;
let mentor: Actor;
let teacher: Actor;
let buildLead: Actor;
let maya: Actor; // Software member
let ethan: Actor; // Build member

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  owner = await makeUser(t.db, { name: "Olivia Owner", isAdmin: true });
  captain = await makeUser(t.db, { name: "Jordan Captain", role: "CAPTAIN" });
  mentor = await makeUser(t.db, { name: "Elena Mentor", role: "MENTOR" });
  teacher = await makeUser(t.db, { name: "David Teacher", role: "TEACHER" });
  buildLead = await makeUser(t.db, { name: "Marcus Lead", role: "BUILD_LEADER" });
  maya = await makeUser(t.db, { name: "Maya Patel", subteam: "SOFTWARE", email: "maya@example.com" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", subteam: "BUILD", email: "ethan@example.com" });
});
afterAll(async () => {
  await t.drop();
});

let n = 0;
const fresh = (input: Parameters<typeof makeUser>[1] = {}) => makeUser(t.db, { name: `Person ${++n}`, ...input });
const ctx = (a: Actor) => contextFor(t.db, a);

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}
async function fileErrorOf(p: Promise<unknown>): Promise<string | undefined> {
  const e = await errorOf(p);
  if (!(e instanceof ValidationError)) throw new Error(`expected a ValidationError, got ${String(e)}`);
  return e.fieldErrors.file;
}

// ── Pictures ─────────────────────────────────────────────────────────────────────────────────────────────────

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => new TextEncoder().encode(s);
const file = (name: string, bytes: Uint8Array, type = "") => ({ name, type, bytes });

/** A real 64 × 64 PNG (the seed's demo head-and-shoulders picture). */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA10lEQVR42u3XwQ2DMAxGYQ/UAToFE3SIDtFxEScG6L0SbRL/xk55ks/4fRIiwe6vx9RjAAAAAAAAAAAAAAAczrpv8wHWfTua6oAv6UEMO79ea7CUeqHBsupVBgCOeokBAIBkgLPeb+AVAgCAkzgZcHsukhmol+yVAXoNqqVKQLtBuFEM+MmQ7woBfGBCnx8OiB4AAADwFfqHg2z4MpcPkPwTpwEk9U6DVaj3GKxCuodhpeoHDBcDnFDfa7CC9V0Gq1nfbrgGIKW+0QCgPiCxvsUAAACAyQFvXeAP0ThbpDQAAAAASUVORK5CYII=",
    "base64",
  ),
);

/** A PNG chunk with its CRC. */
function chunk(type: string, data: number[]): number[] {
  const body = Uint8Array.from([...ascii(type), ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body) >>> 0)];
}

/** PNG with a tEXt chunk saying where and by whom it was taken (right after IHDR). */
function pngWithText(): Uint8Array {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const note = chunk("tEXt", [...ascii("Comment"), 0, ...ascii("GPSLatitude=33.8366;Artist=Maya Patel;Model=iPhone 15")]);
  return Uint8Array.from([...PNG.subarray(0, ihdrEnd), ...note, ...PNG.subarray(ihdrEnd)]);
}

/** A PNG's signature and IHDR claiming `width` × `height` (only the header matters for the size checks). */
function pngHeader(width: number, height: number): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 1, 2, 3, 4]);
}
/** A baseline JPEG's start (SOI, then SOF0 with the size). */
function jpeg(width = 120, height = 40): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}
/** A JPEG with an Exif block: orientation 6 (turned a quarter) and a GPS / author / phone note. */
function jpegWithExif(width: number, height: number): Uint8Array {
  const note = ascii("GPSLatitude=33.8366;Artist=Maya Patel;Model=iPhone 15\0");
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 2, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0x3b, 0x01, 2, 0, note.length, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, ...note];
  const exif = [...ascii("Exif\0\0"), ...tiff];
  const plain = jpeg(width, height);
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif, ...plain.subarray(2)]);
}
/** A lossless WebP (VP8L) of `width` × `height`. */
function webp(width = 50, height = 20): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return Uint8Array.from([...ascii("RIFF"), 30, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8L"), 10, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]);
}

/** PNG with chunks inserted right after IHDR. */
function pngWith(...chunks: number[][]): Uint8Array {
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  return Uint8Array.from([...PNG.subarray(0, ihdrEnd), ...chunks.flat(), ...PNG.subarray(ihdrEnd)]);
}
/** A JPEG segment (marker + length + payload). */
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255, ...payload];
/** A baseline JPEG with these segments between SOI and the frame. */
function jpegWith(...segments: number[][]): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), ...jpeg(64, 64).subarray(2)]);
}
/** A WebP with a VP8X header (`flags`) and more chunks, 64 × 64. */
function webpX(flags: number, ...chunks: number[][]): Uint8Array {
  const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const body = [...ascii("VP8X"), ...le32(10), flags, 0, 0, 0, ...le24(63), ...le24(63), ...chunks.flat()];
  return Uint8Array.from([...ascii("RIFF"), ...le32(4 + body.length), ...ascii("WEBP"), ...body]);
}
const webpChunk = (fourcc: string, data: number[]) => [...ascii(fourcc), data.length & 255, (data.length >>> 8) & 255, 0, 0, ...data, ...(data.length & 1 ? [0] : [])];

const upload = (a: Actor, bytes: Uint8Array = PNG, name = "me.png") => uploadUserPhoto(ctx(a), { file: file(name, bytes) });

async function setSettings(settings: Partial<PublicProgressSettings>) {
  const body = serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, ...settings });
  await t.db.teamNote.upsert({ where: { key: PUBLIC_PROGRESS_KEY }, create: { key: PUBLIC_PROGRESS_KEY, body }, update: { body } });
}

// ── Checking a photo ─────────────────────────────────────────────────────────────────────────────────────────

describe("checking a photo", () => {
  it("takes only real PNG, JPG, or WebP pictures up to 1,024 pixels a side and 1 MB, checked by their contents", async () => {
    const me = await fresh();
    const refuse = (f: ReturnType<typeof file>) => fileErrorOf(uploadUserPhoto(ctx(me), { file: f }));
    const heic = Uint8Array.from([0, 0, 0, 24, ...ascii("ftypheic"), 0, 0, 0, 0]);
    expect(await refuse(file("IMG_0001.HEIC", heic))).toBe(USER_PHOTO_HEIC_MESSAGE);
    expect(USER_PHOTO_HEIC_MESSAGE).toBe(POSTER_HEIC_MESSAGE);
    // A real GIF, PDF, SVG, or a file that doesn't say it's a picture: which pictures it can be.
    expect(await refuse(file("me.gif", text("GIF89a\x01\x00\x01\x00\x00\x00\x00;")))).toBe(USER_PHOTO_TYPES_MESSAGE);
    expect(await refuse(file("me.png", text("%PDF-1.4\n")))).toBe(USER_PHOTO_TYPES_MESSAGE);
    expect(await refuse(file("notes.txt", text("hello"), "text/plain"))).toBe(USER_PHOTO_TYPES_MESSAGE);
    expect(await refuse(file("me.svg", text('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml"))).toBe(USER_PHOTO_TYPES_MESSAGE);
    // Says it's a PNG / JPG but isn't one: it "couldn't be opened".
    expect(await refuse(file("fake.png", text("just some text")))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    expect(await refuse(file("scan", text("not a picture"), "image/jpeg"))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    expect(await refuse(file("zero.png", pngHeader(0, 10)))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    expect(await refuse(file("cut.png", pngHeader(64, 64).subarray(0, 20)))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    // A tiny file claiming an enormous picture (it would freeze every phone that shows the avatar), or just a big one:
    // every avatar decodes the whole photo, and the browser only ever sends 512 × 512.
    expect(await refuse(file("huge.png", pngHeader(30_000, 30_000)))).toBe(userPhotoTooLargeMessage(30_000, 30_000));
    expect(userPhotoTooLargeMessage(7000, 7000)).toBe("That picture is 7,000 × 7,000 pixels. Photos can be up to 1,024 pixels a side — pick a smaller one.");
    expect(USER_PHOTO_MAX_DIMENSION).toBe(1024);
    expect(await refuse(file("flat.png", pngHeader(7000, 7000)))).toBe(userPhotoTooLargeMessage(7000, 7000));
    expect(await refuse(file("wide.png", pngHeader(USER_PHOTO_MAX_DIMENSION + 1, 10)))).toBe(userPhotoTooLargeMessage(1025, 10));
    expect(await refuse(file("tall.jpg", jpeg(512, 1500)))).toBe(userPhotoTooLargeMessage(512, 1500));
    expect(checkUserPhoto(file("edge.jpg", jpeg(1024, 1024)))).toMatchObject({ width: 1024, height: 1024 });
    // Bytes: 1 MB at most (a 512 × 512 JPG is ~50 KB), and the uploads' 4 MB with the same message.
    expect(USER_PHOTO_MAX_BYTES).toBe(1024 * 1024);
    const padded = new Uint8Array(USER_PHOTO_MAX_BYTES + 1);
    padded.set(jpeg(512, 512));
    expect(await refuse(file("big.jpg", padded))).toMatch(/^That photo is 1\.0 MB\. Photos can be up to 1 MB — pick a smaller one\.$/);
    expect(await refuse(file("bigger.jpg", new Uint8Array(LIMITS.resourceFileMaxBytes + 1)))).toMatch(/^That photo is 4\.0 MB\. Photos can be up to 1 MB/);
    expect(await refuse(file("empty.png", new Uint8Array(0)))).toBe("That file is empty. Choose another one.");
    expect(await refuse(file("run.exe", PNG))).toBe(USER_PHOTO_TYPES_MESSAGE);
    expect(await fileErrorOf(uploadUserPhoto(ctx(me), {}))).toBe(USER_PHOTO_NEEDS_FILE);
    expect(await fileErrorOf(uploadUserPhoto(ctx(me), { file: "me.png" }))).toBe(USER_PHOTO_NEEDS_FILE);
    expect(await t.db.userPhoto.count({ where: { userId: me.id } })).toBe(0);
  });

  it("refuses animations and JPEGs browsers can't draw (a broken avatar everywhere)", async () => {
    const me = await fresh();
    const refuse = (f: ReturnType<typeof file>) => fileErrorOf(uploadUserPhoto(ctx(me), { file: f }));
    // APNG: an acTL chunk before the picture.
    expect(await refuse(file("party.png", pngWith(chunk("acTL", [0, 0, 0, 2, 0, 0, 0, 0]))))).toBe(USER_PHOTO_ANIMATED_MESSAGE);
    // Animated WebP: the VP8X flag, or an ANIM / ANMF chunk.
    expect(await refuse(file("party.webp", webpX(0x02)))).toBe(USER_PHOTO_ANIMATED_MESSAGE);
    expect(await refuse(file("party.webp", webpX(0, webpChunk("ANIM", [0, 0, 0, 0, 0, 0]))))).toBe(USER_PHOTO_ANIMATED_MESSAGE);
    expect(await refuse(file("party.webp", webpX(0, webpChunk("ANMF", Array(16).fill(0)))))).toBe(USER_PHOTO_ANIMATED_MESSAGE);
    // A JPG / JPGn marker (libjpeg: "Unsupported marker type 0xf0"), a lossless or arithmetic frame, DNL: nothing draws.
    expect(await refuse(file("odd.jpg", jpegWith(segment(0xf0, [1, 2, 3]))))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    expect(await refuse(file("odd.jpg", jpegWith(segment(0xc8, [1]))))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    expect(await refuse(file("odd.jpg", jpegWith(segment(0xdc, [0, 64]))))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    const lossless = jpeg(64, 64);
    lossless[3] = 0xc3;
    expect(await refuse(file("lossless.jpg", lossless))).toBe(USER_PHOTO_UNREADABLE_MESSAGE);
    expect(await t.db.userPhoto.count({ where: { userId: me.id } })).toBe(0);
    // Still pictures with ordinary markers are fine (progressive, restart intervals, comments are removed).
    const progressive = jpeg(64, 64);
    progressive[3] = 0xc2;
    expect((await upload(me, progressive, "p.jpg")).id).toBeTruthy();
    expect((await upload(me, jpegWith(segment(0xdd, [0, 4]), segment(0xfe, ascii("hello"))), "r.jpg")).id).toBeTruthy();
    expect((await upload(me, webpX(0), "still.webp")).id).toBeTruthy();
  });

  it("stores the real type under a neutral name, with the size it's shown at", async () => {
    const me = await fresh();
    const { id } = await upload(me, PNG, "Maya at the Anaheim meet.HEIC");
    expect(await t.db.userPhoto.findUniqueOrThrow({ where: { id } })).toMatchObject({
      userId: me.id,
      filename: "photo.png",
      contentType: "image/png",
      width: 64,
      height: 64,
      size: PNG.byteLength,
      storageKey: null,
      createdAt: TEST_NOW,
    });
    expect(checkUserPhoto(file("x.png", jpeg(300, 100))).upload).toMatchObject({ filename: "photo.jpg", contentType: "image/jpeg" });
    expect(checkUserPhoto(file("x", webp(50, 20)))).toMatchObject({ upload: { filename: "photo.webp", contentType: "image/webp" }, width: 50, height: 20 });
  });

  it("takes the metadata out (GPS position, author, phone) before it's stored and published; keeps the orientation", async () => {
    const withText = pngWithText();
    expect(Buffer.from(withText).includes("GPSLatitude")).toBe(true);
    const a = await fresh();
    const { id } = await upload(a, withText);
    const stored = Buffer.from((await t.db.userPhoto.findUniqueOrThrow({ where: { id } })).data!);
    for (const secret of ["GPS", "Maya", "iPhone", "tEXt"]) expect(stored.includes(secret), secret).toBe(false);
    expect(stored.equals(Buffer.from(PNG))).toBe(true);

    // A phone photo turned a quarter (Exif orientation 6): shown 100 × 300, the orientation kept on its own.
    const b = await fresh();
    const turned = await upload(b, jpegWithExif(300, 100), "IMG_2026.jpg");
    const row = await t.db.userPhoto.findUniqueOrThrow({ where: { id: turned.id } });
    const bytes = Buffer.from(row.data!);
    for (const secret of ["GPS", "Maya", "iPhone"]) expect(bytes.includes(secret), secret).toBe(false);
    expect(bytes.includes("Exif")).toBe(true);
    expect(row).toMatchObject({ width: 100, height: 300, size: bytes.byteLength });

    // The public address sends exactly what's stored.
    const served = await publicTeamPhotoResponse(new NextRequest(`https://x.example/api/public/team-photos/${id}`), { db: t.db, id, store: null });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(stored)).toBe(true);
  });

  it("also takes out what can still carry text: colour profiles, a JFIF thumbnail, Adobe extras, PNG palette names", async () => {
    const me = await fresh();
    const stored = async (bytes: Uint8Array, name: string) => {
      const { id } = await upload(me, bytes, name);
      return Buffer.from((await t.db.userPhoto.findUniqueOrThrow({ where: { id } })).data!);
    };
    // JPEG: APP0 with a thumbnail, APP0 JFXX, APP2 ICC profile, APP14 Adobe with extra bytes, MPF.
    const jfif = [...ascii("JFIF\0"), 1, 2, 1, 0, 72, 0, 72, 2, 1, ...ascii("SECRET-APP0-THUMB")];
    const jfxx = [...ascii("JFXX\0"), 0x10, ...ascii("SECRET-JFXX")];
    const icc = [...ascii("ICC_PROFILE\0"), 1, 1, ...ascii("SECRET-ICC-TEXT owner Maya's phone")];
    const adobe = [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1, ...ascii("SECRET-ADOBE")];
    const mpf = [...ascii("MPF\0"), ...ascii("SECRET-MPF")];
    const jpg = await stored(jpegWith(segment(0xe0, jfif), segment(0xe0, jfxx), segment(0xe2, icc), segment(0xee, adobe), segment(0xe2, mpf)), "me.jpg");
    for (const secret of ["SECRET", "ICC_PROFILE", "JFXX", "Maya"]) expect(jpg.includes(secret), secret).toBe(false);
    // A bare JFIF header (version, units, density; no thumbnail) and a bare Adobe one are kept.
    expect(jpg.subarray(0, 20).equals(Buffer.from([0xff, 0xd8, ...segment(0xe0, [...ascii("JFIF\0"), 1, 2, 1, 0, 72, 0, 72, 0, 0])]))).toBe(true);
    expect(jpg.includes(Buffer.from(segment(0xee, [...ascii("Adobe"), 0, 100, 0, 0, 0, 0, 1])))).toBe(true);
    expect(checkUserPhoto(file("again.jpg", jpg)).upload.bytes.byteLength).toBe(jpg.byteLength); // stable

    // PNG: iCCP (a profile and its name), sPLT (a named palette), hIST, bKGD — only the picture is left.
    const png = await stored(
      pngWith(
        chunk("iCCP", [...ascii("SECRET-ICC-NAME"), 0, 0, 1, 2, 3]),
        chunk("sPLT", [...ascii("SECRET-SPLT-NAME Maya"), 0, 8, 1, 2, 3, 4, 0, 1]),
        chunk("bKGD", [0, 0, 0, 0, 0, 0]),
      ),
      "me.png",
    );
    expect(png.equals(Buffer.from(PNG))).toBe(true);

    // WebP: the ICCP chunk goes and the VP8X flag that says there's one is cleared.
    const webp = await stored(webpX(0x20, webpChunk("ICCP", ascii("SECRET-WEBP-ICC"))), "me.webp");
    expect(webp.includes("SECRET")).toBe(false);
    expect(webp.includes("ICCP")).toBe(false);
    expect(webp[20] & 0x20).toBe(0);
  });

  it("checks the picked file in the browser before reading it, and the made photo's size", () => {
    expect(userPhotoProblem({ name: "me.jpg", type: "image/jpeg", size: 10 })).toBeNull();
    expect(userPhotoProblem({ name: "me", type: "image/webp", size: 10 })).toBeNull();
    expect(userPhotoProblem({ name: "IMG_1.HEIC", type: "", size: 10 })).toBe(USER_PHOTO_HEIC_MESSAGE);
    expect(userPhotoProblem({ name: "x", type: "image/heif", size: 10 })).toBe(USER_PHOTO_HEIC_MESSAGE);
    expect(userPhotoProblem({ name: "me.gif", type: "image/gif", size: 10 })).toBe(USER_PHOTO_TYPES_MESSAGE);
    expect(userPhotoProblem({ name: "me.png", type: "image/png", size: 0 })).toBe("That file is empty. Choose another one.");
    // Size isn't a problem here: the browser makes it a small square first.
    expect(userPhotoProblem({ name: "me.png", type: "image/png", size: 40 * 1024 * 1024 })).toBeNull();
    expect(userPhotoFits(60_000)).toBe(true);
    expect(userPhotoFits(0)).toBe(false);
    expect(userPhotoFits(USER_PHOTO_MAX_BYTES)).toBe(true);
    expect(userPhotoFits(USER_PHOTO_MAX_BYTES + 1)).toBe(false);
  });
});

// ── Uploading, replacing, removing ──────────────────────────────────────────────────────────────────────────

describe("uploading, replacing, and removing", () => {
  it("is for every ACTIVE account, whatever its position; never for accounts waiting, turned down, or disabled", async () => {
    for (const role of ["MEMBER", "SOFTWARE_LEADER", "BUSINESS_LEADER", "CAPTAIN", "MENTOR", "TEACHER"] as const) {
      const a = await fresh({ role });
      expect((await upload(a)).replaced, role).toBe(false);
    }
    expect((await upload(await fresh({ isAdmin: true }))).replaced).toBe(false);
    for (const status of ["PENDING", "REJECTED", "DISABLED"] as const) {
      const a = await fresh({ status, role: status === "PENDING" ? "BUILD_LEADER" : "MEMBER" });
      const e = await errorOf(upload(a));
      expect(e, status).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).message, status).toBe(USER_PHOTO_INACTIVE);
      expect(await errorOf(removeUserPhoto(ctx(a), {})), status).toBeInstanceOf(ForbiddenError);
      expect(await errorOf(updatePhotoVisibility(ctx(a), { which: "portal" })), status).toBeInstanceOf(ForbiddenError);
      expect(await t.db.userPhoto.count({ where: { userId: a.id } }), status).toBe(0);
    }
    // Disabled after the page was opened: the save itself checks again.
    const later = await fresh();
    const stale = ctx(later);
    await t.db.user.update({ where: { id: later.id }, data: { status: "DISABLED" } });
    expect(await errorOf(uploadUserPhoto(stale, { file: file("me.png", PNG) }))).toBeInstanceOf(ForbiddenError);
    expect(await t.db.userPhoto.count({ where: { userId: later.id } })).toBe(0);
  });

  it("replaces your photo with a new row (a new address everywhere), one per person; removing it removes it", async () => {
    const me = await fresh();
    const first = await upload(me);
    const second = await upload(me, jpeg(512, 512), "again.jpg");
    expect(second.replaced).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(await t.db.userPhoto.findMany({ where: { userId: me.id }, select: { id: true, contentType: true } })).toEqual([
      { id: second.id, contentType: "image/jpeg" },
    ]);
    expect(await getUserPhotoFile(maya, first.id, t.db)).toBeNull(); // the old address is gone

    expect(await removeUserPhoto(ctx(me), {})).toEqual({ userId: me.id, own: true });
    expect(await t.db.userPhoto.count({ where: { userId: me.id } })).toBe(0);
    const none = await errorOf(removeUserPhoto(ctx(me), { userId: "" }));
    expect(none).toBeInstanceOf(NotFoundError);
    expect((none as NotFoundError).message).toBe(USER_PHOTO_NONE);
  });

  it("lets people who manage an account remove its photo (it goes public on its own); nobody else", async () => {
    const member = await fresh({ subteam: "SOFTWARE" });
    const lead = await fresh({ role: "SOFTWARE_LEADER" });
    const otherOwner = await fresh({ isAdmin: true });
    await upload(member);
    await upload(lead);
    await upload(otherOwner);
    // Another member, or a subteam leader for someone at their rank or above (or an owner): refused.
    for (const [who, whose] of [
      [maya, member],
      [buildLead, lead],
      [buildLead, otherOwner],
      [captain, otherOwner],
    ] as const) {
      const e = await errorOf(removeUserPhoto(ctx(who), { userId: whose.id }));
      expect(e, `${who.name} → ${whose.name}`).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).message).toBe(USER_PHOTO_CANT_REMOVE);
    }
    expect(await t.db.userPhoto.count({ where: { userId: { in: [member.id, lead.id, otherOwner.id] } } })).toBe(3);
    // A leader removes a member's, the captain a leader's, an owner another owner's.
    expect(await removeUserPhoto(ctx(buildLead), { userId: member.id })).toEqual({ userId: member.id, own: false });
    expect(await removeUserPhoto(ctx(captain), { userId: lead.id })).toEqual({ userId: lead.id, own: false });
    expect(await removeUserPhoto(ctx(owner), { userId: otherOwner.id })).toEqual({ userId: otherOwner.id, own: false });
    expect(await t.db.userPhoto.count({ where: { userId: { in: [member.id, lead.id, otherOwner.id] } } })).toBe(0);
    expect(await errorOf(removeUserPhoto(ctx(owner), { userId: member.id }))).toBeInstanceOf(NotFoundError);
    const gone = await errorOf(removeUserPhoto(ctx(owner), { userId: "no-such-account" }));
    expect((gone as NotFoundError).message).toBe(USER_PHOTO_NO_ACCOUNT);
  });

  it("allows 20 uploads and removals an hour per person", async () => {
    expect(USER_PHOTO_CHANGES_PER_HOUR).toBe(20);
    const me = await fresh();
    for (let i = 0; i < USER_PHOTO_CHANGES_PER_HOUR; i++) {
      if (i % 2 === 0) await upload(me);
      else await removeUserPhoto(ctx(me), {});
    }
    const limited = await errorOf(upload(me));
    expect(limited).toBeInstanceOf(RateLimitError);
    // Its own words (the window is an hour, not "a few minutes"), and not about the file: no field error.
    expect((limited as RateLimitError).message).toBe(USER_PHOTO_RATE_LIMITED_MESSAGE);
    expect(USER_PHOTO_RATE_LIMITED_MESSAGE).toBe("You've changed your photo 20 times in the last hour, the most there can be. Try again later.");
    expect(limited).not.toBeInstanceOf(ValidationError);
    expect(await errorOf(removeUserPhoto(ctx(me), {}))).toBeInstanceOf(RateLimitError);
    // An hour later it works again.
    expect((await uploadUserPhoto({ ...ctx(me), now: new Date(TEST_NOW.getTime() + 61 * 60 * 1000) }, { file: file("me.png", PNG) })).id).toBeTruthy();
  });

  it("saves each switch on your own account only (both on by default)", async () => {
    const me = await fresh();
    const other = await fresh();
    expect(await t.db.user.findUniqueOrThrow({ where: { id: me.id }, select: { showPhotoInPortal: true, showPhotoOnWebsite: true } })).toEqual({
      showPhotoInPortal: true,
      showPhotoOnWebsite: true,
    });
    expect(await updatePhotoVisibility(ctx(me), { which: "portal" })).toEqual({ which: "portal", show: false, held: false });
    expect(await updatePhotoVisibility(ctx(me), { which: "website", show: "on", userId: other.id })).toEqual({ which: "website", show: true, held: false });
    expect(await updatePhotoVisibility(ctx(me), { which: "website" })).toEqual({ which: "website", show: false, held: false });
    const flags = { showPhotoInPortal: true, showPhotoOnWebsite: true };
    expect(await t.db.user.findUniqueOrThrow({ where: { id: me.id }, select: flags })).toEqual({ showPhotoInPortal: false, showPhotoOnWebsite: false });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: other.id }, select: flags })).toEqual({ showPhotoInPortal: true, showPhotoOnWebsite: true });
    expect(await errorOf(updatePhotoVisibility(ctx(me), { which: "everywhere", show: "on" }))).toBeInstanceOf(ValidationError);
    await updatePhotoVisibility(ctx(me), { which: "portal", show: "on" });
    expect(await getMyPhoto(me, t.db)).toEqual({ photo: null, showPhotoInPortal: true, showPhotoOnWebsite: false, websiteHold: null });
  });

  it("counts toward the team's storage (with its own line), and is refused when it's full", async () => {
    const before = await fileStorageUsage(t.db, false);
    const me = await fresh();
    await upload(me);
    const after = await fileStorageUsage(t.db, false);
    expect(after.photos - before.photos).toBe(PNG.byteLength);
    expect(after.used - before.used).toBe(PNG.byteLength);
    const sum = (await t.db.userPhoto.aggregate({ _sum: { size: true } }))._sum.size;
    expect(after.photos).toBe(sum);
    expect(storageFullSentence({ ...after, resources: 0, sponsors: 0, posters: 0, notebook: 0, strategy: 0, logos: 0, workshop: 0, photos: 2048 })).toBe(
      "The team's file storage is full: 0 bytes of Resources files, 0 bytes of sponsor files, and 2.0 KB of members' photos.",
    );

    // Someone's photo row as big as the whole cap (its size is what counts).
    const hog = await fresh();
    const big = await t.db.userPhoto.create({
      data: { userId: hog.id, filename: "photo.png", contentType: "image/png", size: LIMITS.resourceStorageMaxBytes, data: PNG },
    });
    const full = await fileErrorOf(upload(await fresh()));
    expect(full).toMatch(/^The team's file storage is full: .* of members' photos\. Ask a leader, the captain, a mentor, or a teacher/);
    await t.db.userPhoto.delete({ where: { id: big.id } });
  });
});

// ── Holds: kept off the website until someone who manages the account allows it ─────────────────────────────

describe("holds that keep a photo off the website", () => {
  const listed = async (name: string) => (await listPublicTeamPhotos(t.db)).find((p) => p.key === publicTeamPhotoKey(name));
  const served = async (id: string) =>
    (await publicTeamPhotoResponse(new NextRequest(`https://x.example/api/public/team-photos/${id}`), { db: t.db, id, store: null })).status;

  it("a photo someone who manages the account removed: a new upload stays off the website until they allow it", async () => {
    await setSettings({});
    const member = await makeUser(t.db, { name: "Rory Removed", subteam: "BUILD" });
    await upload(member);
    expect(await listed("Rory Removed")).toBeDefined();
    await removeUserPhoto(ctx(buildLead), { userId: member.id });
    expect(await getWebsitePhotoHold(member.id, t.db)).toEqual({ reason: "removed", at: TEST_NOW.toISOString(), byName: buildLead.name });
    // Uploading the same picture again: in the portal, not on the website (JSON and address), whatever their switch says.
    const again = await upload(member);
    expect((await portalPhotoMap(t.db)).get(member.id)).toBe(again.id);
    expect(await listed("Rory Removed")).toBeUndefined();
    expect(await served(again.id)).toBe(404);
    expect(await updatePhotoVisibility(ctx(member), { which: "website", show: "on" })).toEqual({ which: "website", show: true, held: true });
    expect(await listed("Rory Removed")).toBeUndefined();
    const mine = (await getMyPhoto(member, t.db))!;
    expect(mine.websiteHold?.reason).toBe("removed");
    expect(websitePhotoHoldSentence(mine.websiteHold!)).toMatch(/^Someone who manages your account removed your photo/);
    // Allowed: their switch decides again.
    expect(await allowWebsitePhoto(ctx(buildLead), { userId: member.id })).toEqual({ userId: member.id });
    expect((await listed("Rory Removed"))?.photo).toBe(publicTeamPhotoPath(again.id));
    expect(await served(again.id)).toBe(200);
    const none = await errorOf(allowWebsitePhoto(ctx(buildLead), { userId: member.id }));
    expect([none instanceof NotFoundError, (none as Error).message]).toEqual([true, USER_PHOTO_NOT_HELD]);
    // Removing your own photo holds nothing.
    await removeUserPhoto(ctx(member), {});
    expect(await getWebsitePhotoHold(member.id, t.db)).toBeNull();
  });

  it("“Keep off the team website” (e.g. no photo release) for people who manage the account; never your own unless you're an owner", async () => {
    const member = await makeUser(t.db, { name: "Kim Kept", subteam: "SOFTWARE" });
    const { id } = await upload(member);
    expect(await keepPhotoOffWebsite(ctx(buildLead), { userId: member.id })).toEqual({ userId: member.id });
    expect(await getWebsitePhotoHold(member.id, t.db)).toEqual({ reason: "kept-off", at: TEST_NOW.toISOString(), byName: buildLead.name });
    expect(await listed("Kim Kept")).toBeUndefined();
    expect(await served(id)).toBe(404);
    expect((await portalPhotoMap(t.db)).get(member.id)).toBe(id); // still in the portal
    // A new photo, the switch off and on: still kept off.
    const next = await upload(member);
    await updatePhotoVisibility(ctx(member), { which: "website" });
    await updatePhotoVisibility(ctx(member), { which: "website", show: "on" });
    expect(await served(next.id)).toBe(404);
    // Can be set before there's any photo.
    const noPhoto = await fresh();
    await keepPhotoOffWebsite(ctx(owner), { userId: noPhoto.id });
    expect((await getWebsitePhotoHold(noPhoto.id, t.db))?.reason).toBe("kept-off");

    // Who may: people who manage the account (not other members, not a leader for the captain), never their own
    // (a leader who renamed themselves can't wave it through) — except owners.
    const capt = await fresh({ role: "CAPTAIN" });
    for (const [who, whose, message] of [
      [maya, member, USER_PHOTO_CANT_HOLD],
      [buildLead, capt, USER_PHOTO_CANT_HOLD],
      [buildLead, buildLead, USER_PHOTO_HOLD_OWN],
    ] as const) {
      for (const change of [keepPhotoOffWebsite, allowWebsitePhoto]) {
        const e = await errorOf(change(ctx(who), { userId: whose.id }));
        expect(e, `${who.name} → ${whose.name}`).toBeInstanceOf(ForbiddenError);
        expect((e as ForbiddenError).message).toBe(message);
      }
    }
    expect(await errorOf(keepPhotoOffWebsite(ctx(owner), { userId: "nobody-here" }))).toBeInstanceOf(NotFoundError);
    expect(await errorOf(keepPhotoOffWebsite(ctx(owner), {}))).toBeInstanceOf(ValidationError);
    const pending = await fresh({ status: "PENDING", role: "BUILD_LEADER" });
    expect(await errorOf(keepPhotoOffWebsite(ctx(pending), { userId: member.id }))).toBeInstanceOf(ForbiddenError);
    await keepPhotoOffWebsite(ctx(owner), { userId: owner.id });
    await allowWebsitePhoto(ctx(owner), { userId: owner.id });
    expect(await getWebsitePhotoHold(owner.id, t.db)).toBeNull();

    // Admin → People → a person: the hold, and whether this viewer may change it.
    expect(await getManagedWebsitePhotoHold(buildLead, member.id, t.db)).toEqual({
      hold: { reason: "kept-off", at: TEST_NOW.toISOString(), byName: buildLead.name },
      canChange: true,
    });
    expect(await getManagedWebsitePhotoHold(buildLead, buildLead.id, t.db)).toEqual({ hold: null, canChange: false });
    expect(await getManagedWebsitePhotoHold(owner, owner.id, t.db)).toEqual({ hold: null, canChange: true });
    expect(await getManagedWebsitePhotoHold(maya, member.id, t.db)).toBeNull();
    expect(await getManagedWebsitePhotoHold(buildLead, capt.id, t.db)).toBeNull();
    await allowWebsitePhoto(ctx(captain), { userId: member.id });
    expect(await served(next.id)).toBe(200);
  });

  it("renaming yourself holds your photo off the website until someone checks the new name (the website matches by name)", async () => {
    const coach = await makeUser(t.db, { name: "Coach Kowalski", role: "MENTOR" });
    const coachPhoto = await upload(coach);
    const prankster = await makeUser(t.db, { name: "Pat Prank", subteam: "BUILD" });
    const own = await upload(prankster);
    expect(await listed("Pat Prank")).toBeDefined();

    // Renamed to someone without a portal photo: the photo doesn't go up under the new name.
    // Settings says so when you have a photo.
    expect(await updateProfile(ctx(prankster), { name: "Coach NotInPortal" })).toEqual({ photoHeld: true });
    expect(await getWebsitePhotoHold(prankster.id, t.db)).toEqual({ reason: "renamed", at: TEST_NOW.toISOString(), from: "Pat Prank" });
    expect(await listed("Coach NotInPortal")).toBeUndefined();
    expect(await listed("Pat Prank")).toBeUndefined();
    expect(await served(own.id)).toBe(404);
    const renamed = { ...prankster, name: "Coach NotInPortal" };
    // Uploading after the rename doesn't skip the check.
    const after = await upload(renamed);
    expect(await served(after.id)).toBe(404);

    // Renamed to someone else's name: that person's photo stays (the held account counts under the name it had).
    await updateProfile(ctx(renamed), { name: "coach  KOWALSKI" });
    expect((await getWebsitePhotoHold(prankster.id, t.db))?.from).toBe("Pat Prank"); // the first, checked name
    expect((await listed("Coach Kowalski"))?.photo).toBe(publicTeamPhotoPath(coachPhoto.id));

    // Back to the name it had: the hold goes by itself.
    expect(await updateProfile(ctx({ ...prankster, name: "coach  KOWALSKI" }), { name: "pat prank" })).toEqual({ photoHeld: false });
    expect(await getWebsitePhotoHold(prankster.id, t.db)).toBeNull();
    expect((await listed("Pat Prank"))?.photo).toBe(publicTeamPhotoPath(after.id));

    // Only a change the website would see: case, spacing, and accents don't hold anything.
    const ana = await makeUser(t.db, { name: "Ana Lopez" });
    expect(await updateProfile(ctx(ana), { name: "Ána  LÓPEZ" })).toEqual({ photoHeld: false });
    expect(await getWebsitePhotoHold(ana.id, t.db)).toBeNull();

    // No photo yet: held all the same (photoHeld says there's nothing to hold right now).
    const noPhotoYet = await makeUser(t.db, { name: "Nell First" });
    expect(await updateProfile(ctx(noPhotoYet), { name: "Nell Second" })).toEqual({ photoHeld: false });
    expect((await getWebsitePhotoHold(noPhotoYet.id, t.db))?.reason).toBe("renamed");

    // A real new name, checked and allowed by someone who manages the account: listed under it.
    const zed = await makeUser(t.db, { name: "Zed Old", subteam: "BUILD" });
    await upload(zed);
    await updateProfile(ctx(zed), { name: "Zed New" });
    const held = (await getMyPhoto(zed, t.db))!.websiteHold!;
    expect(websitePhotoHoldSentence(held)).toMatch(/^Your photo is off the team website until a leader, the captain, a mentor, or a teacher checks your new name/);
    expect(await listed("Zed New")).toBeUndefined();
    await allowWebsitePhoto(ctx(buildLead), { userId: zed.id });
    expect(await listed("Zed New")).toBeDefined();

    // A hold someone put on it stays as it is (a rename doesn't replace it, renaming back doesn't lift it).
    const kept = await makeUser(t.db, { name: "Kai Kept" });
    await keepPhotoOffWebsite(ctx(owner), { userId: kept.id });
    expect(await updateProfile(ctx(kept), { name: "Kai Other" })).toEqual({ photoHeld: false });
    expect((await getWebsitePhotoHold(kept.id, t.db))?.reason).toBe("kept-off");
    await updateProfile(ctx({ ...kept, name: "Kai Other" }), { name: "Kai Kept" });
    expect((await getWebsitePhotoHold(kept.id, t.db))?.reason).toBe("kept-off");
  });

  it("reads a damaged hold as kept off (a hold row never lets a photo out)", () => {
    expect(parseWebsitePhotoHold(undefined)).toBeNull();
    expect(parseWebsitePhotoHold(null)).toBeNull();
    expect(parseWebsitePhotoHold("not json")).toEqual({ reason: "kept-off", at: new Date(0).toISOString() });
    expect(parseWebsitePhotoHold('{"reason":"whatever","at":"2026-10-01T00:00:00.000Z"}')).toEqual({ reason: "kept-off", at: "2026-10-01T00:00:00.000Z" });
    expect(parseWebsitePhotoHold('{"reason":"renamed","at":"x","from":"A","byName":"B"}')).toEqual({ reason: "renamed", at: "x", from: "A" });
    expect(websitePhotoHoldKey("abc")).toBe("website-photo-hold:abc");
  });

  it("Admin → Approvals → Members' photos: who's held off (a new name to check) and every photo that went up this week", async () => {
    // Uploaded later than everything above (the list keeps the newest 30).
    const later = new Date(TEST_NOW.getTime() + 30 * 60 * 1000);
    const now = new Date(TEST_NOW.getTime() + 60 * 60 * 1000);
    const uploadLater = (a: Actor) => uploadUserPhoto({ ...ctx(a), now: later }, { file: file("me.png", PNG) });
    const fresh1 = await makeUser(t.db, { name: "Nova New", subteam: "BUILD" });
    const newPhoto = await uploadLater(fresh1);
    const old = await makeUser(t.db, { name: "Olaf Old", subteam: "BUILD" });
    const oldPhoto = await t.db.userPhoto.create({
      data: { userId: old.id, filename: "photo.png", contentType: "image/png", size: PNG.byteLength, data: PNG, createdAt: new Date(TEST_NOW.getTime() - 9 * 24 * 60 * 60 * 1000) },
    });
    const renamer = await makeUser(t.db, { name: "Rene Before", subteam: "BUILD" });
    await upload(renamer);
    await updateProfile(ctx(renamer), { name: "Rene After" });
    const hiddenInPortal = await makeUser(t.db, { name: "Hal Hidden", role: "CAPTAIN" });
    const halPhoto = await uploadLater(hiddenInPortal);
    await updatePhotoVisibility(ctx(hiddenInPortal), { which: "portal" });

    const review = (await getWebsitePhotoReview(buildLead, now, t.db))!;
    expect(review.showPhotos).toBe(true);
    const heldRene = review.held.find((h) => h.userId === renamer.id);
    expect(heldRene).toMatchObject({ name: "Rene After", hold: { reason: "renamed", from: "Rene Before" }, canManage: true });
    const recentIds = review.recent.map((r) => r.userId);
    expect(recentIds).toContain(fresh1.id);
    expect(recentIds).not.toContain(old.id); // older than a week
    expect(recentIds).not.toContain(renamer.id); // held: not on the website
    expect(review.recent.find((r) => r.userId === fresh1.id)).toMatchObject({ photoId: newPhoto.id, uploadedAt: later, hold: null, canManage: true });
    // The newest first.
    const times = review.recent.map((r) => r.uploadedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // A photo hidden in the portal, of someone this viewer doesn't manage: listed, drawn as initials.
    expect(review.recent.find((r) => r.userId === hiddenInPortal.id)).toMatchObject({ photoId: null, canManage: false });
    expect((await getWebsitePhotoReview(owner, now, t.db))!.recent.find((r) => r.userId === hiddenInPortal.id)?.photoId).toBe(halPhoto.id);
    // Members don't get it.
    expect(await getWebsitePhotoReview(maya, now, t.db)).toBeNull();
    expect(oldPhoto.id).toBeTruthy();
  });
});

// ── In Cloudflare R2 ─────────────────────────────────────────────────────────────────────────────────────────

describe("in Cloudflare R2", () => {
  it("is stored under a photos/ key; a replaced or removed photo's object is queued for deletion", async () => {
    const s3 = await startFakeS3();
    try {
      const me = await fresh();
      const r2 = { ...ctx(me), objectStore: s3.store() };
      const first = await uploadUserPhoto(r2, { file: file("me.png", PNG) });
      const firstRow = await t.db.userPhoto.findUniqueOrThrow({ where: { id: first.id } });
      expect(firstRow.data).toBeNull();
      expect(firstRow.storageKey).toMatch(/^photos\/[A-Za-z0-9_-]{24}$/);
      expect(Buffer.from(s3.objects.get(firstRow.storageKey!)!.body).equals(Buffer.from(PNG))).toBe(true);
      expect(await t.db.fileDeletion.count()).toBe(0);

      const second = await uploadUserPhoto(r2, { file: file("me.jpg", jpeg(512, 512)) });
      const secondRow = await t.db.userPhoto.findUniqueOrThrow({ where: { id: second.id } });
      expect((await t.db.fileDeletion.findMany()).map((r) => r.storageKey)).toEqual([firstRow.storageKey]);
      await t.db.fileDeletion.deleteMany();

      // Served from R2 through the public route, like from Postgres.
      const res = await publicTeamPhotoResponse(new NextRequest(`https://x.example/api/public/team-photos/${second.id}`), {
        db: t.db,
        id: second.id,
        store: s3.store(),
      });
      expect([res.status, res.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
      expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(jpeg(512, 512)))).toBe(true);

      await removeUserPhoto(r2, {});
      expect((await t.db.fileDeletion.findMany()).map((r) => r.storageKey)).toEqual([secondRow.storageKey]);
      await t.db.fileDeletion.deleteMany();

      // Deleting the account takes the photo (and queues its object) too.
      const third = await uploadUserPhoto(r2, { file: file("me.png", PNG) });
      const thirdKey = (await t.db.userPhoto.findUniqueOrThrow({ where: { id: third.id } })).storageKey;
      await t.db.user.delete({ where: { id: me.id } });
      expect((await t.db.fileDeletion.findMany()).map((r) => r.storageKey)).toEqual([thirdKey]);
      await t.db.fileDeletion.deleteMany();
    } finally {
      await s3.close();
    }
  });
});

// ── Avatars in the portal ───────────────────────────────────────────────────────────────────────────────────

describe("avatars in the portal", () => {
  it("one lookup says who shows a photo: ACTIVE people with a photo and “Show my photo in the portal” on", async () => {
    const shown = await fresh();
    const hidden = await fresh();
    const leaving = await fresh();
    const none = await fresh();
    const a = await upload(shown);
    await upload(hidden);
    const c = await upload(leaving);
    await updatePhotoVisibility(ctx(hidden), { which: "portal" });
    let map = await portalPhotoMap(t.db);
    expect(map.get(shown.id)).toBe(a.id);
    expect(map.get(leaving.id)).toBe(c.id);
    expect(map.has(hidden.id)).toBe(false);
    expect(map.has(none.id)).toBe(false);
    await t.db.user.update({ where: { id: leaving.id }, data: { status: "DISABLED" } });
    map = await portalPhotoMap(t.db);
    expect(map.has(leaving.id)).toBe(false);
    // The website switch doesn't matter here.
    await updatePhotoVisibility(ctx(shown), { which: "website" });
    expect((await portalPhotoMap(t.db)).get(shown.id)).toBe(a.id);
    // The page render's copy (React cache()) reads the same.
    expect((await getPortalPhotoMap()).get(shown.id)).toBe(a.id);
    // Client components get only the people they show.
    expect(photoIdsFor(map, [shown.id, hidden.id, null, undefined, "nobody"])).toEqual({ [shown.id]: a.id });
  });

  it("the server avatar shows the photo (decorative, in the same fixed circle) or the initials", async () => {
    const me = await makeUser(t.db, { name: "Avery Photo" });
    const { id } = await upload(me);
    const withPhoto = renderToStaticMarkup(await UserAvatar({ userId: me.id, name: me.name, size: "sm" }));
    expect(withPhoto).toContain(`src="${portalPhotoPath(id)}"`);
    expect(withPhoto).toContain('alt=""');
    expect(withPhoto).toContain('aria-hidden="true"');
    expect(withPhoto).toContain("size-7"); // the same size with or without a photo: nothing moves when it loads
    expect(withPhoto).toContain("object-cover");
    expect(withPhoto).toContain("AP"); // the initials stay underneath (shown if the photo can't load)
    const initialsOnly = renderToStaticMarkup(await UserAvatar({ userId: null, name: me.name, size: "sm" }));
    expect(initialsOnly).not.toContain("<img");
    expect(initialsOnly).toContain("size-7");
    expect(renderToStaticMarkup(createElement(Avatar, { name: "No One" }))).not.toContain("<img");

    const chip = renderToStaticMarkup(await UserChipWithPhoto({ userId: me.id, name: me.name, role: "MEMBER", subteam: "BUILD" }));
    expect(chip).toContain(portalPhotoPath(id));
    expect(chip).toContain("Build member");

    // Off in the portal: initials for everyone (the person included).
    await updatePhotoVisibility(ctx(me), { which: "portal" });
    expect(renderToStaticMarkup(await UserAvatar({ userId: me.id, name: me.name }))).not.toContain("<img");
  });

  it("a photo that can't be loaded (replaced, removed, hidden since the page was drawn) hides itself: only the initials show", () => {
    // The photo is a small client component over the initials; it hides (`invisible`: no broken-picture icon) when it
    // fails, also when that happened before the page's script started (complete with no picture), and shows again if
    // it loads after all.
    const html = renderToStaticMarkup(createElement(Avatar, { name: "Avery Photo", photoId: "gone123" }));
    expect(html).toContain(`src="${portalPhotoPath("gone123")}"`);
    expect(html).not.toContain("invisible"); // not hidden before it's tried
    expect(imageFailed({ complete: true, naturalWidth: 0 })).toBe(true); // a 404, or the sign-in page
    expect(imageFailed({ complete: true, naturalWidth: 512 })).toBe(false);
    expect(imageFailed({ complete: false, naturalWidth: 0 })).toBe(false); // still loading, or lazy and not started
    const own = renderToStaticMarkup(createElement(AvatarPhoto, { src: "/people/photos/x", alt: "Maya's photo", lazy: false, className: "size-full" }));
    expect(own).toContain('alt="Maya&#x27;s photo"');
    expect(own).not.toContain('loading="lazy"');
  });

  it("Team members gets photo ids with its rows", () => {
    const html = renderToStaticMarkup(
      createElement(TeamMemberList, {
        people: [
          { ...maya, lastSeenAt: null, adminHref: null, photoId: "photo123" },
          { ...ethan, lastSeenAt: null, adminHref: null },
        ],
        now: TEST_NOW,
        timeZone: TEST_TZ,
      }),
    );
    expect(html).toContain(`src="${portalPhotoPath("photo123")}"`);
    expect(html.split("<img").length - 1).toBe(2); // phone cards + table, Maya only
  });
});

// ── The signed-in route ─────────────────────────────────────────────────────────────────────────────────────

describe("GET /people/photos/[id] (signed in)", () => {
  const call = (id: string, user: Actor | null) => {
    holder.user = user;
    return signedInRoute.GET(new NextRequest(`http://localhost/people/photos/${id}`), { params: Promise.resolve({ id }) } as never);
  };

  it("sends a shown photo to every ACTIVE person, kept by their browser (its address never changes)", async () => {
    const me = await fresh();
    const { id } = await upload(me);
    const res = await call(id, maya);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe(IMMUTABLE_FILE_CACHE);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG))).toBe(true);

    const out = await call(id, null);
    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toMatch(/\/login\?next=%2Fpeople%2Fphotos%2F/);
    expect((await call(id, await fresh({ status: "PENDING" }))).status).toBe(403);
    expect((await call(id, await fresh({ status: "DISABLED" }))).status).toBe(403);
    expect((await call("doesnotexist", maya)).status).toBe(404);
    expect(Object.keys(signedInRoute)).toEqual(["GET"]);
    holder.user = null;
  });

  it("is a 404 once it's hidden in the portal or replaced — except for its owner, and people who manage their account", async () => {
    const me = await fresh({ subteam: "SOFTWARE" });
    const { id } = await upload(me);
    await updatePhotoVisibility(ctx(me), { which: "portal" });
    expect((await call(id, maya)).status).toBe(404);
    expect((await call(id, me)).status).toBe(200); // Settings still shows it
    expect((await call(id, buildLead)).status).toBe(200); // Admin → People (to check what they remove)
    expect((await call(id, owner)).status).toBe(200);

    const capt = await fresh({ role: "CAPTAIN" });
    const capPhoto = await upload(capt);
    await updatePhotoVisibility(ctx(capt), { which: "portal" });
    expect((await call(capPhoto.id, buildLead)).status).toBe(404); // a leader doesn't manage the captain
    expect((await call(capPhoto.id, owner)).status).toBe(200);

    const next = await upload(me);
    for (const who of [me, maya, owner]) expect((await call(id, who)).status, who.name).toBe(404);
    expect((await call(next.id, me)).status).toBe(200);

    // A disabled account's photo isn't shown in the portal any more.
    const leaving = await fresh();
    const theirs = await upload(leaving);
    await t.db.user.update({ where: { id: leaving.id }, data: { status: "DISABLED" } });
    expect((await call(theirs.id, maya)).status).toBe(404);
    expect(await getUserPhotoFile(maya, "x".repeat(65), t.db)).toBeNull();
    holder.user = null;
  });
});

// ── Settings and Admin → People ─────────────────────────────────────────────────────────────────────────────

describe("Settings → My photo and Admin → People", () => {
  it("Settings shows your photo and both switches; Admin → People shows it to people who manage the account", async () => {
    const me = await fresh();
    expect(await getMyPhoto(me, t.db)).toEqual({ photo: null, showPhotoInPortal: true, showPhotoOnWebsite: true, websiteHold: null });
    const { id } = await upload(me);
    expect(await getMyPhoto(me, t.db)).toEqual({
      photo: { id, src: portalPhotoPath(id), width: 64, height: 64, size: PNG.byteLength, createdAt: TEST_NOW },
      showPhotoInPortal: true,
      showPhotoOnWebsite: true,
      websiteHold: null,
    });
    expect(await getMyPhoto({ id: me.id, status: "DISABLED" }, t.db)).toBeNull();

    expect(await getManagedUserPhoto(buildLead, me.id, t.db)).toEqual({
      id,
      src: portalPhotoPath(id),
      createdAt: TEST_NOW,
      showPhotoInPortal: true,
      showPhotoOnWebsite: true,
    });
    expect(await getManagedUserPhoto(maya, me.id, t.db)).toBeNull(); // no admin access
    const capt = await fresh({ role: "CAPTAIN" });
    await upload(capt);
    expect(await getManagedUserPhoto(buildLead, capt.id, t.db)).toBeNull(); // not theirs to manage
    expect(await getManagedUserPhoto(owner, capt.id, t.db)).not.toBeNull();
    expect(await getManagedUserPhoto(owner, (await fresh()).id, t.db)).toBeNull(); // no photo
  });
});

// ── The team website ─────────────────────────────────────────────────────────────────────────────────────────

describe("GET /api/public/team-photos", () => {
  const url = `https://communication-portal-iota.vercel.app${PUBLIC_TEAM_PHOTOS_PATH}`;
  const call = (init: RequestInit & { origin?: string } = {}, extraOrigins?: string, db: Db = t.db) => {
    const headers = new Headers(init.headers);
    if (init.origin) headers.set("origin", init.origin);
    return publicTeamPhotosResponse(new Request(url, { ...init, headers }), { db, now: TEST_NOW, teamTimezone: TEST_TZ, extraOrigins });
  };
  const answer = async () => (await getPublicTeamPhotos(t.db, { now: TEST_NOW })) as PublicTeamPhotos;
  /** The entry the website would match to this name. */
  const named = async (name: string) => (await answer()).photos.find((p) => p.key === publicTeamPhotoKey(name));

  it("keys each photo by a hash of the name, the way the team website hashes its own names (never the name)", () => {
    // The same vectors are in the website's tests/team-photos.test.mjs: keep them in step.
    expect(publicTeamPhotoKey("Maya Patel")).toBe("26ec013ef85a6d422b9cb8158191cf83");
    expect(publicTeamPhotoKey("José  O’Neil")).toBe("5cfa8a3f05f9afcbcb2e7ca5e7cde4fa");
    expect(publicTeamPhotoKey("Ethan Chen")).toBe("83c8ddfd98973272348688899a8133fc");
    expect(publicTeamPhotoKey("  ZOE   park ")).toBe("430c9a24c998fe3de046a33d44b957b5");
    expect(publicTeamPhotoKey("张伟")).toBe("f9e2cbbc79ddcb7cff0a5b670c253a20");
    expect(publicTeamPhotoKey("   ")).toBeNull();
    // Compared like the website's normalizeName: case, spacing, accents, curly apostrophes, look-alike forms.
    expect(teamPhotoNameKey("  JOSÉ   O’Neil ")).toBe("jose o'neil");
    expect(teamPhotoNameKey("Jose Diaz")).toBe(teamPhotoNameKey("José Díaz"));
    expect(teamPhotoNameKey("Ｍａｙａ Patel")).toBe("maya patel");
    expect(publicTeamPhotoKey("maya   PATEL")).toBe(publicTeamPhotoKey("Maya Patel"));
    expect(publicTeamPhotoKey("Maya Patel")).toMatch(TEAM_PHOTO_KEY_RE);
  });

  it("lists every ACTIVE person's published photo by name key — members, leaders, the captain, mentors, teachers — and nothing else", async () => {
    await setSettings({});
    const people = {
      member: await makeUser(t.db, { name: "  Zoe   Park ", email: "zoe.secret@example.com" }),
      lead: await makeUser(t.db, { name: "Lena Lead", role: "SOFTWARE_LEADER" }),
      capt: await makeUser(t.db, { name: "Cap Tain", role: "CAPTAIN" }),
      mentor: await makeUser(t.db, { name: "Mona Mentor", role: "MENTOR" }),
      teacher: await makeUser(t.db, { name: "Ted Teacher", role: "TEACHER" }),
      hidden: await makeUser(t.db, { name: "Hana Hidden" }),
      portalOnly: await makeUser(t.db, { name: "Pat Portal" }),
    };
    const ids: Record<string, string> = {};
    for (const [key, who] of Object.entries(people)) ids[key] = (await upload(who)).id;
    await updatePhotoVisibility(ctx(people.hidden), { which: "website" });
    // "Show my photo in the portal" off doesn't take it off the website.
    await updatePhotoVisibility(ctx(people.portalOnly), { which: "portal" });
    // Waiting, turned down, and disabled accounts never show (rows written directly: they can't upload).
    for (const status of ["PENDING", "REJECTED", "DISABLED"] as const) {
      const a = await makeUser(t.db, { name: `Gone ${status}`, status });
      await t.db.userPhoto.create({ data: { userId: a.id, filename: "photo.png", contentType: "image/png", size: PNG.byteLength, data: PNG } });
    }

    const a = await answer();
    expect(a).toMatchObject({ enabled: true, updatedAt: TEST_NOW.toISOString() });
    expect(Object.keys(a).sort()).toEqual(["enabled", "photos", "updatedAt"]);
    for (const p of a.photos) {
      expect(Object.keys(p).sort()).toEqual(["key", "photo"]);
      expect(p.key).toMatch(TEAM_PHOTO_KEY_RE);
    }
    expect(await named("Zoe Park")).toEqual({ key: publicTeamPhotoKey("Zoe Park"), photo: publicTeamPhotoPath(ids.member) });
    for (const [key, name] of [
      ["lead", "Lena Lead"],
      ["capt", "Cap Tain"],
      ["mentor", "Mona Mentor"],
      ["teacher", "Ted Teacher"],
      ["portalOnly", "Pat Portal"],
    ]) {
      expect(await named(name), name).toEqual({ key: publicTeamPhotoKey(name), photo: `/api/public/team-photos/${ids[key]}` });
    }
    expect(await named("Hana Hidden")).toBeUndefined();
    for (const status of ["PENDING", "REJECTED", "DISABLED"]) expect(await named(`Gone ${status}`)).toBeUndefined();
    // Sorted by key (not by name: nothing about the names).
    const keys = a.photos.map((p) => p.key);
    expect(keys).toEqual([...keys].sort());
    // Never names, emails, account ids, positions, or the switches.
    const json = JSON.stringify(a);
    for (const secret of [
      "Zoe",
      "Park",
      "Mentor",
      "Teacher",
      "@example.com",
      people.member.id,
      people.lead.id,
      "MEMBER",
      "CAPTAIN",
      "showPhoto",
      "storageKey",
      "image/png",
      "name",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
  });

  it("leaves out a name two ACTIVE accounts share as the website compares names (the website matches by name)", async () => {
    const one = await makeUser(t.db, { name: "Sam Same" });
    const two = await makeUser(t.db, { name: "sam  SAME" });
    await upload(one);
    expect(await named("Sam Same")).toBeUndefined();
    await t.db.user.update({ where: { id: two.id }, data: { status: "DISABLED" } });
    expect(await named("Sam Same")).toBeDefined();
    expect(teamPhotoNameKey(" Sam   SAME ")).toBe(teamPhotoNameKey("sam same"));
    // Accents and curly apostrophes too: the website would match "José Díaz" and "Jose Diaz" to the same card.
    const jose = await makeUser(t.db, { name: "José Díaz" });
    await upload(jose);
    expect(await named("Jose Diaz")).toBeDefined();
    const other = await makeUser(t.db, { name: "Jose Diaz" });
    await upload(other);
    expect(await named("José Díaz")).toBeUndefined();
    expect(await named("Jose Diaz")).toBeUndefined();
  });

  it("drops a photo as soon as its owner turns the website switch off, removes it, or replaces it", async () => {
    const me = await makeUser(t.db, { name: "Willa Website" });
    const first = await upload(me);
    expect((await named("Willa Website"))?.photo).toBe(publicTeamPhotoPath(first.id));
    await updatePhotoVisibility(ctx(me), { which: "website" });
    expect(await named("Willa Website")).toBeUndefined();
    await updatePhotoVisibility(ctx(me), { which: "website", show: "on" });
    const second = await upload(me);
    expect((await named("Willa Website"))?.photo).toBe(publicTeamPhotoPath(second.id));
    await removeUserPhoto(ctx(me), {});
    expect(await named("Willa Website")).toBeUndefined();
  });

  it("is {enabled: false} while the team doesn't show photos (Admin → Team website; on by default)", async () => {
    await setSettings({ showPhotos: false });
    expect(await getPublicTeamPhotos(t.db, { now: TEST_NOW })).toEqual({ enabled: false });
    expect(await publicTeamPhotosShown(t.db)).toBe(false);
    expect(await (await call({ origin: TEAM_SITE_ORIGIN })).json()).toEqual({ enabled: false });
    await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_KEY } });
    expect(await publicTeamPhotosShown(t.db)).toBe(true); // nothing saved yet: on
    expect((await answer()).enabled).toBe(true);
    await setSettings({});
  });

  it("lets the team website read it (CORS for it only), cached briefly, never sniffed or indexed; HEAD and the preflight; 503 on failure", async () => {
    const res = await call({ origin: TEAM_SITE_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, noimageindex");
    expect(PUBLIC_NO_INDEX_HEADERS).toEqual({ "X-Robots-Tag": "noindex, noimageindex" });
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(((await res.json()) as PublicTeamPhotos).photos.length).toBeGreaterThan(0);
    for (const origin of ["https://evil.example", "null", "https://huskyteers19516.github.io.evil.example"]) {
      expect((await call({ origin })).headers.get("access-control-allow-origin"), origin).toBe(TEAM_SITE_ORIGIN);
    }
    expect((await call({ origin: "http://localhost:4430" }, "http://localhost:4430")).headers.get("access-control-allow-origin")).toBe("http://localhost:4430");
    const head = await call({ method: "HEAD", origin: TEAM_SITE_ORIGIN });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    const preflight = await call({ method: "OPTIONS", origin: TEAM_SITE_ORIGIN });
    expect([preflight.status, preflight.headers.get("access-control-allow-methods")]).toEqual([204, "GET, HEAD, OPTIONS"]);
    const post = await call({ method: "POST", origin: TEAM_SITE_ORIGIN, body: "{}" });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET, HEAD, OPTIONS"]);

    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { teamNote: { findMany: () => Promise.reject(new Error("database down")) } } as unknown as Db;
    const failed = await call({ origin: TEAM_SITE_ORIGIN }, undefined, broken);
    quiet.mockRestore();
    expect([failed.status, failed.headers.get("cache-control")]).toEqual([503, "no-store"]);
    expect(await failed.json()).toEqual({ error: PUBLIC_TEAM_PHOTOS_UNAVAILABLE });
  });

  it("is served by the route (GET, HEAD, OPTIONS) without signing in", async () => {
    const req = (method: string) => new NextRequest(url, { method, headers: { origin: TEAM_SITE_ORIGIN } });
    const res = await photosRoute.GET(req("GET"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PublicTeamPhotos).photos.map((p) => p.key)).toContain(publicTeamPhotoKey("Zoe Park"));
    expect((await photosRoute.HEAD(req("HEAD"))).status).toBe(200);
    expect((await photosRoute.OPTIONS(req("OPTIONS"))).status).toBe(204);
    expect(Object.keys(photosRoute).sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
  });
});

describe("GET /api/public/team-photos/[id]", () => {
  const ask = (id: string, method = "GET", query = "", db: Db = t.db) =>
    publicTeamPhotoResponse(new NextRequest(`https://communication-portal-iota.vercel.app/api/public/team-photos/${id}${query}`, { method }), {
      db,
      id,
      store: null,
    });

  it("serves a published photo inline, sandboxed, never sniffed, embeddable by the team website, under a neutral name", async () => {
    await setSettings({});
    const me = await makeUser(t.db, { name: "Nia Neutral" });
    const { id } = await upload(me, PNG, "Nia Neutral at home.png");
    const res = await ask(id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(PNG))).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="team-photo.png"; filename*=UTF-8''team-photo.png`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_FILE_IMMUTABLE_CACHE);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, noimageindex"); // minors' photos: not for image search
    expect(res.headers.get("set-cookie")).toBeNull();
    const head = await ask(id, "HEAD");
    expect([head.status, await head.text(), head.headers.get("content-type")]).toEqual([200, "", "image/png"]);

    // Through the route, without signing in.
    const viaRoute = await photoRoute.GET(new NextRequest(`https://x.example/api/public/team-photos/${id}`), { params: Promise.resolve({ id }) } as never);
    expect(viaRoute.status).toBe(200);
    expect(Object.keys(photoRoute).sort()).toEqual(["GET", "HEAD"]);
  });

  it("is a 404 (not cached) unless it's published right now", async () => {
    const me = await makeUser(t.db, { name: "Ola Offline" });
    const { id } = await upload(me);
    const notFound = async (which: string, label: string) => {
      const res = await ask(which);
      expect([res.status, res.headers.get("cache-control")], label).toEqual([404, "private, no-store"]);
      expect(await res.text(), label).toBe(PUBLIC_TEAM_PHOTO_NOT_FOUND);
    };
    expect((await ask(id)).status).toBe(200);
    await updatePhotoVisibility(ctx(me), { which: "website" });
    await notFound(id, "website switch off");
    await updatePhotoVisibility(ctx(me), { which: "website", show: "on" });
    await setSettings({ showPhotos: false });
    await notFound(id, "the team doesn't show photos");
    await setSettings({});
    await t.db.user.update({ where: { id: me.id }, data: { status: "DISABLED" } });
    await notFound(id, "account disabled");
    await t.db.user.update({ where: { id: me.id }, data: { status: "ACTIVE" } });
    const next = await upload(me);
    await notFound(id, "replaced");
    expect((await ask(next.id)).status).toBe(200);
    await notFound("doesnotexist123", "unknown");
    await notFound(`${next.id}.png`, "a dot");
    await notFound("a".repeat(65), "too long");
  });

  it("sends an address with a query string to the bare one, without reading the database or the file", async () => {
    const touched: string[] = [];
    const watching = new Proxy({} as Db, {
      get(_target, key) {
        touched.push(String(key));
        throw new Error(`the database was used (${String(key)})`);
      },
    });
    for (const query of ["?cb=1", "?size=64"]) {
      const res = await ask("abc123", "GET", query, watching);
      expect([res.status, res.headers.get("location"), res.headers.get("cache-control")], query).toEqual([
        308,
        "/api/public/team-photos/abc123",
        PUBLIC_FILE_REDIRECT_CACHE,
      ]);
    }
    expect(touched).toEqual([]);
  });
});

describe("which paths are public", () => {
  it("lets the JSON and one photo id through the proxy without a session; nothing deeper; the portal's own route still needs one", () => {
    expect(PUBLIC_API_PATHS).toContain(PUBLIC_TEAM_PHOTOS_PATH);
    expect(PUBLIC_API_FILE_PREFIXES).toContain(PUBLIC_TEAM_PHOTOS_PREFIX);
    expect(PUBLIC_TEAM_PHOTOS_PREFIX).toBe(`${PUBLIC_TEAM_PHOTOS_PATH}/`);
    const visit = (path: string) => proxy(new NextRequest(`https://communication-portal-iota.vercel.app${path}`));
    for (const path of [PUBLIC_TEAM_PHOTOS_PATH, `${PUBLIC_TEAM_PHOTOS_PREFIX}cmg3x9k2a0000abcd1234efgh`, `${PUBLIC_TEAM_PHOTOS_PREFIX}a_b-C9`]) {
      expect(isPublicApiPath(path), path).toBe(true);
      expect(visit(path).headers.get("x-middleware-next"), path).toBe("1");
    }
    for (const path of [
      PUBLIC_TEAM_PHOTOS_PREFIX,
      `${PUBLIC_TEAM_PHOTOS_PREFIX}a/b`,
      `${PUBLIC_TEAM_PHOTOS_PREFIX}a%2fb`,
      `${PUBLIC_TEAM_PHOTOS_PREFIX}..`,
      `${PUBLIC_TEAM_PHOTOS_PREFIX}a.png`,
      `${PUBLIC_TEAM_PHOTOS_PREFIX}${"a".repeat(65)}`,
      "/api/public/team-photo",
      "/api/public/team-photos/",
      "/API/public/team-photos",
    ]) {
      expect(isPublicApiPath(path), path).toBe(false);
      const res = visit(path);
      expect(res.headers.get("x-middleware-next"), path).toBeNull();
      // Under /api/: the JSON 401; anywhere else: to sign in.
      expect(res.status, path).toBe(path.startsWith("/api/") ? 401 : 307);
    }
    // The portal's own photo route is a signed-in page like any other: without a session cookie, to sign in.
    const signedOut = visit("/people/photos/abc");
    expect(signedOut.status).toBe(307);
    expect(signedOut.headers.get("location")).toMatch(/\/login\?next=%2Fpeople%2Fphotos%2Fabc$/);
  });
});

describe("Admin → Team website", () => {
  it("turns members' photos on and off with the other settings (unchecked = off) and says how many would show", async () => {
    const saved = await updatePublicProgressSettings(ctx(buildLead), { enabled: "on", nameStyle: "full", showTaskTitles: "on", showPhotos: "on" });
    expect(saved.showPhotos).toBe(true);
    expect(await publicTeamPhotosShown(t.db)).toBe(true);
    expect((await updatePublicProgressSettings(ctx(captain), { enabled: "on", nameStyle: "full" })).showPhotos).toBe(false);
    expect(await publicTeamPhotosShown(t.db)).toBe(false);
    expect(await errorOf(updatePublicProgressSettings(ctx(maya), { showPhotos: "on" }))).toBeInstanceOf(ForbiddenError);

    // The card says how many photos the Our Team page gets (counted while it's off, too).
    const preview = (await getTeamWebsitePreview(buildLead, TEST_TZ, t.db))!;
    expect(preview.photos).toBe((await listPublicTeamPhotos(t.db)).length);
    expect(preview.photos).toBeGreaterThan(0);
    expect(await getTeamWebsitePreview(maya, TEST_TZ, t.db)).toBeNull();
    expect((await updatePublicProgressSettings(ctx(teacher), { enabled: "on", nameStyle: "full", showPhotos: "on" })).showPhotos).toBe(true);
    expect(await getTeamWebsitePreview(mentor, TEST_TZ, t.db)).toEqual(preview);
    await setSettings({});
  });
});

// ── Cropping in the browser (the math) ──────────────────────────────────────────────────────────────────────

describe("cropping to a square", () => {
  it("cuts the biggest centered square at zoom 1, a smaller one when zoomed, never outside the picture", () => {
    expect(photoCropRect(400, 300, CENTERED_CROP)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(photoCropRect(300, 400, CENTERED_CROP)).toEqual({ sx: 0, sy: 50, side: 300 });
    expect(photoCropRect(400, 300, { zoom: 2, x: 0.5, y: 0.5 })).toEqual({ sx: 125, sy: 75, side: 150 });
    // Pushed past an edge: pulled back inside.
    expect(photoCropRect(400, 300, { zoom: 1, x: 0, y: 0 })).toEqual({ sx: 0, sy: 0, side: 300 });
    expect(photoCropRect(400, 300, { zoom: 2, x: 1, y: 1 })).toEqual({ sx: 250, sy: 150, side: 150 });
    // Zoom stays between 1 and the most; nonsense falls back to the center.
    expect(photoCropRect(400, 300, { zoom: 0.2, x: 0.5, y: 0.5 }).side).toBe(300);
    expect(photoCropRect(400, 400, { zoom: 99, x: 0.5, y: 0.5 }).side).toBe(400 / USER_PHOTO_MAX_ZOOM);
    expect(photoCropRect(400, 300, { zoom: Number.NaN, x: Number.NaN, y: 0.5 })).toEqual({ sx: 50, sy: 0, side: 300 });
  });

  it("moves with a drag (in preview pixels) and keeps the center where the square can be", () => {
    // 400 × 300 at zoom 1: the square can only slide sideways.
    const left = movePhotoCrop(400, 300, CENTERED_CROP, 80, 0, 160);
    expect(photoCropRect(400, 300, left)).toEqual({ sx: 0, sy: 0, side: 300 });
    const right = movePhotoCrop(400, 300, CENTERED_CROP, -20, 40, 160);
    expect(photoCropRect(400, 300, right).sx).toBeCloseTo(50 + (20 * 300) / 160);
    expect(photoCropRect(400, 300, right).sy).toBe(0);
    expect(clampPhotoCrop(400, 300, { zoom: 1, x: 0.9, y: 0.1 })).toEqual({ zoom: 1, x: 0.625, y: 0.5 });
  });
});
