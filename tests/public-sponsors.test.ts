// The team website's Sponsors page: GET /api/public/sponsors (src/app/api/public/sponsors/route.ts, built by
// src/server/queries/public-sponsors.ts and src/server/public-api.ts), the logo route
// (GET /api/public/sponsors/logos/[id]), uploading / replacing / removing logos (services/sponsorship-logos.ts), the
// edit form's "Team website" section (services/sponsorships.ts), and "Logo needed" (the list's badge and filter, and
// Today's nudge). Everything runs against this file's database.
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

import { NextRequest } from "next/server";
import * as logoRoute from "@/app/api/public/sponsors/logos/[id]/route";
import * as sponsorsRoute from "@/app/api/public/sponsors/route";
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { dateOnlyToDb } from "@/lib/dates";
import { PUBLIC_SPONSORS_PATH } from "@/lib/public-api";
import {
  DEFAULT_PUBLIC_PROGRESS_SETTINGS,
  PUBLIC_PROGRESS_KEY,
  type PublicProgressSettings,
  serializePublicProgressSettings,
  TEAM_SITE_ORIGIN,
} from "@/lib/public-progress";
import {
  pickPublicSponsorName,
  publicSponsorKey,
  publicSponsorLogoFilename,
  publicSponsorLogoPath,
  type PublicSponsors,
  publicSponsorUrl,
  SPONSOR_LOGO_TYPES_MESSAGE,
  SPONSOR_LOGO_UNREADABLE_MESSAGE,
  sponsorLogoProblem,
  sponsorPublicName,
  sponsorPublicYear,
} from "@/lib/public-sponsors";
import { POSTER_HEIC_MESSAGE } from "@/lib/posters";
import type { Actor } from "@/server/actor";
import type { ServiceContext } from "@/server/context";
import type { Db } from "@/server/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import type { ObjectStore } from "@/server/files/object-store";
import { fileStorageUsage } from "@/server/files/storage";
import {
  PUBLIC_CACHE_CONTROL,
  PUBLIC_FILE_CSP,
  PUBLIC_FILE_IMMUTABLE_CACHE,
  PUBLIC_FILE_REDIRECT_CACHE,
  PUBLIC_FILE_UNAVAILABLE,
  PUBLIC_LOGO_NOT_FOUND,
  PUBLIC_SPONSORS_UNAVAILABLE,
  publicFileHeaders,
  publicSponsorLogoResponse,
  publicSponsorsResponse,
} from "@/server/public-api";
import { publicEventsWhere } from "@/server/queries/public-events";
import { getPublicSponsors, publicSponsorsShown } from "@/server/queries/public-sponsors";
import { countSponsorsNeedingLogo, getSponsorship, listSponsorships } from "@/server/queries/sponsorships";
import { getTeamWebsitePreview } from "@/server/queries/team-website";
import { SPONSOR_FILE_BYTES_PER_PERSON } from "@/server/services/sponsorship-files";
import {
  checkSponsorLogo,
  removeSponsorshipLogo,
  SPONSOR_LOGO_NEEDS_FILE,
  SPONSOR_LOGO_NONE,
  uploadSponsorshipLogo,
} from "@/server/services/sponsorship-logos";
import { createSponsorship, SPONSORSHIP_NOT_FOUND, updateSponsorship } from "@/server/services/sponsorships";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

// TEST_NOW is Thu 2026-09-24 in Anaheim.

let t: TestDb;
let amara: Actor; // Business leader
let ava: Actor; // Business member
let daniel: Actor; // Business member
let maya: Actor; // Software member
let priya: Actor; // Software leader (staff: can use Sponsorships)
let pendingBiz: Actor;

const SECRET_NOTE = "secret note: their CFO's cell is 555-0100";
const SECRET_CONTACT = "Rita Secretcontact";
const SECRET_EMAIL = "rita@secret-sponsor.example.com";
const SECRET_ASK = "secret ask: 1234 dollars";

const ids: Record<string, string> = {};
const logos: Record<string, string> = {};

// ── Pictures (only their headers matter: logos are never decoded) ───────────────────────────────────────────

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** A PNG's signature and IHDR claiming `width` × `height` (plus a little padding). */
function png(width = 64, height = 28): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 1, 2, 3, 4]);
}
/** A baseline JPEG's start (SOI, then SOF0 with the size). */
function jpeg(width = 120, height = 40): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
}
/** A lossless WebP (VP8L) of `width` × `height`. */
function webp(width = 50, height = 20): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  return Uint8Array.from([...ascii("RIFF"), 30, 0, 0, 0, ...ascii("WEBP"), ...ascii("VP8L"), 10, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]);
}
const text = (s: string) => new TextEncoder().encode(s);
const file = (name: string, bytes: Uint8Array, type = "") => ({ name, type, bytes });

async function sponsor(
  key: string,
  data: {
    name: string;
    stage: SponsorshipStage;
    publicName?: string;
    showOnWebsite?: boolean;
    website?: string;
    acceptedOn?: string;
    submittedOn?: string;
    createdAt?: string;
    owner?: Actor;
  },
) {
  const row = await t.db.sponsorship.create({
    data: {
      name: data.name,
      stage: data.stage,
      publicName: data.publicName ?? "",
      showOnWebsite: data.showOnWebsite ?? true,
      website: data.website ?? "",
      acceptedOn: data.acceptedOn ? dateOnlyToDb(data.acceptedOn) : null,
      submittedOn: data.submittedOn ? dateOnlyToDb(data.submittedOn) : null,
      createdAt: data.createdAt ? new Date(data.createdAt) : TEST_NOW,
      ownerId: data.owner?.id ?? null,
      createdById: amara.id,
      // Everything the website must never show.
      amountReceived: 4321,
      asking: SECRET_ASK,
      contactName: SECRET_CONTACT,
      contactEmail: SECRET_EMAIL,
      notes: SECRET_NOTE,
    },
  });
  ids[key] = row.id;
  return row;
}

const at = (actor: Actor, now: string): ServiceContext => ({ ...contextFor(t.db, actor), now: new Date(now) });

/** Saves the settings: the defaults with sponsors and events turned on (they're off until an admin turns them on), then `settings`. */
async function setSettings(settings: Partial<PublicProgressSettings>) {
  const body = serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showSponsors: true, showEvents: true, ...settings });
  await t.db.teamNote.upsert({ where: { key: PUBLIC_PROGRESS_KEY }, create: { key: PUBLIC_PROGRESS_KEY, body }, update: { body } });
}

async function answer(): Promise<PublicSponsors> {
  const a = await getPublicSponsors(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
  if (!a.enabled) throw new Error("expected sponsors to be on");
  return a;
}

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

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  ava = await makeUser(t.db, { name: "Ava Thompson", subteam: "BUSINESS" });
  daniel = await makeUser(t.db, { name: "Daniel Park", subteam: "BUSINESS" });
  maya = await makeUser(t.db, { name: "Maya Patel", subteam: "SOFTWARE" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  pendingBiz = await makeUser(t.db, { name: "Pat Pending", subteam: "BUSINESS", status: "PENDING" });
  await setSettings({});

  // On the website: Accepted or Finished, thanked there.
  await sponsor("rev", { name: "REV Robotics", stage: "ACCEPTED", acceptedOn: "2026-09-21", website: "https://rev.example.com/", owner: ava });
  await sponsor("hd26", { name: "Home Depot", stage: "FINISHED", acceptedOn: "2026-08-14", website: "https://homedepot.example.com/2026" });
  // Last year's Home Depot, under a name with other capitals and spacing: one entry with both years.
  await sponsor("hd25", {
    name: "The Home Depot",
    publicName: "  home   DEPOT ",
    stage: "FINISHED",
    acceptedOn: "2025-03-01",
    website: "https://homedepot.example.com/old",
  });
  // An older one still, without a logo: the group has one, so it doesn't need its own.
  await sponsor("hd24", { name: "HOME DEPOT", stage: "FINISHED", submittedOn: "2024-02-02" });
  // No accepted date: the year it was submitted.
  await sponsor("rotary", { name: "Anaheim Rotary Club", stage: "FINISHED", submittedOn: "2025-11-10", owner: ava });
  // No dates at all: the year it was added, in the team's timezone (Dec 31, 2025 in Anaheim; Jan 1 in UTC).
  await sponsor("owl", { name: "Night Owl Donor", stage: "ACCEPTED", createdAt: "2026-01-01T05:00:00Z", website: "javascript:alert(1)" });
  // Never on the website.
  await sponsor("hidden", { name: "Hidden Fund", stage: "FINISHED", acceptedOn: "2026-05-01", showOnWebsite: false });
  await sponsor("pending", { name: "Pending Co", stage: "SUBMITTED", submittedOn: "2026-09-01" });
  await sponsor("declined", { name: "Declined Corp", stage: "DECLINED", submittedOn: "2026-06-01" });
  await sponsor("todo", { name: "Someday Inc", stage: "NOT_STARTED" });

  logos.rev = (await uploadSponsorshipLogo(at(ava, "2026-09-22T18:00:00Z"), { sponsorshipId: ids.rev, file: file("REV logo.PNG", png()) })).id;
  logos.hd25 = (await uploadSponsorshipLogo(at(amara, "2025-03-02T18:00:00Z"), { sponsorshipId: ids.hd25, file: file("hd-old.png", png()) })).id;
  logos.hd26 = (await uploadSponsorshipLogo(at(amara, "2026-08-15T18:00:00Z"), { sponsorshipId: ids.hd26, file: file("hd.jpg", jpeg()) })).id;
  logos.hidden = (await uploadSponsorshipLogo(at(amara, "2026-05-02T18:00:00Z"), { sponsorshipId: ids.hidden, file: file("hidden.png", png()) })).id;
  logos.pending = (await uploadSponsorshipLogo(at(amara, "2026-09-02T18:00:00Z"), { sponsorshipId: ids.pending, file: file("pending.webp", webp()) })).id;
});
afterAll(async () => {
  await t.drop();
});

// ── The answer ────────────────────────────────────────────────────────────────

describe("the public sponsors answer", () => {
  it("lists Accepted and Finished sponsors thanked on the website, grouped by public name, newest year first", async () => {
    const a = await answer();
    expect(a.updatedAt).toBe(TEST_NOW.toISOString());
    expect(a.sponsors).toEqual([
      // The website's homepage only (the newest row's: "https://homedepot.example.com/2026" → its homepage).
      { name: "Home Depot", url: "https://homedepot.example.com/", years: [2024, 2025, 2026], logo: publicSponsorLogoPath(logos.hd26) },
      { name: "REV Robotics", url: "https://rev.example.com/", years: [2026], logo: `/api/public/sponsors/logos/${logos.rev}` },
      { name: "Anaheim Rotary Club", url: null, years: [2025], logo: null },
      // Its website isn't http(s): never linked.
      { name: "Night Owl Donor", url: null, years: [2025], logo: null },
    ]);
  });

  it("never includes amounts, asks, contacts, the person on it, notes, stages, files, or anyone it shouldn't", async () => {
    await t.db.sponsorshipFile.create({
      data: { sponsorshipId: ids.rev, filename: "signed-contract.pdf", contentType: "application/pdf", size: 3, data: new Uint8Array([1, 2, 3]) },
    });
    const json = JSON.stringify(await answer());
    for (const secret of [
      "4321",
      SECRET_ASK,
      SECRET_CONTACT,
      SECRET_EMAIL,
      SECRET_NOTE,
      "Ava Thompson",
      "Amara",
      "ACCEPTED",
      "FINISHED",
      "signed-contract",
      "Hidden Fund",
      "Pending Co",
      "Declined Corp",
      "Someday Inc",
      ids.rev,
      "example.com/old", // an older row's website (and any website's path)
      "example.com/2026",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    const keys = new Set((await answer()).sponsors.flatMap((s) => Object.keys(s)));
    expect([...keys].sort()).toEqual(["logo", "name", "url", "years"]);
  });

  it("works out names, groups, and years the documented way", () => {
    expect(sponsorPublicName({ name: "  The   Home Depot ", publicName: "" })).toBe("The Home Depot");
    expect(sponsorPublicName({ name: "The Home Depot", publicName: " Home  Depot " })).toBe("Home Depot");
    expect(publicSponsorKey({ name: "x", publicName: "HOME   depot" })).toBe(publicSponsorKey({ name: "Home Depot", publicName: "" }));
    const createdAt = new Date("2026-01-01T05:00:00Z");
    expect(sponsorPublicYear({ acceptedOn: "2026-02-03", submittedOn: "2025-12-01", createdAt }, TEST_TZ)).toBe(2026);
    expect(sponsorPublicYear({ acceptedOn: null, submittedOn: dateOnlyToDb("2025-12-01"), createdAt }, TEST_TZ)).toBe(2025);
    expect(sponsorPublicYear({ acceptedOn: null, submittedOn: null, createdAt }, TEST_TZ)).toBe(2025); // Dec 31 in Anaheim
    expect(sponsorPublicYear({ acceptedOn: null, submittedOn: null, createdAt }, "UTC")).toBe(2026);
  });

  it("links only to a sponsor's homepage: never an application page's path, query, or #fragment", async () => {
    const secret = "https://grants.qualcomm.example/portal/application/88213?invite=Zx9-team19516-secret&token=SECRETTOKEN#draft";
    await sponsor("token", { name: "Qualcomm", stage: "FINISHED", acceptedOn: "2026-06-01", website: secret });
    const json = JSON.stringify(await answer());
    for (const leak of ["88213", "invite", "Zx9-team19516-secret", "token=", "SECRETTOKEN", "#draft", "/portal/application"]) {
      expect(json, leak).not.toContain(leak);
    }
    expect((await answer()).sponsors.find((s) => s.name === "Qualcomm")?.url).toBe("https://grants.qualcomm.example/");
    await t.db.sponsorship.delete({ where: { id: ids.token } });

    expect(publicSponsorUrl("https://acme.example.com/apply?applicationId=777&token=SECRET#draft")).toBe("https://acme.example.com/");
    expect(publicSponsorUrl("  http://Shop.Example.org:8080/a/b?c=d ")).toBe("http://shop.example.org:8080/");
    expect(publicSponsorUrl("https://rev.example.com")).toBe("https://rev.example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "https://user:pw@rev.example.com/", "rev.example.com", "ftp://rev.example.com/", ""]) {
      expect(publicSponsorUrl(bad), bad).toBeNull();
    }
  });

  it("shows a group under the newest row's spelling, unless that one is all lower-case and another has capitals", async () => {
    await sponsor("fp25", { name: "Fresh Prints Anaheim", stage: "FINISHED", acceptedOn: "2025-04-01" });
    // A hasty entry for this year doesn't rename them…
    await sponsor("fp26", { name: "FP 2026", publicName: "fresh   prints  anaheim", stage: "ACCEPTED", acceptedOn: "2026-04-01" });
    const fresh = async () => (await answer()).sponsors.filter((s) => publicSponsorKey({ name: s.name, publicName: "" }) === "fresh prints anaheim");
    expect(await fresh()).toEqual([expect.objectContaining({ name: "Fresh Prints Anaheim", years: [2025, 2026] })]);
    // …but a deliberate change to the capitals on the newest row shows.
    await t.db.sponsorship.update({ where: { id: ids.fp26 }, data: { publicName: "Fresh PRINTS Anaheim" } });
    expect((await fresh()).map((s) => s.name)).toEqual(["Fresh PRINTS Anaheim"]);
    await t.db.sponsorship.deleteMany({ where: { id: { in: [ids.fp25, ids.fp26] } } });

    expect(pickPublicSponsorName(["rev robotics", "REV Robotics", "Rev Robotics"])).toBe("REV Robotics");
    expect(pickPublicSponsorName(["REV Robotics", "Rev Robotics"])).toBe("REV Robotics");
    expect(pickPublicSponsorName(["acme", "acme"])).toBe("acme");
    expect(pickPublicSponsorName([])).toBe("");
  });

  it("drops a sponsor taken off the website (or moved back from Accepted) right away", async () => {
    await t.db.sponsorship.update({ where: { id: ids.rev }, data: { showOnWebsite: false } });
    expect((await answer()).sponsors.map((s) => s.name)).not.toContain("REV Robotics");
    await t.db.sponsorship.update({ where: { id: ids.rev }, data: { showOnWebsite: true, stage: "SUBMITTED" } });
    expect((await answer()).sponsors.map((s) => s.name)).not.toContain("REV Robotics");
    await t.db.sponsorship.update({ where: { id: ids.rev }, data: { stage: "ACCEPTED" } });
    expect((await answer()).sponsors.map((s) => s.name)).toContain("REV Robotics");
  });

  it("is off until someone with admin access turns it on (nothing saved yet: {enabled: false}, no logos)", async () => {
    await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_KEY } });
    expect(await getPublicSponsors(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).toEqual({ enabled: false });
    expect(await publicSponsorsShown(t.db)).toBe(false);
    const logo = await publicSponsorLogoResponse(new NextRequest(`https://x.example/api/public/sponsors/logos/${logos.rev}`), { db: t.db, id: logos.rev });
    expect(logo.status).toBe(404);
    expect(await countSponsorsNeedingLogo(amara, t.db)).toBe(0);
    await setSettings({});
    expect(await publicSponsorsShown(t.db)).toBe(true);
    expect((await getPublicSponsors(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).enabled).toBe(true);
  });

  it("Admin → Team website says how many sponsors and events would go public (counts only, admin access only)", async () => {
    const preview = (await getTeamWebsitePreview(amara, TEST_TZ, t.db))!;
    const list = (await answer()).sponsors;
    expect(preview.sponsors).toBe(list.length);
    expect(preview.sponsorsWithoutLogo).toBe(list.filter((s) => !s.logo).length);
    expect(preview.events).toBe(await t.db.calendarEvent.count({ where: publicEventsWhere("2026-08-31") }));
    // The same while it's off: that's when it's needed.
    await setSettings({ showSponsors: false, showEvents: false });
    expect(await getTeamWebsitePreview(amara, TEST_TZ, t.db)).toEqual(preview);
    await setSettings({});
    expect(await getTeamWebsitePreview(ava, TEST_TZ, t.db)).toBeNull();
    expect(await getTeamWebsitePreview(pendingBiz, TEST_TZ, t.db)).toBeNull();
  });

  it("answers only {enabled: false} while the owner has sponsors turned off (progress stays as it is)", async () => {
    await setSettings({ showSponsors: false });
    expect(await getPublicSponsors(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).toEqual({ enabled: false });
    await setSettings({ showSponsors: true, enabled: false });
    expect((await getPublicSponsors(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).enabled).toBe(true);
    await setSettings({});
  });
});

// ── The logo route ────────────────────────────────────────────────────────────

describe("GET /api/public/sponsors/logos/[id]", () => {
  const ask = (id: string, method = "GET") =>
    publicSponsorLogoResponse(new NextRequest(`https://communication-portal-iota.vercel.app/api/public/sponsors/logos/${id}`, { method }), {
      db: t.db,
      id,
    });

  it("serves a public sponsor's logo inline, sandboxed, never sniffed, embeddable by the team website, cached long", async () => {
    const res = await ask(logos.rev);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png());
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(png().byteLength));
    // Under a neutral name from the public name, never the name it was uploaded with ("REV logo.PNG").
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="rev-robotics-logo.png"; filename*=UTF-8''rev-robotics-logo.png`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_FILE_IMMUTABLE_CACHE);
    // Browsers a day; Vercel's CDN 5 minutes (a sponsor taken off the website stops being served from it soon).
    expect(PUBLIC_FILE_IMMUTABLE_CACHE).toBe("public, max-age=86400, s-maxage=300, immutable");
    expect(res.headers.get("set-cookie")).toBeNull();
    const head = await ask(logos.rev, "HEAD");
    expect([head.status, await head.text(), head.headers.get("content-type")]).toEqual([200, "", "image/png"]);
    // The JPEG and an older logo of a public sponsor too.
    expect((await ask(logos.hd26)).headers.get("content-type")).toBe("image/jpeg");
    expect((await ask(logos.hd25)).status).toBe(200);
  });

  it("is a 404 (not cached) unless the sponsor is on the team website right now", async () => {
    const notFound = async (id: string) => {
      const res = await ask(id);
      expect([res.status, res.headers.get("cache-control")], id).toEqual([404, "private, no-store"]);
      expect(res.headers.get("content-type"), id).toBe("text/plain; charset=utf-8");
    };
    await notFound(logos.hidden); // "Thank them on the team website" off
    await notFound(logos.pending); // still Submitted
    await notFound("doesnotexist123");
    await notFound("../" + logos.rev);
    await notFound(`${logos.rev}.png`);
    await notFound("a".repeat(65));
    await t.db.sponsorship.update({ where: { id: ids.rev }, data: { stage: "DECLINED" } });
    await notFound(logos.rev);
    await t.db.sponsorship.update({ where: { id: ids.rev }, data: { stage: "FINISHED" } });
    expect((await ask(logos.rev)).status).toBe(200);
    await setSettings({ showSponsors: false });
    await notFound(logos.rev);
    await setSettings({});
    expect((await ask(logos.rev)).status).toBe(200);
  });

  it("answers a plain 503 when the database fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { teamNote: { findMany: () => Promise.reject(new Error("database down")) } } as unknown as Db;
    const res = await publicSponsorLogoResponse(new NextRequest(`https://x.example/api/public/sponsors/logos/${logos.rev}`), { db: broken, id: logos.rev });
    quiet.mockRestore();
    expect([res.status, res.headers.get("cache-control")]).toEqual([503, "private, no-store"]);
    expect(await res.text()).toBe(PUBLIC_FILE_UNAVAILABLE);
  });

  it("sends an address with a query string to the bare one, without reading the database or the file", async () => {
    // Every unique URL is its own CDN copy: `?cb=1`, `?cb=2`, … must never make the server read the logo again.
    const touched: string[] = [];
    const watching = new Proxy({} as Db, {
      get(_target, key) {
        touched.push(String(key));
        throw new Error(`the database was used (${String(key)})`);
      },
    });
    for (const query of ["?cb=1", "?cb=2&x=y", "?download=1", "?a"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await publicSponsorLogoResponse(
          new NextRequest(`https://communication-portal-iota.vercel.app/api/public/sponsors/logos/${logos.rev}${query}`, { method }),
          { db: watching, id: logos.rev, store: null },
        );
        expect([res.status, res.headers.get("location")], query).toEqual([308, `/api/public/sponsors/logos/${logos.rev}`]);
        expect(res.headers.get("cache-control"), query).toBe(PUBLIC_FILE_REDIRECT_CACHE);
        expect(await res.text(), query).toBe("");
      }
    }
    // A bad id is a 404 either way (never a redirect to it).
    const bad = await publicSponsorLogoResponse(new NextRequest("https://x.example/api/public/sponsors/logos/a.b?cb=1"), { db: watching, id: "a.b" });
    expect(bad.status).toBe(404);
    expect(touched).toEqual([]);
  });

  it("is served under a neutral name and with guest-facing errors when Cloudflare R2 can't send it", async () => {
    const s = await sponsor("r2", { name: "Ünïcode & Co — IMG", stage: "ACCEPTED", acceptedOn: "2026-02-02" });
    const { id } = await t.db.sponsorshipLogo.create({
      data: {
        sponsorshipId: s.id,
        filename: "IMG_2026 Amara Okafor home desk.png",
        contentType: "image/png",
        size: png().byteLength,
        storageKey: `test/logo-${s.id}`,
        uploadedById: amara.id,
      },
      select: { id: true },
    });
    const req = () => new NextRequest(`https://x.example/api/public/sponsors/logos/${id}`);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = (getObject: ObjectStore["getObject"]): ObjectStore => ({
      putObject: async () => {},
      getObject,
      getObjectBytes: async () => null,
      deleteObject: async () => {},
      withTimeout() {
        return this;
      },
    });
    try {
      const ok = await publicSponsorLogoResponse(req(), {
        db: t.db,
        id,
        store: store(async () => ({ body: new Response(Uint8Array.from(png())).body!, contentLength: png().byteLength })),
      });
      expect(ok.status).toBe(200);
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(png());
      const disposition = ok.headers.get("content-disposition")!;
      expect(disposition).toBe(`inline; filename="unicode-co-img-logo.png"; filename*=UTF-8''unicode-co-img-logo.png`);
      expect(disposition).not.toContain("Amara");

      // R2 isn't set up / doesn't answer / lost the file: never the team's R2 messages.
      for (const [st, status, text] of [
        [null, 503, PUBLIC_FILE_UNAVAILABLE],
        [store(() => Promise.reject(new Error("R2 down"))), 503, PUBLIC_FILE_UNAVAILABLE],
        [store(async () => null), 404, PUBLIC_LOGO_NOT_FOUND],
      ] as const) {
        const res = await publicSponsorLogoResponse(req(), { db: t.db, id, store: st });
        const body = await res.text();
        expect([res.status, body, res.headers.get("cache-control")]).toEqual([status, text, "private, no-store"]);
        expect(body).not.toMatch(/R2|owner/);
      }
    } finally {
      quiet.mockRestore();
      await t.db.sponsorship.delete({ where: { id: s.id } });
    }
    expect(publicSponsorLogoFilename("REV Robotics", "image/png")).toBe("rev-robotics-logo.png");
    expect(publicSponsorLogoFilename("  ", "image/jpeg")).toBe("sponsor-logo.jpg");
    expect(publicSponsorLogoFilename("株式会社", "image/webp")).toBe("sponsor-logo.webp");
    expect(publicSponsorLogoFilename("x".repeat(100), "image/png")).toBe(`${"x".repeat(48)}-logo.png`);
  });

  it("is served by the route (GET, HEAD) without signing in", async () => {
    const req = (method: string) => new NextRequest(`https://communication-portal-iota.vercel.app/api/public/sponsors/logos/${logos.rev}`, { method });
    const params = { params: Promise.resolve({ id: logos.rev }) } as never;
    const res = await logoRoute.GET(req("GET"), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await logoRoute.HEAD(req("HEAD"), params)).status).toBe(200);
    expect(Object.keys(logoRoute).sort()).toEqual(["GET", "HEAD"]);
  });

  it("publicFileHeaders shows only pictures inline; anything else is a download", () => {
    const pic = publicFileHeaders({ contentType: "IMAGE/WEBP; x=1", filename: "logo.webp", inline: true, immutable: false });
    expect(Object.fromEntries(pic)).toEqual({
      "content-type": "image/webp",
      "content-disposition": `inline; filename="logo.webp"; filename*=UTF-8''logo.webp`,
      "x-content-type-options": "nosniff",
      "content-security-policy": PUBLIC_FILE_CSP,
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "public, max-age=60, s-maxage=60",
    });
    for (const contentType of ["image/svg+xml", "text/html", "application/pdf", "application/octet-stream"]) {
      const h = publicFileHeaders({ contentType, filename: 'x"évil.svg', inline: true, immutable: true });
      expect(h.get("content-type"), contentType).toBe("application/octet-stream");
      expect(h.get("content-disposition"), contentType).toBe(`attachment; filename="x__vil.svg"; filename*=UTF-8''x%22%C3%A9vil.svg`);
      expect(h.get("cache-control")).toBe(PUBLIC_FILE_IMMUTABLE_CACHE);
    }
    expect(publicFileHeaders({ contentType: "image/png", filename: "a.png", inline: false, immutable: true }).get("content-disposition")).toMatch(/^attachment;/);
  });
});

// ── HTTP ──────────────────────────────────────────────────────────────────────

describe("GET /api/public/sponsors", () => {
  const url = `https://communication-portal-iota.vercel.app${PUBLIC_SPONSORS_PATH}`;
  const call = (init: RequestInit & { origin?: string } = {}, extraOrigins?: string) => {
    const headers = new Headers(init.headers);
    if (init.origin) headers.set("origin", init.origin);
    return publicSponsorsResponse(new Request(url, { ...init, headers }), { db: t.db, now: TEST_NOW, teamTimezone: TEST_TZ, extraOrigins });
  };

  it("lets the team website read it (CORS for it only), cached briefly and never sniffed", async () => {
    const res = await call({ origin: TEAM_SITE_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(((await res.json()) as PublicSponsors).sponsors.length).toBe(4);
    for (const origin of ["https://evil.example", "null", "https://huskyteers19516.github.io.evil.example"]) {
      expect((await call({ origin })).headers.get("access-control-allow-origin"), origin).toBe(TEAM_SITE_ORIGIN);
    }
    expect((await call({ origin: "http://localhost:4410" }, "http://localhost:4410")).headers.get("access-control-allow-origin")).toBe("http://localhost:4410");
  });

  it("answers HEAD and the CORS preflight, and nothing else", async () => {
    const head = await call({ method: "HEAD", origin: TEAM_SITE_ORIGIN });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    const preflight = await call({ method: "OPTIONS", origin: TEAM_SITE_ORIGIN });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    const post = await call({ method: "POST", origin: TEAM_SITE_ORIGIN, body: "{}" });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET, HEAD, OPTIONS"]);
  });

  it("says {enabled: false} when turned off, and a 503 that isn't cached when the database fails", async () => {
    await setSettings({ showSponsors: false });
    expect(await (await call({ origin: TEAM_SITE_ORIGIN })).json()).toEqual({ enabled: false });
    await setSettings({});
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { teamNote: { findMany: () => Promise.reject(new Error("database down")) } } as unknown as Db;
    const res = await publicSponsorsResponse(new Request(url, { headers: { origin: TEAM_SITE_ORIGIN } }), { db: broken, now: TEST_NOW, teamTimezone: TEST_TZ });
    quiet.mockRestore();
    expect([res.status, res.headers.get("cache-control")]).toEqual([503, "no-store"]);
    expect(await res.json()).toEqual({ error: PUBLIC_SPONSORS_UNAVAILABLE });
  });

  it("is served by the route (GET, HEAD, OPTIONS) without signing in", async () => {
    const req = (method: string) => new NextRequest(url, { method, headers: { origin: TEAM_SITE_ORIGIN } });
    const res = await sponsorsRoute.GET(req("GET"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PublicSponsors).sponsors.map((s) => s.name)).toContain("REV Robotics");
    expect((await sponsorsRoute.HEAD(req("HEAD"))).status).toBe(200);
    expect((await sponsorsRoute.OPTIONS(req("OPTIONS"))).status).toBe(204);
    expect(Object.keys(sponsorsRoute).sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
  });
});

// ── Uploading logos ───────────────────────────────────────────────────────────

describe("uploading a logo", () => {
  const up = (actor: Actor, sponsorshipId: string, f: ReturnType<typeof file>) => uploadSponsorshipLogo(contextFor(t.db, actor), { sponsorshipId, file: f });

  it("is for everyone who can edit the sponsor (the Business team and staff), and only active accounts", async () => {
    const s = await sponsor("perm", { name: "Permission Co", stage: "ACCEPTED" });
    for (const who of [maya, pendingBiz]) {
      expect(await errorOf(up(who, s.id, file("a.png", png()))), who.name).toBeInstanceOf(ForbiddenError);
    }
    await up(daniel, s.id, file("a.png", png()));
    await up(priya, s.id, file("b.png", png())); // a leader of another subteam (staff) replaces it
    expect(await t.db.sponsorshipLogo.count({ where: { sponsorshipId: s.id } })).toBe(1);
    const e = await errorOf(up(ava, "nosuchsponsor", file("a.png", png())));
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as NotFoundError).userMessage).toBe(SPONSORSHIP_NOT_FOUND);
  });

  it("takes only real PNG, JPG, or WebP pictures a phone can draw, up to 4 MB, checked by their contents", async () => {
    const s = await sponsor("checks", { name: "Checks Co", stage: "ACCEPTED" });
    const refuse = (f: ReturnType<typeof file>) => fileErrorOf(up(ava, s.id, f));
    expect(await refuse(file("logo.svg", text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml"))).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    // Named or typed as a PNG / JPG / WebP but not really a picture: it "couldn't be opened" (they did pick a PNG).
    expect(await refuse(file("logo.png", text("<html><script>alert(1)</script></html>"), "image/png"))).toBe(SPONSOR_LOGO_UNREADABLE_MESSAGE);
    expect(await refuse(file("fake.png", text("just some text, not a picture")))).toBe(SPONSOR_LOGO_UNREADABLE_MESSAGE);
    expect(await refuse(file("scan", text("not a picture"), "image/jpeg"))).toBe(SPONSOR_LOGO_UNREADABLE_MESSAGE);
    // A real SVG, GIF, or PDF — whatever it's called — or something that doesn't say it's a picture: the type message.
    expect(await refuse(file("logo.png", text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/png"))).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    expect(await refuse(file("notes.txt", text("hello"), "text/plain"))).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    expect(await refuse(file("logo.webp", text("GIF89a\x01\x00\x01\x00\x00\x00\x00;")))).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    expect(await refuse(file("logo.gif", text("GIF89a\x01\x00\x01\x00\x00\x00\x00;")))).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    expect(await refuse(file("logo.pdf", text("%PDF-1.4\n")))).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    const heic = Uint8Array.from([0, 0, 0, 24, ...Array.from("ftypheic", (c) => c.charCodeAt(0)), 0, 0, 0, 0]);
    expect(await refuse(file("IMG_0001.HEIC", heic))).toBe(POSTER_HEIC_MESSAGE);
    expect(await refuse(file("huge.png", png(30_000, 30_000)))).toMatch(/^That picture is 30,000 × 30,000 pixels — far bigger than a logo needs\./);
    expect(await refuse(file("zero.png", png(0, 10)))).toBe(SPONSOR_LOGO_UNREADABLE_MESSAGE);
    expect(await refuse(file("cut.png", png().subarray(0, 20)))).toBe(SPONSOR_LOGO_UNREADABLE_MESSAGE);
    expect(await refuse(file("big.png", new Uint8Array(LIMITS.resourceFileMaxBytes + 1)))).toMatch(/^That file is 4\.0 MB\. Logos can be up to 4 MB/);
    expect(await refuse(file("empty.png", new Uint8Array(0)))).toBe("That file is empty. Choose another one.");
    expect(await fileErrorOf(uploadSponsorshipLogo(contextFor(t.db, ava), { sponsorshipId: s.id }))).toBe(SPONSOR_LOGO_NEEDS_FILE);
    expect(await t.db.sponsorshipLogo.count({ where: { sponsorshipId: s.id } })).toBe(0);

    // A picture is stored with its real type and a matching extension, whatever it was called; with its size.
    const { id } = await up(ava, s.id, file("brand.HEIC", jpeg(300, 100), "image/heic"));
    expect(await t.db.sponsorshipLogo.findUniqueOrThrow({ where: { id } })).toMatchObject({
      filename: "brand.jpg",
      contentType: "image/jpeg",
      width: 300,
      height: 100,
      uploadedById: ava.id,
      storageKey: null,
    });
    expect(checkSponsorLogo(file("x", webp(50, 20))).upload).toMatchObject({ filename: "x.webp", contentType: "image/webp" });
    expect(checkSponsorLogo(file("", png())).upload.filename).toBe("logo.png");
  });

  it("is stored and published without its metadata (GPS, author, phone), keeping its orientation", async () => {
    const s = await sponsor("exif", { name: "Exif Co", stage: "ACCEPTED", acceptedOn: "2026-03-03" });
    const note = Array.from("GPSLatitude=33.8366;Artist=Amara Okafor;Model=iPhone 15\0", (c) => c.charCodeAt(0));
    // II*\0, IFD0 at 8: Orientation = 6, Artist → the note.
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 2, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0x3b, 0x01, 2, 0, note.length, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, ...note];
    const exif = [...Array.from("Exif\0\0", (c) => c.charCodeAt(0)), ...tiff];
    const plain = jpeg(300, 100);
    const withExif = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 255, ...exif, ...plain.subarray(2)]);
    const { id } = await uploadSponsorshipLogo(contextFor(t.db, amara), { sponsorshipId: s.id, file: file("IMG_2026.jpg", withExif) });
    const row = await t.db.sponsorshipLogo.findUniqueOrThrow({ where: { id } });
    const stored = Buffer.from(row.data!);
    for (const secret of ["GPS", "Amara", "iPhone"]) expect(stored.includes(secret), secret).toBe(false);
    expect(row).toMatchObject({ width: 300, height: 100, size: stored.byteLength });
    expect(stored.byteLength).toBeLessThan(withExif.byteLength);
    expect(stored.includes("Exif")).toBe(true); // just the orientation

    const served = await publicSponsorLogoResponse(new NextRequest(`https://x.example/api/public/sponsors/logos/${id}`), { db: t.db, id });
    const body = Buffer.from(await served.arrayBuffer());
    expect(served.status).toBe(200);
    expect(body.equals(stored)).toBe(true);
    await t.db.sponsorship.delete({ where: { id: s.id } });
  });

  it("checks the picked file in the browser the same way (size and type) before sending it", () => {
    expect(sponsorLogoProblem({ name: "logo.png", type: "image/png", size: 10 })).toBeNull();
    expect(sponsorLogoProblem({ name: "logo", type: "image/webp", size: 10 })).toBeNull();
    expect(sponsorLogoProblem({ name: "logo.svg", type: "image/svg+xml", size: 10 })).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    expect(sponsorLogoProblem({ name: "logo.gif", type: "image/gif", size: 10 })).toBe(SPONSOR_LOGO_TYPES_MESSAGE);
    expect(sponsorLogoProblem({ name: "logo.png", type: "image/png", size: LIMITS.resourceFileMaxBytes + 1 })).toMatch(/Logos can be up to 4 MB/);
    expect(sponsorLogoProblem({ name: "logo.png", type: "image/png", size: 0 })).toBe("That file is empty. Choose another one.");
  });

  it("replaces the old logo with a new row (so a new public address), and removes it", async () => {
    const s = await sponsor("replace", { name: "Replace Co", stage: "FINISHED" });
    const first = await up(ava, s.id, file("one.png", png()));
    expect(first.replaced).toBe(false);
    const second = await up(ava, s.id, file("two.png", png(80, 30)));
    expect(second).toMatchObject({ replaced: true });
    expect(second.id).not.toBe(first.id);
    expect(await t.db.sponsorshipLogo.findUnique({ where: { id: first.id } })).toBeNull();
    expect((await t.db.sponsorshipLogo.findUniqueOrThrow({ where: { sponsorshipId: s.id } })).filename).toBe("two.png");

    expect(await errorOf(removeSponsorshipLogo(contextFor(t.db, maya), { sponsorshipId: s.id }))).toBeInstanceOf(ForbiddenError);
    await removeSponsorshipLogo(contextFor(t.db, daniel), { sponsorshipId: s.id });
    expect(await t.db.sponsorshipLogo.count({ where: { sponsorshipId: s.id } })).toBe(0);
    const again = await errorOf(removeSponsorshipLogo(contextFor(t.db, daniel), { sponsorshipId: s.id }));
    expect((again as NotFoundError).userMessage).toBe(SPONSOR_LOGO_NONE);
    // Removing the sponsor removes its logo.
    await up(ava, s.id, file("three.png", png()));
    await t.db.sponsorship.delete({ where: { id: s.id } });
    expect(await t.db.sponsorshipLogo.count({ where: { sponsorshipId: s.id } })).toBe(0);
  });

  it("counts toward the team's storage and each person's sponsor-upload allowance (shared with sponsor files)", async () => {
    const usage = await t.db.$transaction((tx) => fileStorageUsage(tx, false));
    const sum = (await t.db.sponsorshipLogo.aggregate({ _sum: { size: true } }))._sum.size ?? 0;
    expect(usage.logos).toBe(sum);
    expect(usage.used).toBe(usage.resources + usage.sponsors + usage.posters + usage.notebook + usage.strategy + usage.logos);

    const gwen = await makeUser(t.db, { name: "Gwen Byers", subteam: "BUSINESS" });
    const s = await sponsor("allowance", { name: "Allowance Co", stage: "ACCEPTED" });
    await t.db.sponsorshipFile.create({
      data: { sponsorshipId: s.id, uploadedById: gwen.id, filename: "scan.pdf", contentType: "application/pdf", size: SPONSOR_FILE_BYTES_PER_PERSON - 10, data: new Uint8Array([1]) },
    });
    expect(await fileErrorOf(up(gwen, s.id, file("logo.png", png())))).toMatch(/^You've uploaded 50 MB of sponsor files and logos/);
    await up(amara, s.id, file("logo.png", png())); // the Business leader isn't limited
  });
});

// ── The edit form's "Team website" section ────────────────────────────────────

describe("the Team website section of the sponsor form", () => {
  const base = { stage: "ACCEPTED", website: "", contactName: "", contactEmail: "", asking: "", amountReceived: "", notes: "" };

  it("saves 'Thank them on the team website' and 'Name on the website' only when the form sent the section", async () => {
    const plain = await createSponsorship(contextFor(t.db, ava), { ...base, name: "Plain Co" });
    expect(await t.db.sponsorship.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject({ showOnWebsite: true, publicName: "" });

    const { id } = await createSponsorship(contextFor(t.db, ava), { ...base, name: "The Fresh Prints Shop", websiteFields: "1", publicName: "  Fresh Prints  " });
    // An unchecked box is off.
    expect(await t.db.sponsorship.findUniqueOrThrow({ where: { id } })).toMatchObject({ showOnWebsite: false, publicName: "Fresh Prints" });

    await updateSponsorship(contextFor(t.db, ava), { ...base, sponsorshipId: id, name: "The Fresh Prints Shop", websiteFields: "1", showOnWebsite: "on", publicName: "" });
    expect(await t.db.sponsorship.findUniqueOrThrow({ where: { id } })).toMatchObject({ showOnWebsite: true, publicName: "" });

    // A save without the section (an older form, the import's update) leaves them as they are.
    await t.db.sponsorship.update({ where: { id }, data: { showOnWebsite: false, publicName: "Kept" } });
    await updateSponsorship(contextFor(t.db, ava), { ...base, sponsorshipId: id, name: "The Fresh Prints Shop" });
    expect(await t.db.sponsorship.findUniqueOrThrow({ where: { id } })).toMatchObject({ showOnWebsite: false, publicName: "Kept" });
    await t.db.sponsorship.deleteMany({ where: { id: { in: [id, plain.id] } } });
  });

  it("checks the name's length with the other fields", async () => {
    const e = await errorOf(
      createSponsorship(contextFor(t.db, ava), { ...base, name: "", websiteFields: "1", publicName: "x".repeat(LIMITS.sponsorNameMax + 1) }),
    );
    expect(Object.keys((e as ValidationError).fieldErrors).sort()).toEqual(["name", "publicName"]);
  });
});

// ── Logo needed ───────────────────────────────────────────────────────────────

describe("Logo needed", () => {
  it("marks sponsors on the website without a logo — unless the same public name has one — on the list and its filter", async () => {
    const all = (await listSponsorships(amara, { filter: "all", today: TEST_TODAY }, t.db))!;
    const needs = (key: string) => all.items.find((i) => i.id === ids[key])?.logoNeeded;
    expect(needs("rotary")).toBe(true);
    expect(needs("owl")).toBe(true);
    expect(needs("rev")).toBe(false); // has one
    expect(needs("hd24")).toBe(false); // the Home Depot group has one
    expect(needs("hidden")).toBe(false); // not on the website
    expect(needs("pending")).toBe(false); // not yet
    expect(needs("todo")).toBe(false);

    const filtered = (await listSponsorships(amara, { filter: "logo", today: TEST_TODAY }, t.db))!;
    const names = filtered.items.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["Anaheim Rotary Club", "Night Owl Donor"]));
    expect(names).not.toContain("HOME DEPOT");
    expect(filtered.items.every((i) => i.logoNeeded)).toBe(true);
    expect(filtered.summary.logoNeeded).toBe(filtered.items.length);
    expect((await listSponsorships(ava, { filter: "logo", mine: true, today: TEST_TODAY }, t.db))!.items.map((i) => i.name)).toEqual(["Anaheim Rotary Club"]);

    const hd24 = (await getSponsorship(amara, ids.hd24, t.db))!;
    expect(hd24).toMatchObject({ logoNeeded: false, logoFromSameName: true, logo: null });
    const rev = (await getSponsorship(amara, ids.rev, t.db))!;
    expect(rev).toMatchObject({ logoNeeded: false, logoFromSameName: false, showOnWebsite: true, hasLogo: true });
    expect(rev.logo).toMatchObject({ id: logos.rev, filename: "REV logo.PNG", width: 64, height: 28, uploadedByName: "Ava Thompson" });
    expect((await getSponsorship(amara, ids.rotary, t.db))!.logoNeeded).toBe(true);
  });

  it("nudges the Business leader about all of them and everyone else about the ones they're on — not while sponsors are off", async () => {
    const all = (await listSponsorships(amara, { filter: "logo", today: TEST_TODAY }, t.db))!.items.length;
    expect(await countSponsorsNeedingLogo(amara, t.db)).toBe(all);
    expect(await countSponsorsNeedingLogo(ava, t.db)).toBe(1); // the Rotary Club
    expect(await countSponsorsNeedingLogo(daniel, t.db)).toBe(0);
    expect(await countSponsorsNeedingLogo(maya, t.db)).toBe(0); // outside Sponsorships
    expect(await countSponsorsNeedingLogo(pendingBiz, t.db)).toBe(0);
    await setSettings({ showSponsors: false });
    expect(await countSponsorsNeedingLogo(amara, t.db)).toBe(0);
    await setSettings({});
    // A logo for the Rotary Club takes it off Ava's list.
    await uploadSponsorshipLogo(contextFor(t.db, ava), { sponsorshipId: ids.rotary, file: file("rotary.png", png()) });
    expect(await countSponsorsNeedingLogo(ava, t.db)).toBe(0);
    expect(await countSponsorsNeedingLogo(amara, t.db)).toBe(all - 1);
  });
});
