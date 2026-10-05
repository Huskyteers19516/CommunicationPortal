// The team website's Events page: GET /api/public/events (src/app/api/public/events/route.ts, built by
// src/server/queries/public-events.ts and src/server/public-api.ts), the calendar's "Hide from the team website" box
// (services/calendar.ts, src/lib/calendar.ts) and its "On the team website" marker (src/lib/public-events.ts), and the
// shared answer cache. Everything runs against this file's database.
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
import * as eventsRoute from "@/app/api/public/events/route";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import { checkCalendarEventFields } from "@/lib/calendar";
import { CALENDAR_EVENT_KINDS } from "@/lib/constants";
import { addDays, dateOnlyToDb, type DateOnly } from "@/lib/dates";
import { PUBLIC_EVENTS_PATH } from "@/lib/public-api";
import { isPublicEventKind, PUBLIC_EVENT_KINDS, PUBLIC_EVENTS_MAX, type PublicEvents, publicEventStatus } from "@/lib/public-events";
import {
  DEFAULT_PUBLIC_PROGRESS_SETTINGS,
  PUBLIC_PROGRESS_KEY,
  type PublicProgressSettings,
  serializePublicProgressSettings,
  TEAM_SITE_ORIGIN,
} from "@/lib/public-progress";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import {
  cachedPublicAnswer,
  createPublicAnswerCache,
  PUBLIC_ANSWER_TTL_MS,
  PUBLIC_CACHE_CONTROL,
  PUBLIC_EVENTS_UNAVAILABLE,
  publicEventsResponse,
  publicJsonResponse,
} from "@/server/public-api";
import { getCalendarEvent } from "@/server/queries/calendar";
import { getPublicEvents, getPublicEventsWebsite } from "@/server/queries/public-events";
import { createCalendarEvent, updateCalendarEvent } from "@/server/services/calendar";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

// TEST_NOW is Thu 2026-09-24 in Anaheim. With no settings and no attendance schedule, the season starts Aug 31.

let t: TestDb;
let captain: Actor;
let leader: Actor;
const ids: Record<string, string> = {};

const SECRET_NOTES = "secret notes: gate code 4417, meet at Coach Kim's house";
const SECRET_SOURCE = "secret-source/key";

async function event(
  key: string,
  data: {
    title: string;
    kind: CalendarEventKind;
    startsOn: DateOnly;
    endsOn?: DateOnly;
    startTime?: string;
    endTime?: string;
    location?: string;
    link?: string;
    hideFromWebsite?: boolean;
    sourceKey?: string;
  },
) {
  const row = await t.db.calendarEvent.create({
    data: {
      title: data.title,
      kind: data.kind,
      startsOn: dateOnlyToDb(data.startsOn),
      endsOn: data.endsOn ? dateOnlyToDb(data.endsOn) : null,
      startTime: data.startTime ?? null,
      endTime: data.endTime ?? null,
      location: data.location ?? "",
      link: data.link ?? "",
      notes: SECRET_NOTES,
      hideFromWebsite: data.hideFromWebsite ?? false,
      sourceKey: data.sourceKey ?? null,
      createdById: captain.id,
      updatedById: leader.id,
    },
  });
  ids[key] = row.id;
  return row;
}

/** Saves the settings: the defaults with sponsors and events turned on (they're off until an admin turns them on), then `settings`. */
async function setSettings(settings: Partial<PublicProgressSettings>) {
  const body = serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showSponsors: true, showEvents: true, ...settings });
  await t.db.teamNote.upsert({ where: { key: PUBLIC_PROGRESS_KEY }, create: { key: PUBLIC_PROGRESS_KEY, body }, update: { body } });
}

async function answer(): Promise<PublicEvents> {
  const a = await getPublicEvents(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
  if (!a.enabled) throw new Error("expected events to be on");
  return a;
}

const titles = async () => (await answer()).events.map((e) => e.title);

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  captain = await makeUser(t.db, { name: "Jordan Captainperson", role: "CAPTAIN" });
  leader = await makeUser(t.db, { name: "Marcus Leaderperson", role: "BUILD_LEADER" });
  // The season schedule a migration loads (four scrimmages) isn't part of these tests.
  await t.db.calendarEvent.deleteMany();
  await setSettings({});

  await event("meet", {
    title: "League Meet 1",
    kind: "MEET",
    startsOn: "2026-10-10",
    startTime: "08:00",
    endTime: "16:00",
    location: "Anaheim High School Gym",
    link: "https://ftc-events.example.org/meet1",
    sourceKey: SECRET_SOURCE,
  });
  await event("ilt", { title: "League Tournament", kind: "ILT", startsOn: "2027-02-06", endsOn: "2027-02-07", startTime: "07:30", endTime: "17:00" });
  await event("scrimmage", { title: "League Scrimmage 0", kind: "SCRIMMAGE", startsOn: "2026-10-31", startTime: "07:00", endTime: "12:00" });
  await event("competition", { title: "SoCal Invitational", kind: "COMPETITION", startsOn: "2027-03-20" });
  // Same day: all day first, then by start time, then title.
  await event("outreachLate", { title: "Library demo", kind: "OUTREACH", startsOn: "2026-10-10", startTime: "15:00", link: "javascript:alert(1)" });
  await event("outreachAllDay", { title: "Zoo booth", kind: "OUTREACH", startsOn: "2026-10-10" });
  // This season, already past.
  await event("outreachPast", { title: "Farmers market booth", kind: "OUTREACH", startsOn: "2026-09-12", startTime: "09:00", endTime: "13:00" });
  // Started before the season starts, ends after: still listed.
  await event("straddle", { title: "Summer camp demos", kind: "OUTREACH", startsOn: "2026-08-29", endsOn: "2026-09-01" });
  // Never on the website.
  await event("before", { title: "Last season's showcase", kind: "OUTREACH", startsOn: "2026-08-20" });
  await event("hidden", { title: "Mentoring the FLL team", kind: "OUTREACH", startsOn: "2026-10-03", hideFromWebsite: true });
  await event("meeting", { title: "Extra build day", kind: "MEETING", startsOn: "2026-09-26" });
  await event("team", { title: "Team pizza night", kind: "TEAM", startsOn: "2026-10-02" });
  await event("deadline", { title: "Portfolio due", kind: "DEADLINE", startsOn: "2026-10-05" });
  await event("other", { title: "Something else", kind: "OTHER", startsOn: "2026-10-06" });
});
afterAll(async () => {
  await t.drop();
});

// ── The answer ────────────────────────────────────────────────────────────────

describe("the public events answer", () => {
  it("lists meets, the ILT, scrimmages, competitions, and outreach from the season's start, by date", async () => {
    const a = await answer();
    expect(a.updatedAt).toBe(TEST_NOW.toISOString());
    expect(a.timezone).toBe(TEST_TZ);
    expect(a.events.map((e) => e.title)).toEqual([
      "Summer camp demos",
      "Farmers market booth",
      "Zoo booth",
      "League Meet 1",
      "Library demo",
      "League Scrimmage 0",
      "League Tournament",
      "SoCal Invitational",
    ]);
    expect(a.events.find((e) => e.title === "League Meet 1")).toEqual({
      id: ids.meet,
      title: "League Meet 1",
      kind: "MEET",
      kindLabel: "League meet",
      startsOn: "2026-10-10",
      endsOn: null,
      startTime: "08:00",
      endTime: "16:00",
      location: "Anaheim High School Gym",
      link: "https://ftc-events.example.org/meet1",
    });
    expect(a.events.find((e) => e.title === "League Tournament")).toMatchObject({
      kind: "ILT",
      kindLabel: "League tournament (ILT)",
      startsOn: "2027-02-06",
      endsOn: "2027-02-07",
      startTime: "07:30",
      endTime: "17:00",
    });
    expect(a.events.find((e) => e.title === "SoCal Invitational")).toMatchObject({ startTime: null, endTime: null, location: "", link: null });
    // Only http(s) links.
    expect(a.events.find((e) => e.title === "Library demo")!.link).toBeNull();
  });

  it("never has team meetings, team events, deadlines, hidden events, notes, sourceKeys, or who added them", async () => {
    const a = await answer();
    const json = JSON.stringify(a);
    for (const secret of [
      SECRET_NOTES,
      "4417",
      SECRET_SOURCE,
      "Captainperson",
      "Leaderperson",
      captain.id,
      leader.id,
      "Extra build day",
      "MEETING",
      "Team pizza night",
      "Portfolio due",
      "Something else",
      "Mentoring the FLL team",
      "Last season's showcase",
      "@example.com",
    ]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(new Set(a.events.map((e) => e.kind))).toEqual(new Set(PUBLIC_EVENT_KINDS));
    const keys = new Set(a.events.flatMap((e) => Object.keys(e)));
    expect([...keys].sort()).toEqual(["endTime", "endsOn", "id", "kind", "kindLabel", "link", "location", "startTime", "startsOn", "title"]);
  });

  it("starts at the settings' day (else the attendance reports' start)", async () => {
    await setSettings({ since: "2026-10-01" });
    expect(await titles()).not.toContain("Farmers market booth");
    expect(await titles()).not.toContain("Summer camp demos");
    expect(await titles()).toContain("League Meet 1");
    expect(await getPublicEventsWebsite(t.db)).toEqual({ showEvents: true, since: "2026-10-01" });
    await setSettings({});
    expect(await titles()).toContain("Farmers market booth");
    expect((await getPublicEventsWebsite(t.db)).since).toBe("2026-08-31");
  });

  it("drops an event the moment it's hidden from the website, or turned into another kind", async () => {
    await t.db.calendarEvent.update({ where: { id: ids.scrimmage }, data: { hideFromWebsite: true } });
    expect(await titles()).not.toContain("League Scrimmage 0");
    await t.db.calendarEvent.update({ where: { id: ids.scrimmage }, data: { hideFromWebsite: false, kind: "MEETING" } });
    expect(await titles()).not.toContain("League Scrimmage 0");
    await t.db.calendarEvent.update({ where: { id: ids.scrimmage }, data: { kind: "SCRIMMAGE" } });
    expect(await titles()).toContain("League Scrimmage 0");
  });

  it("is off until someone with admin access turns it on (nothing saved yet: {enabled: false})", async () => {
    await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_KEY } });
    expect(await getPublicEvents(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).toEqual({ enabled: false });
    expect((await getPublicEventsWebsite(t.db)).showEvents).toBe(false);
    await setSettings({});
    expect((await getPublicEvents(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).enabled).toBe(true);
  });

  it("answers only {enabled: false} while the owner has events turned off (progress and sponsors stay as they are)", async () => {
    await setSettings({ showEvents: false });
    expect(await getPublicEvents(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).toEqual({ enabled: false });
    await setSettings({ enabled: false, showSponsors: false });
    expect((await getPublicEvents(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).enabled).toBe(true);
    await setSettings({});
  });

  it(`has at most ${PUBLIC_EVENTS_MAX}: the latest ones, so what's coming up is never cut`, async () => {
    const extra = Array.from({ length: PUBLIC_EVENTS_MAX }, (_, i) => ({
      title: `Bulk meet ${String(i).padStart(3, "0")}`,
      kind: "MEET" as const,
      startsOn: dateOnlyToDb(addDays("2026-11-01", Math.floor(i / 2))),
      createdById: captain.id,
    }));
    await t.db.calendarEvent.createMany({ data: extra });
    const a = await answer();
    expect(a.events).toHaveLength(PUBLIC_EVENTS_MAX);
    const list = a.events.map((e) => e.title);
    // The earliest ones went; the last of the season stayed; still in date order.
    expect(list).not.toContain("Summer camp demos");
    expect(list).toContain("SoCal Invitational");
    const days = a.events.map((e) => e.startsOn);
    expect([...days].sort()).toEqual(days);
    await t.db.calendarEvent.deleteMany({ where: { title: { startsWith: "Bulk meet" } } });
  });
});

// ── The calendar's side ───────────────────────────────────────────────────────

describe("Hide from the team website (Team calendar)", () => {
  const form = (over: Record<string, unknown> = {}) => ({
    title: "Robot demo",
    kind: "OUTREACH",
    startsOn: addDays(TEST_TODAY, 10),
    endsOn: "",
    startTime: "15:00",
    endTime: "17:00",
    location: "Library",
    link: "",
    notes: "",
    ...over,
  });

  it("is a checkbox on the event form (missing = off), saved with the event", async () => {
    expect(checkCalendarEventFields(form({ hideFromWebsite: "on" }), TEST_TODAY)).toMatchObject({ ok: true, value: { hideFromWebsite: true } });
    expect(checkCalendarEventFields(form(), TEST_TODAY)).toMatchObject({ ok: true, value: { hideFromWebsite: false } });

    const ctx = contextFor(t.db, leader);
    const { id } = await createCalendarEvent(ctx, form({ hideFromWebsite: "on" }));
    const created = (await getCalendarEvent(leader, id, t.db))!;
    expect(created.hideFromWebsite).toBe(true);
    expect(await titles()).not.toContain("Robot demo");
    await updateCalendarEvent(ctx, { ...form(), eventId: id, version: created.version });
    expect((await getCalendarEvent(leader, id, t.db))!.hideFromWebsite).toBe(false);
    expect(await titles()).toContain("Robot demo");
    await t.db.calendarEvent.delete({ where: { id } });
  });

  it("marks events On / Hidden from the team website only for the kinds it lists, while it's on, from the season's start", () => {
    const website = { showEvents: true, since: "2026-08-31" };
    const e = (kind: CalendarEventKind, hideFromWebsite = false, startsOn = "2026-10-10", endsOn: string | null = null) => ({ kind, hideFromWebsite, startsOn, endsOn });
    for (const kind of CALENDAR_EVENT_KINDS) {
      expect(publicEventStatus(e(kind), website), kind).toBe(isPublicEventKind(kind) ? "public" : null);
      expect(publicEventStatus(e(kind, true), website), kind).toBe(isPublicEventKind(kind) ? "hidden" : null);
    }
    expect(PUBLIC_EVENT_KINDS).toEqual(["MEET", "ILT", "SCRIMMAGE", "COMPETITION", "OUTREACH"]);
    expect(publicEventStatus(e("MEET"), { ...website, showEvents: false })).toBeNull();
    expect(publicEventStatus(e("MEET", false, "2026-08-20"), website)).toBeNull();
    expect(publicEventStatus(e("MEET", false, "2026-08-29", "2026-09-01"), website)).toBe("public");
  });
});

// ── HTTP and the shared helpers ───────────────────────────────────────────────

describe("GET /api/public/events", () => {
  const url = `https://communication-portal-iota.vercel.app${PUBLIC_EVENTS_PATH}`;
  const call = (init: RequestInit & { origin?: string } = {}, extraOrigins?: string) => {
    const headers = new Headers(init.headers);
    if (init.origin) headers.set("origin", init.origin);
    return publicEventsResponse(new Request(url, { ...init, headers }), { db: t.db, now: TEST_NOW, teamTimezone: TEST_TZ, extraOrigins });
  };

  it("lets the team website read it (CORS for it only), cached briefly and never sniffed", async () => {
    const res = await call({ origin: TEAM_SITE_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(((await res.json()) as PublicEvents).events.length).toBeGreaterThan(0);
    for (const origin of ["https://evil.example", "http://localhost:4410"]) {
      expect((await call({ origin })).headers.get("access-control-allow-origin"), origin).toBe(TEAM_SITE_ORIGIN);
    }
    expect((await call({ origin: "http://localhost:4410" }, "http://localhost:4410, *")).headers.get("access-control-allow-origin")).toBe(
      "http://localhost:4410",
    );
  });

  it("answers HEAD and the preflight, refuses other methods, and says {enabled: false} or a 503 when it must", async () => {
    expect((await call({ method: "HEAD" })).status).toBe(200);
    expect((await call({ method: "OPTIONS", origin: TEAM_SITE_ORIGIN })).status).toBe(204);
    expect((await call({ method: "DELETE" })).status).toBe(405);
    await setSettings({ showEvents: false });
    expect(await (await call({ origin: TEAM_SITE_ORIGIN })).json()).toEqual({ enabled: false });
    await setSettings({});
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { teamNote: { findMany: () => Promise.reject(new Error("database down")) } } as unknown as Db;
    const res = await publicEventsResponse(new Request(url), { db: broken, now: TEST_NOW, teamTimezone: TEST_TZ });
    quiet.mockRestore();
    expect([res.status, res.headers.get("cache-control"), await res.json()]).toEqual([503, "no-store", { error: PUBLIC_EVENTS_UNAVAILABLE }]);
  });

  it("is served by the route (GET, HEAD, OPTIONS) without signing in", async () => {
    const req = (method: string) => new NextRequest(url, { method, headers: { origin: TEAM_SITE_ORIGIN } });
    const res = await eventsRoute.GET(req("GET"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as PublicEvents).events.map((e) => e.title)).toContain("League Meet 1");
    expect((await eventsRoute.HEAD(req("HEAD"))).status).toBe(200);
    expect((await eventsRoute.OPTIONS(req("OPTIONS"))).status).toBe(204);
    expect(Object.keys(eventsRoute).sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
  });

  it("cachedPublicAnswer shares one build for 10 seconds and doesn't keep a failure", async () => {
    const cache = createPublicAnswerCache();
    let builds = 0;
    const build = () => Promise.resolve(`{"n":${++builds}}`);
    const t0 = TEST_NOW.getTime();
    const first = await Promise.all([1, 2, 3].map(() => cachedPublicAnswer(cache, TEST_NOW, build)));
    expect(first).toEqual(['{"n":1}', '{"n":1}', '{"n":1}']);
    expect(await cachedPublicAnswer(cache, new Date(t0 + PUBLIC_ANSWER_TTL_MS - 1), build)).toBe('{"n":1}');
    expect(await cachedPublicAnswer(cache, new Date(t0 + PUBLIC_ANSWER_TTL_MS), build)).toBe('{"n":2}');
    // A clock that went backwards builds again.
    expect(await cachedPublicAnswer(cache, new Date(t0 - 1), build)).toBe('{"n":3}');
    // Without a cache, every call builds.
    await cachedPublicAnswer(undefined, TEST_NOW, build);
    expect(builds).toBe(4);

    const failing = createPublicAnswerCache();
    await expect(cachedPublicAnswer(failing, TEST_NOW, () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cachedPublicAnswer(failing, TEST_NOW, () => Promise.resolve("ok"))).toBe("ok");

    // publicJsonResponse names the endpoint in the log and answers with the given message.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await publicJsonResponse(new Request(url), {
      now: TEST_NOW,
      build: () => Promise.reject(new Error("down")),
      unavailableMessage: "The workshop isn't available right now.",
      logTag: "public-workshop",
    });
    expect(quiet.mock.calls[0][0]).toBe("[public-workshop] couldn't build the answer");
    quiet.mockRestore();
    expect([res.status, await res.json()]).toEqual([503, { error: "The workshop isn't available right now." }]);
  });
});
