// Attendance's query layer (src/server/queries/attendance.ts): who may read what (the session secret and other
// people's answers stay with runners/staff), report periods, and who counts in the reports.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The queries read through the app-wide `prisma`: point it at this file's throwaway database.
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

import type { Role, Subteam } from "@/generated/prisma/enums";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { currentCodes, newSessionSecret, qrTokenFor, slotAt } from "@/server/attendance/codes";
import {
  getAttendanceHome,
  getAttendanceReport,
  getComingOverview,
  getLiveCode,
  getRunnerSession,
  getScanLanding,
  getTodayAttendance,
  listReports,
} from "@/server/queries/attendance";
import { openSession, setRsvp, updateSettings } from "@/server/services/attendance";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

// TEST_TODAY is Thursday 2026-09-24; with the default schedule reports start Mon 2026-08-31, so period 1 is
// Sep 14 – Sep 27 (the current one) and period 0 is Aug 31 – Sep 13.
const JOINED = new Date("2026-08-01T12:00:00Z");
const opts = { now: TEST_NOW, today: TEST_TODAY, appUrl: "https://portal.example.com" };
const reportOpts = { today: TEST_TODAY, timeZone: TEST_TZ };

let t: TestDb;
type Who = "teacher" | "bizLead" | "swLead" | "member" | "member2" | "pendingTeacher";
let p: Record<Who, Actor>;

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  const spec: Record<Who, { role: Role; subteam?: Subteam | null; status?: "PENDING" }> = {
    teacher: { role: "TEACHER" },
    bizLead: { role: "BUSINESS_LEADER" },
    swLead: { role: "SOFTWARE_LEADER" },
    member: { role: "MEMBER", subteam: "BUILD" },
    member2: { role: "MEMBER", subteam: "SOFTWARE" },
    pendingTeacher: { role: "TEACHER", status: "PENDING" },
  };
  const entries = await Promise.all(Object.entries(spec).map(async ([who, s]) => [who, await makeUser(t.db, { ...s, name: who })] as const));
  p = Object.fromEntries(entries) as Record<Who, Actor>;
  // Everyone joined well before the dates these tests use.
  await t.db.user.updateMany({ data: { createdAt: JOINED } });
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.attendanceRecord.deleteMany();
  await t.db.attendanceSession.deleteMany();
  await t.db.attendanceRsvp.deleteMany();
  await t.db.attendancePlan.deleteMany();
  await t.db.rateLimit.deleteMany();
  await t.db.teamNote.deleteMany();
});

async function secretOf(id: string) {
  return (await t.db.attendanceSession.findUniqueOrThrow({ where: { id }, select: { secret: true } })).secret;
}

async function sessionOn(day: string, kind: "REGULAR" | "FLEX", records: { userId: string; method: "QR" | "CODE" | "MANUAL" }[] = []) {
  return t.db.attendanceSession.create({
    data: {
      date: dateOnlyToDb(day),
      kind,
      secret: newSessionSecret(),
      openedById: p.teacher.id,
      closedAt: TEST_NOW,
      records: { create: records.map((r) => ({ ...r, checkedInAt: TEST_NOW })) },
    },
    select: { id: true },
  });
}

describe("gates", () => {
  it("only active runners get the live code, and it never carries the secret", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    for (const who of ["member", "swLead", "pendingTeacher"] as const) {
      expect((await getLiveCode(p[who], id, opts)).ok, who).toBe(false);
    }
    const live = await getLiveCode(p.bizLead, id, opts);
    expect(live).toMatchObject({ ok: true, code: expect.stringMatching(/^\d{6}$/) });
    if (!live.ok) throw new Error("expected a code");
    expect(live.url).toMatch(/^https:\/\/portal\.example\.com\/attendance\/scan\//);
    expect(live.expiresInMs).toBeGreaterThan(0);
    expect(live.expiresInMs).toBeLessThanOrEqual(30_000);
    expect(JSON.stringify(live)).not.toContain(await secretOf(id));
    // Another day's session, or a closed one: no code.
    expect(await getLiveCode(p.teacher, id, { ...opts, today: addDays(TEST_TODAY, 1) })).toMatchObject({ ok: false, closed: true });
  });

  it("the live screen, planner, and reports are for runners / staff only", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    for (const who of ["member", "swLead"] as const) expect(await getRunnerSession(p[who], id, TEST_TODAY), who).toBeNull();
    expect(await getRunnerSession(p.bizLead, id, TEST_TODAY)).toMatchObject({ id, canEdit: true, canDelete: true });
    expect(await getComingOverview(p.member, TEST_TODAY)).toBeNull();
    expect(await getComingOverview(p.swLead, TEST_TODAY)).not.toBeNull();
    expect(await listReports(p.member, TEST_TODAY)).toBeNull();
    expect(await getAttendanceReport(p.member, 1, reportOpts)).toBeNull();
    expect(await getAttendanceReport(p.swLead, 1, reportOpts)).not.toBeNull();
    // Only periods from the first one to the current one.
    expect(await getAttendanceReport(p.swLead, 2, reportOpts)).toBeNull();
    expect(await getAttendanceReport(p.swLead, -1, reportOpts)).toBeNull();
    expect(await getAttendanceReport(p.swLead, 0.5, reportOpts)).toBeNull();
  });

  it("the scan landing only reads, never returns the secret, and refuses forged tokens", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const secret = await secretOf(id);
    const landing = await getScanLanding(p.member, currentCodes(secret, id, TEST_NOW).token, opts);
    expect(landing).toMatchObject({ status: "ok", isToday: true, session: { id, open: true, checkedIn: false } });
    expect(JSON.stringify(landing)).not.toContain(secret);
    expect(await t.db.attendanceRecord.count()).toBe(0);
    // This session's signature on another session's id.
    const other = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    expect((await getScanLanding(p.member, qrTokenFor(secret, other.id, slotAt(TEST_NOW)), opts)).status).toBe("invalid");
    expect((await getScanLanding(p.member, "garbage", opts)).status).toBe("invalid");
  });

  it("old sessions are read-only for student runners, and only deletable while nobody checked themselves in", async () => {
    const old = await sessionOn(addDays(TEST_TODAY, -10), "REGULAR", [{ userId: p.member.id, method: "MANUAL" }]);
    expect(await getRunnerSession(p.bizLead, old.id, TEST_TODAY)).toMatchObject({ canEdit: false, canDelete: false });
    expect(await getRunnerSession(p.teacher, old.id, TEST_TODAY)).toMatchObject({ canEdit: true, canDelete: true });
    const scanned = await sessionOn(addDays(TEST_TODAY, -2), "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    expect(await getRunnerSession(p.bizLead, scanned.id, TEST_TODAY)).toMatchObject({ canEdit: true, canDelete: false });
  });
});

describe("reports", () => {
  it("moving 'Reports start' later keeps earlier periods (negative indices)", async () => {
    const early = await sessionOn("2026-09-02", "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    await sessionOn("2026-09-15", "REGULAR");
    const before = await listReports(p.teacher, TEST_TODAY);
    expect(before?.periods.map((x) => [x.index, x.regular])).toEqual([
      [1, 1],
      [0, 1],
    ]);

    // Next season starts Monday Sep 28: today is now before the first period.
    await updateSettings(contextFor(t.db, p.teacher), { regularDays: ["1", "2", "3", "4", "5"], flexDays: ["2", "4"], reportStart: "2026-09-28" });
    const after = await listReports(p.teacher, TEST_TODAY);
    expect(after?.periods.map((x) => [x.index, x.start, x.regular, x.current])).toEqual([
      [-1, "2026-09-14", 1, true],
      [-2, "2026-08-31", 1, false],
    ]);
    const report = await getAttendanceReport(p.teacher, -2, reportOpts);
    expect(report?.data.sessions.map((s) => s.id)).toEqual([early.id]);
    expect(report).toMatchObject({ hasOlder: false, hasNewer: true });
    expect(await getAttendanceReport(p.teacher, -3, reportOpts)).toBeNull();
    expect(await getAttendanceReport(p.teacher, 0, reportOpts)).toBeNull(); // after today's period
  });

  it("counts people from the day they joined, leaves out later joiners, and ignores disabled accounts' 'said yes'", async () => {
    const newcomer = await makeUser(t.db, { name: "Newcomer" });
    await t.db.user.update({ where: { id: newcomer.id }, data: { createdAt: new Date("2026-09-16T19:00:00Z") } });
    const later = await makeUser(t.db, { name: "Later" }); // joins after period 0
    await t.db.user.update({ where: { id: later.id }, data: { createdAt: new Date("2026-09-20T19:00:00Z") } });
    const gone = await makeUser(t.db, { name: "Gone" });
    await t.db.user.update({ where: { id: gone.id }, data: { createdAt: JOINED } });

    const s1 = await sessionOn("2026-09-14", "REGULAR");
    await sessionOn("2026-09-17", "REGULAR", [{ userId: newcomer.id, method: "QR" }]);
    await sessionOn("2026-09-03", "REGULAR");
    await t.db.attendanceRsvp.create({ data: { userId: gone.id, date: dateOnlyToDb("2026-09-14"), regular: "YES" } });
    await t.db.user.update({ where: { id: gone.id }, data: { status: "DISABLED" } });

    const report = await getAttendanceReport(p.teacher, 1, reportOpts);
    const row = (id: string) => report?.data.people.find((x) => x.id === id);
    expect(row(newcomer.id)).toMatchObject({ regular: { attended: 1, held: 1 } });
    expect(row(p.member.id)).toMatchObject({ regular: { attended: 0, held: 2 } });
    expect(row(gone.id)).toBeUndefined();
    expect(report?.data.sessions.find((s) => s.id === s1.id)?.saidYes).toBe(0);

    const period0 = await getAttendanceReport(p.teacher, 0, reportOpts);
    expect(period0?.data.people.some((x) => x.id === later.id)).toBe(false);
    expect(period0?.data.people.some((x) => x.id === newcomer.id)).toBe(false);
    expect(period0?.data.people.some((x) => x.id === p.member.id)).toBe(true);

    // "Your attendance" works the same way.
    const home = await getAttendanceHome(newcomer, TEST_TODAY, TEST_TZ);
    expect(home.summary.thisPeriod.regular).toEqual({ attended: 1, held: 1 });
    await t.db.user.deleteMany({ where: { id: { in: [newcomer.id, later.id, gone.id] } } });
  });
});

describe("home, Today, and the planner", () => {
  it("runners see recent sessions (to fix them); members don't", async () => {
    await sessionOn(addDays(TEST_TODAY, -1), "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    await t.db.attendanceSession.updateMany({ data: { note: "Drive practice" } });
    await sessionOn(addDays(TEST_TODAY, -2), "FLEX");
    const runner = await getAttendanceHome(p.bizLead, TEST_TODAY, TEST_TZ);
    expect(runner.recentSessions.map((r) => [r.date, r.kind, r.count, r.hasNote])).toEqual([
      [addDays(TEST_TODAY, -1), "REGULAR", 1, true],
      [addDays(TEST_TODAY, -2), "FLEX", 0, false],
    ]);
    expect((await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ)).recentSessions).toEqual([]);
  });

  it("Today points staff to the report that just finished, for the first few days", async () => {
    await sessionOn("2026-09-15", "REGULAR");
    const monday = "2026-09-28"; // period 2 starts
    expect((await getTodayAttendance(p.swLead, monday))?.reportReady).toMatchObject({ index: 1, start: "2026-09-14" });
    expect((await getTodayAttendance(p.swLead, "2026-09-30"))?.reportReady).toMatchObject({ index: 1 });
    expect((await getTodayAttendance(p.swLead, "2026-10-01"))?.reportReady ?? null).toBeNull();
    expect((await getTodayAttendance(p.member, monday))?.reportReady ?? null).toBeNull();
    // Nothing taken in the period that ended: nothing to point to (and Sunday isn't a team day).
    expect(await getTodayAttendance(p.swLead, "2026-09-13")).toBeNull();
  });

  it("the planner tells 'no answers yet' apart from 'nobody's coming'", async () => {
    const tomorrow = addDays(TEST_TODAY, 1);
    await setRsvp(contextFor(t.db, p.member), { date: tomorrow, regular: "NO" });
    const overview = await getComingOverview(p.swLead, TEST_TODAY);
    const day = (d: string) => overview?.days.find((x) => x.date === d);
    expect(day(TEST_TODAY)).toMatchObject({ yes: 0, answered: 0 });
    expect(day(tomorrow)).toMatchObject({ yes: 0, no: 1, answered: 1 });
  });
});
