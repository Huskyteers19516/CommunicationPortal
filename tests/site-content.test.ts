// Website Coding (Admin → Website Coding): the services (src/server/services/site-content.ts — who may change the team
// website, keys, the link rule, text / link / picture saves, reset, the history and Undo, keeping a few pictures per
// spot), the admin view and the public JSON (src/server/queries/site-content.ts, GET /api/public/site-content), the
// picture route (GET /api/public/site-images/[id]: only pictures a spot shows now), and the editor's message checks
// (src/lib/public-site-content.ts). Everything runs against this file's database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown as Record<string | symbol, unknown> }));
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

import { deflateSync } from "node:zlib";
import { NextRequest } from "next/server";
import * as siteContentRoute from "@/app/api/public/site-content/route";
import * as siteImageRoute from "@/app/api/public/site-images/[id]/route";
import { isPublicApiPath, PUBLIC_SITE_CONTENT_PATH, PUBLIC_SITE_IMAGES_PREFIX } from "@/lib/public-api";
import { TEAM_SITE_ORIGIN } from "@/lib/public-progress";
import {
  isSiteKey,
  parseSiteLink,
  parseSiteMessage,
  type PublicSiteContent,
  SITE_CONTENT_MAX_ROWS,
  SITE_IMAGE_TYPES_MESSAGE,
  SITE_IMAGE_UNREADABLE_MESSAGE,
  SITE_IMAGES_KEPT_PER_SLOT,
  SITE_KEY_INVALID,
  SITE_LINK_INVALID,
  SITE_TEXT_EMPTY,
  siteSlotGroup,
} from "@/lib/public-site-content";
import { POSTER_HEIC_MESSAGE } from "@/lib/posters";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { DEFAULT_WEBSITE_EDITOR_URL, parseWebsiteEditorUrl } from "@/server/env";
import { fileStorageUsage } from "@/server/files/storage";
import {
  PUBLIC_CACHE_CONTROL,
  PUBLIC_FILE_CSP,
  PUBLIC_FILE_IMMUTABLE_CACHE,
  PUBLIC_SITE_IMAGE_NOT_FOUND,
  publicSiteContentResponse,
  publicSiteImageResponse,
} from "@/server/public-api";
import { getPublicSiteContent, getPublicSiteImage, getSiteContentAdminView, getSiteImageFile } from "@/server/queries/site-content";
import {
  resetSiteContent,
  revertSiteContentEdit,
  SITE_CONTENT_FORBIDDEN,
  SITE_CONTENT_FULL,
  SITE_EDIT_NOT_FOUND,
  SITE_IMAGE_GONE,
  SITE_IMAGE_NONE,
  setSiteImageAlt,
  setSiteLink,
  setSiteText,
  uploadSiteImage,
} from "@/server/services/site-content";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW } from "./helpers/factories";

let t: TestDb;
let owner: Actor;
let captain: Actor;
let mentor: Actor;
let leader: Actor; // Build leader: admin access
let member: Actor;
let pendingMentor: Actor;

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  owner = await makeUser(t.db, { name: "Olivia Owner", isAdmin: true });
  captain = await makeUser(t.db, { name: "Jordan Captain", role: "CAPTAIN" });
  mentor = await makeUser(t.db, { name: "Elena Mentor", role: "MENTOR" });
  leader = await makeUser(t.db, { name: "Ben Builder", role: "BUILD_LEADER" });
  member = await makeUser(t.db, { name: "Maya Member", subteam: "SOFTWARE" });
  pendingMentor = await makeUser(t.db, { name: "Pat Pending", role: "MENTOR", status: "PENDING" });
});
afterAll(async () => {
  await t.drop();
});

/** A clock that moves a minute per call, so changes have an order. */
let tick = 0;
const ctx = (actor: Actor) => ({ ...contextFor(t.db, actor), now: new Date(TEST_NOW.getTime() + ++tick * 60_000) });

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

// ── Pictures: real, tiny, decodable files ──────────────────────────────────────────────────────────────────────

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): number[] {
  const head = Uint8Array.from([...Array.from(type, (c) => c.charCodeAt(0)), ...data]);
  return [...u32(data.length), ...head, ...u32(crc32(head))];
}
/** A real `width` × `height` grey PNG (with a tEXt "Author" chunk that must be stripped), shade varies the bytes. */
function png(width = 4, height = 3, shade = 128, comment = "Author: Maya's phone"): Uint8Array {
  const ihdr = Uint8Array.from([...u32(width), ...u32(height), 8, 0, 0, 0, 0]); // 8-bit greyscale
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.fill(shade, y * (width + 1) + 1, (y + 1) * (width + 1));
  const text = new TextEncoder().encode(comment.replace(": ", "\0"));
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("tEXt", text),
    ...chunk("IDAT", deflateSync(raw)),
    ...chunk("IEND", new Uint8Array()),
  ]);
}
const file = (name: string, bytes: Uint8Array, type = "image/png") => ({ name, type, bytes });
const has = (bytes: Uint8Array, s: string) => Buffer.from(bytes).includes(Buffer.from(s));

// ── Who may change the website ──────────────────────────────────────────────────────────────────────────────────

describe("who can change the website", () => {
  it("everyone with admin access (owners, captain, mentors, leaders); never members or accounts waiting for approval", async () => {
    for (const a of [owner, captain, mentor, leader]) {
      expect((await setSiteText(ctx(a), { key: `perm.${a.role.toLowerCase().replace("_", "-")}.${a.isAdmin ? "o" : "x"}`, value: "Hi" })).changed).toBe(true);
    }
    for (const a of [member, pendingMentor]) {
      const c = ctx(a);
      for (const run of [
        () => setSiteText(c, { key: "perm.blocked", value: "Hi" }),
        () => setSiteLink(c, { key: "perm.blocked-link", value: "https://example.com" }),
        () => resetSiteContent(c, { key: "perm.blocked" }),
        () => revertSiteContentEdit(c, { editId: "nope" }),
        () => setSiteImageAlt(c, { key: "perm.pic", alt: "x" }),
        () => uploadSiteImage(c, { key: "perm.pic", alt: "", file: file("a.png", png()) }),
      ]) {
        const e = await errorOf(run());
        expect(e).toBeInstanceOf(ForbiddenError);
        expect((e as ForbiddenError).userMessage).toBe(SITE_CONTENT_FORBIDDEN);
      }
    }
    expect(await t.db.siteContent.count({ where: { key: { startsWith: "perm.blocked" } } })).toBe(0);
    // The admin view too.
    expect(await getSiteContentAdminView(member, t.db)).toBeNull();
    expect(await getSiteContentAdminView(pendingMentor, t.db)).toBeNull();
    expect(await getSiteContentAdminView(mentor, t.db)).not.toBeNull();
    expect(await getSiteImageFile(member, "anything", t.db)).toBeNull();
  });
});

// ── Keys and links ──────────────────────────────────────────────────────────────────────────────────────────────

describe("keys and the link rule", () => {
  it("keys are lower-case words joined by '.' or '-', up to 120 characters", async () => {
    for (const ok of ["home.hero.tagline", "season.2025-2026.team-photo", "footer", "a1.b-2"]) expect(isSiteKey(ok), ok).toBe(true);
    for (const bad of ["", "Home.hero", "home..hero", ".home", "home.", "home_hero", "home hero", "home/hero", "a".repeat(121), "-a", "constructor!"]) {
      expect(isSiteKey(bad), bad).toBe(false);
      const e = await errorOf(setSiteText(ctx(mentor), { key: bad, value: "x" }));
      expect(e, bad).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).fieldErrors.key, bad).toBe(SITE_KEY_INVALID);
    }
    expect(siteSlotGroup("home.hero.tagline")).toBe("home.hero");
    expect(siteSlotGroup("footer")).toBe("footer");
  });

  it("links: https/http (normalised), mailto, or one-slash site paths — never javascript:, data:, // or anything odd", async () => {
    expect(parseSiteLink("https://Example.com")).toBe("https://example.com/");
    expect(parseSiteLink("  http://ftc.example/x?y=1#z ")).toBe("http://ftc.example/x?y=1#z");
    expect(parseSiteLink("mailto:team@example.com")).toBe("mailto:team@example.com");
    expect(parseSiteLink("/events")).toBe("/events");
    expect(parseSiteLink("/about/team#mentors")).toBe("/about/team#mentors");
    for (const bad of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html,<b>x</b>",
      "//evil.example",
      "/\\evil.example",
      "/a\\b",
      "events",
      "https://user:pw@example.com",
      "https:/example.com",
      "https://exa mple.com",
      "/ev\nents",
      "mailto:/x",
      "ftp://example.com",
      "vbscript:x",
      "",
      `https://example.com/${"a".repeat(2000)}`,
    ]) {
      expect(parseSiteLink(bad), bad).toBeNull();
    }
    const e = await errorOf(setSiteLink(ctx(mentor), { key: "links.bad", value: "javascript:alert(1)" }));
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).fieldErrors.value).toBe(SITE_LINK_INVALID);
    expect(await setSiteLink(ctx(mentor), { key: "links.good", value: " https://Example.com " })).toEqual({ changed: true });
    expect((await t.db.siteContent.findUniqueOrThrow({ where: { key: "links.good" } })).value).toBe("https://example.com/");
    // The same address again (as typed differently) changes nothing.
    expect(await setSiteLink(ctx(mentor), { key: "links.good", value: "https://example.com/" })).toEqual({ changed: false });
    expect(await t.db.siteContentEdit.count({ where: { key: "links.good" } })).toBe(1);
  });
});

// ── Text: save, no-op, reset, history, Undo ─────────────────────────────────────────────────────────────────────

describe("text", () => {
  it("saves plain text (line breaks kept, control characters dropped), refuses empty or too long", async () => {
    expect(await setSiteText(ctx(captain), { key: "home.hero.tagline", value: "  Hi,\r\nwe're the\u0000 Huskyteers!  " })).toEqual({ changed: true });
    const row = await t.db.siteContent.findUniqueOrThrow({ where: { key: "home.hero.tagline" } });
    expect(row).toMatchObject({ kind: "TEXT", value: "Hi,\nwe're the Huskyteers!", updatedById: captain.id });
    expect((await errorOf(setSiteText(ctx(captain), { key: "home.hero.tagline", value: "   " })) as ValidationError).fieldErrors.value).toBe(SITE_TEXT_EMPTY);
    expect(await errorOf(setSiteText(ctx(captain), { key: "home.hero.tagline", value: "x".repeat(5001) }))).toBeInstanceOf(ValidationError);
    expect(await setSiteText(ctx(captain), { key: "home.hero.other", value: "x".repeat(5000) })).toEqual({ changed: true });
    // HTML is just text (the website applies it with textContent).
    await setSiteText(ctx(captain), { key: "home.hero.html", value: "<img src=x onerror=alert(1)>" });
    expect((await t.db.siteContent.findUniqueOrThrow({ where: { key: "home.hero.html" } })).value).toBe("<img src=x onerror=alert(1)>");
  });

  it("the same text again is a no-op; every change writes its before → after; reset and Undo are changes too", async () => {
    const key = "about.intro";
    const edits = () => t.db.siteContentEdit.findMany({ where: { key }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    await setSiteText(ctx(mentor), { key, value: "One" });
    expect(await setSiteText(ctx(mentor), { key, value: "One" })).toEqual({ changed: false });
    await setSiteText(ctx(leader), { key, value: "Two" });
    expect((await edits()).map((e) => [e.before, e.after, e.editedById])).toEqual([
      [null, "One", mentor.id],
      ["One", "Two", leader.id],
    ]);

    // Reset: back to the website's own; resetting again changes nothing.
    expect(await resetSiteContent(ctx(owner), { key })).toEqual({ changed: true });
    expect(await t.db.siteContent.findUnique({ where: { key } })).toBeNull();
    expect(await resetSiteContent(ctx(owner), { key })).toEqual({ changed: false });
    expect((await edits()).at(-1)).toMatchObject({ before: "Two", after: null, kind: "TEXT", editedById: owner.id });

    // Undo the reset: "Two" again.
    const resetEdit = (await edits()).at(-1)!;
    expect(await revertSiteContentEdit(ctx(captain), { editId: resetEdit.id })).toEqual({ changed: true, key });
    expect((await t.db.siteContent.findUniqueOrThrow({ where: { key } })).value).toBe("Two");
    // Undo the first change ("" → One): back to the website's own.
    const first = (await edits())[0];
    expect(await revertSiteContentEdit(ctx(captain), { editId: first.id })).toEqual({ changed: true, key });
    expect(await t.db.siteContent.findUnique({ where: { key } })).toBeNull();
    // Already there: nothing changes, nothing is written.
    const count = (await edits()).length;
    expect(await revertSiteContentEdit(ctx(captain), { editId: first.id })).toEqual({ changed: false, key });
    expect((await edits()).length).toBe(count);
    expect((await edits()).slice(-2).map((e) => [e.before, e.after])).toEqual([
      [null, "Two"],
      ["Two", null],
    ]);

    const e = await errorOf(revertSiteContentEdit(ctx(captain), { editId: "missing-edit" }));
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as NotFoundError).userMessage).toBe(SITE_EDIT_NOT_FOUND);
  });

  it("the admin view: saved values and the latest changes with who made them, newest first", async () => {
    const view = (await getSiteContentAdminView(owner, t.db))!;
    expect(view.entries.find((e) => e.key === "home.hero.tagline")).toMatchObject({
      kind: "text",
      value: "Hi,\nwe're the Huskyteers!",
      image: null,
      updatedByName: "Jordan Captain",
    });
    expect(view.entries.map((e) => e.key)).toEqual([...view.entries.map((e) => e.key)].sort());
    const times = view.edits.map((e) => e.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(view.edits[0]).toMatchObject({ editorName: expect.any(String), beforeAvailable: true });
    expect(view.edits.length).toBeLessThanOrEqual(100);
  });

  it("caps the number of saved spots", async () => {
    const existing = await t.db.siteContent.count();
    const fill = SITE_CONTENT_MAX_ROWS - existing;
    await t.db.siteContent.createMany({
      data: Array.from({ length: fill }, (_, i) => ({ key: `filler.k${i}`, kind: "TEXT" as const, value: "x", updatedAt: TEST_NOW })),
    });
    const e = await errorOf(setSiteText(ctx(owner), { key: "one.too.many", value: "x" }));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).userMessage).toBe(SITE_CONTENT_FULL);
    // Changing a spot that's already saved still works.
    expect(await setSiteText(ctx(owner), { key: "filler.k0", value: "y" })).toEqual({ changed: true });
    await t.db.siteContent.deleteMany({ where: { key: { startsWith: "filler." } } });
  });
});

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("pictures", () => {
  const key = "season.2025-2026.team-photo";

  it("checks the picture by its bytes and strips its metadata", async () => {
    const refuse = async (f: ReturnType<typeof file>) => {
      const e = await errorOf(uploadSiteImage(ctx(mentor), { key, alt: "", file: f }));
      expect(e).toBeInstanceOf(ValidationError);
      return (e as ValidationError).fieldErrors.file;
    };
    expect(await refuse(file("photo.png", new TextEncoder().encode("not a picture")))).toBe(SITE_IMAGE_UNREADABLE_MESSAGE);
    expect(await refuse(file("logo.svg", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), "image/svg+xml"))).toBe(SITE_IMAGE_TYPES_MESSAGE);
    const heic = Uint8Array.from([0, 0, 0, 24, ...Array.from("ftypheic", (c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    expect(await refuse(file("IMG_0001.HEIC", heic, "image/heic"))).toBe(POSTER_HEIC_MESSAGE);
    expect(await refuse(file("empty.png", new Uint8Array()))).toMatch(/empty/);
    expect(await refuse(file("huge.png", png(9000, 10)))).toMatch(/9,000 × 10 pixels/);
    expect(await t.db.siteImage.count({ where: { key } })).toBe(0);

    const picture = png(4, 3);
    expect(has(picture, "Author")).toBe(true);
    const { id, pruned } = await uploadSiteImage(ctx(mentor), { key, alt: "  The team at the league meet  ", file: file("IMG_2041 Maya.png", picture) });
    expect(pruned).toBe(0);
    const row = await t.db.siteImage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ key, filename: "picture.png", contentType: "image/png", width: 4, height: 3, alt: "The team at the league meet", uploadedById: mentor.id });
    expect(has(row.data!, "Author")).toBe(false);
    expect(row.size).toBe(row.data!.byteLength);
    expect(await t.db.siteContent.findUniqueOrThrow({ where: { key } })).toMatchObject({ kind: "IMAGE", value: id });
    expect(await t.db.siteContentEdit.findFirst({ where: { key }, orderBy: { createdAt: "desc" } })).toMatchObject({ before: null, after: id, kind: "IMAGE" });
    // Counted toward the team's storage.
    expect((await fileStorageUsage(t.db, false)).website).toBe(row.size);
  });

  it("changes the shown picture's description; not without a picture", async () => {
    expect(await setSiteImageAlt(ctx(mentor), { key, alt: "Our team, 2025" })).toEqual({ changed: true });
    expect(await setSiteImageAlt(ctx(mentor), { key, alt: "Our team, 2025" })).toEqual({ changed: false });
    const current = await t.db.siteContent.findUniqueOrThrow({ where: { key } });
    expect((await t.db.siteImage.findUniqueOrThrow({ where: { id: current.value } })).alt).toBe("Our team, 2025");
    expect(await errorOf(setSiteImageAlt(ctx(mentor), { key, alt: "x".repeat(301) }))).toBeInstanceOf(ValidationError);
    const e = await errorOf(setSiteImageAlt(ctx(mentor), { key: "no.picture.here", alt: "x" }));
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as NotFoundError).userMessage).toBe(SITE_IMAGE_NONE);
  });

  it(`keeps the ${SITE_IMAGES_KEPT_PER_SLOT} newest pictures per spot; Undo to a deleted one says so politely`, async () => {
    const firstEdit = await t.db.siteContentEdit.findFirstOrThrow({ where: { key, before: null } });
    const ids: string[] = [firstEdit.after!];
    let prunedTotal = 0;
    for (let i = 0; i < SITE_IMAGES_KEPT_PER_SLOT + 1; i++) {
      const r = await uploadSiteImage(ctx(captain), { key, alt: `Version ${i + 2}`, file: file("v.png", png(4, 3, 10 + i)) });
      ids.push(r.id);
      prunedTotal += r.pruned;
    }
    const left = await t.db.siteImage.findMany({ where: { key }, orderBy: { createdAt: "asc" }, select: { id: true } });
    expect(left.map((r) => r.id)).toEqual(ids.slice(-SITE_IMAGES_KEPT_PER_SLOT));
    expect(prunedTotal).toBe(ids.length - SITE_IMAGES_KEPT_PER_SLOT);
    expect((await t.db.siteContent.findUniqueOrThrow({ where: { key } })).value).toBe(ids.at(-1));

    // Undo the change that replaced the very first picture: it's gone.
    const replacedFirst = await t.db.siteContentEdit.findFirstOrThrow({ where: { key, before: ids[0] } });
    const view = (await getSiteContentAdminView(owner, t.db))!;
    expect(view.edits.find((e) => e.id === replacedFirst.id)?.beforeAvailable).toBe(false);
    const e = await errorOf(revertSiteContentEdit(ctx(owner), { editId: replacedFirst.id }));
    expect(e).toBeInstanceOf(ConflictError);
    expect((e as ConflictError).userMessage).toBe(SITE_IMAGE_GONE);
    // Undo the latest: the one before it, still kept, comes back.
    const latest = await t.db.siteContentEdit.findFirstOrThrow({ where: { key, after: ids.at(-1) } });
    expect(await revertSiteContentEdit(ctx(owner), { editId: latest.id })).toEqual({ changed: true, key });
    expect((await t.db.siteContent.findUniqueOrThrow({ where: { key } })).value).toBe(ids.at(-2));
    expect(view.entries.find((x) => x.key === key)?.image).toMatchObject({ id: ids.at(-1), width: 4, height: 3 });
  });
});

// ── The public JSON and the picture route ───────────────────────────────────────────────────────────────────────

describe("GET /api/public/site-content", () => {
  it("has exactly the contract's shape, and nothing about who changed what", async () => {
    await setSiteLink(ctx(owner), { key: "footer.email", value: "mailto:team@example.com" });
    const answer = await getPublicSiteContent(t.db, { now: TEST_NOW });
    expect(Object.keys(answer).sort()).toEqual(["enabled", "images", "links", "texts", "updatedAt"]);
    expect(answer.enabled).toBe(true);
    expect(answer.updatedAt).toBe(TEST_NOW.toISOString());
    expect(answer.texts["home.hero.tagline"]).toBe("Hi,\nwe're the Huskyteers!");
    expect(answer.links["footer.email"]).toBe("mailto:team@example.com");
    expect(answer.links["links.good"]).toBe("https://example.com/");
    const image = answer.images["season.2025-2026.team-photo"];
    expect(Object.keys(image).sort()).toEqual(["alt", "height", "src", "width"]);
    expect(image.src).toMatch(/^\/api\/public\/site-images\/[A-Za-z0-9_-]{1,64}$/);
    for (const [k, v] of Object.entries(answer.links)) expect(parseSiteLink(v), k).toBe(v);
    const json = JSON.stringify(answer);
    for (const secret of ["Jordan Captain", "Elena Mentor", captain.id, mentor.id, "Olivia", "picture.png"]) expect(json).not.toContain(secret);
  });

  it("CORS and caching like the other public feeds, through the real route", async () => {
    const call = (init: { method?: string; origin?: string } = {}) => {
      const headers = new Headers();
      if (init.origin) headers.set("origin", init.origin);
      return siteContentRoute[(init.method ?? "GET") as "GET"](new Request(`https://portal.example${PUBLIC_SITE_CONTENT_PATH}?t=123`, { method: init.method, headers }));
    };
    const res = await call({ origin: TEAM_SITE_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(((await res.json()) as PublicSiteContent).enabled).toBe(true);
    expect((await call({ origin: "https://evil.example" })).headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    const preflight = await siteContentRoute.OPTIONS(new Request(`https://portal.example${PUBLIC_SITE_CONTENT_PATH}`, { method: "OPTIONS", headers: { origin: TEAM_SITE_ORIGIN } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    // The website's dev server, when it's listed.
    const local = await publicSiteContentResponse(new Request("https://portal.example/api/public/site-content", { headers: { origin: "http://localhost:4321" } }), {
      db: t.db,
      now: TEST_NOW,
      teamTimezone: "America/Los_Angeles",
      extraOrigins: "http://localhost:4321",
    });
    expect(local.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    // Public paths for the proxy.
    expect(isPublicApiPath(PUBLIC_SITE_CONTENT_PATH)).toBe(true);
    expect(isPublicApiPath(`${PUBLIC_SITE_IMAGES_PREFIX}abc_123`)).toBe(true);
    expect(isPublicApiPath(`${PUBLIC_SITE_IMAGES_PREFIX}a/b`)).toBe(false);
    expect(isPublicApiPath(`${PUBLIC_SITE_IMAGES_PREFIX}a.png`)).toBe(false);
  });
});

describe("GET /api/public/site-images/[id]", () => {
  const key = "season.2025-2026.team-photo";
  const req = (id: string, method = "GET", query = "") => new NextRequest(`https://portal.example${PUBLIC_SITE_IMAGES_PREFIX}${id}${query}`, { method });

  it("serves the picture a spot shows now: inline, immutable, a neutral name, sandboxed", async () => {
    const shown = (await t.db.siteContent.findUniqueOrThrow({ where: { key } })).value;
    const res = await siteImageRoute.GET(req(shown), { params: Promise.resolve({ id: shown }) } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="website-picture\.png"/);
    expect(res.headers.get("cache-control")).toBe(PUBLIC_FILE_IMMUTABLE_CACHE);
    expect(res.headers.get("content-security-policy")).toBe(PUBLIC_FILE_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    const row = await t.db.siteImage.findUniqueOrThrow({ where: { id: shown } });
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(row.data!))).toBe(true);
    const head = await siteImageRoute.HEAD(req(shown, "HEAD"), { params: Promise.resolve({ id: shown }) } as never);
    expect(head.status).toBe(200);
    // A query string goes to the bare address before anything is read.
    const redirected = await publicSiteImageResponse(req(shown, "GET", "?cb=1"), { db: t.db, id: shown });
    expect(redirected.status).toBe(308);
    expect(redirected.headers.get("location")).toBe(`${PUBLIC_SITE_IMAGES_PREFIX}${shown}`);
  });

  it("404 for pictures no spot shows (kept for Undo, deleted, reset, made up)", async () => {
    const shown = (await t.db.siteContent.findUniqueOrThrow({ where: { key } })).value;
    const kept = (await t.db.siteImage.findMany({ where: { key, id: { not: shown } }, select: { id: true } })).map((r) => r.id);
    expect(kept.length).toBeGreaterThan(0);
    for (const id of [...kept, "made-up-id", "a.b"]) {
      const res = await publicSiteImageResponse(req(id), { db: t.db, id });
      expect(res.status, id).toBe(404);
      expect(res.headers.get("cache-control"), id).toBe("private, no-store");
      expect(await res.text(), id).toBe(PUBLIC_SITE_IMAGE_NOT_FOUND);
    }
    // Signed in, people who edit the website still see them.
    expect(await getSiteImageFile(captain, kept[0], t.db)).not.toBeNull();
    // Reset the spot: its picture goes off the website at once.
    await resetSiteContent(ctx(owner), { key });
    expect(await getPublicSiteImage(t.db, shown)).toBeNull();
    expect((await getPublicSiteContent(t.db, { now: TEST_NOW })).images[key]).toBeUndefined();
    // Another spot's saved value naming this id doesn't publish it either (only its own spot's picture counts).
    await t.db.siteContent.create({ data: { key: "other.spot", kind: "IMAGE", value: shown, updatedAt: TEST_NOW } });
    expect(await getPublicSiteImage(t.db, shown)).toBeNull();
    expect((await getPublicSiteContent(t.db, { now: TEST_NOW })).images["other.spot"]).toBeUndefined();
    // A text that happens to equal its id doesn't either.
    await t.db.siteContent.update({ where: { key: "other.spot" }, data: { kind: "TEXT" } });
    expect(await getPublicSiteImage(t.db, shown)).toBeNull();
  });
});

// ── The editor's messages and settings ──────────────────────────────────────────────────────────────────────────

describe("the editor", () => {
  it("checks the website's messages field by field", () => {
    expect(parseSiteMessage(null)).toBeNull();
    expect(parseSiteMessage({ source: "other", type: "ready" })).toBeNull();
    expect(parseSiteMessage({ source: "hk-site", type: "select", key: "Bad Key" })).toBeNull();
    expect(parseSiteMessage({ source: "hk-site", type: "select", key: "home.hero" })).toEqual({ type: "select", key: "home.hero" });
    expect(parseSiteMessage({ source: "hk-site", type: "nope" })).toBeNull();
    const ready = parseSiteMessage({
      source: "hk-site",
      type: "ready",
      path: "/about/team",
      title: "Our Team",
      slots: [
        { key: "about.team.intro", kind: "text", label: " Intro ", defaultValue: "We build robots.", multiline: true },
        { key: "about.team.intro", kind: "text", label: "Again", defaultValue: "dup" },
        { key: "about.team.photo", kind: "image", label: "", defaultValue: "/img/team.jpg" },
        { key: "BAD", kind: "text", label: "x", defaultValue: "x" },
        { key: "about.team.x", kind: "html", label: "x", defaultValue: "x" },
        { key: "about.team.link", kind: "link", label: 5, defaultValue: 7, multiline: "yes" },
        "junk",
      ],
    });
    expect(ready).toEqual({
      type: "ready",
      path: "/about/team",
      title: "Our Team",
      slots: [
        { key: "about.team.intro", kind: "text", label: "Intro", defaultValue: "We build robots.", multiline: true },
        { key: "about.team.photo", kind: "image", label: "about.team.photo", defaultValue: "/img/team.jpg", multiline: false },
        { key: "about.team.link", kind: "link", label: "about.team.link", defaultValue: "", multiline: false },
      ],
    });
    expect(parseSiteMessage({ source: "hk-site", type: "ready", path: "javascript:x", slots: "no" })).toEqual({ type: "ready", path: "/", title: "", slots: [] });
  });

  it("WEBSITE_EDITOR_URL: an http(s) base address, else the live website", () => {
    expect(parseWebsiteEditorUrl(undefined)).toBe(DEFAULT_WEBSITE_EDITOR_URL);
    expect(parseWebsiteEditorUrl("")).toBe(DEFAULT_WEBSITE_EDITOR_URL);
    expect(parseWebsiteEditorUrl("http://localhost:4321/")).toBe("http://localhost:4321");
    expect(parseWebsiteEditorUrl("https://example.github.io/site/")).toBe("https://example.github.io/site");
    for (const bad of ["javascript:alert(1)", "ftp://x.example", "https://u:p@x.example", "https://x.example/?a=1", "not a url"]) {
      expect(parseWebsiteEditorUrl(bad), bad).toBe(DEFAULT_WEBSITE_EDITOR_URL);
    }
  });
});
