// The team website's live progress page: GET /api/public/progress (src/app/api/public/progress/route.ts, built by
// src/server/queries/public-progress.ts and src/server/public-api.ts), its settings (Admin → Approvals → Team
// website, services/public-progress.ts), each person's "Show me on the team website" switch (services/settings.ts),
// and the proxy letting /api/public/* through without a session. Everything runs against this file's database.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { NextRequest } from "next/server";
import { updatePublicProgressSettingsAction } from "@/app/(app)/admin/actions";
import { updatePublicProgressVisibilityAction } from "@/app/(app)/settings/actions";
import * as progressRoute from "@/app/api/public/progress/route";
import type { AssignmentStatus, Subteam } from "@/generated/prisma/enums";
import { initialActionState } from "@/lib/action-state";
import { ATTENDANCE_SETTINGS_KEY, DEFAULT_ATTENDANCE_SETTINGS, serializeAttendanceSettings } from "@/lib/attendance";
import { dateOnlyToDb, type DateOnly } from "@/lib/dates";
import {
  DEFAULT_PUBLIC_PROGRESS_SETTINGS,
  parseExtraOrigins,
  parsePublicProgressSettings,
  PUBLIC_PROGRESS_ID_SALT_KEY,
  PUBLIC_PROGRESS_KEY,
  publicName,
  publicRoleLabel,
  type PublicProgress,
  type PublicProgressSettings,
  serializePublicProgressSettings,
  TEAM_SITE_ORIGIN,
} from "@/lib/public-progress";
import { proxy } from "@/proxy";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/server/errors";
import { PUBLIC_CACHE_CONTROL, publicProgressResponse } from "@/server/public-api";
import { getPublicProgress, getPublicProgressAdminView, getPublicProgressConfig } from "@/server/queries/public-progress";
import { PUBLIC_PROGRESS_FORBIDDEN, updatePublicProgressSettings } from "@/server/services/public-progress";
import { getSettings, updatePublicProgressVisibility } from "@/server/services/settings";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TZ } from "./helpers/factories";

// TEST_NOW is Thu 2026-09-24, 12:00 in Anaheim: "the last 7 days" = Fri Sep 18 – Thu Sep 24, this week starts Mon
// Sep 21, and the 8 weeks start Mon Aug 3. Counting starts Mon Aug 31 (the attendance reports' default start).

let t: TestDb;
let captain: Actor;
let buildLead: Actor;
let ethan: Actor;
let hannah: Actor; // turned off "Show me on the team website"
let maya: Actor;
let ava: Actor;
let mentor: Actor;
let teacher: Actor;
let pending: Actor;
let disabled: Actor;
const taskIds: Record<string, string> = {};

const SECRET_REVIEW = "secret review note: redo the bolts";
const SECRET_SUBMISSION = "secret submission note: done at home";

type Item = [Actor, AssignmentStatus, string?, { finishedWithTask?: boolean }?];

async function task(key: string, title: string, subteam: Subteam | null, due: DateOnly, items: Item[], completedAt?: string) {
  const row = await t.db.task.create({
    data: {
      title,
      subteam,
      dueDate: dateOnlyToDb(due),
      createdById: captain.id,
      completedAt: completedAt ? new Date(completedAt) : null,
      completedById: completedAt ? captain.id : null,
      assignments: {
        create: items.map(([user, status, reviewedAt, extra]) => ({
          userId: user.id,
          status,
          submittedAt: status === "TODO" ? null : new Date("2026-09-01T17:00:00Z"),
          submissionNote: status === "TODO" ? null : SECRET_SUBMISSION,
          reviewedAt: reviewedAt ? new Date(reviewedAt) : null,
          reviewedById: reviewedAt ? captain.id : null,
          reviewNote: status === "REJECTED" || status === "APPROVED" ? SECRET_REVIEW : null,
          finishedWithTask: extra?.finishedWithTask ?? false,
          statusBeforeFinish: extra?.finishedWithTask ? "TODO" : null,
        })),
      },
    },
  });
  taskIds[key] = row.id;
}

async function setSettings(settings: Partial<PublicProgressSettings>) {
  const body = serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, ...settings });
  await t.db.teamNote.upsert({ where: { key: PUBLIC_PROGRESS_KEY }, create: { key: PUBLIC_PROGRESS_KEY, body }, update: { body } });
}

async function progress(): Promise<PublicProgress> {
  const answer = await getPublicProgress(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
  if (!answer.enabled) throw new Error("expected the page to be on");
  return answer;
}

const personNamed = (p: PublicProgress, name: string) => p.people.find((x) => x.name === name);

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  captain = await makeUser(t.db, { role: "CAPTAIN", isAdmin: true, name: "Jordan Lee", email: "jordan.secret@example.com" });
  buildLead = await makeUser(t.db, { role: "BUILD_LEADER", name: "Marcus Johnson", email: "marcus.secret@example.com" });
  ethan = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "  Ethan   Chen ", email: "ethan.secret@example.com" });
  hannah = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Hannah Hidden", email: "hannah.secret@example.com" });
  await t.db.user.update({ where: { id: hannah.id }, data: { hideFromPublicProgress: true } });
  maya = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Patel", email: "maya.secret@example.com" });
  ava = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS", name: "Ava Thompson", email: "ava.secret@example.com" });
  mentor = await makeUser(t.db, { role: "MENTOR", name: "Elena Mentor", email: "elena.secret@example.com" });
  teacher = await makeUser(t.db, { role: "TEACHER", name: "Tom Teacher", email: "tom.secret@example.com" });
  pending = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", status: "PENDING", name: "Pat Pending" });
  disabled = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE", status: "DISABLED", name: "Dan Disabled" });

  // Due before counting starts: never counted.
  await task("old", "Last season's robot", "BUILD", "2026-08-20", [[ethan, "APPROVED", "2026-08-21T19:00:00Z"]]);
  // All counted items approved (the mentor's open item and the pending account's approval don't count).
  // Ethan's approval is Sun Sep 20 23:30 in Anaheim (Mon Sep 21 in UTC): last week, but within the last 7 days.
  await task("intake", "Build the intake", "BUILD", "2026-09-10", [
    [buildLead, "APPROVED", "2026-09-23T18:00:00Z"],
    [ethan, "APPROVED", "2026-09-21T06:30:00Z"],
    [hannah, "APPROVED", "2026-09-22T17:00:00Z"],
    [mentor, "TODO"],
    [pending, "APPROVED", "2026-09-24T18:00:00Z"],
  ]);
  // Open (and overdue): to do, sent back, checked off.
  await task("drive", "Wire the drivetrain", "BUILD", "2026-09-20", [
    [ethan, "TODO"],
    [hannah, "REJECTED", "2026-09-19T17:00:00Z"],
    [buildLead, "SUBMITTED"],
  ]);
  // Due later: open. The teacher's and the disabled account's items don't count.
  await task("auto", "Code autonomous", "SOFTWARE", "2026-10-01", [
    [maya, "TODO"],
    [teacher, "TODO"],
    [disabled, "TODO"],
  ]);
  // Marked finished, counted for Ava; the captain's and Maya's items are closed (neither done nor open).
  await task(
    "letters",
    "Sponsor letters",
    null,
    "2026-09-15",
    [
      [ava, "APPROVED", "2026-09-23T20:00:00Z", { finishedWithTask: true }],
      [captain, "TODO"],
      [maya, "SUBMITTED"],
    ],
    "2026-09-23T20:00:00Z",
  );
  // Maya's approval is Thu Sep 17 23:00 in Anaheim: not in the last 7 days. The disabled account's never counts.
  await task("kickoff", "Kickoff notes", null, "2026-09-01", [
    [captain, "APPROVED", "2026-09-07T19:00:00Z"],
    [maya, "APPROVED", "2026-09-18T06:00:00Z"],
    [disabled, "APPROVED", "2026-09-24T12:00:00Z"],
  ]);
  // Only a mentor on it: not a counted task.
  await task("mentor", "Mentor paperwork", null, "2026-09-22", [[mentor, "APPROVED", "2026-09-24T10:00:00Z"]]);
  // Every item approved, never marked finished: finished. Marcus's approval is Fri Sep 18 01:00 in Anaheim.
  await task("arm", "Finish the arm", "BUILD", "2026-09-24", [
    [buildLead, "APPROVED", "2026-09-18T08:00:00Z"],
    [ethan, "APPROVED", "2026-09-24T18:59:00Z"],
  ]);
});

afterAll(async () => {
  await t?.drop();
});

beforeEach(async () => {
  holder.user = null;
  await t.db.teamNote.deleteMany({ where: { key: { in: [PUBLIC_PROGRESS_KEY, ATTENDANCE_SETTINGS_KEY] } } });
  await t.db.user.update({ where: { id: ethan.id }, data: { hideFromPublicProgress: false } });
  await t.db.user.update({ where: { id: hannah.id }, data: { hideFromPublicProgress: true } });
});

// ── The answer ────────────────────────────────────────────────────────────────

describe("the public progress answer", () => {
  it("has the agreed shape, with team, subteam, and per-person numbers", async () => {
    const p = await progress();
    expect(Object.keys(p)).toEqual(["enabled", "team", "since", "updatedAt", "totals", "subteams", "people", "recent", "weekly"]);
    expect(p.team).toEqual({ name: "The Huskyteers", number: 19516 });
    expect(p.since).toBe("2026-08-31");
    expect(p.updatedAt).toBe(TEST_NOW.toISOString());

    // 6 people count (Hannah too); 8 done, 4 open; tasks: intake, kickoff, letters, arm finished; drive, auto active.
    expect(p.totals).toEqual({
      itemsDone: 8,
      itemsOpen: 4,
      completion: 67,
      doneLast7Days: 6,
      tasksFinished: 4,
      tasksActive: 2,
      people: 6,
    });
    expect(p.subteams).toEqual([
      { key: "SOFTWARE", name: "Software", itemsDone: 1, itemsOpen: 1, completion: 50, doneLast7Days: 0, tasksActive: 1, people: 1 },
      { key: "BUILD", name: "Build", itemsDone: 5, itemsOpen: 3, completion: 63, doneLast7Days: 5, tasksActive: 1, people: 3 },
      { key: "BUSINESS", name: "Business", itemsDone: 1, itemsOpen: 0, completion: 100, doneLast7Days: 1, tasksActive: 0, people: 1 },
    ]);

    // Grouped by subteam (Software, Build, Business, then no subteam), by name — not ranked.
    expect(p.people.map((x) => [x.name, x.subteam, x.role])).toEqual([
      ["Maya Patel", "SOFTWARE", "Software Team"],
      ["Ethan Chen", "BUILD", "Build Team"],
      ["Marcus Johnson", "BUILD", "Build Lead"],
      ["Ava Thompson", "BUSINESS", "Business Team"],
      ["Jordan Lee", null, "Captain"],
    ]);
    const { id: _id, ...ethanRow } = personNamed(p, "Ethan Chen")!;
    void _id;
    expect(ethanRow).toEqual({
      name: "Ethan Chen",
      subteam: "BUILD",
      role: "Build Team",
      itemsDone: 2,
      itemsOpen: 1,
      completion: 67,
      doneLast7Days: 2,
      lastDoneAt: "2026-09-24T18:59:00.000Z",
    });
    expect(personNamed(p, "Marcus Johnson")).toMatchObject({ itemsDone: 2, itemsOpen: 1, doneLast7Days: 2, lastDoneAt: "2026-09-23T18:00:00.000Z" });
    expect(personNamed(p, "Maya Patel")).toMatchObject({ itemsDone: 1, itemsOpen: 1, completion: 50, doneLast7Days: 0, lastDoneAt: "2026-09-18T06:00:00.000Z" });
    expect(personNamed(p, "Ava Thompson")).toMatchObject({ itemsDone: 1, itemsOpen: 0, completion: 100, doneLast7Days: 1 });
    // The captain's closed item counts as neither.
    expect(personNamed(p, "Jordan Lee")).toMatchObject({ itemsDone: 1, itemsOpen: 0, completion: 100, doneLast7Days: 0 });
  });

  it("buckets approvals into the last 8 Monday–Sunday weeks of the team's timezone", async () => {
    const p = await progress();
    expect(p.weekly).toEqual([
      { weekStart: "2026-08-03", itemsDone: 0 },
      { weekStart: "2026-08-10", itemsDone: 0 },
      { weekStart: "2026-08-17", itemsDone: 0 },
      { weekStart: "2026-08-24", itemsDone: 0 },
      { weekStart: "2026-08-31", itemsDone: 0 },
      { weekStart: "2026-09-07", itemsDone: 1 },
      // Marcus (Fri), Ethan (Sun 23:30 in Anaheim — Monday in UTC), Maya (Thu 23:00 in Anaheim — Friday in UTC).
      { weekStart: "2026-09-14", itemsDone: 3 },
      { weekStart: "2026-09-21", itemsDone: 4 },
    ]);
    // In another timezone the same approvals land elsewhere.
    const utc = await getPublicProgress(t.db, { now: TEST_NOW, teamTimezone: "UTC" });
    if (!utc.enabled) throw new Error("expected on");
    expect(utc.weekly.slice(-2)).toEqual([
      { weekStart: "2026-09-14", itemsDone: 2 },
      { weekStart: "2026-09-21", itemsDone: 5 },
    ]);
  });

  it("lists recent approvals newest first, without whole-task credit, and never names a hidden person", async () => {
    const p = await progress();
    expect(p.recent).toEqual([
      { title: "Finish the arm", subteam: "BUILD", who: "Ethan Chen", at: "2026-09-24T18:59:00.000Z" },
      { title: "Build the intake", subteam: "BUILD", who: "Marcus Johnson", at: "2026-09-23T18:00:00.000Z" },
      { title: "Build the intake", subteam: "BUILD", who: null, at: "2026-09-22T17:00:00.000Z" },
      { title: "Build the intake", subteam: "BUILD", who: "Ethan Chen", at: "2026-09-21T06:30:00.000Z" },
      { title: "Finish the arm", subteam: "BUILD", who: "Marcus Johnson", at: "2026-09-18T08:00:00.000Z" },
      { title: "Kickoff notes", subteam: "SOFTWARE", who: "Maya Patel", at: "2026-09-18T06:00:00.000Z" },
      { title: "Kickoff notes", subteam: null, who: "Jordan Lee", at: "2026-09-07T19:00:00.000Z" },
    ]);
  });

  it("never includes emails, notes, due dates, overdue info, ids, or anyone it shouldn't", async () => {
    const json = JSON.stringify(await progress());
    const users = await t.db.user.findMany({ select: { id: true, email: true } });
    for (const u of users) {
      expect(json).not.toContain(u.email);
      expect(json).not.toContain(u.id);
    }
    for (const id of Object.values(taskIds)) expect(json).not.toContain(id);
    for (const text of [SECRET_REVIEW, SECRET_SUBMISSION, "secret", "@", "overdue", "late", "dueDate", "2026-09-20", "2026-10-01"]) {
      expect(json.toLowerCase()).not.toContain(text.toLowerCase());
    }
    // Mentors, teachers, sign-ups waiting for approval, disabled accounts, and the person who hid themselves.
    for (const name of ["Elena", "Tom Teacher", "Pat Pending", "Dan Disabled", "Hannah"]) expect(json).not.toContain(name);
    // Their tasks don't show up either (the mentor-only task, last season's).
    expect(json).not.toContain("Mentor paperwork");
    expect(json).not.toContain("Last season");
  });

  it("leaves a hidden person off the list but counts them in the totals", async () => {
    const p = await progress();
    expect(p.people).toHaveLength(5);
    expect(p.totals.people).toBe(6);
    expect(p.subteams.find((s) => s.key === "BUILD")).toMatchObject({ people: 3, itemsDone: 5, itemsOpen: 3 });
    // Ethan hides too: one fewer listed, nothing else changes.
    await t.db.user.update({ where: { id: ethan.id }, data: { hideFromPublicProgress: true } });
    const after = await progress();
    expect(after.people.map((x) => x.name)).not.toContain("Ethan Chen");
    expect(after.totals).toEqual(p.totals);
    expect(after.subteams).toEqual(p.subteams);
    expect(after.recent.filter((r) => r.who === "Ethan Chen")).toEqual([]);
    expect(after.recent.filter((r) => r.who === null)).toHaveLength(3);
  });

  it("gives every person an opaque, stable id that isn't their account id", async () => {
    const first = await progress();
    const second = await progress();
    const ids = first.people.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const accountIds = (await t.db.user.findMany({ select: { id: true } })).map((u) => u.id);
    for (const id of ids) expect(accountIds).not.toContain(id);
    expect(second.people.map((x) => x.id)).toEqual(ids);
    // Made from one random salt, saved once.
    const salt = await t.db.teamNote.findUniqueOrThrow({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } });
    expect(salt.body.length).toBeGreaterThanOrEqual(32);
    // A new salt (deleted, or too short to be one) gives new ids.
    await t.db.teamNote.update({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY }, data: { body: "short" } });
    const renewed = await progress();
    expect(renewed.people.map((x) => x.id)).not.toEqual(ids);
    expect((await progress()).people.map((x) => x.id)).toEqual(renewed.people.map((x) => x.id));
  });

  it("shows names the way the settings say", async () => {
    await setSettings({ nameStyle: "first-initial" });
    let p = await progress();
    expect(p.people.map((x) => x.name)).toEqual(["Maya P.", "Ethan C.", "Marcus J.", "Ava T.", "Jordan L."]);
    expect(p.recent[0].who).toBe("Ethan C.");

    await setSettings({ nameStyle: "initials" });
    p = await progress();
    expect(p.people.map((x) => x.name)).toEqual(["M.P.", "E.C.", "M.J.", "A.T.", "J.L."]);
    expect(p.recent[0].who).toBe("E.C.");

    await setSettings({ nameStyle: "hidden" });
    p = await progress();
    expect(p.people).toEqual([]);
    expect(p.recent.every((r) => r.who === null)).toBe(true);
    expect(p.totals.people).toBe(6);
    expect(p.totals.itemsDone).toBe(8);
    const json = JSON.stringify(p);
    for (const name of ["Maya", "Ethan", "Marcus", "Ava", "Jordan"]) expect(json).not.toContain(name);
  });

  it("leaves task titles out when they're turned off", async () => {
    await setSettings({ showTaskTitles: false });
    const p = await progress();
    expect(p.recent).toHaveLength(7);
    expect(p.recent.every((r) => r.title === null)).toBe(true);
    const json = JSON.stringify(p);
    for (const title of ["Finish the arm", "Build the intake", "Kickoff notes", "Wire the drivetrain", "Sponsor letters"]) {
      expect(json).not.toContain(title);
    }
  });

  it("answers only {enabled: false} while the page is turned off", async () => {
    await setSettings({ enabled: false });
    expect(await getPublicProgress(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).toEqual({ enabled: false });
  });

  it("counts tasks due on or after `since` (the setting, else the attendance reports' start)", async () => {
    await setSettings({ since: "2026-09-15" });
    let p = await progress();
    expect(p.since).toBe("2026-09-15");
    // Left: drive, auto, letters, arm (intake and kickoff are due earlier).
    expect(p.totals).toMatchObject({ itemsDone: 3, itemsOpen: 4, tasksFinished: 2, tasksActive: 2, people: 6 });
    expect(personNamed(p, "Jordan Lee")).toMatchObject({ itemsDone: 0, itemsOpen: 0, completion: 0, lastDoneAt: null });
    expect(p.recent.map((r) => r.title)).toEqual(["Finish the arm", "Finish the arm"]);
    expect(p.weekly.reduce((n, w) => n + w.itemsDone, 0)).toBe(3);

    // No date set: the attendance reports' start.
    await setSettings({ since: null });
    const body = serializeAttendanceSettings({ ...DEFAULT_ATTENDANCE_SETTINGS, reportStart: "2026-09-07" });
    await t.db.teamNote.create({ data: { key: ATTENDANCE_SETTINGS_KEY, body } });
    p = await progress();
    expect(p.since).toBe("2026-09-07");
    expect(personNamed(p, "Jordan Lee")).toMatchObject({ itemsDone: 0 }); // kickoff is due Sep 1
    expect(p.totals.itemsDone).toBe(6);
  });

  it("reads broken settings with defaults", () => {
    expect(parsePublicProgressSettings("not json")).toEqual(DEFAULT_PUBLIC_PROGRESS_SETTINGS);
    expect(parsePublicProgressSettings("[1,2]")).toEqual(DEFAULT_PUBLIC_PROGRESS_SETTINGS);
    expect(parsePublicProgressSettings('{"enabled":"no","nameStyle":"nicknames","showTaskTitles":0,"since":"2026-02-30"}')).toEqual(
      DEFAULT_PUBLIC_PROGRESS_SETTINGS,
    );
    expect(parsePublicProgressSettings('{"enabled":false,"nameStyle":"initials","showTaskTitles":false,"since":"2026-09-01"}')).toEqual({
      enabled: false,
      nameStyle: "initials",
      showTaskTitles: false,
      since: "2026-09-01",
    });
  });

  it("writes names and positions in the team website's words", () => {
    expect(publicName("  Ethan   Chen ", "full")).toBe("Ethan Chen");
    expect(publicName("Mary Ann Lee", "first-initial")).toBe("Mary L.");
    expect(publicName("Prince", "first-initial")).toBe("Prince");
    expect(publicName("élodie zhang", "initials")).toBe("É.Z.");
    expect(publicName("Prince", "initials")).toBe("P.");
    expect(publicName("Ethan Chen", "hidden")).toBeNull();
    expect(publicRoleLabel("CAPTAIN", null)).toBe("Captain");
    expect(publicRoleLabel("SOFTWARE_LEADER", "SOFTWARE")).toBe("Software Lead");
    expect(publicRoleLabel("BUSINESS_LEADER", "BUSINESS")).toBe("Business Lead");
    expect(publicRoleLabel("MEMBER", "BUILD")).toBe("Build Team");
    expect(publicRoleLabel("MEMBER", null)).toBe("Team Member");
  });
});

describe("the recent list", () => {
  let small: TestDb;
  afterAll(async () => {
    await small?.drop();
  });

  it("keeps the newest 15 and is fine with an empty team", async () => {
    small = await createTestDb();
    const empty = await getPublicProgress(small.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
    expect(empty).toMatchObject({
      enabled: true,
      totals: { itemsDone: 0, itemsOpen: 0, completion: 0, doneLast7Days: 0, tasksFinished: 0, tasksActive: 0, people: 0 },
      people: [],
      recent: [],
    });
    if (!empty.enabled) return;
    expect(empty.weekly).toHaveLength(8);
    expect(empty.subteams.map((s) => s.key)).toEqual(["SOFTWARE", "BUILD", "BUSINESS"]);

    const lead = await makeUser(small.db, { role: "BUILD_LEADER", name: "Lead One" });
    for (let i = 0; i < 20; i++) {
      await small.db.task.create({
        data: {
          title: `Part ${String(i).padStart(2, "0")}`,
          subteam: "BUILD",
          dueDate: dateOnlyToDb("2026-09-10"),
          createdById: lead.id,
          assignments: {
            create: [{ userId: lead.id, status: "APPROVED", reviewedAt: new Date(Date.UTC(2026, 8, 1, 12, i)) }],
          },
        },
      });
    }
    const p = await getPublicProgress(small.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
    if (!p.enabled) throw new Error("expected on");
    expect(p.recent).toHaveLength(15);
    expect(p.recent[0].title).toBe("Part 19");
    expect(p.recent[14].title).toBe("Part 05");
    expect(p.totals).toMatchObject({ itemsDone: 20, tasksFinished: 20, tasksActive: 0, people: 1 });
  });
});

// ── The endpoint ──────────────────────────────────────────────────────────────

describe("GET /api/public/progress", () => {
  const url = "https://communication-portal-iota.vercel.app/api/public/progress";
  const call = (init: RequestInit & { origin?: string } = {}, extraOrigins?: string) => {
    const headers = new Headers(init.headers);
    if (init.origin) headers.set("origin", init.origin);
    return publicProgressResponse(new Request(url, { ...init, headers }), { db: t.db, now: TEST_NOW, teamTimezone: TEST_TZ, extraOrigins });
  };

  it("lets the team website read it, cached briefly and never sniffed", async () => {
    const res = await call({ origin: TEAM_SITE_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://huskyteers19516.github.io");
    expect(res.headers.get("vary")).toBe("Origin");
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=15, stale-while-revalidate=45");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const body = (await res.json()) as PublicProgress;
    expect(body.enabled).toBe(true);
    expect(body.totals.itemsDone).toBe(8);
  });

  it("never names another site (or *) as allowed; extra origins come from the setting", async () => {
    for (const origin of ["https://evil.example", "http://localhost:4321", "null", "https://huskyteers19516.github.io.evil.example"]) {
      const res = await call({ origin });
      expect(res.headers.get("access-control-allow-origin"), origin).toBe(TEAM_SITE_ORIGIN);
    }
    expect((await call({})).headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    const extra = "http://localhost:4321, *, not a url, https://preview.example.org/path, https://preview.example.org";
    expect(parseExtraOrigins(extra)).toEqual(["http://localhost:4321", "https://preview.example.org"]);
    expect((await call({ origin: "http://localhost:4321" }, extra)).headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    expect((await call({ origin: "https://evil.example" }, "*")).headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
  });

  it("answers HEAD and the CORS preflight, and nothing else", async () => {
    const head = await call({ method: "HEAD", origin: TEAM_SITE_ORIGIN });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe(PUBLIC_CACHE_CONTROL);

    const preflight = await call({ method: "OPTIONS", origin: TEAM_SITE_ORIGIN });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(preflight.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);

    const post = await call({ method: "POST", origin: TEAM_SITE_ORIGIN, body: "{}" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("says {enabled: false} when turned off", async () => {
    await setSettings({ enabled: false });
    const res = await call({ origin: TEAM_SITE_ORIGIN });
    expect(await res.json()).toEqual({ enabled: false });
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
  });

  it("answers a 503 that isn't cached when the database fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { teamNote: { findMany: () => Promise.reject(new Error("database down")) } } as unknown as Db;
    const res = await publicProgressResponse(new Request(url, { headers: { origin: TEAM_SITE_ORIGIN } }), {
      db: broken,
      now: TEST_NOW,
      teamTimezone: TEST_TZ,
    });
    quiet.mockRestore();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(((await res.json()) as { error: string }).error).toMatch(/isn't available/);
  });

  it("is served by the route (GET, HEAD, OPTIONS) without signing in", async () => {
    holder.user = null;
    const req = (method: string) => new NextRequest(url, { method, headers: { origin: TEAM_SITE_ORIGIN } });
    const res = await progressRoute.GET(req("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    const body = (await res.json()) as PublicProgress;
    expect(body.enabled).toBe(true);
    expect(body.people.map((x) => x.name)).toContain("Maya Patel");
    expect((await progressRoute.HEAD(req("HEAD"))).status).toBe(200);
    expect((await progressRoute.OPTIONS(req("OPTIONS"))).status).toBe(204);
    expect(Object.keys(progressRoute).sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
  });

  it("gets through the proxy without a session (the rest of the API still needs one)", async () => {
    const visit = (path: string) => proxy(new NextRequest(`https://communication-portal-iota.vercel.app${path}`));
    expect(visit("/api/public/progress").headers.get("x-middleware-next")).toBe("1");
    expect(visit("/api/public/progress?x=1").headers.get("x-middleware-next")).toBe("1");
    expect(visit("/api/planner/session").status).toBe(401);
    expect(visit("/api/publicity").status).toBe(401);
    expect(visit("/api/public").status).toBe(401);
  });
});

// ── Settings (Admin → Approvals → Team website) ──────────────────────────────

describe("the page's settings", () => {
  const save = (actor: Actor, raw: Record<string, unknown>) => updatePublicProgressSettings(contextFor(t.db, actor), raw);

  it("are changed by everyone with admin access", async () => {
    expect(await save(buildLead, { enabled: "on", nameStyle: "initials", since: "2026-09-01" })).toEqual({
      enabled: true,
      nameStyle: "initials",
      showTaskTitles: false,
      since: "2026-09-01",
    });
    expect((await getPublicProgressConfig(t.db)).settings).toMatchObject({ nameStyle: "initials", showTaskTitles: false });
    const note = await t.db.teamNote.findUniqueOrThrow({ where: { key: PUBLIC_PROGRESS_KEY } });
    expect(note.updatedById).toBe(buildLead.id);

    // Unchecked boxes = off; an empty date = back to the attendance reports' start.
    await save(mentor, { nameStyle: "full", showTaskTitles: "on", since: "" });
    const config = await getPublicProgressConfig(t.db);
    expect(config.settings).toEqual({ enabled: false, nameStyle: "full", showTaskTitles: true, since: null });
    expect(config.since).toBe("2026-08-31");
    expect(await getPublicProgress(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).toEqual({ enabled: false });
    await save(captain, { enabled: "on", nameStyle: "full", showTaskTitles: "on" });
    expect((await progress()).people).toHaveLength(5);
  });

  it("are refused to members and accounts that aren't active", async () => {
    await expect(save(ethan, { enabled: "", nameStyle: "hidden" })).rejects.toThrow(ForbiddenError);
    await expect(save(ethan, { enabled: "", nameStyle: "hidden" })).rejects.toThrow(PUBLIC_PROGRESS_FORBIDDEN);
    const pendingLeader = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });
    await expect(save(pendingLeader, { enabled: "", nameStyle: "hidden" })).rejects.toThrow(ForbiddenError);
    expect(await t.db.teamNote.findUnique({ where: { key: PUBLIC_PROGRESS_KEY } })).toBeNull();
    expect((await progress()).people).toHaveLength(5);
  });

  it("check what's sent", async () => {
    const fieldErrors = async (raw: Record<string, unknown>) => {
      try {
        await save(captain, raw);
      } catch (e) {
        if (e instanceof ValidationError) return e.fieldErrors;
        throw e;
      }
      throw new Error("expected a ValidationError");
    };
    expect(await fieldErrors({ nameStyle: "nicknames" })).toHaveProperty("nameStyle");
    expect(await fieldErrors({ nameStyle: "full", since: "2026-02-30" })).toHaveProperty("since");
    expect(await fieldErrors({ nameStyle: "full", since: "2019-01-01" })).toHaveProperty("since");
    expect(await fieldErrors({ nameStyle: "full", since: "2028-01-01" })).toHaveProperty("since");
    expect(await t.db.teamNote.findUnique({ where: { key: PUBLIC_PROGRESS_KEY } })).toBeNull();
  });

  it("are shown on the admin card only to people with admin access, with how many people hid themselves", async () => {
    expect(await getPublicProgressAdminView(ethan, t.db)).toBeNull();
    expect(await getPublicProgressAdminView(pending, t.db)).toBeNull();
    expect(await getPublicProgressAdminView(buildLead, t.db)).toEqual({
      settings: DEFAULT_PUBLIC_PROGRESS_SETTINGS,
      defaultSince: "2026-08-31",
      since: "2026-08-31",
      hiddenPeople: 1,
    });
  });

  it("are saved by the admin page's action", async () => {
    holder.user = await t.db.user.findUniqueOrThrow({ where: { id: buildLead.id } });
    const form = new FormData();
    form.set("nameStyle", "first-initial");
    form.set("showTaskTitles", "on");
    const state = await updatePublicProgressSettingsAction(initialActionState, form);
    expect(state).toMatchObject({ ok: true, message: expect.stringMatching(/private/) });
    expect((await getPublicProgressConfig(t.db)).settings).toMatchObject({ enabled: false, nameStyle: "first-initial" });

    holder.user = await t.db.user.findUniqueOrThrow({ where: { id: ethan.id } });
    expect(await updatePublicProgressSettingsAction(initialActionState, form)).toMatchObject({ ok: false, message: PUBLIC_PROGRESS_FORBIDDEN });
  });
});

// ── Each person's switch (Settings → Team website) ───────────────────────────

describe("Show me on the team website", () => {
  it("leaves only yourself off the list, and back on", async () => {
    const ctx = contextFor(t.db, ethan);
    expect((await getSettings(t.db, ethan, { currentSessionTokenHash: null, now: TEST_NOW }))?.showOnPublicProgress).toBe(true);

    // Unchecked (missing) = off. Ids in the form are ignored: it's always your own account.
    expect(await updatePublicProgressVisibility(ctx, { userId: maya.id })).toEqual({ show: false });
    expect((await getSettings(t.db, ethan, { currentSessionTokenHash: null, now: TEST_NOW }))?.showOnPublicProgress).toBe(false);
    expect((await t.db.user.findUniqueOrThrow({ where: { id: maya.id } })).hideFromPublicProgress).toBe(false);
    let p = await progress();
    expect(p.people.map((x) => x.name)).toEqual(["Maya Patel", "Marcus Johnson", "Ava Thompson", "Jordan Lee"]);
    expect(p.totals.itemsDone).toBe(8);

    expect(await updatePublicProgressVisibility(ctx, { show: "on" })).toEqual({ show: true });
    p = await progress();
    expect(p.people.map((x) => x.name)).toContain("Ethan Chen");
  });

  it("is refused to accounts that aren't active", async () => {
    await expect(updatePublicProgressVisibility(contextFor(t.db, pending), { show: "" })).rejects.toThrow(UnauthorizedError);
    expect((await t.db.user.findUniqueOrThrow({ where: { id: pending.id } })).hideFromPublicProgress).toBe(false);
  });

  it("is saved by the Settings page's action", async () => {
    holder.user = await t.db.user.findUniqueOrThrow({ where: { id: maya.id } });
    const state = await updatePublicProgressVisibilityAction(initialActionState, new FormData());
    expect(state).toMatchObject({ ok: true, message: "You're no longer listed on the team website." });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: maya.id } })).hideFromPublicProgress).toBe(true);
    const on = new FormData();
    on.set("show", "on");
    expect(await updatePublicProgressVisibilityAction(initialActionState, on)).toMatchObject({ ok: true, message: "You're shown on the team website." });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: maya.id } })).hideFromPublicProgress).toBe(false);
  });
});
