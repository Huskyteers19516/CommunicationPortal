// Meeting recaps (/meetings): who records and who reads (services/meeting-recaps.ts, services/meeting-categories.ts,
// queries/meeting-recaps.ts), validation, saving again with the same request id, the team's categories, the recording
// uploaded in parts (exact sizes, the first part's bytes, retries, two uploads of one part at once — in Postgres and
// in a fake R2 — completeness), its 3 days (every read, the purge — also before a new recording is checked against the
// storage cap — the daily cron and its proxy exemption, "Delete recording now"), the list's filters and search, Today,
// the part route, the actions (and what the upload check says when it can't answer), and the demo seed. Cloudflare R2
// for this kind of file is otherwise covered by tests/file-storage-r2.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Queries, routes, and actions read through the app-wide `prisma`: point it at this file's database. Routes and
// actions ask getCurrentUser who's signed in (holder.user). revalidatePath is counted and after() collected (there's
// no Next.js request here).
const holder = vi.hoisted(() => ({
  db: null as unknown as Record<string | symbol, unknown>,
  user: null as unknown,
  refreshed: 0,
  after: [] as (() => unknown)[],
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
vi.mock("next/cache", () => ({
  revalidatePath: () => {
    holder.refreshed++;
  },
}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (fn: () => unknown) => {
      holder.after.push(fn);
    },
  };
});

import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { DEFAULT_MEETING_CATEGORIES, seed } from "../prisma/seed";
import {
  createMeetingCategoryAction,
  createMeetingRecapAction,
  deleteMeetingRecapAction,
  getMeetingAudioUploadStateAction,
  updateMeetingRecapAction,
  uploadMeetingAudioPartAction,
} from "@/app/(app)/meetings/actions";
import * as audioRoute from "@/app/(app)/meetings/audio/[id]/route";
import * as cronRoute from "@/app/api/cron/meeting-audio/route";
import { initialActionState } from "@/lib/action-state";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb, todayInTimezone } from "@/lib/dates";
import {
  formatMeetingDuration,
  MEETING_AUDIO_KEEP_MS,
  MEETING_AUDIO_MAX_BYTES,
  MEETING_AUDIO_PART_BYTES,
  MEETING_AUDIO_PARTS_MAX,
  MEETING_CATEGORIES_MAX,
  MEETING_RECAPS_PAGE_SIZE,
  meetingAudioExtension,
  meetingAudioPartHref,
  meetingRecapCountText,
  meetingRecapsHref,
  newMeetingRequestId,
  normalizeMeetingAudioType,
  parseMeetingRecapFilters,
  parseMeetingRequestId,
  sniffMeetingAudioType,
} from "@/lib/meeting-recaps";
import { config as proxyConfig, proxy } from "@/proxy";
import { type Actor, actorSelect } from "@/server/actor";
import type { Db } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { drainFileDeletions, type ObjectStore } from "@/server/files/object-store";
import { fileStorageUsage, storageFullSentence } from "@/server/files/storage";
import { scheduleMeetingAudioPurge } from "@/server/meetings/purge";
import { canManageMeetingRecaps } from "@/server/permissions";
import {
  getMeetingAudioPartFile,
  getMeetingRecap,
  getMeetingRecapFormValues,
  getMeetingRecorderSetup,
  getRecentMeetingRecaps,
  listMeetingCategories,
  listMeetingRecaps,
  meetingAudioHeaders,
  meetingAudioState,
} from "@/server/queries/meeting-recaps";
import {
  createMeetingCategory,
  deleteMeetingCategory,
  MEETING_CATEGORIES_FULL,
  MEETING_CATEGORY_RATE_LIMIT,
  meetingCategoryDuplicateMessage,
  renameMeetingCategory,
} from "@/server/services/meeting-categories";
import {
  addMeetingAudioPart,
  createMeetingRecap,
  deleteMeetingAudio,
  deleteMeetingRecap,
  getMeetingAudioUploadState,
  hasExpiredMeetingAudio,
  MEETING_AUDIO_ALREADY_DELETED,
  MEETING_AUDIO_NONE,
  MEETING_AUDIO_PART_WRONG_SIZE,
  MEETING_AUDIO_PART_WRONG_TYPE,
  MEETING_AUDIO_PARTS_INVALID,
  MEETING_AUDIO_PARTS_PER_HOUR,
  MEETING_AUDIO_POSITION_INVALID,
  MEETING_AUDIO_SAVED_WITHOUT,
  MEETING_AUDIO_TOO_BIG,
  MEETING_AUDIO_TOO_LATE,
  MEETING_AUDIO_TYPE_REFUSED,
  MEETING_CATEGORY_GONE,
  MEETING_RECAP_CHANGED,
  MEETING_RECAP_CHANGED_BEFORE_DELETE,
  MEETING_RECAP_FORBIDDEN,
  MEETING_RECAP_RATE_LIMIT,
  meetingAudioRefusedMessage,
  purgeExpiredMeetingAudio,
  updateMeetingRecap,
} from "@/server/services/meeting-recaps";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";
import { type FakeS3, startFakeS3 } from "./helpers/fake-s3";

type Who =
  | "owner"
  | "captain"
  | "mentor"
  | "teacher"
  | "swLead"
  | "buildLead"
  | "bizLead"
  | "swMember"
  | "buildMember"
  | "bizMember"
  | "noSubteam"
  | "pendingLead"
  | "disabledMentor";

const ADMINS: Who[] = ["owner", "captain", "mentor", "teacher", "swLead", "buildLead", "bizLead"];
const MEMBERS: Who[] = ["swMember", "buildMember", "bizMember", "noSubteam"];
const INACTIVE: Who[] = ["pendingLead", "disabledMentor"];

let t: TestDb;
let p: Record<Who, Actor>;

const HOUR = 60 * 60 * 1000;
const PART = MEETING_AUDIO_PART_BYTES;

async function makePeople(db: Db): Promise<Record<Who, Actor>> {
  return {
    owner: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true, name: "Olive Owner" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Mia Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Theo Teacher" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Lead" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Amara Lead" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ethan Build" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Gwen Business" }),
    noSubteam: await makeUser(db, { role: "MEMBER", subteam: null, name: "Nia Nosubteam" }),
    pendingLead: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING", name: "Pat Pending" }),
    disabledMentor: await makeUser(db, { role: "MENTOR", status: "DISABLED", name: "Dana Disabled" }),
  };
}

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  p = await makePeople(t.db);
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  await t.db.rateLimit.deleteMany();
  holder.user = null;
  holder.after.length = 0;
});

const ctxFor = (a: Actor, now: Date = TEST_NOW) => ({ ...contextFor(t.db, a), now });

const input = (over: Record<string, unknown> = {}) => ({
  title: "Kickoff: game strategy",
  meetingDate: TEST_TODAY,
  categoryIds: ["meetingcat-whole-team", "meetingcat-strategy"],
  keyPoints: "[0:42] Decision: we build a 4-bar intake.\n[3:10] To do (Alice, by Friday): order the motors.",
  transcript: "[0:00] Welcome, everyone.\n[0:42] Let's go with the 4-bar intake.",
  durationSec: "1830",
  ...over,
});

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (e: unknown) => e,
  );
}

/** A fake WebM recording of `size` bytes: its magic bytes, then zeros. */
function webm(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
}

/** A recording cut into upload parts. */
function partsOf(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += PART) out.push(bytes.subarray(i, i + PART));
  return out;
}

const file = (bytes: Uint8Array) => ({ name: "blob", type: "audio/webm", bytes });

/** A recap that says a recording of `size` bytes is coming (saved at `now`). */
async function recapWithAudio(by: Actor, size: number, now: Date = TEST_NOW, over: Record<string, unknown> = {}): Promise<string> {
  const { id, audioRefused } = await createMeetingRecap(
    ctxFor(by, now),
    input({ audioType: "audio/webm", audioBytes: size, audioParts: Math.ceil(size / PART), ...over }),
  );
  expect(audioRefused).toBeNull();
  return id;
}

async function uploadAll(by: Actor, recapId: string, bytes: Uint8Array, now: Date = TEST_NOW) {
  const results = [];
  for (const [position, part] of partsOf(bytes).entries()) {
    results.push(await addMeetingAudioPart(ctxFor(by, now), { recapId, position, file: file(part) }));
  }
  return results;
}

const updatedAtOf = async (id: string) => (await t.db.meetingRecap.findUniqueOrThrow({ where: { id } })).updatedAt.getTime();

/** A Resources file of `size` bytes (counted by its row's size; it holds one byte), deleted again by the returned function. */
async function filler(size: number): Promise<() => Promise<void>> {
  const { id } = await t.db.resource.create({
    data: { title: "Filler", file: { create: { filename: "big.bin", contentType: "application/octet-stream", size, data: new Uint8Array([1]) } } },
    select: { id: true },
  });
  return async () => {
    await t.db.resource.delete({ where: { id } });
  };
}

/** Fills the team's file storage (Postgres cap) until only `room` bytes are left. */
async function leaveRoom(room: number): Promise<() => Promise<void>> {
  const usage = await fileStorageUsage(t.db, false);
  return filler(usage.max - usage.used - room);
}

/** Resolves once `n` callers have called it: each one waits for all the others (to make two requests overlap). */
function meetingPoint(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((resolve) => (open = resolve));
  return () => {
    if (++arrived >= n) open();
    return all;
  };
}

/** `db`, except that addMeetingAudioPart's first look for the part (meetingAudioPart.findUnique) waits at `wait`. */
function dbWaitingAt(db: Db, wait: () => Promise<void>): Db {
  const bind = <T extends object>(target: T, key: string | symbol) => {
    const value = Reflect.get(target, key) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };
  const parts = new Proxy(db.meetingAudioPart, {
    get: (target, key) =>
      key === "findUnique"
        ? async (args: Parameters<Db["meetingAudioPart"]["findUnique"]>[0]) => {
            await wait();
            return target.findUnique(args);
          }
        : bind(target, key),
  });
  return new Proxy(db, { get: (target, key) => (key === "meetingAudioPart" ? parts : bind(target, key)) });
}

// ── Client-safe helpers ─────────────────────────────────────────────────────────────────────────────────────────

describe("the client-safe helpers (src/lib/meeting-recaps.ts)", () => {
  it("sniff recordings by their first bytes", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sniffMeetingAudioType(webm(16))).toBe("audio/webm");
    expect(sniffMeetingAudioType(Uint8Array.from([0, 0, 0, 0x20, ...enc("ftypM4A ")]))).toBe("audio/mp4");
    expect(sniffMeetingAudioType(enc("OggS\u0000\u0002"))).toBe("audio/ogg");
    expect(sniffMeetingAudioType(enc("RIFF$\u0000\u0000\u0000WAVEfmt "))).toBe("audio/wav");
    expect(sniffMeetingAudioType(enc("RIFF$\u0000\u0000\u0000AVI LIST"))).toBeNull();
    expect(sniffMeetingAudioType(enc("ID3\u0004\u0000"))).toBe("audio/mpeg");
    expect(sniffMeetingAudioType(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg"); // MPEG-1 layer III
    expect(sniffMeetingAudioType(Uint8Array.from([0xff, 0xf1, 0x50, 0x80]))).toBeNull(); // AAC (ADTS), not MP3
    expect(sniffMeetingAudioType(enc("<html>"))).toBeNull();
    expect(sniffMeetingAudioType(new Uint8Array())).toBeNull();
  });

  it("normalize browsers' types, and name the files", () => {
    expect(normalizeMeetingAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(normalizeMeetingAudioType("Video/WebM")).toBe("audio/webm");
    expect(normalizeMeetingAudioType("audio/x-m4a")).toBe("audio/mp4");
    expect(normalizeMeetingAudioType("audio/mp4; codecs=mp4a.40.2")).toBe("audio/mp4");
    expect(normalizeMeetingAudioType("audio/mp3")).toBe("audio/mpeg");
    expect(normalizeMeetingAudioType("audio/x-wav")).toBe("audio/wav");
    expect(normalizeMeetingAudioType("audio/aac")).toBeNull();
    expect(normalizeMeetingAudioType("text/html")).toBeNull();
    expect(meetingAudioExtension("audio/mp4")).toBe("m4a");
    expect(meetingAudioExtension("audio/mpeg")).toBe("mp3");
    expect(MEETING_AUDIO_PARTS_MAX).toBe(34);
    expect(MEETING_AUDIO_KEEP_MS).toBe(72 * HOUR);
  });

  it("read the list's filters from the URL and build links", () => {
    expect(parseMeetingRecapFilters({ category: "meetingcat-build", q: "  intake  ", page: "2" })).toEqual({
      category: "meetingcat-build",
      q: "intake",
      page: 2,
    });
    expect(parseMeetingRecapFilters({ category: "../x", q: "\u0000", page: "-3" })).toEqual({});
    expect(parseMeetingRecapFilters({ q: ["a", "b"], page: "1" })).toEqual({ q: "a" });
    expect(meetingRecapsHref({})).toBe("/meetings");
    expect(meetingRecapsHref({ category: "c1", q: "4-bar intake", page: 3 }, { removed: "1" })).toBe("/meetings?category=c1&q=4-bar+intake&page=3&removed=1");
    expect(meetingAudioPartHref("abc")).toBe("/meetings/audio/abc");
    expect(formatMeetingDuration(30)).toBe("under a minute");
    expect(formatMeetingDuration(42 * 60 + 10)).toBe("42 min");
    expect(formatMeetingDuration(65 * 60)).toBe("1 h 05 min");
    expect(meetingRecapCountText(1)).toBe("1 recap");
    expect(meetingRecapCountText(21, { categoryName: "Build", q: "intake", page: 2, pageCount: 2 })).toBe("21 recaps in Build matching “intake” · page 2 of 2");
  });
});

// ── Who ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("who records and who reads", () => {
  it("everyone with admin access manages recaps; members, pending, and disabled accounts don't", () => {
    for (const who of ADMINS) expect(canManageMeetingRecaps(p[who]), who).toBe(true);
    for (const who of MEMBERS) expect(canManageMeetingRecaps(p[who]), who).toBe(false);
  });

  it("every admin-access role can do everything: save, edit, upload, check an upload, delete the recording and the recap, and keep the categories", async () => {
    for (const who of ADMINS) {
      const a = p[who];
      const id = await recapWithAudio(a, 100, TEST_NOW, { title: `Saved by ${who}` });
      const version = (await getMeetingRecapFormValues(a, id, t.db))!.version;
      expect(await updateMeetingRecap(ctxFor(a), input({ recapId: id, version, title: `Edited by ${who}` }))).toEqual({ id, changed: true });
      expect(await addMeetingAudioPart(ctxFor(a), { recapId: id, position: 0, file: file(webm(100)) })).toEqual({ complete: true, duplicate: false });
      expect((await getMeetingAudioUploadState(ctxFor(a), { recapId: id })).complete).toBe(true);
      expect(await deleteMeetingAudio(ctxFor(a), { recapId: id })).toEqual({ id, parts: 1 });
      expect(await deleteMeetingRecap(ctxFor(a), { recapId: id })).toEqual({ id });
      const category = await createMeetingCategory(ctxFor(a), { name: `Category of ${who}` });
      expect((await renameMeetingCategory(ctxFor(a), { categoryId: category.id, name: `Renamed by ${who}` })).changed).toBe(true);
      expect(await deleteMeetingCategory(ctxFor(a), { categoryId: category.id })).toMatchObject({ id: category.id, recaps: 0 });
    }
  });

  it("members, pending, and disabled accounts change nothing (a ForbiddenError from every service)", async () => {
    const id = await recapWithAudio(p.captain, 100);
    const version = (await getMeetingRecapFormValues(p.captain, id, t.db))!.version;
    const category = "meetingcat-build";
    for (const who of [...MEMBERS, ...INACTIVE]) {
      const c = ctxFor(p[who]);
      const calls: [string, Promise<unknown>][] = [
        ["create", createMeetingRecap(c, input())],
        ["update", updateMeetingRecap(c, input({ recapId: id, version, title: "Mine now" }))],
        ["delete", deleteMeetingRecap(c, { recapId: id })],
        ["part", addMeetingAudioPart(c, { recapId: id, position: 0, file: file(webm(100)) })],
        ["state", getMeetingAudioUploadState(c, { recapId: id })],
        ["delete audio", deleteMeetingAudio(c, { recapId: id })],
        ["new category", createMeetingCategory(c, { name: "Secret meetings" })],
        ["rename category", renameMeetingCategory(c, { categoryId: category, name: "Builders" })],
        ["delete category", deleteMeetingCategory(c, { categoryId: category })],
      ];
      for (const [name, call] of calls) expect(await errorOf(call), `${who} ${name}`).toBeInstanceOf(ForbiddenError);
    }
    const e = (await errorOf(createMeetingRecap(ctxFor(p.swMember), input()))) as ForbiddenError;
    expect(e.userMessage).toBe(MEETING_RECAP_FORBIDDEN);
    const row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id }, include: { audio: true } });
    expect(row).toMatchObject({ title: input().title, audioDeletedAt: null });
    expect(row.audio).toHaveLength(0);
    expect(await t.db.meetingCategory.findUnique({ where: { id: category } })).toMatchObject({ name: "Build" });
    expect(await t.db.meetingCategory.count({ where: { name: "Secret meetings" } })).toBe(0);
  });

  it("everyone ACTIVE reads (members without the admin bits); pending and disabled accounts read nothing", async () => {
    const id = await recapWithAudio(p.mentor, 100);
    await uploadAll(p.mentor, id, webm(100));
    const [part] = await t.db.meetingAudioPart.findMany({ where: { recapId: id } });
    for (const who of MEMBERS) {
      const a = p[who];
      expect((await listMeetingRecaps(a, {}, TEST_NOW, t.db))?.canManage, who).toBe(false);
      expect((await getMeetingRecap(a, id, TEST_NOW, t.db))?.canManage, who).toBe(false);
      expect(await getMeetingRecapFormValues(a, id, t.db), who).toBeNull();
      expect(await getMeetingRecorderSetup(a, TEST_NOW, t.db), who).toBeNull();
      expect((await listMeetingCategories(a, t.db)).length, who).toBeGreaterThan(0);
      expect(await getMeetingAudioPartFile(a, part.id, t.db, TEST_NOW), who).not.toBeNull(); // members listen too
    }
    for (const who of INACTIVE) {
      const a = p[who];
      expect(await listMeetingRecaps(a, {}, TEST_NOW, t.db), who).toBeNull();
      expect(await getMeetingRecap(a, id, TEST_NOW, t.db), who).toBeNull();
      expect(await getRecentMeetingRecaps(a, TEST_NOW, t.db), who).toEqual([]);
      expect(await listMeetingCategories(a, t.db), who).toEqual([]);
      expect(await getMeetingAudioPartFile(a, part.id, t.db, TEST_NOW), who).toBeNull();
      expect(await getMeetingRecapFormValues(a, id, t.db), who).toBeNull();
    }
    expect((await getMeetingRecap(p.buildLead, id, TEST_NOW, t.db))?.canManage).toBe(true);
    expect(await getMeetingRecap(p.swMember, "nope", TEST_NOW, t.db)).toBeNull();
  });
});

// ── Saving and editing ──────────────────────────────────────────────────────────────────────────────────────────

describe("saving a recap", () => {
  it("saves the fields as typed (line breaks as \\n, NUL characters dropped), who saved it, and no recording", async () => {
    const { id, audioRefused } = await createMeetingRecap(
      ctxFor(p.captain),
      input({ title: "  Build\u0000 review  ", keyPoints: "- Point one\r\n- Point two\r\n", transcript: "", durationSec: "" }),
    );
    expect(audioRefused).toBeNull();
    const row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id }, include: { categories: true } });
    expect(row).toMatchObject({
      title: "Build review",
      keyPoints: "- Point one\n- Point two",
      transcript: "",
      durationSec: null,
      createdById: p.captain.id,
      editedAt: null,
      audioType: null,
      audioParts: 0,
      audioBytes: 0,
      audioExpiresAt: null,
      audioDeletedAt: null,
    });
    expect(row.meetingDate).toEqual(dateOnlyToDb(TEST_TODAY));
    expect(row.createdAt).toEqual(TEST_NOW);
    expect(row.categories.map((c) => c.categoryId).sort()).toEqual(["meetingcat-strategy", "meetingcat-whole-team"]);
    expect((await getMeetingRecap(p.swMember, id, TEST_NOW, t.db))?.audio).toEqual({ state: "none" });
  });

  it("with a recording declared: ready for its parts, kept until exactly 72 hours after saving", async () => {
    const id = await recapWithAudio(p.captain, 2 * PART + 10, TEST_NOW, { audioType: "audio/webm;codecs=opus" });
    const row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ audioType: "audio/webm", audioParts: 3, audioBytes: 2 * PART + 10 });
    expect(row.audioExpiresAt).toEqual(new Date(TEST_NOW.getTime() + 72 * HOUR));
    expect((await getMeetingRecap(p.swMember, id, TEST_NOW, t.db))?.audio).toEqual({
      state: "uploading",
      received: 0,
      total: 3,
      expiresAt: row.audioExpiresAt!.toISOString(),
    });
  });

  it("checks every field", async () => {
    const c = ctxFor(p.captain);
    const saved = await t.db.meetingRecap.count();
    const fieldError = async (over: Record<string, unknown>) => {
      const e = await errorOf(createMeetingRecap(c, input(over)));
      expect(e, JSON.stringify(over).slice(0, 80)).toBeInstanceOf(ValidationError);
      return (e as ValidationError).fieldErrors;
    };
    expect((await fieldError({ title: "  " })).title).toBe("Title is required.");
    expect((await fieldError({ title: "x".repeat(LIMITS.meetingTitleMax + 1) })).title).toMatch(/at most 160/);
    expect((await fieldError({ keyPoints: "x".repeat(LIMITS.meetingKeyPointsMax + 1) })).keyPoints).toMatch(/at most 20,000/);
    expect((await fieldError({ transcript: "x".repeat(LIMITS.meetingTranscriptMax + 1) })).transcript).toMatch(/at most 300,000/);
    expect((await fieldError({ meetingDate: "2026-13-01" })).meetingDate).toBe("Pick a valid date.");
    expect((await fieldError({ meetingDate: addDays(TEST_TODAY, 2) })).meetingDate).toMatch(/after tomorrow/);
    expect((await fieldError({ meetingDate: "2021-09-23" })).meetingDate).toMatch(/more than 5 years ago/);
    expect((await fieldError({ categoryIds: ["a", "b", "c", "d", "e", "f"] })).categoryIds).toMatch(/up to 5/);
    expect((await fieldError({ categoryIds: ["meetingcat-build", "gone"] })).categoryIds).toBe(MEETING_CATEGORY_GONE);
    expect((await fieldError({ durationSec: "abc" })).durationSec).toBeTruthy();
    expect((await fieldError({ durationSec: "-1" })).durationSec).toBeTruthy();
    expect((await fieldError({ durationSec: "21601" })).durationSec).toMatch(/6 hours/);
    expect((await fieldError({ audioType: "text/html", audioBytes: 10, audioParts: 1 })).audioType).toBe(MEETING_AUDIO_TYPE_REFUSED);
    expect((await fieldError({ audioType: "audio/webm", audioBytes: 0, audioParts: 0 })).audioBytes).toBe(MEETING_AUDIO_PARTS_INVALID);
    expect((await fieldError({ audioType: "audio/webm", audioBytes: MEETING_AUDIO_MAX_BYTES + 1, audioParts: MEETING_AUDIO_PARTS_MAX + 1 })).audioBytes).toBe(
      MEETING_AUDIO_TOO_BIG,
    );
    expect((await fieldError({ audioType: "audio/webm", audioBytes: PART + 1, audioParts: 1 })).audioParts).toBe(MEETING_AUDIO_PARTS_INVALID);

    expect(await t.db.meetingRecap.count()).toBe(saved); // none of those saved anything

    // The edges are fine: tomorrow, five years ago today, five categories (repeats counted once), 6 hours.
    for (const over of [
      { meetingDate: addDays(TEST_TODAY, 1) },
      { meetingDate: "2021-09-24" },
      { categoryIds: ["meetingcat-build", "meetingcat-build", "meetingcat-software", "meetingcat-business", "meetingcat-outreach", "meetingcat-competition"] },
      { durationSec: 21600, categoryIds: [] },
    ]) {
      await expect(createMeetingRecap(c, input(over))).resolves.toMatchObject({ audioRefused: null });
    }
  });

  it("is rate-limited (only saves that pass the checks count)", async () => {
    const c = ctxFor(p.teacher);
    await expect(createMeetingRecap(c, input({ title: "" }))).rejects.toBeInstanceOf(ValidationError);
    for (let i = 0; i < MEETING_RECAP_RATE_LIMIT.limit; i++) await createMeetingRecap(c, input({ title: `Meeting ${i}` }));
    await expect(createMeetingRecap(c, input())).rejects.toBeInstanceOf(RateLimitError);
  });

  it("a recording that won't fit in the storage: the recap is saved without it, and audioRefused says why", async () => {
    const before = await fileStorageUsage(t.db, false);
    const filler = await t.db.resource.create({
      data: {
        title: "Filler",
        file: { create: { filename: "big.bin", contentType: "application/octet-stream", size: before.max - before.used - 10, data: new Uint8Array([1]) } },
      },
      select: { id: true },
    });
    try {
      const usage = await fileStorageUsage(t.db, false);
      const { id, audioRefused } = await createMeetingRecap(ctxFor(p.captain), input({ audioType: "audio/webm", audioBytes: 1000, audioParts: 1 }));
      expect(audioRefused).toBe(meetingAudioRefusedMessage(usage));
      expect(audioRefused!.startsWith(storageFullSentence(usage))).toBe(true);
      expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id } })).toMatchObject({ audioParts: 0, audioType: null, audioExpiresAt: null });
    } finally {
      await t.db.resource.delete({ where: { id: filler.id } });
    }
  });

  it("names meeting recordings in the storage-full sentence when there are some", () => {
    const usage = { resources: 0, sponsors: 0, posters: 0, notebook: 0, strategy: 0, logos: 0, workshop: 0, photos: 0, website: 0, meetings: 3 * 1024 * 1024, used: 3 * 1024 * 1024, max: 1 };
    expect(storageFullSentence(usage)).toBe("The team's file storage is full: 0 bytes of Resources files, 0 bytes of sponsor files, and 3.0 MB of meeting recordings.");
  });
});

describe("saving again with the same request id (the recorder after a lost answer, or after a reload)", () => {
  const REQUEST = "6F1C1E0A-3B7D-4E7A-9C2B-0D5E8F1A2B3C"; // upper case is fine: saved lower-cased
  let n = 0;
  /** A fresh request id (UUID-shaped). */
  const requestId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

  it("reads only a UUID as a request id", () => {
    expect(parseMeetingRequestId(REQUEST)).toBe(REQUEST.toLowerCase());
    for (const bad of ["", "abc", "cmg1x2y3z0000abcd1234efgh", `${REQUEST}0`, 42, null, undefined]) expect(parseMeetingRequestId(bad), String(bad)).toBeNull();
  });

  it("makes request ids the server takes: randomUUID where there is one, else a version 4 UUID from getRandomValues", () => {
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newMeetingRequestId()).toMatch(V4);
    // A page that isn't a secure context (plain http to a LAN address) has no randomUUID.
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    try {
      expect(globalThis.crypto.randomUUID).toBeUndefined();
      const ids = Array.from({ length: 50 }, () => newMeetingRequestId());
      for (const id of ids) {
        expect(id).toMatch(V4);
        expect(parseMeetingRequestId(id)).toBe(id);
      }
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(typeof globalThis.crypto.randomUUID).toBe("function");
  });

  it("returns the first recap instead of saving a second — with the retry's text while nobody changed it since — and counts once toward the rate limit", async () => {
    const c = ctxFor(p.captain);
    const first = await createMeetingRecap(c, input({ requestId: REQUEST, title: "Build sync" }));
    expect(first).toEqual({ id: REQUEST.toLowerCase(), audioRefused: null, duplicate: false, textKept: false });
    const version = await updatedAtOf(first.id);

    // The same save again, as it was (its answer was lost): nothing is written.
    expect(await createMeetingRecap(c, input({ requestId: REQUEST, title: "Build sync" }))).toEqual({
      id: first.id,
      audioRefused: null,
      duplicate: true,
      textKept: false,
    });
    expect(await updatedAtOf(first.id)).toBe(version);

    // Changed in between (the form stays editable after a lost answer): the retry is that save, so its text is the
    // recap's — not marked edited, and the version moves (an open edit form hears of it).
    const renamed = {
      requestId: REQUEST,
      title: "Build sync (renamed in between)",
      meetingDate: addDays(TEST_TODAY, -1),
      categoryIds: ["meetingcat-build"],
      keyPoints: "- Two new points\r\n- And this one",
      transcript: "",
      durationSec: "1900",
    };
    const later = new Date(TEST_NOW.getTime() + 60_000);
    expect(await createMeetingRecap(ctxFor(p.captain, later), input(renamed))).toEqual({ id: first.id, audioRefused: null, duplicate: true, textKept: false });
    const row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id: first.id }, include: { categories: true } });
    expect(row).toMatchObject({
      title: "Build sync (renamed in between)",
      keyPoints: "- Two new points\n- And this one",
      transcript: "",
      durationSec: 1900,
      createdById: p.captain.id,
      createdAt: TEST_NOW,
      editedAt: null,
      editedById: null,
    });
    expect(row.meetingDate).toEqual(dateOnlyToDb(addDays(TEST_TODAY, -1)));
    expect(row.categories.map((cat) => cat.categoryId)).toEqual(["meetingcat-build"]);
    expect(row.updatedAt).toEqual(later);
    expect(await t.db.meetingRecap.count({ where: { id: first.id } })).toBe(1);
    expect((await t.db.rateLimit.findUniqueOrThrow({ where: { key: `meeting-recap:${p.captain.id}` } })).count).toBe(1);

    // From then on it's been changed since its first save: another try with other text keeps what it has (textKept).
    expect(await createMeetingRecap(c, input({ ...renamed, title: "Build sync, third try" }))).toEqual({ id: first.id, audioRefused: null, duplicate: true, textKept: true });
    expect((await t.db.meetingRecap.findUniqueOrThrow({ where: { id: first.id } })).title).toBe("Build sync (renamed in between)");

    // Even with the rate limit used up, the retry still finds it.
    await t.db.rateLimit.update({ where: { key: `meeting-recap:${p.captain.id}` }, data: { count: MEETING_RECAP_RATE_LIMIT.limit } });
    await expect(createMeetingRecap(c, input({ ...renamed, requestId: REQUEST.toLowerCase() }))).resolves.toEqual({
      id: first.id,
      audioRefused: null,
      duplicate: true,
      textKept: false,
    });
    await expect(createMeetingRecap(c, input({ requestId: requestId() }))).rejects.toBeInstanceOf(RateLimitError);
    await t.db.meetingRecap.delete({ where: { id: first.id } });
  });

  it("a retry that would change the recap is checked like the save it is: a field error, and nothing changes until it's fixed", async () => {
    const id = requestId();
    const c = ctxFor(p.swLead);
    await createMeetingRecap(c, input({ requestId: id, title: "Software sync" }));
    const before = await t.db.meetingRecap.findUniqueOrThrow({ where: { id } });
    const fieldError = async (over: Record<string, unknown>) => {
      const e = await errorOf(createMeetingRecap(c, input({ requestId: id, ...over })));
      expect(e, JSON.stringify(over)).toBeInstanceOf(ValidationError);
      return (e as ValidationError).fieldErrors;
    };
    expect((await fieldError({ title: "  " })).title).toBe("Title is required.");
    expect((await fieldError({ meetingDate: addDays(TEST_TODAY, 2) })).meetingDate).toMatch(/after tomorrow/);
    // A category deleted since (it was picked in the form before it went).
    expect((await fieldError({ categoryIds: ["meetingcat-whole-team", "gone"] })).categoryIds).toBe(MEETING_CATEGORY_GONE);
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id } })).toEqual(before);
    // Fixed: saved.
    expect(await createMeetingRecap(c, input({ requestId: id, title: "Software sync", categoryIds: ["meetingcat-whole-team"] }))).toMatchObject({
      id,
      duplicate: true,
      textKept: false,
    });
    expect(await t.db.meetingRecapCategory.findMany({ where: { recapId: id }, select: { categoryId: true } })).toEqual([{ categoryId: "meetingcat-whole-team" }]);
    await t.db.meetingRecap.delete({ where: { id } });
  });

  it("once the recap was edited since, a retry keeps its text: textKept says when the retry's differed", async () => {
    const id = requestId();
    const c = ctxFor(p.captain);
    await createMeetingRecap(c, input({ requestId: id, title: "Build sync" }));
    const version = (await getMeetingRecapFormValues(p.captain, id, t.db))!.version;
    await updateMeetingRecap(ctxFor(p.mentor), input({ recapId: id, version, title: "Build sync (with the mentor's notes)" }));
    const edited = await t.db.meetingRecap.findUniqueOrThrow({ where: { id }, include: { categories: true } });
    expect(edited.editedById).toBe(p.mentor.id);

    // The retry as first sent, or with changes of its own: not added, and said so.
    expect(await createMeetingRecap(c, input({ requestId: id, title: "Build sync" }))).toEqual({ id, audioRefused: null, duplicate: true, textKept: true });
    expect(await createMeetingRecap(c, input({ requestId: id, keyPoints: "- Something new" }))).toMatchObject({ duplicate: true, textKept: true });
    // Fields that couldn't be saved now aren't a refusal (the recap is saved): they weren't added either.
    expect(await createMeetingRecap(c, input({ requestId: id, title: "", categoryIds: ["gone"] }))).toMatchObject({ duplicate: true, textKept: true });
    // The same text as the recap has now: nothing to tell.
    expect(await createMeetingRecap(c, input({ requestId: id, title: "Build sync (with the mentor's notes)" }))).toEqual({
      id,
      audioRefused: null,
      duplicate: true,
      textKept: false,
    });
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id }, include: { categories: true } })).toEqual(edited);
    await t.db.meetingRecap.delete({ where: { id } });
  });

  it("a change that lands between a retry's look and its write wins: an edit is kept (textKept); a deleted recap is saved again", async () => {
    /** `t.db`, except that `meanwhile` runs (once) right before its next transaction starts. */
    const dbWith = (meanwhile: () => Promise<unknown>): Db => {
      let ran = false;
      return new Proxy(t.db, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if (key === "$transaction" && !ran) {
            return async (...args: unknown[]) => {
              ran = true;
              await meanwhile();
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    const c = ctxFor(p.buildLead);

    const edited = requestId();
    await createMeetingRecap(c, input({ requestId: edited, title: "Build sync" }));
    const version = (await getMeetingRecapFormValues(p.buildLead, edited, t.db))!.version;
    const editIt = () => updateMeetingRecap(ctxFor(p.mentor), input({ recapId: edited, version, title: "Build sync (edited)" }));
    expect(await createMeetingRecap({ ...c, db: dbWith(editIt) }, input({ requestId: edited, title: "Build sync, take 2" }))).toEqual({
      id: edited,
      audioRefused: null,
      duplicate: true,
      textKept: true,
    });
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id: edited } })).toMatchObject({ title: "Build sync (edited)", editedById: p.mentor.id });

    const deleted = requestId();
    await createMeetingRecap(c, input({ requestId: deleted, title: "Build sync" }));
    const deleteIt = () => t.db.meetingRecap.delete({ where: { id: deleted } });
    expect(await createMeetingRecap({ ...c, db: dbWith(deleteIt) }, input({ requestId: deleted, title: "Build sync, take 2" }))).toEqual({
      id: deleted,
      audioRefused: null,
      duplicate: false,
      textKept: false,
    });
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id: deleted } })).toMatchObject({ title: "Build sync, take 2", createdById: p.buildLead.id });
    await t.db.meetingRecap.deleteMany({ where: { id: { in: [edited, deleted] } } });
  });

  it("anything that isn't a UUID is ignored (a normal save each time)", async () => {
    const c = ctxFor(p.mentor);
    const a = await createMeetingRecap(c, input({ requestId: "not-a-uuid" }));
    const b = await createMeetingRecap(c, input({ requestId: "not-a-uuid" }));
    expect(a.id).not.toBe(b.id);
    expect([a.duplicate, b.duplicate]).toEqual([false, false]);
  });

  it("another admin may finish someone's save (a shared browser's copy): the same recap and its recording, its text kept", async () => {
    const id = requestId();
    const declared = { audioType: "audio/webm", audioBytes: PART + 5, audioParts: 2 };
    await createMeetingRecap(ctxFor(p.captain), input({ requestId: id, title: "Captain's recap", ...declared }));
    const before = await t.db.meetingRecap.findUniqueOrThrow({ where: { id } });

    // As it was saved: nothing to tell, and the recording goes on uploading from the copy.
    expect(await createMeetingRecap(ctxFor(p.mentor), input({ requestId: id, title: "Captain's recap", ...declared }))).toEqual({
      id,
      audioRefused: null,
      duplicate: true,
      textKept: false,
    });
    expect((await uploadAll(p.mentor, id, webm(PART + 5))).at(-1)).toEqual({ complete: true, duplicate: false });
    // With other text: never put on someone else's save.
    expect(await createMeetingRecap(ctxFor(p.mentor), input({ requestId: id, title: "Mentor's version", ...declared }))).toEqual({
      id,
      audioRefused: null,
      duplicate: true,
      textKept: true,
    });
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await t.db.meetingRecap.count({ where: { id } })).toBe(1);
    // Still only people who manage recaps.
    for (const who of [...MEMBERS, ...INACTIVE]) {
      expect(await errorOf(createMeetingRecap(ctxFor(p[who]), input({ requestId: id }))), who).toBeInstanceOf(ForbiddenError);
    }
    await t.db.meetingRecap.delete({ where: { id } });
  });

  it("two of the same save at once make one recap (both answer with it)", async () => {
    const id = requestId();
    const c = ctxFor(p.teacher);
    const results = await Promise.all([createMeetingRecap(c, input({ requestId: id })), createMeetingRecap(c, input({ requestId: id }))]);
    expect(results.map((r) => r.id)).toEqual([id, id]);
    expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
    expect(results.map((r) => r.textKept)).toEqual([false, false]);
    expect(await t.db.meetingRecap.count({ where: { id } })).toBe(1);
  });

  it("the recording: still expected when declared both times; refused again when the first save had none; dropped when the retry keeps none", async () => {
    const c = ctxFor(p.captain);
    const withAudio = (over: Record<string, unknown> = {}) => input({ audioType: "audio/webm", audioBytes: PART + 5, audioParts: 2, ...over });

    // Declared both times: the first recap waits for its parts, which then upload to it.
    const both = requestId();
    await createMeetingRecap(c, withAudio({ requestId: both }));
    expect(await createMeetingRecap(c, withAudio({ requestId: both }))).toEqual({ id: both, audioRefused: null, duplicate: true, textKept: false });
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id: both } })).toMatchObject({ audioParts: 2, audioBytes: PART + 5 });

    // First saved without one (not kept), then with one: saved without it, as the first time.
    const without = requestId();
    await createMeetingRecap(c, input({ requestId: without }));
    expect(await createMeetingRecap(c, withAudio({ requestId: without }))).toEqual({
      id: without,
      audioRefused: MEETING_AUDIO_SAVED_WITHOUT,
      duplicate: true,
      textKept: false,
    });

    // First refused for space, retried while it still won't fit: the same reason again.
    const full = requestId();
    const free = await leaveRoom(10);
    try {
      expect((await createMeetingRecap(c, withAudio({ requestId: full }))).audioRefused).toMatch(/^The team's file storage is full/);
      const usage = await fileStorageUsage(t.db, false);
      expect(await createMeetingRecap(c, withAudio({ requestId: full }))).toEqual({
        id: full,
        audioRefused: meetingAudioRefusedMessage(usage),
        duplicate: true,
        textKept: false,
      });
    } finally {
      await free();
    }

    // Declared, nothing uploaded, then saved again without it (unticked in between): no "still uploading" left behind,
    // and the version doesn't move.
    const dropped = requestId();
    await createMeetingRecap(c, withAudio({ requestId: dropped }));
    const version = await updatedAtOf(dropped);
    expect(await createMeetingRecap(c, input({ requestId: dropped }))).toEqual({ id: dropped, audioRefused: null, duplicate: true, textKept: false });
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id: dropped } })).toMatchObject({
      audioType: null,
      audioParts: 0,
      audioBytes: 0,
      audioExpiresAt: null,
    });
    expect(await updatedAtOf(dropped)).toBe(version);
    expect((await getMeetingRecap(p.swMember, dropped, TEST_NOW, t.db))?.audio).toEqual({ state: "none" });

    // Once a part is in, a retry without it changes nothing.
    await addMeetingAudioPart(c, { recapId: both, position: 0, file: file(webm(PART)) });
    await createMeetingRecap(c, input({ requestId: both }));
    expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id: both } })).toMatchObject({ audioParts: 2 });
    await t.db.meetingRecap.deleteMany({ where: { id: { in: [both, without, full, dropped] } } });
  });
});

describe("editing a recap", () => {
  it("checks the version first, then saves; only text, date, and category changes mark it edited", async () => {
    const { id } = await createMeetingRecap(ctxFor(p.captain), input());
    const loaded = (await getMeetingRecapFormValues(p.captain, id, t.db))!;
    expect(loaded).toMatchObject({ id, title: input().title, meetingDate: TEST_TODAY, durationSec: 1830 });
    expect(loaded.categoryIds.sort()).toEqual(["meetingcat-strategy", "meetingcat-whole-team"]);
    const later = new Date(TEST_NOW.getTime() + HOUR);
    const save = (over: Record<string, unknown>, now = later) => updateMeetingRecap(ctxFor(p.mentor, now), input({ recapId: id, ...over }));

    // Nothing changed: nothing written.
    expect(await save({ version: loaded.version })).toEqual({ id, changed: false });
    expect(await updatedAtOf(id)).toBe(TEST_NOW.getTime());

    // Only the length: saved, not "edited".
    expect(await save({ version: loaded.version, durationSec: "1900" })).toEqual({ id, changed: true });
    let row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ durationSec: 1900, editedAt: null, editedById: null });

    // The old version is stale now — refused before the fields are even looked at.
    const stale = (await errorOf(save({ version: loaded.version, title: "" }))) as ConflictError;
    expect(stale).toBeInstanceOf(ConflictError);
    expect(stale.userMessage).toBe(MEETING_RECAP_CHANGED);
    await expect(save({ version: "not a date" })).rejects.toBeInstanceOf(ConflictError);

    // Categories replaced, title changed: edited, by whom.
    const version = row.updatedAt.toISOString();
    expect(await save({ version, durationSec: "1900", title: "Kickoff (edited)", categoryIds: ["meetingcat-build"] }, new Date(later.getTime() + HOUR))).toEqual({
      id,
      changed: true,
    });
    row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ title: "Kickoff (edited)", editedById: p.mentor.id });
    expect(row.editedAt).toEqual(new Date(later.getTime() + HOUR));
    expect((await t.db.meetingRecapCategory.findMany({ where: { recapId: id } })).map((c) => c.categoryId)).toEqual(["meetingcat-build"]);
    const detail = (await getMeetingRecap(p.swMember, id, TEST_NOW, t.db))!;
    expect(detail.editedBy).toMatchObject({ id: p.mentor.id, name: "Mia Mentor", role: "MENTOR" });
    expect(detail.createdBy).toMatchObject({ id: p.captain.id, role: "CAPTAIN", subteam: null, isAdmin: false });

    // A category deleted since the form loaded, or a recap deleted meanwhile.
    const next = row.updatedAt.toISOString();
    expect(((await errorOf(save({ version: next, categoryIds: ["meetingcat-build", "gone"] }))) as ValidationError).fieldErrors.categoryIds).toBe(MEETING_CATEGORY_GONE);
    await t.db.meetingRecap.delete({ where: { id } });
    await expect(save({ version: next, title: "Too late" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a date may stay as it is even when it's out of range now; changing it checks the range", async () => {
    const { id } = await createMeetingRecap(ctxFor(p.captain), input({ meetingDate: "2021-09-24" }));
    const later = new Date(TEST_NOW.getTime() + 3 * 24 * HOUR);
    const version = (await getMeetingRecapFormValues(p.captain, id, t.db))!.version;
    await expect(updateMeetingRecap(ctxFor(p.captain, later), input({ recapId: id, version, meetingDate: "2021-09-24", title: "Old one" }))).resolves.toEqual({
      id,
      changed: true,
    });
    const v2 = (await getMeetingRecapFormValues(p.captain, id, t.db))!.version;
    await expect(updateMeetingRecap(ctxFor(p.captain, later), input({ recapId: id, version: v2, meetingDate: "2021-09-23" }))).rejects.toBeInstanceOf(ValidationError);
  });

  it("deleting checks the version when one is sent, and takes the recording's parts with it", async () => {
    const id = await recapWithAudio(p.captain, 100);
    await uploadAll(p.captain, id, webm(100));
    const e = (await errorOf(deleteMeetingRecap(ctxFor(p.captain), { recapId: id, version: new Date(0).toISOString() }))) as ConflictError;
    expect(e.userMessage).toBe(MEETING_RECAP_CHANGED_BEFORE_DELETE);
    const version = (await getMeetingRecapFormValues(p.captain, id, t.db))!.version;
    expect(await deleteMeetingRecap(ctxFor(p.captain), { recapId: id, version })).toEqual({ id });
    expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(0);
    await expect(deleteMeetingRecap(ctxFor(p.captain), { recapId: id })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Categories ──────────────────────────────────────────────────────────────────────────────────────────────────

describe("the meeting categories", () => {
  it("start with the usual ones (from the migration), alphabetically, with how many recaps have each", async () => {
    const rows = await listMeetingCategories(p.swMember, t.db);
    const defaults = rows.filter((r) => r.id.startsWith("meetingcat-")).map((r) => [r.id, r.name]);
    expect(defaults).toEqual([
      ["meetingcat-build", "Build"],
      ["meetingcat-business", "Business"],
      ["meetingcat-competition", "Competition"],
      ["meetingcat-leadership", "Leadership"],
      ["meetingcat-outreach", "Outreach"],
      ["meetingcat-software", "Software"],
      ["meetingcat-strategy", "Strategy"],
      ["meetingcat-whole-team", "Whole team"],
    ]);
    const strategy = rows.find((r) => r.id === "meetingcat-strategy")!;
    expect(strategy.recapCount).toBe(await t.db.meetingRecapCategory.count({ where: { categoryId: "meetingcat-strategy" } }));
  });

  it("names are tidied and unique ignoring case; renaming may change only the capitals", async () => {
    const c = ctxFor(p.captain);
    const made = await createMeetingCategory(c, { name: "  Drive   team " });
    expect(made.name).toBe("Drive team");
    const dup = (await errorOf(createMeetingCategory(c, { name: "drive TEAM" }))) as ValidationError;
    expect(dup.fieldErrors.name).toBe(meetingCategoryDuplicateMessage("Drive team"));
    expect(((await errorOf(createMeetingCategory(c, { name: "  " }))) as ValidationError).fieldErrors.name).toBe("Name is required.");
    expect(await renameMeetingCategory(c, { categoryId: made.id, name: "Drive Team" })).toEqual({ id: made.id, name: "Drive Team", changed: true });
    expect(await renameMeetingCategory(c, { categoryId: made.id, name: "Drive Team" })).toMatchObject({ changed: false });
    const clash = (await errorOf(renameMeetingCategory(c, { categoryId: made.id, name: "build" }))) as ValidationError;
    expect(clash.fieldErrors.name).toBe(meetingCategoryDuplicateMessage("Build"));
    await expect(renameMeetingCategory(c, { categoryId: "gone", name: "X" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deleting one takes it off its recaps (they stay) and says how many", async () => {
    const c = ctxFor(p.captain);
    const made = await createMeetingCategory(c, { name: "Scouting" });
    const { id: recapId } = await createMeetingRecap(c, input({ categoryIds: [made.id, "meetingcat-build"] }));
    expect(await deleteMeetingCategory(c, { categoryId: made.id })).toEqual({ id: made.id, name: "Scouting", recaps: 1 });
    expect((await getMeetingRecap(p.swMember, recapId, TEST_NOW, t.db))?.categories).toEqual([{ id: "meetingcat-build", name: "Build" }]);
    await expect(deleteMeetingCategory(c, { categoryId: made.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("at most 30, and rate-limited", async () => {
    const c = ctxFor(p.mentor);
    const added: string[] = [];
    while ((await t.db.meetingCategory.count()) < MEETING_CATEGORIES_MAX) {
      added.push((await createMeetingCategory(c, { name: `Extra ${added.length}` })).id);
    }
    const full = (await errorOf(createMeetingCategory(c, { name: "One too many" }))) as ValidationError;
    expect(full.fieldErrors.name).toBe(MEETING_CATEGORIES_FULL);
    await t.db.meetingCategory.deleteMany({ where: { id: { in: added } } });

    await t.db.rateLimit.deleteMany();
    await t.db.rateLimit.create({ data: { key: `meeting-category:${p.mentor.id}`, count: MEETING_CATEGORY_RATE_LIMIT.limit, windowStart: TEST_NOW } });
    await expect(createMeetingCategory(c, { name: "Over the limit" })).rejects.toBeInstanceOf(RateLimitError);
  });
});

// ── The recording, in parts ─────────────────────────────────────────────────────────────────────────────────────

describe("uploading a recording in parts", () => {
  it("takes the parts in any order, says when it's complete, and never touches the recap's row", async () => {
    const bytes = webm(2 * PART + 1234);
    const id = await recapWithAudio(p.captain, bytes.byteLength);
    const updatedAt = await updatedAtOf(id);
    const [a, b, c] = partsOf(bytes);
    const add = (position: number, part: Uint8Array) => addMeetingAudioPart(ctxFor(p.captain), { recapId: id, position, file: file(part) });
    expect(await add(2, c)).toEqual({ complete: false, duplicate: false });
    expect((await getMeetingRecap(p.swMember, id, TEST_NOW, t.db))?.audio).toMatchObject({ state: "uploading", received: 1, total: 3 });
    expect(await add(0, a)).toEqual({ complete: false, duplicate: false });
    expect(await getMeetingAudioUploadState(ctxFor(p.captain), { recapId: id })).toEqual({
      audioType: "audio/webm",
      audioParts: 3,
      audioBytes: bytes.byteLength,
      present: [0, 2],
      expired: false,
      complete: false,
    });
    expect(await add(1, b)).toEqual({ complete: true, duplicate: false });
    // A retry after a lost answer: fine, nothing new.
    expect(await add(1, b)).toEqual({ complete: true, duplicate: true });
    expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(3);
    expect(await updatedAtOf(id)).toBe(updatedAt);

    const parts = await t.db.meetingAudioPart.findMany({ where: { recapId: id }, orderBy: { position: "asc" } });
    expect(parts.map((x) => [x.position, x.filename, x.contentType, x.size])).toEqual([
      [0, "recording-1.webm", "audio/webm", PART],
      [1, "recording-2.webm", "audio/webm", PART],
      [2, "recording-3.webm", "audio/webm", 1234],
    ]);
    const detail = (await getMeetingRecap(p.swMember, id, TEST_NOW, t.db))!;
    expect(detail.audio).toEqual({
      state: "ready",
      partIds: parts.map((x) => x.id),
      audioType: "audio/webm",
      audioBytes: bytes.byteLength,
      expiresAt: new Date(TEST_NOW.getTime() + MEETING_AUDIO_KEEP_MS).toISOString(),
    });
    const served = (await getMeetingAudioPartFile(p.swMember, parts[2].id, t.db, TEST_NOW))!;
    expect(Buffer.from(served.data!).equals(Buffer.from(c))).toBe(true);
  });

  it("each part must be exactly its size, inside the recording, and the first one really the declared kind", async () => {
    const bytes = webm(PART + 100);
    const id = await recapWithAudio(p.captain, bytes.byteLength);
    const [first, last] = partsOf(bytes);
    const c = ctxFor(p.captain);
    const add = (position: unknown, part: Uint8Array) => errorOf(addMeetingAudioPart(c, { recapId: id, position, file: file(part) }));
    expect(((await add(0, first.subarray(0, PART - 1))) as ValidationError).fieldErrors.file).toBe(MEETING_AUDIO_PART_WRONG_SIZE);
    expect(((await add(1, webm(101))) as ValidationError).fieldErrors.file).toBe(MEETING_AUDIO_PART_WRONG_SIZE);
    expect(((await add(2, last)) as ValidationError).fieldErrors.position).toBe(MEETING_AUDIO_POSITION_INVALID);
    expect(((await add(-1, last)) as ValidationError).fieldErrors.position).toBe(MEETING_AUDIO_POSITION_INVALID);
    expect(((await add("1.5", last)) as ValidationError).fieldErrors.position).toBe(MEETING_AUDIO_POSITION_INVALID);
    const ogg = new Uint8Array(PART);
    ogg.set(new TextEncoder().encode("OggS"));
    expect(((await add(0, ogg)) as ValidationError).fieldErrors.file).toBe(MEETING_AUDIO_PART_WRONG_TYPE);
    expect(((await errorOf(addMeetingAudioPart(c, { recapId: id, position: 0 }))) as ValidationError).fieldErrors.file).toBeTruthy();
    // Later parts are just the rest of the bytes (not sniffed). A Blob works as well as an uploaded file.
    expect(await addMeetingAudioPart(c, { recapId: id, position: "1", file: new Blob([last as Uint8Array<ArrayBuffer>]) })).toEqual({ complete: false, duplicate: false });
    expect(await addMeetingAudioPart(c, { recapId: id, position: 0, file: file(first) })).toEqual({ complete: true, duplicate: false });
    await expect(addMeetingAudioPart(c, { recapId: "gone", position: 0, file: file(first) })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refused for a recap without a recording, and once the recording is past its 3 days or deleted", async () => {
    const { id: none } = await createMeetingRecap(ctxFor(p.captain), input());
    expect(((await errorOf(addMeetingAudioPart(ctxFor(p.captain), { recapId: none, position: 0, file: file(webm(10)) }))) as ConflictError).userMessage).toBe(
      MEETING_AUDIO_NONE,
    );
    const id = await recapWithAudio(p.captain, PART + 10);
    const atExpiry = new Date(TEST_NOW.getTime() + MEETING_AUDIO_KEEP_MS);
    const late = (await errorOf(addMeetingAudioPart(ctxFor(p.captain, atExpiry), { recapId: id, position: 1, file: file(webm(10)) }))) as ConflictError;
    expect(late.userMessage).toBe(MEETING_AUDIO_TOO_LATE);
    await addMeetingAudioPart(ctxFor(p.captain, new Date(atExpiry.getTime() - 1)), { recapId: id, position: 1, file: file(webm(10)) });
    expect(await getMeetingAudioUploadState(ctxFor(p.captain, atExpiry), { recapId: id })).toMatchObject({ present: [1], expired: true, complete: false });
    await deleteMeetingAudio(ctxFor(p.captain), { recapId: id });
    const gone = (await errorOf(addMeetingAudioPart(ctxFor(p.captain), { recapId: id, position: 0, file: file(webm(PART)) }))) as ConflictError;
    expect(gone.userMessage).toBe(MEETING_AUDIO_ALREADY_DELETED);
  });

  it("is rate-limited per person", async () => {
    const id = await recapWithAudio(p.captain, 10);
    await t.db.rateLimit.create({ data: { key: `meeting-audio:${p.captain.id}`, count: MEETING_AUDIO_PARTS_PER_HOUR, windowStart: TEST_NOW } });
    await expect(addMeetingAudioPart(ctxFor(p.captain), { recapId: id, position: 0, file: file(webm(10)) })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("two uploads of the same part at once (a retry overlapping the first try): one row, both succeed, one says duplicate", async () => {
    const bytes = webm(PART + 50);
    const id = await recapWithAudio(p.captain, bytes.byteLength);
    const [first] = partsOf(bytes);
    // Both get past the first look for the part before either saves it, so the second finds its twin under the lock.
    const c = { ...ctxFor(p.captain), db: dbWaitingAt(t.db, meetingPoint(2)) };
    const results = await Promise.allSettled([0, 1].map(() => addMeetingAudioPart(c, { recapId: id, position: 0, file: file(first) })));
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    const values = results.map((r) => (r as PromiseFulfilledResult<{ complete: boolean; duplicate: boolean }>).value);
    expect(values.map((v) => v.duplicate).sort()).toEqual([false, true]);
    expect(values.every((v) => !v.complete)).toBe(true);
    expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(1);
  });

  describe("in Cloudflare R2 (a fake one)", () => {
    let s3: FakeS3;
    beforeAll(async () => {
      s3 = await startFakeS3();
    });
    afterAll(async () => {
      await s3?.close();
    });

    it("two uploads of the same part at once: both objects go up, one row keeps its own, and the other object is deleted", async () => {
      const bytes = webm(64);
      const id = await recapWithAudio(p.captain, bytes.byteLength);
      // Both uploads reach R2 before either saves its row.
      const real = s3.store();
      const put = meetingPoint(2);
      const putKeys: string[] = [];
      const store: ObjectStore = {
        putObject: async (key, data) => {
          putKeys.push(key);
          await put();
          return real.putObject(key, data);
        },
        getObject: (key) => real.getObject(key),
        getObjectBytes: (key) => real.getObjectBytes(key),
        deleteObject: (key) => real.deleteObject(key),
        withTimeout: (ms) => real.withTimeout(ms),
      };
      const c = { ...ctxFor(p.captain), objectStore: store };
      const results = await Promise.all([0, 1].map(() => addMeetingAudioPart(c, { recapId: id, position: 0, file: file(bytes) })));
      expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
      expect(results.every((r) => r.complete)).toBe(true);

      const rows = await t.db.meetingAudioPart.findMany({ where: { recapId: id } });
      expect(rows).toHaveLength(1);
      const kept = rows[0].storageKey!;
      expect(putKeys.sort()).toEqual(expect.arrayContaining([kept]));
      expect(putKeys).toHaveLength(2);
      const loser = putKeys.find((k) => k !== kept)!;
      expect(s3.objects.has(kept) && s3.objects.has(loser)).toBe(true);
      // The unused one is due for deletion now; the cleanup deletes it and leaves the one in use.
      expect((await t.db.fileDeletion.findMany({ where: { storageKey: { in: putKeys } } })).map((r) => r.storageKey)).toEqual([loser]);
      await drainFileDeletions(t.db, { store: real });
      expect(s3.objects.has(loser)).toBe(false);
      expect(s3.objects.has(kept)).toBe(true);
      expect(await t.db.fileDeletion.count({ where: { storageKey: { in: putKeys } } })).toBe(0);

      await t.db.meetingRecap.delete({ where: { id } });
      await drainFileDeletions(t.db, { store: real });
      expect(s3.objects.has(kept)).toBe(false);
    });
  });
});

// ── 3 days ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the recording's 3 days", () => {
  it("the state, for every read", () => {
    const expiresAt = new Date(TEST_NOW.getTime() + 10 * HOUR);
    const base = { audioType: "audio/webm", audioParts: 2, audioBytes: PART + 5, audioExpiresAt: expiresAt, audioDeletedAt: null };
    const parts = [
      { id: "a", size: PART },
      { id: "b", size: 5 },
    ];
    expect(meetingAudioState({ ...base, audioParts: 0, audioType: null, audioExpiresAt: null }, [], TEST_NOW)).toEqual({ state: "none" });
    expect(meetingAudioState(base, parts.slice(0, 1), TEST_NOW)).toEqual({ state: "uploading", received: 1, total: 2, expiresAt: expiresAt.toISOString() });
    expect(meetingAudioState(base, [parts[0], { id: "b", size: 4 }], TEST_NOW)).toMatchObject({ state: "uploading", received: 2 });
    expect(meetingAudioState(base, parts, TEST_NOW)).toEqual({
      state: "ready",
      partIds: ["a", "b"],
      audioType: "audio/webm",
      audioBytes: PART + 5,
      expiresAt: expiresAt.toISOString(),
    });
    expect(meetingAudioState(base, parts, new Date(expiresAt.getTime() - 1)).state).toBe("ready");
    expect(meetingAudioState(base, parts, expiresAt)).toEqual({ state: "deleted", early: false, at: expiresAt.toISOString() });
    expect(meetingAudioState({ ...base, audioDeletedAt: TEST_NOW }, [], TEST_NOW)).toEqual({ state: "deleted", early: true, at: TEST_NOW.toISOString() });
    // An unfinished upload whose time is up is just as gone.
    expect(meetingAudioState(base, parts.slice(0, 1), expiresAt)).toMatchObject({ state: "deleted", early: false });
  });

  it("ends at exactly 72 hours: the recap's page and the part's route stop offering it", async () => {
    const id = await recapWithAudio(p.captain, 100);
    await uploadAll(p.captain, id, webm(100));
    const [part] = await t.db.meetingAudioPart.findMany({ where: { recapId: id } });
    const expiry = new Date(TEST_NOW.getTime() + 72 * HOUR);
    const before = new Date(expiry.getTime() - 1);
    expect((await getMeetingRecap(p.swMember, id, before, t.db))?.audio.state).toBe("ready");
    expect(await getMeetingAudioPartFile(p.swMember, part.id, t.db, before)).not.toBeNull();
    expect((await getMeetingRecap(p.swMember, id, expiry, t.db))?.audio).toEqual({ state: "deleted", early: false, at: expiry.toISOString() });
    expect(await getMeetingAudioPartFile(p.swMember, part.id, t.db, expiry)).toBeNull();
    // "Delete recording now" afterwards: already gone.
    const e = (await errorOf(deleteMeetingAudio(ctxFor(p.captain, expiry), { recapId: id }))) as ConflictError;
    expect(e.userMessage).toBe(MEETING_AUDIO_ALREADY_DELETED);
  });

  it("“Delete recording now” deletes the parts, keeps the text and the version, and says so after", async () => {
    const id = await recapWithAudio(p.captain, PART + 10);
    await uploadAll(p.captain, id, webm(PART + 10));
    const version = await updatedAtOf(id);
    const when = new Date(TEST_NOW.getTime() + HOUR);
    expect(await deleteMeetingAudio(ctxFor(p.bizLead, when), { recapId: id })).toEqual({ id, parts: 2 });
    const row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id } });
    expect(row.audioDeletedAt).toEqual(when);
    expect(row.updatedAt.getTime()).toBe(version);
    expect(row.keyPoints).toBe(input().keyPoints);
    expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(0);
    expect((await getMeetingRecap(p.swMember, id, when, t.db))?.audio).toEqual({ state: "deleted", early: true, at: when.toISOString() });
    expect(((await errorOf(deleteMeetingAudio(ctxFor(p.captain, when), { recapId: id }))) as ConflictError).userMessage).toBe(MEETING_AUDIO_ALREADY_DELETED);
    const { id: none } = await createMeetingRecap(ctxFor(p.captain), input());
    expect(((await errorOf(deleteMeetingAudio(ctxFor(p.captain), { recapId: none }))) as ConflictError).userMessage).toBe(MEETING_AUDIO_NONE);
    await expect(deleteMeetingAudio(ctxFor(p.captain), { recapId: "gone" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the purge deletes what's past its 3 days (finished or not), keeps the version, leaves the rest, and finds nothing the second time", async () => {
    // Older leftovers from other tests go first, so the counts below are this test's own.
    await purgeExpiredMeetingAudio(t.db, new Date(TEST_NOW.getTime() + 365 * 24 * HOUR));
    const savedAt = new Date(TEST_NOW.getTime() + 1000 * HOUR); // clear of every other test's recordings
    const done = await recapWithAudio(p.captain, PART + 1, savedAt);
    await uploadAll(p.captain, done, webm(PART + 1), savedAt);
    const unfinished = await recapWithAudio(p.captain, PART + 1, savedAt);
    await addMeetingAudioPart(ctxFor(p.captain, savedAt), { recapId: unfinished, position: 0, file: file(webm(PART)) });
    const fresh = await recapWithAudio(p.captain, 10, new Date(savedAt.getTime() + 2 * HOUR));
    await uploadAll(p.captain, fresh, webm(10), new Date(savedAt.getTime() + 2 * HOUR));
    const versions = await Promise.all([done, unfinished].map(updatedAtOf));

    const now = new Date(savedAt.getTime() + 72 * HOUR + 30 * 60 * 1000);
    expect(await hasExpiredMeetingAudio(t.db, now)).toBe(true);
    const first = await purgeExpiredMeetingAudio(t.db, now, { limit: 1 });
    const second = await purgeExpiredMeetingAudio(t.db, now);
    expect([first.recaps, second.recaps, first.parts + second.parts]).toEqual([1, 1, 3]);
    expect(await purgeExpiredMeetingAudio(t.db, now)).toEqual({ recaps: 0, parts: 0 });
    expect(await hasExpiredMeetingAudio(t.db, now)).toBe(false);
    for (const [i, id] of [done, unfinished].entries()) {
      const row = await t.db.meetingRecap.findUniqueOrThrow({ where: { id }, include: { audio: true } });
      expect(row.audio).toHaveLength(0);
      expect(row.audioDeletedAt).toEqual(now);
      expect(row.updatedAt.getTime()).toBe(versions[i]);
      expect((await getMeetingRecap(p.swMember, id, now, t.db))?.audio).toMatchObject({ state: "deleted", early: false });
    }
    expect(await t.db.meetingAudioPart.count({ where: { recapId: fresh } })).toBe(1);
    await t.db.meetingRecap.deleteMany({ where: { id: { in: [done, unfinished, fresh] } } });
  });

  it("recordings past their 3 days never crowd out a new one: they're purged before it's checked against the storage cap", async () => {
    // Far from every other test's recordings, so these are the only ones that expire here.
    const at = new Date(TEST_NOW.getTime() + 2000 * HOUR);
    const ctxAt = (when: Date) => ctxFor(p.captain, when);
    const dayOf = (when: Date) => todayInTimezone(TEST_TZ, when);

    // Saving: Monday's recording expired an hour ago, nobody opened a meeting page since, and it's what fills the storage.
    const old = await recapWithAudio(p.captain, 2 * PART, at, { meetingDate: dayOf(at) });
    await uploadAll(p.captain, old, webm(2 * PART), at);
    const later = new Date(at.getTime() + 73 * HOUR);
    let free = await leaveRoom(PART);
    try {
      const saved = await createMeetingRecap(ctxAt(later), input({ meetingDate: dayOf(later), audioType: "audio/webm", audioBytes: 2 * PART, audioParts: 2 }));
      expect(saved.audioRefused).toBeNull();
      const purged = await t.db.meetingRecap.findUniqueOrThrow({ where: { id: old }, include: { audio: true } });
      expect(purged.audioDeletedAt).toEqual(later);
      expect(purged.audio).toHaveLength(0);
      expect((await uploadAll(p.captain, saved.id, webm(2 * PART), later)).at(-1)).toEqual({ complete: true, duplicate: false });
    } finally {
      await free();
    }

    // A part: another recording expires between saving this one and uploading it.
    const at2 = new Date(at.getTime() + 200 * HOUR);
    const expiring = await recapWithAudio(p.captain, PART, at2, { meetingDate: dayOf(at2) });
    await uploadAll(p.captain, expiring, webm(PART), at2);
    const saving = new Date(at2.getTime() + 71 * HOUR);
    const next = await recapWithAudio(p.captain, PART, saving, { meetingDate: dayOf(saving) });
    free = await leaveRoom(PART - 1);
    try {
      const uploading = new Date(at2.getTime() + 73 * HOUR);
      expect(await addMeetingAudioPart(ctxAt(uploading), { recapId: next, position: 0, file: file(webm(PART)) })).toEqual({ complete: true, duplicate: false });
      expect((await t.db.meetingRecap.findUniqueOrThrow({ where: { id: expiring } })).audioDeletedAt).toEqual(uploading);
    } finally {
      await free();
    }

    // Still full after the purge: refused, and the reason no longer counts the recording that was purged.
    const at3 = new Date(at.getTime() + 400 * HOUR);
    const gone = await recapWithAudio(p.captain, PART, at3, { meetingDate: dayOf(at3) });
    await uploadAll(p.captain, gone, webm(PART), at3);
    const after = new Date(at3.getTime() + 73 * HOUR);
    free = await leaveRoom(10);
    try {
      const refused = await createMeetingRecap(ctxAt(after), input({ meetingDate: dayOf(after), audioType: "audio/webm", audioBytes: 2 * PART, audioParts: 2 }));
      const usage = await fileStorageUsage(t.db, false);
      expect(usage.meetings).toBe(0);
      expect(refused.audioRefused).toBe(meetingAudioRefusedMessage(usage));
      expect(refused.audioRefused).not.toMatch(/meeting recordings/);
      expect((await t.db.meetingRecap.findUniqueOrThrow({ where: { id: gone } })).audioDeletedAt).toEqual(after);
    } finally {
      await free();
    }
  });

  it("a purge before the storage check that fails (a timeout, a dropped connection) is only logged: the recap is saved, and the part uploaded", async () => {
    // Far from every other test's recordings.
    const at = new Date(TEST_NOW.getTime() + 3000 * HOUR);
    const dayOf = (when: Date) => todayInTimezone(TEST_TZ, when);
    const expired = await recapWithAudio(p.captain, PART, at, { meetingDate: dayOf(at) });
    await uploadAll(p.captain, expired, webm(PART), at);
    const later = new Date(at.getTime() + 73 * HOUR);
    expect(await hasExpiredMeetingAudio(t.db, later)).toBe(true);

    /** The database, except that its next transaction (the purge's: nothing before it in these calls opens one) fails. */
    const purgeFails = (): Db => {
      let failed = false;
      return new Proxy(t.db, {
        get(target, key) {
          if (key === "$transaction" && !failed) {
            return () => {
              failed = true;
              return Promise.reject(new Error("Transaction API error: Transaction already closed (timeout)"));
            };
          }
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const saved = await createMeetingRecap(
        { ...ctxFor(p.captain, later), db: purgeFails() },
        input({ meetingDate: dayOf(later), audioType: "audio/webm", audioBytes: PART, audioParts: 1 }),
      );
      expect(saved.audioRefused).toBeNull();
      expect(await t.db.meetingRecap.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({ audioParts: 1, audioType: "audio/webm" });
      expect(await addMeetingAudioPart({ ...ctxFor(p.captain, later), db: purgeFails() }, { recapId: saved.id, position: 0, file: file(webm(PART)) })).toEqual({
        complete: true,
        duplicate: false,
      });
      expect(spy).toHaveBeenCalledTimes(2);
      // Nothing was purged: the old recording still counted (and goes with the next purge).
      expect((await t.db.meetingRecap.findUniqueOrThrow({ where: { id: expired } })).audioDeletedAt).toBeNull();
      await t.db.meetingRecap.deleteMany({ where: { id: { in: [expired, saved.id] } } });
    } finally {
      spy.mockRestore();
    }
  });

  it("the pages and actions purge after the response (scheduleMeetingAudioPurge), never throwing", async () => {
    const id = await recapWithAudio(p.captain, 10, new Date());
    await uploadAll(p.captain, id, webm(10), new Date());
    await t.db.meetingRecap.update({ where: { id }, data: { audioExpiresAt: new Date(Date.now() - 1000) } });
    scheduleMeetingAudioPurge();
    expect(holder.after).toHaveLength(1);
    expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(1); // nothing before the response
    await holder.after[0]();
    expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(0);
    expect((await t.db.meetingRecap.findUniqueOrThrow({ where: { id } })).audioDeletedAt).not.toBeNull();
    // Nothing due: one quick look, nothing else. A broken database is only logged.
    scheduleMeetingAudioPurge();
    await expect(Promise.resolve(holder.after[1]())).resolves.toBeUndefined();
    const real = holder.db;
    holder.db = { $queryRaw: () => Promise.reject(new Error("database went away")) } as unknown as Record<string | symbol, unknown>;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      scheduleMeetingAudioPurge();
      await expect(Promise.resolve(holder.after[2]())).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      holder.db = real;
      spy.mockRestore();
    }
  });
});

// ── The daily cron and the proxy ────────────────────────────────────────────────────────────────────────────────

describe("the daily job (GET /api/cron/meeting-audio)", () => {
  const call = (authorization?: string) =>
    cronRoute.GET(new Request("http://localhost/api/cron/meeting-audio", { headers: authorization ? { authorization } : {} }));

  /** A recording that's past its 3 days by the real clock (older leftovers purged first, so the counts are its own). */
  async function expiredRecording(): Promise<string> {
    await purgeExpiredMeetingAudio(t.db, new Date());
    const id = await recapWithAudio(p.captain, 10, new Date());
    await uploadAll(p.captain, id, webm(10), new Date());
    await t.db.meetingRecap.update({ where: { id }, data: { audioExpiresAt: new Date(Date.now() - 1000) } });
    return id;
  }

  it("with CRON_SECRET set: only `Authorization: Bearer <secret>` runs it", async () => {
    const id = await expiredRecording();
    process.env.CRON_SECRET = "a-long-random-cron-secret";
    try {
      for (const header of [undefined, "Bearer wrong", "a-long-random-cron-secret", "bearer a-long-random-cron-secret"]) {
        const res = await call(header);
        expect(res.status, String(header)).toBe(401);
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(1);
      const ok = await call("Bearer a-long-random-cron-secret");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toMatchObject({ ok: true, recordings: 1, parts: 1 });
      expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(0);
    } finally {
      delete process.env.CRON_SECRET;
    }
  });

  it("without CRON_SECRET: it still runs (it can only delete expired recordings), a few times an hour at most", async () => {
    delete process.env.CRON_SECRET;
    const id = await expiredRecording();
    const first = await call();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, recordings: 1 });
    expect(await t.db.meetingAudioPart.count({ where: { recapId: id } })).toBe(0);
    for (let i = 1; i < 12; i++) expect((await call()).status).toBe(200);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });

  it("gets through the proxy without a session (exactly that path); the rest of the API still needs one; the speech-to-text files skip the proxy", () => {
    const visit = (path: string) => proxy(new NextRequest(`https://communication-portal-iota.vercel.app${path}`));
    expect(visit("/api/cron/meeting-audio").headers.get("x-middleware-next")).toBe("1");
    for (const path of ["/api/cron/meeting-audio/", "/api/cron/meeting-audio/x", "/api/cron/Meeting-audio", "/api/cron/meeting%2Daudio", "/api/cron/other"]) {
      expect(visit(path).status, path).toBe(401);
    }
    expect(visit("/meetings").status).toBe(307);
    expect(visit("/meetings/audio/abc").headers.get("location")).toMatch(/\/login\?next=%2Fmeetings%2Faudio%2Fabc$/);

    const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
    for (const path of ["/asr/v1/asr-worker.js", "/asr/v1/transformers.min.js", "/brand/logo.svg"]) expect(matcher.test(path), path).toBe(false);
    for (const path of ["/meetings", "/meetings/record", "/api/cron/meeting-audio", "/asrx"]) expect(matcher.test(path), path).toBe(true);
  });
});

// ── The part route ──────────────────────────────────────────────────────────────────────────────────────────────

describe("a part of a recording (GET /meetings/audio/[id])", () => {
  const get = (id: string) => audioRoute.GET(new NextRequest(`http://localhost/meetings/audio/${id}`), { params: Promise.resolve({ id }) } as never);

  it("any ACTIVE person gets the bytes as a no-store download; pending accounts don't; signed out → sign in; a 404 once it's gone", async () => {
    const bytes = webm(PART + 7);
    const id = await recapWithAudio(p.captain, bytes.byteLength, new Date());
    await uploadAll(p.captain, id, bytes, new Date());
    const parts = await t.db.meetingAudioPart.findMany({ where: { recapId: id }, orderBy: { position: "asc" } });
    holder.user = p.bizMember;
    const res = await get(parts[1].id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="recording-2\.webm"/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("content-length")).toBe("7");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.subarray(PART));
    expect(meetingAudioHeaders({ filename: "recording-1.webm", contentType: "audio/webm", byteLength: 3 })["Content-Security-Policy"]).toMatch(/sandbox/);

    holder.user = p.pendingLead;
    expect((await get(parts[0].id)).status).toBe(403);
    holder.user = null;
    expect((await get(parts[0].id)).status).toBe(307);
    holder.user = p.swMember;
    expect((await get("not-a-part")).status).toBe(404);
    await deleteMeetingAudio(ctxFor(p.captain, new Date()), { recapId: id });
    expect((await get(parts[0].id)).status).toBe(404);
  });
});

// ── The list and Today ──────────────────────────────────────────────────────────────────────────────────────────

describe("the list and Today", () => {
  let l: TestDb;
  let lp: Record<Who, Actor>;
  beforeAll(async () => {
    l = await createTestDb();
    lp = await makePeople(l.db);
  });
  afterAll(async () => {
    await l?.drop();
  });

  /** A recap straight in the DB (bypassing the service). */
  async function make(opts: { title: string; date: string; createdAt: Date; categories?: string[]; keyPoints?: string; transcript?: string }) {
    return l.db.meetingRecap.create({
      data: {
        title: opts.title,
        meetingDate: dateOnlyToDb(opts.date),
        keyPoints: opts.keyPoints ?? "",
        transcript: opts.transcript ?? "",
        createdById: lp.captain.id,
        createdAt: opts.createdAt,
        updatedAt: opts.createdAt,
        categories: { create: (opts.categories ?? []).map((categoryId) => ({ categoryId })) },
      },
      select: { id: true },
    });
  }

  it("newest meeting first (then the newest saved), filtered by category and by words anywhere, 20 a page", async () => {
    const ago = (h: number) => new Date(TEST_NOW.getTime() - h * HOUR);
    const empty = (await listMeetingRecaps(lp.swMember, {}, TEST_NOW, l.db))!;
    expect(empty).toMatchObject({ items: [], total: 0, anyAtAll: false, category: null, canManage: false });
    expect(empty.categories.map((c) => c.name)).toContain("Whole team");

    const a = await make({
      title: "Build review",
      date: "2026-09-20",
      createdAt: ago(100),
      categories: ["meetingcat-build"],
      keyPoints: "- [1:05] Decision: the 4-bar intake.\n* Second point\n3. Third\nFourth",
    });
    const b = await make({ title: "Strategy session", date: "2026-09-22", createdAt: ago(50), categories: ["meetingcat-strategy"], transcript: "[2:00] We talked about the 100% autonomous run." });
    const c = await make({ title: "Kickoff", date: "2026-09-22", createdAt: ago(40), categories: ["meetingcat-build", "meetingcat-whole-team"] });

    const all = (await listMeetingRecaps(lp.captain, {}, TEST_NOW, l.db))!;
    expect(all.items.map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(all.canManage).toBe(true);
    const card = all.items[2];
    expect(card).toMatchObject({
      title: "Build review",
      meetingDate: "2026-09-20",
      categories: [{ id: "meetingcat-build", name: "Build" }],
      keyPointsPreview: ["Decision: the 4-bar intake.", "Second point", "Third"],
      keyPointCount: 4,
      createdBy: { id: lp.captain.id, name: "Casey Captain" },
      createdAt: ago(100).toISOString(),
      audio: { state: "none" },
    });
    expect(all.items[0].categories.map((x) => x.name)).toEqual(["Build", "Whole team"]);

    const build = (await listMeetingRecaps(lp.swMember, { category: "meetingcat-build" }, TEST_NOW, l.db))!;
    expect(build.items.map((r) => r.id)).toEqual([c.id, a.id]);
    expect(build.category).toEqual({ id: "meetingcat-build", name: "Build" });
    const search = async (q: string) => (await listMeetingRecaps(lp.swMember, { q }, TEST_NOW, l.db))!.items.map((r) => r.id);
    expect(await search("KICKOFF")).toEqual([c.id]); // title, any case
    expect(await search("4-bar")).toEqual([a.id]); // key points
    expect(await search("100%")).toEqual([b.id]); // transcript; "%" is just a character
    expect(await search("%")).toEqual([b.id]);
    expect(await search("_")).toEqual([]);
    const none = (await listMeetingRecaps(lp.swMember, { q: "zebra", category: "meetingcat-build" }, TEST_NOW, l.db))!;
    expect(none).toMatchObject({ total: 0, anyAtAll: true });

    // Pages: 20 each; a page past the end shows the last one.
    for (let i = 0; i < MEETING_RECAPS_PAGE_SIZE; i++) await make({ title: `Old meeting ${i}`, date: "2026-08-01", createdAt: ago(1000 + i) });
    const page2 = (await listMeetingRecaps(lp.swMember, { page: 2 }, TEST_NOW, l.db))!;
    expect(page2).toMatchObject({ total: 23, page: 2, pageCount: 2 });
    expect(page2.items).toHaveLength(3);
    expect((await listMeetingRecaps(lp.swMember, { page: 9 }, TEST_NOW, l.db))!.page).toBe(2);
  });

  it("Today: recaps saved in the last 72 hours, newest first, up to 3", async () => {
    await l.db.meetingRecap.deleteMany();
    const ago = (h: number) => new Date(TEST_NOW.getTime() - h * HOUR);
    await make({ title: "Exactly 72 h ago", date: "2026-09-21", createdAt: ago(72) });
    const recent = [];
    for (const h of [71, 30, 5, 1]) recent.push((await make({ title: `${h} h ago`, date: TEST_TODAY, createdAt: ago(h) })).id);
    await make({ title: "From the future", date: TEST_TODAY, createdAt: new Date(TEST_NOW.getTime() + HOUR) });
    const today = await getRecentMeetingRecaps(lp.swMember, TEST_NOW, l.db);
    expect(today.map((r) => r.title)).toEqual(["1 h ago", "5 h ago", "30 h ago"]);
    expect((await getRecentMeetingRecaps(lp.swMember, TEST_NOW, l.db, 10)).map((r) => r.title)).toEqual(["1 h ago", "5 h ago", "30 h ago", "71 h ago"]);
  });

  it("the recorder's setup: categories, everyone ACTIVE's first names, and today (admins only)", async () => {
    const setup = (await getMeetingRecorderSetup(lp.teacher, TEST_NOW, l.db))!;
    expect(setup.today).toBe(TEST_TODAY);
    expect(setup.categories.map((c) => c.id)).toContain("meetingcat-leadership");
    expect(setup.roster).toEqual(["Amara", "Blake", "Casey", "Ethan", "Gwen", "Maya", "Mia", "Nia", "Olive", "Sam", "Theo"]);
    expect(await getMeetingRecorderSetup(lp.swMember, TEST_NOW, l.db)).toBeNull();
  });
});

// ── Actions ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a Server Action redirected to (it throws Next.js's redirect error), or null. */
async function redirectOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    const m = /^NEXT_REDIRECT;[^;]*;([^;]*);/.exec(digest);
    if (!m) throw e;
    return m[1];
  }
}

function form(fields: Record<string, string | string[] | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) fd.append(k, item);
    else fd.set(k, v);
  }
  return fd;
}

describe("the actions", () => {
  it("save (no redirect, nothing echoed back), upload the parts, ask which are in, edit, and delete", async () => {
    holder.user = p.captain;
    const bytes = webm(PART + 3);
    const today = new Date().toISOString().slice(0, 10);
    const failed = await createMeetingRecapAction(initialActionState, form({ title: "", meetingDate: today, transcript: "a long transcript" }));
    expect(failed).toMatchObject({ ok: false, fieldErrors: { title: "Title is required." } });
    expect(failed?.values).toBeUndefined();

    const refreshed = holder.refreshed;
    const saved = await createMeetingRecapAction(
      initialActionState,
      form({
        title: "Drive practice",
        meetingDate: today,
        categoryIds: ["meetingcat-competition", "meetingcat-build"],
        keyPoints: "[0:10] Practice the endgame.",
        transcript: "[0:10] Let's practice the endgame.",
        durationSec: "600",
        audioType: "audio/webm;codecs=opus",
        audioBytes: String(bytes.byteLength),
        audioParts: "2",
      }),
    );
    expect(saved).toMatchObject({ ok: true, message: "Recap saved.", audioRefused: null });
    const recapId = saved!.recapId!;
    expect(holder.refreshed).toBe(refreshed + 1);
    expect(holder.after.length).toBeGreaterThan(0); // the purge after the response

    const [first, second] = partsOf(bytes);
    const part = (position: number, chunk: Uint8Array) =>
      uploadMeetingAudioPartAction(initialActionState, form({ recapId, position: String(position), file: new File([chunk as Uint8Array<ArrayBuffer>], "blob", { type: "audio/webm" }) }));
    const before = holder.refreshed;
    expect(await part(1, second)).toMatchObject({ ok: true, complete: false });
    expect(holder.refreshed).toBe(before); // no refresh until it's complete
    expect(await getMeetingAudioUploadStateAction(recapId)).toMatchObject({ ok: true, state: { present: [1], complete: false } });
    expect(await part(0, first)).toMatchObject({ ok: true, complete: true });
    expect(holder.refreshed).toBe(before + 1);
    expect(await part(0, webm(5))).toMatchObject({ ok: false, fieldErrors: { file: MEETING_AUDIO_PART_WRONG_SIZE } });

    holder.user = p.swMember; // members can't ask, or upload
    expect(await getMeetingAudioUploadStateAction(recapId)).toEqual({ ok: false, gone: false, message: MEETING_RECAP_FORBIDDEN });
    expect(await part(0, first)).toMatchObject({ ok: false, message: MEETING_RECAP_FORBIDDEN });

    holder.user = p.mentor;
    const version = (await getMeetingRecapFormValues(p.mentor, recapId, t.db))!.version!;
    const fields = { recapId, version, title: "Drive practice (edited)", meetingDate: today, keyPoints: "", transcript: "", durationSec: "600" };
    expect(await redirectOf(updateMeetingRecapAction(initialActionState, form(fields)))).toBe(`/meetings/${recapId}?saved=1`);
    const stale = await updateMeetingRecapAction(initialActionState, form({ ...fields, title: "Stale" }));
    expect(stale).toMatchObject({ ok: false, message: MEETING_RECAP_CHANGED, values: { title: "Stale" } });
    const newest = (await getMeetingRecapFormValues(p.mentor, recapId, t.db))!.version!;
    expect(await redirectOf(updateMeetingRecapAction(initialActionState, form({ ...fields, version: newest, title: "Drive practice (edited)" })))).toBe(
      `/meetings/${recapId}?saved=0`,
    );

    expect(await redirectOf(deleteMeetingRecapAction(initialActionState, form({ recapId })))).toBe("/meetings?removed=1");
    expect(await t.db.meetingRecap.count({ where: { id: recapId } })).toBe(0);
    // Deleted already (someone else was first): same place.
    expect(await redirectOf(deleteMeetingRecapAction(initialActionState, form({ recapId })))).toBe("/meetings?removed=1");
  });

  it("saving again with the same request id answers with the same recap (no second one)", async () => {
    holder.user = p.bizLead;
    const today = new Date().toISOString().slice(0, 10);
    const fields = { title: "Outreach planning", meetingDate: today, requestId: "8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" };
    const first = await createMeetingRecapAction(initialActionState, form(fields));
    expect(first).toMatchObject({ ok: true, recapId: fields.requestId, duplicate: false });
    const again = await createMeetingRecapAction(initialActionState, form(fields));
    expect(again).toMatchObject({ ok: true, message: "Recap saved.", recapId: fields.requestId, duplicate: true, audioRefused: null, textKept: false });
    expect(await t.db.meetingRecap.count({ where: { id: fields.requestId } })).toBe(1);

    // Edited since, then saved again with other text: the recap keeps its own, and the answer says so (the forms open
    // it with ?saved=first).
    const version = (await getMeetingRecapFormValues(p.bizLead, fields.requestId, t.db))!.version;
    await updateMeetingRecap(ctxFor(p.mentor, new Date()), { ...fields, recapId: fields.requestId, version, title: "Outreach planning (edited)" });
    expect(await createMeetingRecapAction(initialActionState, form({ ...fields, title: "Outreach planning, take 2" }))).toMatchObject({
      ok: true,
      recapId: fields.requestId,
      duplicate: true,
      textKept: true,
    });
    expect((await t.db.meetingRecap.findUniqueOrThrow({ where: { id: fields.requestId } })).title).toBe("Outreach planning (edited)");
  });

  it("asking which parts are in says “gone” only when the recap was deleted; any other failure is a message (the recorder keeps its copy)", async () => {
    const id = await recapWithAudio(p.captain, PART + 1, new Date());
    holder.user = p.captain;
    expect(await getMeetingAudioUploadStateAction(id)).toEqual({
      ok: true,
      state: { audioType: "audio/webm", audioParts: 2, audioBytes: PART + 1, present: [], expired: false, complete: false },
    });

    // Signed out (or the session ended), and no access anymore: not gone.
    holder.user = null;
    expect(await getMeetingAudioUploadStateAction(id)).toEqual({ ok: false, gone: false, message: "Please sign in to continue." });
    holder.user = p.buildMember;
    expect(await getMeetingAudioUploadStateAction(id)).toEqual({ ok: false, gone: false, message: MEETING_RECAP_FORBIDDEN });

    // The database failing: not gone either.
    holder.user = p.captain;
    const real = holder.db;
    holder.db = new Proxy(t.db, {
      get: (target, key) => {
        if (key === "meetingRecap") return { findUnique: () => Promise.reject(new Error("Connection terminated unexpectedly")) };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as unknown as Record<string | symbol, unknown>;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await getMeetingAudioUploadStateAction(id)).toEqual({ ok: false, gone: false, message: "Something went wrong. Please try again." });
    } finally {
      holder.db = real;
      spy.mockRestore();
    }
    expect(await getMeetingAudioUploadStateAction("")).toMatchObject({ ok: false, gone: false });

    // Deleted: gone.
    await deleteMeetingRecap(ctxFor(p.captain, new Date()), { recapId: id });
    expect(await getMeetingAudioUploadStateAction(id)).toEqual({ ok: false, gone: true });
  });

  it("a new category says its id and name (the recap form selects it)", async () => {
    holder.user = p.swLead;
    const state = await createMeetingCategoryAction(initialActionState, form({ name: "  Parent   night " }));
    expect(state).toMatchObject({ ok: true, name: "Parent night", message: "Added “Parent night”." });
    expect(await t.db.meetingCategory.findUnique({ where: { id: state!.categoryId! } })).toMatchObject({ name: "Parent night", nameKey: "parent night" });
    const dup = await createMeetingCategoryAction(initialActionState, form({ name: "parent NIGHT" }));
    expect(dup).toMatchObject({ ok: false, fieldErrors: { name: meetingCategoryDuplicateMessage("Parent night") } });
    expect(dup).not.toHaveProperty("categoryId");
  });
});

// ── The demo seed ───────────────────────────────────────────────────────────────────────────────────────────────

describe("the demo seed", () => {
  let s: TestDb;
  beforeAll(async () => {
    s = await createTestDb();
  });
  afterAll(async () => {
    await s?.drop();
  });

  it("adds three recaps: a recent write-up, one whose recording is gone, and one with a short recording that plays (and a reset replaces them)", async () => {
    await seed(s.db, { now: TEST_NOW, timezone: TEST_TZ });
    const viewer = await s.db.user.findUniqueOrThrow({ where: { email: "maya.patel@example.com" }, select: actorSelect });
    const kickoff = (await getMeetingRecap(viewer, "demo-recap-kickoff", TEST_NOW, s.db))!;
    expect(kickoff.audio).toEqual({ state: "none" });
    expect(kickoff.categories).toHaveLength(2);
    expect(kickoff.keyPoints).toMatch(/^\[\d+:\d{2}\] /m);
    expect(kickoff.transcript).toMatch(/^\[\d+:\d{2}\] /m);
    expect(kickoff.createdBy?.name).toBe("Jordan Lee");

    expect((await getMeetingRecap(viewer, "demo-recap-scrimmage-prep", TEST_NOW, s.db))!.audio).toMatchObject({ state: "deleted", early: false });

    const drive = (await getMeetingRecap(viewer, "demo-recap-drive-practice", TEST_NOW, s.db))!;
    expect(drive.audio).toMatchObject({ state: "ready", audioType: "audio/wav", expiresAt: new Date(TEST_NOW.getTime() + MEETING_AUDIO_KEEP_MS).toISOString() });
    const partIds = drive.audio.state === "ready" ? drive.audio.partIds : [];
    expect(partIds).toHaveLength(1);
    const wav = (await getMeetingAudioPartFile(viewer, partIds[0], s.db, TEST_NOW))!;
    expect(sniffMeetingAudioType(wav.data!)).toBe("audio/wav");
    expect(wav.data!.byteLength).toBeLessThan(32 * 1024);
    expect(await getRecentMeetingRecaps(viewer, TEST_NOW, s.db)).not.toHaveLength(0);

    // Meanwhile on the categories page: "Build" deleted, "Strategy" renamed to "Build" (taking its name), "Competition"
    // renamed, and one added. A reset puts the usual ones back as the migration made them, and drops the added one.
    await s.db.meetingCategory.delete({ where: { id: "meetingcat-build" } });
    await s.db.meetingCategory.update({ where: { id: "meetingcat-strategy" }, data: { name: "Build", nameKey: "build" } });
    await s.db.meetingCategory.update({ where: { id: "meetingcat-competition" }, data: { name: "Comps", nameKey: "comps" } });
    await s.db.meetingCategory.create({ data: { name: "Parents night", nameKey: "parents night" } });

    await seed(s.db, { now: TEST_NOW, timezone: TEST_TZ, reset: true });
    expect(await s.db.meetingRecap.count()).toBe(3);
    expect(await s.db.meetingAudioPart.count()).toBe(1);
    const categories = await s.db.meetingCategory.findMany({ select: { id: true, name: true, nameKey: true }, orderBy: { id: "asc" } });
    expect(categories).toEqual([...DEFAULT_MEETING_CATEGORIES].sort((a, b) => a.id.localeCompare(b.id)));
    const reader = await s.db.user.findUniqueOrThrow({ where: { email: "maya.patel@example.com" }, select: actorSelect });
    const prep = (await getMeetingRecap(reader, "demo-recap-scrimmage-prep", TEST_NOW, s.db))!;
    expect(prep.categories.map((c) => c.name).sort()).toEqual(["Build", "Competition"]);
  });

  it("without a reset, a usual category that can't be put back (its name is taken) is left off the demo recaps instead of failing", async () => {
    const fresh = await createTestDb();
    try {
      await fresh.db.meetingCategory.delete({ where: { id: "meetingcat-build" } });
      await fresh.db.meetingCategory.update({ where: { id: "meetingcat-strategy" }, data: { name: "Build", nameKey: "build" } });
      await fresh.db.meetingCategory.delete({ where: { id: "meetingcat-outreach" } });
      await seed(fresh.db, { now: TEST_NOW, timezone: TEST_TZ });
      expect(await fresh.db.meetingRecap.count()).toBe(3);
      expect(await fresh.db.meetingCategory.findUnique({ where: { id: "meetingcat-outreach" } })).toMatchObject({ name: "Outreach" }); // put back
      expect(await fresh.db.meetingCategory.findUnique({ where: { id: "meetingcat-build" } })).toBeNull(); // "Build" is taken
      const viewer = await fresh.db.user.findUniqueOrThrow({ where: { email: "maya.patel@example.com" }, select: actorSelect });
      const prep = (await getMeetingRecap(viewer, "demo-recap-scrimmage-prep", TEST_NOW, fresh.db))!;
      expect(prep.categories.map((c) => c.id)).toEqual(["meetingcat-competition"]);
    } finally {
      await fresh.drop();
    }
  });

  it("knows the usual categories exactly as the migration adds them", () => {
    const sql = readFileSync(new URL("../prisma/migrations/20261007090000_meeting_recaps/migration.sql", import.meta.url), "utf8");
    const rows = [...sql.matchAll(/\('(meetingcat-[a-z-]+)', '([^']+)', '([^']+)', CURRENT_TIMESTAMP\)/g)].map((m) => ({ id: m[1], name: m[2], nameKey: m[3] }));
    expect(rows).toHaveLength(8);
    expect(DEFAULT_MEETING_CATEGORIES).toEqual(rows);
  });
});
