// The team website's live progress page: GET /api/public/progress (src/app/api/public/progress/route.ts, built by
// src/server/queries/public-progress.ts and src/server/public-api.ts), its settings (Admin → Approvals → Team
// website, services/public-progress.ts), each person's "Show me on the team website" switch (services/settings.ts),
// and the proxy letting /api/public/* through without a session. Everything runs against this file's database.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
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
import * as personRoute from "@/app/api/public/progress/people/[id]/route";
import * as progressRoute from "@/app/api/public/progress/route";
import type { AssignmentStatus, Subteam } from "@/generated/prisma/enums";
import { initialActionState } from "@/lib/action-state";
import { ATTENDANCE_SETTINGS_KEY, DEFAULT_ATTENDANCE_SETTINGS, serializeAttendanceSettings } from "@/lib/attendance";
import { dateOnlyToDb, type DateOnly } from "@/lib/dates";
import {
  isPublicApiPath,
  PUBLIC_API_FILE_PREFIXES,
  PUBLIC_API_ID_RE,
  PUBLIC_PROGRESS_PEOPLE_PREFIX,
  PUBLIC_SPONSOR_LOGOS_PREFIX,
} from "@/lib/public-api";
import {
  DEFAULT_PUBLIC_PROGRESS_SETTINGS,
  PUBLIC_API_PATHS,
  parseExtraOrigins,
  parsePublicProgressSettings,
  PUBLIC_PROGRESS_ID_SALT_KEY,
  PUBLIC_PROGRESS_KEY,
  PUBLIC_PERSON_DONE_MAX,
  PUBLIC_PERSON_ID_RE,
  publicName,
  publicRoleLabel,
  type PublicPersonProgress,
  type PublicProgress,
  type PublicProgressSettings,
  serializePublicProgressSettings,
  TEAM_SITE_ORIGIN,
} from "@/lib/public-progress";
import { proxy } from "@/proxy";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/server/errors";
import {
  cachedPublicAnswerByKey,
  cachedPublicValue,
  createPublicAnswerCache,
  createPublicAnswerCacheMap,
  createPublicValueCache,
  PUBLIC_ANSWER_TTL_MS,
  PUBLIC_CACHE_CONTROL,
  PUBLIC_PERSON_CACHE_MAX,
  PUBLIC_PERSON_NOT_FOUND,
  type PublicPersonDeps,
  publicPersonProgressResponse,
  publicProgressResponse,
} from "@/server/public-api";
import {
  firstPublicWeek,
  getPublicPeopleDirectory,
  getPublicPersonProgress,
  getPublicProgress,
  getPublicProgressAdminView,
  getPublicProgressConfig,
  type PublicPeopleDirectory,
  publicPersonId,
  publicTime,
} from "@/server/queries/public-progress";
import { PUBLIC_PROGRESS_FORBIDDEN, updatePublicProgressSettings } from "@/server/services/public-progress";
import { getSettings, updatePublicProgressVisibility } from "@/server/services/settings";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TZ } from "./helpers/factories";

// TEST_NOW is Thu 2026-09-24, 12:00 in Anaheim: "the last 7 days" = Fri Sep 18 – Thu Sep 24, this week starts Mon
// Sep 21. Counting starts Mon Aug 31 (the attendance reports' default start), so `weekly` is the 4 weeks from Aug 31.
// Hannah left herself off the list and is the only one hidden in Build: she's left out of every number (otherwise
// Build's totals minus the listed Build people would be exactly hers).

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

/**
 * `db` that records the queries made through it: how many ran at once (at most), and the writes. Prisma's model
 * methods and $queryRaw only; enough for getPublicProgress.
 */
function tracked(db: Db) {
  const stats = { calls: [] as string[], inflight: 0, maxInflight: 0, writes: [] as string[] };
  const track = (name: string, query: PromiseLike<unknown>) => {
    stats.calls.push(name);
    stats.inflight += 1;
    stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
    return Promise.resolve(query).finally(() => {
      stats.inflight -= 1;
    });
  };
  const delegate = (model: string, target: object) =>
    new Proxy(target, {
      get(obj, key) {
        const value = Reflect.get(obj, key) as unknown;
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const name = `${model}.${String(key)}`;
          if (/^(create|update|upsert|delete)/.test(String(key))) stats.writes.push(name);
          return track(name, (value as (...a: unknown[]) => PromiseLike<unknown>).apply(obj, args));
        };
      },
    });
  const wrapped = new Proxy(db, {
    get(obj, key) {
      const value = Reflect.get(obj, key) as unknown;
      if (key === "$queryRaw") {
        return (...args: unknown[]) => track("$queryRaw", (value as (...a: unknown[]) => PromiseLike<unknown>).apply(obj, args));
      }
      if (typeof key === "string" && !key.startsWith("$") && value && typeof value === "object") return delegate(key, value);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    },
  });
  return { db: wrapped as Db, stats };
}

/** Sums of the listed people's numbers (what a visitor can add up from the page). */
function listedSum(people: PublicProgress["people"]) {
  return people.reduce(
    (a, x) => ({
      itemsDone: a.itemsDone + x.itemsDone,
      itemsOpen: a.itemsOpen + x.itemsOpen,
      itemsSubmitted: a.itemsSubmitted + x.itemsSubmitted,
      doneLast7Days: a.doneLast7Days + x.doneLast7Days,
    }),
    { itemsDone: 0, itemsOpen: 0, itemsSubmitted: 0, doneLast7Days: 0 },
  );
}

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
  await t.db.user.update({ where: { id: captain.id }, data: { hideFromPublicProgress: false } });
});

// ── The answer ────────────────────────────────────────────────────────────────

describe("the public progress answer", () => {
  it("has the agreed shape, with team, subteam, and per-person numbers", async () => {
    const p = await progress();
    expect(Object.keys(p)).toEqual(["enabled", "team", "since", "updatedAt", "totals", "subteams", "people", "recent", "weekly"]);
    expect(p.team).toEqual({ name: "The Huskyteers", number: 19516 });
    expect(p.since).toBe("2026-08-31");
    expect(p.updatedAt).toBe(TEST_NOW.toISOString());

    // 5 people count (not Hannah, the only one hidden in Build); 7 done, 3 open (Marcus's checked off, waiting for
    // review); tasks: intake, kickoff, letters, arm finished; drive, auto active.
    expect(p.totals).toEqual({
      itemsDone: 7,
      itemsOpen: 3,
      itemsSubmitted: 1,
      completion: 70,
      doneLast7Days: 5,
      tasksFinished: 4,
      tasksActive: 2,
      people: 5,
    });
    expect(p.subteams).toEqual([
      { key: "SOFTWARE", name: "Software", itemsDone: 1, itemsOpen: 1, itemsSubmitted: 0, completion: 50, doneLast7Days: 0, tasksActive: 1, people: 1 },
      { key: "BUILD", name: "Build", itemsDone: 4, itemsOpen: 2, itemsSubmitted: 1, completion: 67, doneLast7Days: 4, tasksActive: 1, people: 2 },
      { key: "BUSINESS", name: "Business", itemsDone: 1, itemsOpen: 0, itemsSubmitted: 0, completion: 100, doneLast7Days: 1, tasksActive: 0, people: 1 },
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
      itemsSubmitted: 0,
      completion: 67,
      doneLast7Days: 2,
      lastDoneAt: "2026-09-24T18:59:00.000Z",
    });
    expect(personNamed(p, "Marcus Johnson")).toMatchObject({
      itemsDone: 2,
      itemsOpen: 1,
      itemsSubmitted: 1,
      doneLast7Days: 2,
      lastDoneAt: "2026-09-23T18:00:00.000Z",
    });
    // Maya's checked-off item is on a finished task: closed, so not waiting for review either.
    expect(personNamed(p, "Maya Patel")).toMatchObject({
      itemsDone: 1,
      itemsOpen: 1,
      itemsSubmitted: 0,
      completion: 50,
      doneLast7Days: 0,
      lastDoneAt: "2026-09-18T06:00:00.000Z",
    });
    expect(personNamed(p, "Ava Thompson")).toMatchObject({ itemsDone: 1, itemsOpen: 0, completion: 100, doneLast7Days: 1 });
    // The captain's closed item counts as neither.
    expect(personNamed(p, "Jordan Lee")).toMatchObject({ itemsDone: 1, itemsOpen: 0, completion: 100, doneLast7Days: 0 });
  });

  it("buckets approvals into Monday–Sunday weeks of the team's timezone, from the week counting starts", async () => {
    const p = await progress();
    // Counting starts Mon Aug 31: no empty weeks from before it.
    expect(p.weekly).toEqual([
      { weekStart: "2026-08-31", itemsDone: 0 },
      { weekStart: "2026-09-07", itemsDone: 1 },
      // Marcus (Fri), Ethan (Sun 23:30 in Anaheim — Monday in UTC), Maya (Thu 23:00 in Anaheim — Friday in UTC).
      { weekStart: "2026-09-14", itemsDone: 3 },
      { weekStart: "2026-09-21", itemsDone: 3 },
    ]);
    // In another timezone the same approvals land elsewhere.
    const utc = await getPublicProgress(t.db, { now: TEST_NOW, teamTimezone: "UTC" });
    if (!utc.enabled) throw new Error("expected on");
    expect(utc.weekly.slice(-2)).toEqual([
      { weekStart: "2026-09-14", itemsDone: 2 },
      { weekStart: "2026-09-21", itemsDone: 4 },
    ]);
  });

  it("has at most 8 weeks, and at least this one", async () => {
    // Counting started long ago: the last 8 weeks.
    await setSettings({ since: "2026-05-04" });
    const long = await progress();
    expect(long.weekly.map((w) => w.weekStart)).toEqual([
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
      "2026-09-07",
      "2026-09-14",
      "2026-09-21",
    ]);
    // Starting mid-week: from that week. Starting later than this week: this week only.
    expect(firstPublicWeek("2026-09-16", "2026-09-21")).toBe("2026-09-14");
    expect(firstPublicWeek("2026-09-21", "2026-09-21")).toBe("2026-09-21");
    await setSettings({ since: "2026-10-15" });
    expect((await progress()).weekly).toEqual([{ weekStart: "2026-09-21", itemsDone: 0 }]);
  });

  it("lists recent approvals newest first, without whole-task credit or anyone who hid themselves", async () => {
    const p = await progress();
    // Hannah's approval (Sep 22, "Build the intake") isn't there at all: a title and a time could point at her.
    expect(p.recent).toEqual([
      { title: "Finish the arm", subteam: "BUILD", who: "Ethan Chen", at: "2026-09-24T18:59:00.000Z" },
      { title: "Build the intake", subteam: "BUILD", who: "Marcus Johnson", at: "2026-09-23T18:00:00.000Z" },
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

  it("leaves a lone hidden person out of every number, so subtracting the listed people gives nothing away", async () => {
    const p = await progress();
    expect(p.people).toHaveLength(5);
    expect(p.totals.people).toBe(5);
    // Each subteam's numbers are exactly its listed people's, and the team's are the subteams' plus the captain's.
    for (const sub of p.subteams) {
      const listed = p.people.filter((x) => x.subteam === sub.key);
      expect(sub.people, sub.key).toBe(listed.length);
      expect({ itemsDone: sub.itemsDone, itemsOpen: sub.itemsOpen, itemsSubmitted: sub.itemsSubmitted, doneLast7Days: sub.doneLast7Days }).toEqual(
        listedSum(listed),
      );
    }
    const { itemsDone, itemsOpen, itemsSubmitted, doneLast7Days } = p.totals;
    expect({ itemsDone, itemsOpen, itemsSubmitted, doneLast7Days }).toEqual(listedSum(p.people));
    expect(p.recent.some((r) => r.at === "2026-09-22T17:00:00.000Z")).toBe(false);
  });

  it("counts hidden people in the totals once at least 2 in the same group are hidden", async () => {
    // Ethan hides too: two hidden in Build, so both count (only their sum can be worked out).
    await t.db.user.update({ where: { id: ethan.id }, data: { hideFromPublicProgress: true } });
    const p = await progress();
    expect(p.people.map((x) => x.name)).toEqual(["Maya Patel", "Marcus Johnson", "Ava Thompson", "Jordan Lee"]);
    expect(p.totals).toMatchObject({ itemsDone: 8, itemsOpen: 4, itemsSubmitted: 1, doneLast7Days: 6, people: 6 });
    const build = p.subteams.find((s) => s.key === "BUILD")!;
    expect(build).toMatchObject({ people: 3, itemsDone: 5, itemsOpen: 3, doneLast7Days: 5 });
    const marcus = personNamed(p, "Marcus Johnson")!;
    expect(build.itemsDone - marcus.itemsDone).toBe(3); // Ethan's 2 + Hannah's 1: a sum, nobody's own number
    expect(p.weekly.at(-1)).toEqual({ weekStart: "2026-09-21", itemsDone: 4 });
    // Neither of them is in the recent list, named or not.
    expect(p.recent.map((r) => r.who)).toEqual(["Marcus Johnson", "Marcus Johnson", "Maya Patel", "Jordan Lee"]);
    expect(JSON.stringify(p)).not.toContain("Ethan");
  });

  it("leaves the captain out of every number when they hide (the only one without a subteam)", async () => {
    await t.db.user.update({ where: { id: captain.id }, data: { hideFromPublicProgress: true } });
    const p = await progress();
    expect(p.people.map((x) => x.name)).not.toContain("Jordan Lee");
    expect(p.totals).toMatchObject({ itemsDone: 6, itemsOpen: 3, people: 4 });
    // The team's numbers are exactly the subteams': nothing is left over for the captain.
    const subteams = p.subteams.reduce((n, s) => n + s.itemsDone, 0);
    expect(p.totals.itemsDone - subteams).toBe(0);
    expect(p.recent.some((r) => r.title === "Kickoff notes" && r.subteam === null)).toBe(false);
    expect((await getPublicProgressAdminView(buildLead, t.db))?.hiddenUncounted).toBe(2);
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
    // Shorter names give everyone new ids: an earlier copy can't be matched up by id to put full names back.
    await setSettings({ nameStyle: "initials" });
    const short = await progress();
    for (const id of short.people.map((x) => x.id)) expect(ids).not.toContain(id);
    await setSettings({ nameStyle: "full" });
    expect((await progress()).people.map((x) => x.id)).toEqual(ids);
    // Made from one random salt, saved once.
    const salt = await t.db.teamNote.findUniqueOrThrow({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } });
    expect(salt.body.length).toBeGreaterThanOrEqual(32);
    expect(personNamed(first, "Ethan Chen")?.id).toBe(publicPersonId(salt.body, ethan.id, "full"));
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
    expect(p.totals.people).toBe(5);
    expect(p.totals.itemsDone).toBe(7);
    const json = JSON.stringify(p);
    for (const name of ["Maya", "Ethan", "Marcus", "Ava", "Jordan"]) expect(json).not.toContain(name);
  });

  it("leaves task titles out when they're turned off", async () => {
    await setSettings({ showTaskTitles: false });
    const p = await progress();
    expect(p.recent).toHaveLength(6);
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
    expect(p.totals).toMatchObject({ itemsDone: 3, itemsOpen: 3, tasksFinished: 2, tasksActive: 2, people: 5 });
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
    expect(p.totals.itemsDone).toBe(5);
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
      // Saved before sponsors, events, and profiles had switches: off until an admin turns them on (nothing goes public
      // on its own).
      showSponsors: false,
      showEvents: false,
      showPersonPages: false,
      // Members' photos: on — each person decides about their own (Settings → My photo, on by default).
      showPhotos: true,
    });
    expect(DEFAULT_PUBLIC_PROGRESS_SETTINGS).toMatchObject({ showSponsors: false, showEvents: false, showPersonPages: false, showPhotos: true });
    expect(parsePublicProgressSettings('{"showPhotos":false}')).toEqual({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showPhotos: false });
    expect(parsePublicProgressSettings('{"showPhotos":"off"}').showPhotos).toBe(true);
    expect(parsePublicProgressSettings(serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showPhotos: false })).showPhotos).toBe(false);
    expect(parsePublicProgressSettings('{"showSponsors":true,"showEvents":"yes"}')).toEqual({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showSponsors: true });
    expect(parsePublicProgressSettings('{"showPersonPages":true}')).toEqual({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showPersonPages: true });
    expect(parsePublicProgressSettings('{"showPersonPages":"on"}').showPersonPages).toBe(false);
    expect(parsePublicProgressSettings(serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showPersonPages: true }))).toEqual({
      ...DEFAULT_PUBLIC_PROGRESS_SETTINGS,
      showPersonPages: true,
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
      totals: { itemsDone: 0, itemsOpen: 0, itemsSubmitted: 0, completion: 0, doneLast7Days: 0, tasksFinished: 0, tasksActive: 0, people: 0 },
      people: [],
      recent: [],
    });
    if (!empty.enabled) return;
    expect(empty.weekly).toHaveLength(4); // Aug 31 – this week
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
            create: [{ userId: lead.id, status: "APPROVED", reviewedAt: new Date(Date.UTC(2026, 8, 1, 12, i, 37, 412)) }],
          },
        },
      });
    }
    const p = await getPublicProgress(small.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
    if (!p.enabled) throw new Error("expected on");
    expect(p.recent).toHaveLength(15);
    expect(p.recent[0].title).toBe("Part 19");
    expect(p.recent[14].title).toBe("Part 05");
    // Times to the minute, never the second.
    expect(p.recent[0].at).toBe("2026-09-01T12:19:00.000Z");
    expect(p.people[0].lastDoneAt).toBe("2026-09-01T12:19:00.000Z");
    expect(publicTime("2026-09-01T12:19:59.999Z")).toBe("2026-09-01T12:19:00.000Z");
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
    expect(body.totals.itemsDone).toBe(7);
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

  it("builds the answer one query at a time (one database connection), only reading once the salt exists", async () => {
    await progress(); // makes the salt
    const { db, stats } = tracked(t.db);
    const answer = await getPublicProgress(db, { now: TEST_NOW, teamTimezone: TEST_TZ });
    expect(answer.enabled).toBe(true);
    expect(stats.maxInflight).toBe(1);
    expect(stats.calls.length).toBeLessThanOrEqual(6);
    expect(stats.writes).toEqual([]);
    // Names hidden: no ids, so a missing salt isn't made either.
    await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } });
    await setSettings({ nameStyle: "hidden" });
    const hidden = tracked(t.db);
    await getPublicProgress(hidden.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
    expect(hidden.stats.maxInflight).toBe(1);
    expect(hidden.stats.writes).toEqual([]);
    expect(await t.db.teamNote.findUnique({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } })).toBeNull();
  });

  it("reuses one built answer for 10 seconds, whatever the query string", async () => {
    const cache = createPublicAnswerCache();
    const { db, stats } = tracked(t.db);
    const ask = (query: string, now: Date) =>
      publicProgressResponse(new Request(`${url}${query}`, { headers: { origin: TEAM_SITE_ORIGIN } }), {
        db,
        now,
        teamTimezone: TEST_TZ,
        cache,
      });
    const settingsReads = () => stats.calls.filter((c) => c === "teamNote.findMany").length;

    // Ten visitors at once, each with a different cache-busting query string: one build.
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(`?x=${i}-${Math.random()}`, TEST_NOW)));
    expect(first.every((r) => r.status === 200)).toBe(true);
    expect(settingsReads()).toBe(1);
    const bodies = await Promise.all(first.map((r) => r.text()));
    expect(new Set(bodies).size).toBe(1);
    expect((JSON.parse(bodies[0]) as PublicProgress).updatedAt).toBe(TEST_NOW.toISOString());

    // Still fresh just before 10 s; built again after.
    await ask("?t=1", new Date(TEST_NOW.getTime() + PUBLIC_ANSWER_TTL_MS - 1));
    expect(settingsReads()).toBe(1);
    const later = new Date(TEST_NOW.getTime() + PUBLIC_ANSWER_TTL_MS);
    const rebuilt = (await (await ask("?t=2", later)).json()) as PublicProgress;
    expect(settingsReads()).toBe(2);
    expect(rebuilt.updatedAt).toBe(later.toISOString());
  });

  it("doesn't keep a failed build", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const cache = createPublicAnswerCache();
    const broken = { teamNote: { findMany: () => Promise.reject(new Error("database down")) } } as unknown as Db;
    const req = () => new Request(url, { headers: { origin: TEAM_SITE_ORIGIN } });
    expect((await publicProgressResponse(req(), { db: broken, now: TEST_NOW, teamTimezone: TEST_TZ, cache })).status).toBe(503);
    quiet.mockRestore();
    const res = await publicProgressResponse(req(), { db: t.db, now: TEST_NOW, teamTimezone: TEST_TZ, cache });
    expect(res.status).toBe(200);
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
    // Only the listed paths: anything else under /api/public/ still needs a session.
    for (const path of ["/api/public/", "/api/public/progress/", "/api/public/progress/x", "/api/public/other", "/api/public/..%2fplanner/paths"]) {
      expect(visit(path).status, path).toBe(401);
    }
    // The sponsors and events JSON, and one logo id after its prefix.
    for (const path of ["/api/public/sponsors", "/api/public/events", "/api/public/sponsors/logos/cmabc123xyz", "/api/public/sponsors/logos/a_b-C9"]) {
      expect(visit(path).headers.get("x-middleware-next"), path).toBe("1");
    }
    for (const path of [
      "/api/public/sponsors/",
      "/api/public/events/",
      "/api/public/sponsors/logos",
      "/api/public/sponsors/logos/",
      "/api/public/sponsors/logos/abc/",
      "/api/public/sponsors/logos/abc/def",
      "/api/public/sponsors/logos/..",
      "/api/public/sponsors/logos/.",
      "/api/public/sponsors/logos/a.png",
      "/api/public/sponsors/logos/..%2f..%2fplanner%2fpaths",
      "/api/public/sponsors/logos/abc%2fdef",
      "/api/public/sponsors/logos/%2e%2e",
      "/api/public/sponsors/logos/abc%00",
      `/api/public/sponsors/logos/${"a".repeat(65)}`,
      "/api/public/sponsors/logo/abc",
      "/api/public/SPONSORS",
    ]) {
      expect(visit(path).status, path).toBe(401);
    }
  });

  it("knows the public paths exactly (isPublicApiPath)", () => {
    for (const path of PUBLIC_API_PATHS) expect(isPublicApiPath(path), path).toBe(true);
    expect(isPublicApiPath(`${PUBLIC_SPONSOR_LOGOS_PREFIX}${"a".repeat(64)}`)).toBe(true);
    expect(isPublicApiPath(`${PUBLIC_SPONSOR_LOGOS_PREFIX}${"a".repeat(65)}`)).toBe(false);
    for (const path of [
      "",
      "/",
      "/api/public",
      "/api/public/progress?x=1", // the proxy gets the path without the query
      "/api/public/progress/",
      "//api/public/progress",
      "/api/public//progress",
      "/API/public/progress",
      "/api/public/progress%2f",
      PUBLIC_SPONSOR_LOGOS_PREFIX,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}a/b`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}a%2fb`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}a%2Fb`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}%2e%2e`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}..`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}a.b`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}a b`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}é`,
      `${PUBLIC_SPONSOR_LOGOS_PREFIX}abc\n`,
      `/x${PUBLIC_SPONSOR_LOGOS_PREFIX}abc`,
    ]) {
      expect(isPublicApiPath(path), JSON.stringify(path)).toBe(false);
    }
    expect(PUBLIC_API_ID_RE.test("cmg3x9k2a0000abcd1234efgh")).toBe(true);
    expect(PUBLIC_API_ID_RE.test("")).toBe(false);
  });

  it("lists every route under src/app/api/public, and each one is the public kind (no session)", () => {
    const root = fileURLToPath(new URL("../src/app/api/public", import.meta.url));
    const appDir = fileURLToPath(new URL("../src/app", import.meta.url));
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/^route\.(ts|tsx|js)$/.test(entry.name)) routes.push(path);
      }
    };
    walk(root);
    const paths = routes.map((file) => "/" + relative(appDir, join(file, "..")).split(sep).join("/"));
    // A static route only when it's listed by exact path; an [id] route only when its parent path + "/" is a file
    // prefix (and nothing deeper or with another dynamic segment); every listed path and prefix has its route.
    const statics = paths.filter((p) => !p.includes("["));
    const dynamics = paths.filter((p) => p.includes("["));
    expect(statics.sort()).toEqual([...PUBLIC_API_PATHS].sort());
    for (const p of dynamics) {
      expect(p, p).toMatch(/\/\[id\]$/);
      expect(p.slice(0, -"[id]".length).includes("["), p).toBe(false);
      expect(PUBLIC_API_FILE_PREFIXES, p).toContain(p.slice(0, -"[id]".length));
    }
    expect(dynamics.map((p) => p.slice(0, -"[id]".length)).sort()).toEqual([...PUBLIC_API_FILE_PREFIXES].sort());
    expect(dynamics).toContain("/api/public/progress/people/[id]");
    for (const prefix of PUBLIC_API_FILE_PREFIXES) expect(prefix.endsWith("/"), prefix).toBe(true);
    for (const file of routes) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("@/server/public-api");
      expect(source, file).not.toMatch(/auth\/session|next\/headers|cookies\(|getCurrentUser|getServiceContext/);
    }
  });
});

// ── One person (GET /api/public/progress/people/[id]) ────────────────────────

describe("one person's progress (GET /api/public/progress/people/[id])", () => {
  const url = (id: string, query = "") => `https://communication-portal-iota.vercel.app${PUBLIC_PROGRESS_PEOPLE_PREFIX}${id}${query}`;
  const page = (id: string, db: Db = t.db) => getPublicPersonProgress(db, { now: TEST_NOW, teamTimezone: TEST_TZ, id });
  const found = async (id: string): Promise<PublicPersonProgress> => {
    const answer = await page(id);
    if (!answer) throw new Error(`expected ${id} to be listed`);
    return answer;
  };
  const idOf = async (name: string) => {
    const entry = personNamed(await progress(), name);
    if (!entry) throw new Error(`expected ${name} to be listed`);
    return entry.id;
  };
  const call = (id: string, init: RequestInit & { origin?: string } = {}, deps: Partial<Omit<PublicPersonDeps, "id">> = {}) => {
    const headers = new Headers(init.headers);
    if (init.origin) headers.set("origin", init.origin);
    return publicPersonProgressResponse(new Request(url(id), { ...init, headers }), { db: t.db, now: TEST_NOW, teamTimezone: TEST_TZ, id, ...deps });
  };
  /** Everything a visitor gets back. */
  const seen = async (res: Response) => ({ status: res.status, headers: [...res.headers.entries()], body: await res.text() });
  /** A well-formed id nobody has. */
  const NOBODY = "AAAAAAAAAAAAAAAA";
  /** The profiles are off until an admin turns them on: these tests turn them on, with whatever else they need. */
  const setProfileSettings = (settings: Partial<PublicProgressSettings>) => setSettings({ showPersonPages: true, ...settings });
  beforeEach(async () => {
    await setProfileSettings({});
  });

  let small: TestDb;
  afterAll(async () => {
    await small?.drop();
  });

  it("has the agreed shape: their people entry, their weeks, and what they finished", async () => {
    const team = await progress();
    const entry = personNamed(team, "Ethan Chen")!;
    const p = await found(entry.id);
    expect(Object.keys(p)).toEqual(["enabled", "updatedAt", "since", "person", "weekly", "done"]);
    expect(p).toEqual({
      enabled: true,
      updatedAt: TEST_NOW.toISOString(),
      since: "2026-08-31",
      person: entry,
      weekly: [
        { weekStart: "2026-08-31", itemsDone: 0 },
        { weekStart: "2026-09-07", itemsDone: 0 },
        { weekStart: "2026-09-14", itemsDone: 1 }, // Sun Sep 20, 23:30 in Anaheim
        { weekStart: "2026-09-21", itemsDone: 1 },
      ],
      // Newest first; last season's robot (due before counting starts) isn't there.
      done: [
        { title: "Finish the arm", subteam: "BUILD", at: "2026-09-24T18:59:00.000Z", withTask: false },
        { title: "Build the intake", subteam: "BUILD", at: "2026-09-21T06:30:00.000Z", withTask: false },
      ],
    });
    expect(Object.keys(p.person)).toEqual(Object.keys(entry));
    expect(Object.keys(p.done[0])).toEqual(["title", "subteam", "at", "withTask"]);
    // Whole-task credit is on their own list (marked), unlike the team's recent list; `subteam` is the task's.
    expect((await found(personNamed(team, "Ava Thompson")!.id)).done).toEqual([
      { title: "Sponsor letters", subteam: null, at: "2026-09-23T20:00:00.000Z", withTask: true },
    ]);
    expect((await found(personNamed(team, "Maya Patel")!.id)).done).toEqual([
      { title: "Kickoff notes", subteam: null, at: "2026-09-18T06:00:00.000Z", withTask: false },
    ]);
  });

  it("agrees with the progress JSON for everyone it lists", async () => {
    const team = await progress();
    const weekSums = team.weekly.map(() => 0);
    for (const entry of team.people) {
      const p = await found(entry.id);
      expect(p.person, entry.name).toEqual(entry);
      expect(p.since).toBe(team.since);
      expect(p.weekly.map((w) => w.weekStart), entry.name).toEqual(team.weekly.map((w) => w.weekStart));
      p.weekly.forEach((w, i) => (weekSums[i] += w.itemsDone));
      expect(p.done, entry.name).toHaveLength(Math.min(entry.itemsDone, PUBLIC_PERSON_DONE_MAX));
      expect(p.done[0]?.at ?? null, entry.name).toBe(entry.lastDoneAt);
      expect([...p.done].sort((a, b) => b.at.localeCompare(a.at))).toEqual(p.done);
    }
    // Everyone counted is listed (Hannah, the only one hidden in Build, isn't counted): the weeks add up exactly.
    expect(weekSums).toEqual(team.weekly.map((w) => w.itemsDone));
  });

  it("finds only the people the progress JSON lists: everyone else gets the same 404", async () => {
    const ethanId = await idOf("Ethan Chen");
    const salt = (await t.db.teamNote.findUniqueOrThrow({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } })).body;
    const baseline = await seen(await call(NOBODY, { origin: TEAM_SITE_ORIGIN }));
    expect(baseline.status).toBe(404);
    expect(JSON.parse(baseline.body)).toEqual({ error: PUBLIC_PERSON_NOT_FOUND });
    expect(Object.fromEntries(baseline.headers)).toEqual({
      "access-control-allow-origin": TEAM_SITE_ORIGIN,
      vary: "Origin",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-type": "application/json; charset=utf-8",
    });
    const sameAsNobody = async (id: string, why: string) => {
      expect(await page(id), why).toBeNull();
      expect(await seen(await call(id, { origin: TEAM_SITE_ORIGIN })), why).toEqual(baseline);
    };

    // Ids made exactly like the listed ones (as if the salt had leaked): the person who left herself off the list,
    // mentors, teachers, sign-ups waiting for approval, disabled accounts.
    for (const [why, actor] of [
      ["hidden", hannah],
      ["mentor", mentor],
      ["teacher", teacher],
      ["pending", pending],
      ["disabled", disabled],
    ] as const) {
      await sameAsNobody(publicPersonId(salt, actor.id, "full"), why);
    }
    // Not a person id at all (an account id, too short or long, path tricks): the same 404.
    for (const id of [ethan.id, "abc", "A".repeat(17), "", "..", "AAAAAAAAAAAAAAA.", "AAAAAAAA/AAAAAAA"]) await sameAsNobody(id, JSON.stringify(id));

    // Ethan leaves himself off the list: his id stops working at once (and he's gone from the progress JSON too).
    expect((await found(ethanId)).person.name).toBe("Ethan Chen");
    await t.db.user.update({ where: { id: ethan.id }, data: { hideFromPublicProgress: true } });
    await sameAsNobody(ethanId, "Ethan hidden");
    expect((await progress()).people.map((x) => x.id)).not.toContain(ethanId);
    await t.db.user.update({ where: { id: ethan.id }, data: { hideFromPublicProgress: false } });
    expect((await found(ethanId)).person.name).toBe("Ethan Chen");

    // The page turned off, or names hidden (the progress JSON lists nobody): the same 404.
    await setProfileSettings({ enabled: false });
    await sameAsNobody(ethanId, "page off");
    await setProfileSettings({ nameStyle: "hidden" });
    await sameAsNobody(ethanId, "names hidden");
    await sameAsNobody(publicPersonId(salt, ethan.id, "hidden"), "names hidden, an id made for that style");

    // Shorter names: the old id is gone, the new one shows the shorter name.
    await setProfileSettings({ nameStyle: "initials" });
    await sameAsNobody(ethanId, "full-name id after switching to initials");
    const short = await found(await idOf("E.C."));
    expect(short.person).toMatchObject({ name: "E.C.", subteam: "BUILD", role: "Build Team", itemsDone: 2 });
    expect(JSON.stringify(short)).not.toContain("Ethan");
  });

  it("leaves task titles out when they're turned off", async () => {
    await setProfileSettings({ showTaskTitles: false });
    const team = await progress();
    for (const entry of team.people) {
      const p = await found(entry.id);
      expect(p.done.every((d) => d.title === null), entry.name).toBe(true);
      const json = JSON.stringify(p);
      for (const title of ["Finish the arm", "Build the intake", "Kickoff notes", "Sponsor letters", "Wire the drivetrain", "Code autonomous"]) {
        expect(json, entry.name).not.toContain(title);
      }
    }
    expect((await found(personNamed(team, "Ethan Chen")!.id)).done).toHaveLength(2);
  });

  it("never includes emails, notes, due dates, overdue info, account or task ids, or anyone else", async () => {
    const team = await progress();
    const users = await t.db.user.findMany({ select: { id: true, email: true } });
    for (const entry of team.people) {
      const json = JSON.stringify(await found(entry.id));
      for (const u of users) {
        expect(json).not.toContain(u.email);
        expect(json).not.toContain(u.id);
      }
      for (const id of Object.values(taskIds)) expect(json).not.toContain(id);
      for (const text of [
        SECRET_REVIEW,
        SECRET_SUBMISSION,
        "secret",
        "@",
        "overdue",
        "late",
        "dueDate",
        "reviewNote",
        "submissionNote",
        "2026-09-10", // due dates
        "2026-09-15",
        "2026-09-20",
        "2026-10-01",
        "Last season",
        "Mentor paperwork",
        "Hannah",
        "Elena",
      ]) {
        expect(json.toLowerCase(), `${entry.name}: ${text}`).not.toContain(text.toLowerCase());
      }
    }
  });

  it("counts from `since`, like the progress JSON", async () => {
    await setProfileSettings({ since: "2026-09-15" });
    const team = await progress();
    const entry = personNamed(team, "Ethan Chen")!;
    const p = await found(entry.id);
    expect(p.since).toBe("2026-09-15");
    expect(p.person).toEqual(entry);
    expect(p.done.map((d) => d.title)).toEqual(["Finish the arm"]); // the intake was due Sep 10
    expect(p.weekly).toEqual([
      { weekStart: "2026-09-14", itemsDone: 0 },
      { weekStart: "2026-09-21", itemsDone: 1 },
    ]);
    const jordan = await found(personNamed(team, "Jordan Lee")!.id);
    expect(jordan.done).toEqual([]);
    expect(jordan.person).toMatchObject({ itemsDone: 0, itemsOpen: 0, completion: 0, lastDoneAt: null });
  });

  it("only reads, one query at a time, and never makes the salt", async () => {
    const id = await idOf("Ethan Chen");
    const { db, stats } = tracked(t.db);
    expect(await page(id, db)).not.toBeNull();
    expect(stats.maxInflight).toBe(1);
    expect(stats.calls.length).toBeLessThanOrEqual(5);
    expect(stats.writes).toEqual([]);

    // Not a person id: nothing is read.
    const junk = tracked(t.db);
    expect(await page("../../planner", junk.db)).toBeNull();
    expect(junk.stats.calls).toEqual([]);

    // No salt yet: no id can be valid, so nothing is found — and the person endpoint doesn't make one.
    await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } });
    const fresh = tracked(t.db);
    expect(await page(id, fresh.db)).toBeNull();
    expect(fresh.stats.writes).toEqual([]);
    expect(await t.db.teamNote.findUnique({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } })).toBeNull();
    // The progress JSON makes a new one: everyone gets new ids, which work.
    const renewed = await idOf("Ethan Chen");
    expect(renewed).not.toBe(id);
    expect(await page(id)).toBeNull();
    expect((await found(renewed)).person.name).toBe("Ethan Chen");
  });

  it("lists the newest 25 things they finished", async () => {
    small = await createTestDb();
    const body = serializePublicProgressSettings({ ...DEFAULT_PUBLIC_PROGRESS_SETTINGS, showPersonPages: true });
    await small.db.teamNote.create({ data: { key: PUBLIC_PROGRESS_KEY, body } });
    const lead = await makeUser(small.db, { role: "BUILD_LEADER", subteam: "BUILD", name: "Lead One" });
    for (let i = 0; i < 30; i++) {
      await small.db.task.create({
        data: {
          title: `Part ${String(i).padStart(2, "0")}`,
          subteam: i % 2 ? "BUILD" : null,
          dueDate: dateOnlyToDb("2026-09-10"),
          createdById: lead.id,
          assignments: { create: [{ userId: lead.id, status: "APPROVED", reviewedAt: new Date(Date.UTC(2026, 8, 1, 12, i, 37, 412)) }] },
        },
      });
    }
    const team = await getPublicProgress(small.db, { now: TEST_NOW, teamTimezone: TEST_TZ });
    if (!team.enabled) throw new Error("expected on");
    const p = await page(team.people[0].id, small.db);
    if (!p) throw new Error("expected the lead to be listed");
    expect(p.person).toEqual(team.people[0]);
    expect(p.person.itemsDone).toBe(30);
    expect(p.done).toHaveLength(PUBLIC_PERSON_DONE_MAX);
    expect(p.done[0]).toEqual({ title: "Part 29", subteam: "BUILD", at: "2026-09-01T12:29:00.000Z", withTask: false });
    expect(p.done[1]).toMatchObject({ title: "Part 28", subteam: null });
    expect(p.done[24].title).toBe("Part 05");
    expect(p.weekly[0]).toEqual({ weekStart: "2026-08-31", itemsDone: 30 });
  });

  it("lets the team website read it, with the progress JSON's CORS and caching", async () => {
    const id = await idOf("Ethan Chen");
    const res = await call(id, { origin: TEAM_SITE_ORIGIN });
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual({
      "access-control-allow-origin": TEAM_SITE_ORIGIN,
      vary: "Origin",
      "cache-control": PUBLIC_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
      "content-type": "application/json; charset=utf-8",
    });
    expect(((await res.json()) as PublicPersonProgress).person.name).toBe("Ethan Chen");

    // Never another site (or *); extra origins come from the setting — for the 404 too, so the website can read it.
    for (const origin of ["https://evil.example", "http://localhost:4321", "null", "https://huskyteers19516.github.io.evil.example"]) {
      expect((await call(id, { origin })).headers.get("access-control-allow-origin"), origin).toBe(TEAM_SITE_ORIGIN);
    }
    const local = { extraOrigins: "http://localhost:4321" };
    expect((await call(id, { origin: "http://localhost:4321" }, local)).headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    const missing = await call(NOBODY, { origin: "http://localhost:4321" }, local);
    expect([missing.status, missing.headers.get("access-control-allow-origin")]).toEqual([404, "http://localhost:4321"]);
    expect(missing.headers.get("access-control-allow-credentials")).toBeNull();

    // HEAD (found or not), the CORS preflight, and nothing else.
    const head = await call(id, { method: "HEAD" });
    expect([head.status, await head.text(), head.headers.get("cache-control")]).toEqual([200, "", PUBLIC_CACHE_CONTROL]);
    const headMissing = await call(NOBODY, { method: "HEAD" });
    expect([headMissing.status, await headMissing.text(), headMissing.headers.get("cache-control")]).toEqual([404, "", "no-store"]);
    const preflight = await call(id, { method: "OPTIONS", origin: TEAM_SITE_ORIGIN });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    const post = await call(id, { method: "POST", origin: TEAM_SITE_ORIGIN, body: "{}" });
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET, HEAD, OPTIONS"]);
  });

  it("answers a 503 that isn't cached or kept when the database fails", async () => {
    const id = await idOf("Ethan Chen");
    const cache = createPublicAnswerCacheMap(10);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { teamNote: { findMany: () => Promise.reject(new Error("database down")) } } as unknown as Db;
    const res = await call(id, { origin: TEAM_SITE_ORIGIN }, { db: broken, cache });
    quiet.mockRestore();
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(((await res.json()) as { error: string }).error).toMatch(/isn't available/);
    expect((await call(id, {}, { cache })).status).toBe(200);
  });

  it("keeps one built answer per listed id for 10 seconds, whatever the query string", async () => {
    const ethanId = await idOf("Ethan Chen");
    const mayaId = await idOf("Maya Patel");
    const cache = createPublicAnswerCacheMap(PUBLIC_PERSON_CACHE_MAX);
    const directory = createPublicValueCache<PublicPeopleDirectory | null>();
    const { db, stats } = tracked(t.db);
    const ask = (id: string, query: string, now = TEST_NOW) =>
      publicPersonProgressResponse(new Request(url(id, query), { headers: { origin: TEAM_SITE_ORIGIN } }), {
        db,
        now,
        teamTimezone: TEST_TZ,
        cache,
        directory,
        id,
      });
    /** Directory builds (settings + the listed people) and per-person builds (their counts, weeks, approvals). */
    const directoryBuilds = () => stats.calls.filter((c) => c === "teamNote.findMany").length;
    const personBuilds = () => stats.calls.filter((c) => c === "taskAssignment.findMany").length;

    // Ten visitors at once, each with a different cache-busting query string: one directory, one build.
    const first = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(ethanId, `?x=${i}-${Math.random()}`)));
    expect(first.every((r) => r.status === 200)).toBe(true);
    expect(new Set(await Promise.all(first.map((r) => r.text()))).size).toBe(1);
    expect([directoryBuilds(), personBuilds()]).toEqual([1, 1]);
    // Another person: their own build, the same directory.
    expect((await ask(mayaId, "?x=1")).status).toBe(200);
    expect([directoryBuilds(), personBuilds()]).toEqual([1, 2]);
    // An id nobody has, or something that isn't an id: answered from memory, never built or kept.
    const before = stats.calls.length;
    expect((await ask(NOBODY, "")).status).toBe(404);
    expect((await ask(NOBODY, "?again")).status).toBe(404);
    expect((await ask("not-an-id", "")).status).toBe(404);
    expect(stats.calls.length).toBe(before);
    expect([...cache.entries.keys()]).toEqual([ethanId, mayaId]);

    // Still fresh just before 10 s; built again after (the directory too).
    await ask(ethanId, "?t=1", new Date(TEST_NOW.getTime() + PUBLIC_ANSWER_TTL_MS - 1));
    expect([directoryBuilds(), personBuilds()]).toEqual([1, 2]);
    const later = new Date(TEST_NOW.getTime() + PUBLIC_ANSWER_TTL_MS);
    const rebuilt = (await (await ask(ethanId, "?t=2", later)).json()) as PublicPersonProgress;
    expect([directoryBuilds(), personBuilds()]).toEqual([2, 3]);
    expect(rebuilt.updatedAt).toBe(later.toISOString());
  });

  it("answers made-up ids from memory: a flood costs at most the directory's two reads and keeps nobody out", async () => {
    const ethanId = await idOf("Ethan Chen");
    const cache = createPublicAnswerCacheMap(PUBLIC_PERSON_CACHE_MAX);
    const directory = createPublicValueCache<PublicPeopleDirectory | null>();
    const { db, stats } = tracked(t.db);
    const ask = (id: string) =>
      publicPersonProgressResponse(new Request(url(id)), { db, now: TEST_NOW, teamTimezone: TEST_TZ, cache, directory, id });

    const flood = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(12)}`);
    for (const id of flood) expect(PUBLIC_PERSON_ID_RE.test(id)).toBe(true);
    const answers = await Promise.all(flood.map(ask));
    expect(answers.every((r) => r.status === 404)).toBe(true);
    // Within one TTL: the directory (settings, the listed people) once, nothing else.
    expect(stats.calls).toEqual(["teamNote.findMany", "user.findMany"]);
    expect(cache.entries.size).toBe(0);

    // A listed person's kept answer survives another flood bigger than the cache.
    expect((await ask(ethanId)).status).toBe(200);
    const builtCalls = stats.calls.length;
    for (const id of flood.slice(0, PUBLIC_PERSON_CACHE_MAX + 50)) await ask(id);
    expect([...cache.entries.keys()]).toEqual([ethanId]);
    expect((await ask(ethanId)).status).toBe(200);
    expect(stats.calls.length).toBe(builtCalls);
  });

  it("finds people through a directory of exactly the progress JSON's people (null while anything is off)", async () => {
    const team = await progress();
    const dir = await getPublicPeopleDirectory(t.db);
    if (!dir) throw new Error("expected a directory");
    expect([...dir.byId.keys()].sort()).toEqual(team.people.map((x) => x.id).sort());
    expect([...dir.byId.values()].map((u) => u.id)).not.toContain(hannah.id);
    for (const u of dir.byId.values()) expect(Object.keys(u).sort()).toEqual(["id", "name", "role", "subteam"]);
    expect(dir).toMatchObject({ since: team.since, style: "full", showTaskTitles: true });

    await setProfileSettings({ enabled: false });
    expect(await getPublicPeopleDirectory(t.db)).toBeNull();
    await setProfileSettings({ nameStyle: "hidden" });
    expect(await getPublicPeopleDirectory(t.db)).toBeNull();
    await setSettings({ showPersonPages: false });
    expect(await getPublicPeopleDirectory(t.db)).toBeNull();
  });

  it("stops finding someone who hides themselves once the directory is rebuilt (within 10 seconds)", async () => {
    const ethanId = await idOf("Ethan Chen");
    const cache = createPublicAnswerCacheMap(PUBLIC_PERSON_CACHE_MAX);
    const directory = createPublicValueCache<PublicPeopleDirectory | null>();
    const ask = (now: Date) =>
      publicPersonProgressResponse(new Request(url(ethanId)), { db: t.db, now, teamTimezone: TEST_TZ, cache, directory, id: ethanId });
    expect((await ask(TEST_NOW)).status).toBe(200);
    await t.db.user.update({ where: { id: ethan.id }, data: { hideFromPublicProgress: true } });
    const t0 = TEST_NOW.getTime();
    expect((await ask(new Date(t0 + PUBLIC_ANSWER_TTL_MS - 1))).status).toBe(200);
    const gone = await ask(new Date(t0 + PUBLIC_ANSWER_TTL_MS));
    expect([gone.status, await gone.json()]).toEqual([404, { error: PUBLIC_PERSON_NOT_FOUND }]);
  });

  it("cachedPublicValue keeps any value like cachedPublicAnswer", async () => {
    const cache = createPublicValueCache<{ n: number }>();
    let n = 0;
    const build = () => Promise.resolve({ n: ++n });
    const [a, b] = await Promise.all([cachedPublicValue(cache, TEST_NOW, build), cachedPublicValue(cache, TEST_NOW, build)]);
    expect(a).toBe(b);
    expect(await cachedPublicValue(cache, new Date(TEST_NOW.getTime() + PUBLIC_ANSWER_TTL_MS - 1), build)).toBe(a);
    expect(await cachedPublicValue(cache, new Date(TEST_NOW.getTime() + PUBLIC_ANSWER_TTL_MS), build)).toEqual({ n: 2 });
    const failing = createPublicValueCache<number>();
    await expect(cachedPublicValue(failing, TEST_NOW, () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cachedPublicValue(failing, TEST_NOW, () => Promise.resolve(7))).toBe(7);
    expect(await cachedPublicValue(undefined, TEST_NOW, build)).toEqual({ n: 3 });
  });

  it("is the same 404 for everyone while the profiles are off (the default), and the progress JSON is unchanged", async () => {
    const ethanId = await idOf("Ethan Chen");
    const baseline = await seen(await call(NOBODY, { origin: TEAM_SITE_ORIGIN }));
    expect(baseline.status).toBe(404);
    expect((await call(ethanId, { origin: TEAM_SITE_ORIGIN })).status).toBe(200);
    const before = await progress();

    await setSettings({ showPersonPages: false });
    expect(await page(ethanId)).toBeNull();
    expect(await seen(await call(ethanId, { origin: TEAM_SITE_ORIGIN }))).toEqual(baseline);
    expect(await seen(await call(NOBODY, { origin: TEAM_SITE_ORIGIN }))).toEqual(baseline);
    expect(await progress()).toEqual(before);
    // Nothing saved yet at all (a team that never opened the settings): off.
    await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_KEY } });
    expect(await seen(await call(ethanId, { origin: TEAM_SITE_ORIGIN }))).toEqual(baseline);
    // On again: found again.
    await setProfileSettings({});
    expect((await call(ethanId, { origin: TEAM_SITE_ORIGIN })).status).toBe(200);
  });

  it("cachedPublicAnswerByKey shares one build per key and keeps at most `max` keys", async () => {
    expect(() => createPublicAnswerCacheMap(0)).toThrow(RangeError);
    expect(() => createPublicAnswerCacheMap(1.5)).toThrow(RangeError);
    const map = createPublicAnswerCacheMap(2);
    let n = 0;
    const build = (key: string) => () => Promise.resolve(`${key}${++n}`);
    const get = (key: string, now = TEST_NOW) => cachedPublicAnswerByKey(map, key, now, build(key));

    expect(await Promise.all([get("a"), get("a"), get("a")])).toEqual(["a1", "a1", "a1"]);
    expect(await get("b")).toBe("b2");
    // "a" asked again, so "b" is now the least recently asked: "c" pushes it out.
    expect(await get("a")).toBe("a1");
    expect(await get("c")).toBe("c3");
    expect([...map.entries.keys()]).toEqual(["a", "c"]);
    expect(await get("b")).toBe("b4");
    expect([...map.entries.keys()]).toEqual(["c", "b"]);
    // Made-up keys never grow it past `max`.
    for (let i = 0; i < 50; i++) await get(`k${i}`);
    expect(map.entries.size).toBe(2);
    expect([...map.entries.keys()]).toEqual(["k48", "k49"]);

    // Each key's answer lasts PUBLIC_ANSWER_TTL_MS.
    const t0 = TEST_NOW.getTime();
    const kept = await get("k49");
    expect(await get("k49", new Date(t0 + PUBLIC_ANSWER_TTL_MS - 1))).toBe(kept);
    expect(await get("k49", new Date(t0 + PUBLIC_ANSWER_TTL_MS))).not.toBe(kept);

    // A failed build isn't kept; no map builds every time.
    await expect(cachedPublicAnswerByKey(map, "f", TEST_NOW, () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    expect(await cachedPublicAnswerByKey(map, "f", TEST_NOW, () => Promise.resolve("ok"))).toBe("ok");
    const before = n;
    await cachedPublicAnswerByKey(undefined, "a", TEST_NOW, build("a"));
    await cachedPublicAnswerByKey(undefined, "a", TEST_NOW, build("a"));
    expect(n).toBe(before + 2);
  });

  it("is served by the route (GET, HEAD, OPTIONS) without signing in", async () => {
    holder.user = null;
    const id = await idOf("Maya Patel");
    const req = (method: string, which = id) => new NextRequest(url(which), { method, headers: { origin: TEAM_SITE_ORIGIN } });
    const ctx = (which = id) => ({ params: Promise.resolve({ id: which }) }) as never;
    const res = await personRoute.GET(req("GET"), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(TEAM_SITE_ORIGIN);
    expect(((await res.json()) as PublicPersonProgress).person.name).toBe("Maya Patel");
    expect((await personRoute.HEAD(req("HEAD"), ctx())).status).toBe(200);
    expect((await personRoute.OPTIONS(req("OPTIONS"), ctx())).status).toBe(204);
    const missing = await personRoute.GET(req("GET", NOBODY), ctx(NOBODY));
    expect([missing.status, await missing.json()]).toEqual([404, { error: PUBLIC_PERSON_NOT_FOUND }]);
    expect(Object.keys(personRoute).sort()).toEqual(["GET", "HEAD", "OPTIONS"]);
  });

  it("gets through the proxy as exactly one id after its prefix", async () => {
    const ids = (await progress()).people.map((x) => x.id);
    for (const id of ids) {
      expect(id).toMatch(PUBLIC_PERSON_ID_RE);
      expect(PUBLIC_API_ID_RE.test(id)).toBe(true);
      expect(isPublicApiPath(`${PUBLIC_PROGRESS_PEOPLE_PREFIX}${id}`)).toBe(true);
    }
    expect(PUBLIC_PROGRESS_PEOPLE_PREFIX).toBe("/api/public/progress/people/");
    expect(PUBLIC_API_FILE_PREFIXES).toContain(PUBLIC_PROGRESS_PEOPLE_PREFIX);
    const visit = (path: string) => proxy(new NextRequest(`https://communication-portal-iota.vercel.app${path}`));
    for (const path of [`${PUBLIC_PROGRESS_PEOPLE_PREFIX}${ids[0]}`, `${PUBLIC_PROGRESS_PEOPLE_PREFIX}${ids[0]}?x=1`, `${PUBLIC_PROGRESS_PEOPLE_PREFIX}a_b-C9`]) {
      expect(visit(path).headers.get("x-middleware-next"), path).toBe("1");
    }
    for (const path of [
      "/api/public/progress/people",
      "/api/public/progress/people/",
      "/api/public/progress/people/a/b",
      `/api/public/progress/people/${ids[0]}/`,
      "/api/public/progress/people/a.b",
      "/api/public/progress/people/..",
      "/api/public/progress/people/%2e%2e",
      "/api/public/progress/people/..%2f..%2fplanner%2fpaths",
      `/api/public/progress/people/${"a".repeat(65)}`,
      "/api/public/progress/person/abc",
      "/api/public/progress/x/abc",
      "/api/public/PROGRESS/people/abc",
    ]) {
      expect(visit(path).status, path).toBe(401);
      expect(isPublicApiPath(path), path).toBe(false);
    }
  });
});

// ── Settings (Admin → Approvals → Team website) ──────────────────────────────

describe("the page's settings", () => {
  const save = (actor: Actor, raw: Record<string, unknown>) => updatePublicProgressSettings(contextFor(t.db, actor), raw);

  it("are changed by everyone with admin access", async () => {
    expect(
      await save(buildLead, {
        enabled: "on",
        nameStyle: "initials",
        since: "2026-09-01",
        showSponsors: "on",
        showEvents: "on",
        showPersonPages: "on",
        showPhotos: "on",
      }),
    ).toEqual({
      enabled: true,
      nameStyle: "initials",
      showTaskTitles: false,
      since: "2026-09-01",
      showSponsors: true,
      showEvents: true,
      showPersonPages: true,
      showPhotos: true,
    });
    expect((await getPublicProgressConfig(t.db)).settings).toMatchObject({ nameStyle: "initials", showTaskTitles: false });
    const note = await t.db.teamNote.findUniqueOrThrow({ where: { key: PUBLIC_PROGRESS_KEY } });
    expect(note.updatedById).toBe(buildLead.id);

    // Unchecked boxes = off; an empty date = back to the attendance reports' start.
    await save(mentor, { nameStyle: "full", showTaskTitles: "on", since: "" });
    const config = await getPublicProgressConfig(t.db);
    expect(config.settings).toEqual({
      enabled: false,
      nameStyle: "full",
      showTaskTitles: true,
      since: null,
      showSponsors: false,
      showEvents: false,
      showPersonPages: false,
      showPhotos: false,
    });
    expect(config.since).toBe("2026-08-31");
    expect(await getPublicProgress(t.db, { now: TEST_NOW, teamTimezone: TEST_TZ })).toEqual({ enabled: false });
    await save(captain, { enabled: "on", nameStyle: "full", showTaskTitles: "on" });
    expect((await progress()).people).toHaveLength(5);
  });

  it("make the people ids' salt when saved, so the public request only reads", async () => {
    await t.db.teamNote.deleteMany({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } });
    await save(captain, { enabled: "on", nameStyle: "full", showTaskTitles: "on" });
    const salt = await t.db.teamNote.findUniqueOrThrow({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } });
    expect(salt.body.length).toBeGreaterThanOrEqual(32);
    const { db, stats } = tracked(t.db);
    await getPublicProgress(db, { now: TEST_NOW, teamTimezone: TEST_TZ });
    expect(stats.writes).toEqual([]);
    // Saving again keeps it (the ids stay the same).
    await save(captain, { enabled: "on", nameStyle: "full", showTaskTitles: "on" });
    expect((await t.db.teamNote.findUniqueOrThrow({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY } })).body).toBe(salt.body);
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
      hiddenUncounted: 1,
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
