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

import type { AttendanceCreditKind, Role, Subteam } from "@/generated/prisma/enums";
import { isRegularDay } from "@/lib/attendance";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { currentCodes, newSessionSecret, qrTokenFor, slotAt } from "@/server/attendance/codes";
import {
  getAttendanceHome,
  getAttendanceReport,
  getComingOverview,
  getLiveCode,
  getMyWeeks,
  getRunnerSession,
  getScanLanding,
  getTodayAttendance,
  getTodayNoShows,
  listReports,
} from "@/server/queries/attendance";
import { getChangeFilterChoices, listAttendanceChanges, listAttendanceChangesForCsv } from "@/server/queries/attendance-changes";
import { addPerson, checkInWithCode, openSession, removePerson, setCredit, setMyCredit, setRsvp, updateSettings } from "@/server/services/attendance";
import { finishTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeTask, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

// TEST_TODAY is Thursday 2026-09-24; with the default schedule (regular meetings Mon/Tue/Thu, Flex Tue/Thu) reports
// start Mon 2026-08-31, so period 1 is Sep 14 – Sep 27 (the current one) and period 0 is Aug 31 – Sep 13.
const JOINED = new Date("2026-08-01T12:00:00Z");
const opts = { now: TEST_NOW, today: TEST_TODAY, appUrl: "https://portal.example.com" };
const reportOpts = { today: TEST_TODAY, timeZone: TEST_TZ };

let t: TestDb;
type Who = "teacher" | "bizLead" | "swLead" | "member" | "member2" | "pendingTeacher" | "mentor" | "captain" | "owner";
let p: Record<Who, Actor>;

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  const spec: Record<Who, { role: Role; subteam?: Subteam | null; status?: "PENDING"; isAdmin?: boolean }> = {
    teacher: { role: "TEACHER" },
    bizLead: { role: "BUSINESS_LEADER" },
    swLead: { role: "SOFTWARE_LEADER" },
    member: { role: "MEMBER", subteam: "BUILD" },
    member2: { role: "MEMBER", subteam: "SOFTWARE" },
    pendingTeacher: { role: "TEACHER", status: "PENDING" },
    mentor: { role: "MENTOR" },
    captain: { role: "CAPTAIN" },
    owner: { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true },
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
  await t.db.attendanceChange.deleteMany();
  await t.db.attendanceRecord.deleteMany();
  await t.db.attendanceSession.deleteMany();
  await t.db.attendanceRsvp.deleteMany();
  await t.db.attendancePlan.deleteMany();
  await t.db.rateLimit.deleteMany();
  await t.db.teamNote.deleteMany();
  await t.db.calendarEvent.deleteMany();
});

async function secretOf(id: string) {
  return (await t.db.attendanceSession.findUniqueOrThrow({ where: { id }, select: { secret: true } })).secret;
}

type RecordSpec = { userId: string; method: "QR" | "CODE" | "MANUAL"; credit?: number; creditKind?: AttendanceCreditKind };

async function sessionOn(day: string, kind: "REGULAR" | "FLEX", records: RecordSpec[] = []) {
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

  it("a session's page is for every admin (runners get the controls); the planner and reports for staff", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    for (const who of ["member", "member2"] as const) expect(await getRunnerSession(p[who], id, TEST_TODAY), who).toBeNull();
    expect(await getRunnerSession(p.bizLead, id, TEST_TODAY)).toMatchObject({ id, canRun: true, canEditNote: true, canDelete: true, canGiveExtraCredit: true });
    expect(await getRunnerSession(p.captain, id, TEST_TODAY)).toMatchObject({ canRun: true, canGiveExtraCredit: false });
    // A subteam leader fixes people and credits, without the QR code, "What we did", or delete.
    expect(await getRunnerSession(p.swLead, id, TEST_TODAY)).toMatchObject({ id, canRun: false, canEditNote: false, canDelete: false, canGiveExtraCredit: false });
    expect((await getLiveCode(p.swLead, id, opts)).ok).toBe(false);
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

  it("old sessions: 'What we did' and delete follow the week rule for student runners; only deletable while nobody checked themselves in", async () => {
    const old = await sessionOn(addDays(TEST_TODAY, -10), "REGULAR", [{ userId: p.member.id, method: "MANUAL", credit: 3 }]);
    expect(await getRunnerSession(p.bizLead, old.id, TEST_TODAY)).toMatchObject({ canEditNote: false, canDelete: false });
    expect(await getRunnerSession(p.teacher, old.id, TEST_TODAY)).toMatchObject({ canEditNote: true, canDelete: true });
    const scanned = await sessionOn(addDays(TEST_TODAY, -2), "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    expect(await getRunnerSession(p.bizLead, scanned.id, TEST_TODAY)).toMatchObject({ canEditNote: true, canDelete: false });
  });
});

describe("reports", () => {
  it("'What got done' lists items counted when a task was marked finished, never ones closed without credit", async () => {
    const lead = await makeUser(t.db, { role: "BUILD_LEADER", name: "Finish Lead" });
    const counted = await makeTask(t.db, lead, { title: "Counted for everyone", subteam: "BUILD", assigneeIds: [p.member.id] });
    const closed = await makeTask(t.db, lead, { title: "Closed without credit", subteam: "BUILD", assigneeIds: [p.member.id] });
    await finishTask(contextFor(t.db, lead), { taskId: counted.id, credit: "everyone" });
    await finishTask(contextFor(t.db, lead), { taskId: closed.id, credit: "none" });

    const report = await getAttendanceReport(p.teacher, 1, reportOpts);
    expect(report?.tasks.find((x) => x.id === counted.id)).toMatchObject({ title: "Counted for everyone", people: ["member"] });
    expect(report?.tasks.some((x) => x.id === closed.id)).toBe(false);
    await t.db.task.deleteMany({ where: { id: { in: [counted.id, closed.id] } } });
  });

  it("attendance taken on an extra meeting day counts", async () => {
    const saturday = "2026-09-19";
    await t.db.calendarEvent.create({ data: { title: "Extra build day", kind: "MEETING", startsOn: dateOnlyToDb(saturday) } });
    const extra = await sessionOn(saturday, "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    await sessionOn("2026-09-17", "REGULAR");
    const report = await getAttendanceReport(p.teacher, 1, reportOpts);
    expect(report?.data.sessions.map((s) => s.id)).toContain(extra.id);
    expect(report?.data.people.find((x) => x.id === p.member.id)).toMatchObject({ regular: { attended: 1, held: 2 } });
    expect(report?.data.sessions.map((s) => s.date)).toEqual(["2026-09-17", saturday]);
  });

  it("moving 'Reports start' later keeps earlier periods (negative indices)", async () => {
    const early = await sessionOn("2026-09-02", "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    await sessionOn("2026-09-15", "REGULAR");
    const before = await listReports(p.teacher, TEST_TODAY);
    expect(before?.periods.map((x) => [x.index, x.regular])).toEqual([
      [1, 1],
      [0, 1],
    ]);

    // Next season starts Monday Sep 28: today is now before the first period.
    await updateSettings(contextFor(t.db, p.teacher), { regularDays: ["1", "2", "4"], flexDays: ["2", "4"], reportStart: "2026-09-28" });
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
  it("admins see recent sessions (to fix them; No credit isn't counted as came); members don't", async () => {
    await sessionOn(addDays(TEST_TODAY, -1), "REGULAR", [
      { userId: p.member.id, method: "QR" },
      { userId: p.member2.id, method: "MANUAL", credit: 0 },
    ]);
    await t.db.attendanceSession.updateMany({ data: { note: "Drive practice" } });
    await sessionOn(addDays(TEST_TODAY, -2), "FLEX");
    for (const who of ["bizLead", "swLead"] as const) {
      const admin = await getAttendanceHome(p[who], TEST_TODAY, TEST_TZ);
      expect(admin.recentSessions.map((r) => [r.date, r.kind, r.count, r.hasNote]), who).toEqual([
        [addDays(TEST_TODAY, -1), "REGULAR", 1, true],
        [addDays(TEST_TODAY, -2), "FLEX", 0, false],
      ]);
      expect([admin.canFix, admin.canViewChanges], who).toEqual([true, true]);
    }
    expect((await getAttendanceHome(p.swLead, TEST_TODAY, TEST_TZ)).canRun).toBe(false);
    const member = await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ);
    expect([member.recentSessions, member.canFix, member.canViewChanges]).toEqual([[], false, false]);
    // My own "No credit" isn't a time I came.
    const home2 = await getAttendanceHome(p.member2, TEST_TODAY, TEST_TZ);
    expect(home2.summary.thisPeriod.regular).toEqual({ attended: 0, held: 1 });
    expect(home2.history).toMatchObject([{ credit: 0, method: "MANUAL" }]);
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
    const monday = addDays(TEST_TODAY, 4); // the next team day
    await setRsvp(contextFor(t.db, p.member), { date: monday, regular: "NO" });
    const overview = await getComingOverview(p.swLead, TEST_TODAY);
    const day = (d: string) => overview?.days.find((x) => x.date === d);
    expect(day(TEST_TODAY)).toMatchObject({ yes: 0, answered: 0, extraMeetings: [] });
    expect(day(monday)).toMatchObject({ yes: 0, no: 1, answered: 1 });
    // Only Mondays, Tuesdays, and Thursdays (no extra meetings here).
    expect(overview?.days.map((d) => d.date).slice(0, 4)).toEqual([TEST_TODAY, monday, addDays(TEST_TODAY, 5), addDays(TEST_TODAY, 7)]);
  });

  it("an extra meeting shows up under Coming?, on Today, and in the planner, with its title; removing it takes it off", async () => {
    const saturday = addDays(TEST_TODAY, 2);
    const sunday = addDays(TEST_TODAY, 3);
    const { id } = await t.db.calendarEvent.create({
      data: { title: "Extra build day", kind: "MEETING", startsOn: dateOnlyToDb(saturday), startTime: "09:00", endTime: "13:00" },
    });
    await t.db.calendarEvent.create({ data: { title: "Team social", kind: "TEAM", startsOn: dateOnlyToDb(sunday) } }); // not a meeting
    await setRsvp(contextFor(t.db, p.member), { date: saturday, regular: "YES", note: "Until noon" });
    const ref = [{ id, title: "Extra build day" }];

    const home = await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ);
    expect(home.days.find((d) => d.date === saturday)).toMatchObject({ regularDay: true, flexDay: false, regular: "YES", extraMeetings: ref });
    expect(home.days.find((d) => d.date === TEST_TODAY)?.extraMeetings).toEqual([]);
    expect(home.days.map((d) => d.date)).not.toContain(sunday);

    // On the day: "Coming today?", and starting Regular attendance doesn't ask "no practice today?".
    expect((await getTodayAttendance(p.member, saturday))?.day).toMatchObject({ date: saturday, regularDay: true, extraMeetings: ref });
    expect(await getTodayAttendance(p.member, sunday)).toBeNull();
    const runnerHome = await getAttendanceHome(p.teacher, saturday, TEST_TZ);
    expect(isRegularDay(runnerHome.settings, saturday)).toBe(true);
    expect(runnerHome.days[0]).toMatchObject({ date: saturday, extraMeetings: ref });

    // The planner lists it with its answers.
    const overview = await getComingOverview(p.swLead, TEST_TODAY, saturday);
    expect(overview?.days.find((d) => d.date === saturday)).toMatchObject({ regularDay: true, flexDay: false, yes: 1, answered: 1, extraMeetings: ref });
    expect(overview?.selected).toMatchObject({ date: saturday, extraMeetings: ref });
    expect(overview?.selected?.regular.YES.map((x) => [x.id, x.note])).toEqual([[p.member.id, "Until noon"]]);
    expect(overview?.selected?.regular.NONE.map((x) => x.id)).toContain(p.member2.id);

    // Removed from the calendar: the day is gone everywhere (the answer given stays in the database).
    await t.db.calendarEvent.delete({ where: { id } });
    expect((await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ)).days.map((d) => d.date)).not.toContain(saturday);
    expect(await getTodayAttendance(p.member, saturday)).toBeNull();
    expect((await getComingOverview(p.swLead, TEST_TODAY, saturday))?.selected?.date).toBe(TEST_TODAY);
    expect(await t.db.attendanceRsvp.count({ where: { date: dateOnlyToDb(saturday) } })).toBe(1);
  });

  it("Coming? and the planner list every extra meeting people can answer for, even one four weeks out", async () => {
    // With these, there are more than 14 team days ahead; the last extra meeting (Wed Oct 21) used to be cut off.
    const far = addDays(TEST_TODAY, LIMITS.rsvpDaysAhead - 1);
    for (const day of [addDays(TEST_TODAY, 2), addDays(TEST_TODAY, 9), far]) {
      await t.db.calendarEvent.create({ data: { title: `Build day ${day}`, kind: "MEETING", startsOn: dateOnlyToDb(day) } });
    }
    const home = await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ);
    const listed = home.days.map((d) => d.date);
    expect(listed).toHaveLength(16);
    expect(listed).toContain(far);
    expect(listed.at(-1)).toBe(addDays(TEST_TODAY, LIMITS.rsvpDaysAhead));
    expect(home.days.find((d) => d.date === far)?.extraMeetings.map((m) => m.title)).toEqual([`Build day ${far}`]);

    const overview = await getComingOverview(p.swLead, TEST_TODAY, far);
    expect(overview?.days.map((d) => d.date)).toEqual(listed);
    expect(overview?.selected?.date).toBe(far);
    // …the same days the services accept.
    await expect(setRsvp(contextFor(t.db, p.member), { date: far, regular: "YES" })).resolves.toMatchObject({ regular: "YES" });
    await expect(setRsvp(contextFor(t.db, p.member), { date: addDays(TEST_TODAY, LIMITS.rsvpDaysAhead + 1), regular: "YES" })).rejects.toThrow();
  });
});

describe("credits and the weekly target", () => {
  it("my week and last week add up every kind (Mon–Sun by session day); mentors and teachers have no target", async () => {
    await sessionOn("2026-09-13", "REGULAR", [{ userId: p.member.id, method: "QR" }]); // Sunday two weeks back: not counted
    await sessionOn("2026-09-14", "REGULAR", [{ userId: p.member.id, method: "QR", credit: 3 }]); // last week
    await sessionOn("2026-09-20", "FLEX", [{ userId: p.member.id, method: "QR", credit: 6, creditKind: "FLEX" }]); // last Sunday
    await sessionOn("2026-09-21", "REGULAR", [{ userId: p.member.id, method: "QR", credit: 4 }]); // this Monday
    await sessionOn("2026-09-22", "FLEX", [{ userId: p.member.id, method: "CODE", credit: 3, creditKind: "FLEX" }]);
    await sessionOn("2026-09-22", "REGULAR", [
      { userId: p.member.id, method: "MANUAL", credit: 3, creditKind: "EXTRA" },
      { userId: p.member2.id, method: "QR" },
    ]);
    const weeks = await getMyWeeks(p.member, TEST_TODAY, 2);
    expect(weeks).toEqual({
      target: 2,
      thisWeek: { start: "2026-09-21", end: "2026-09-27", credit: { total: 10, regular: 4, extra: 3, flex: 3 } },
      lastWeek: { start: "2026-09-14", end: "2026-09-20", credit: { total: 9, regular: 3, extra: 0, flex: 6 } },
    });
    // On Sunday the 27th it's still this week; on Monday the 28th it's last week.
    expect((await getMyWeeks(p.member, "2026-09-27", 2))?.thisWeek.credit.total).toBe(10);
    expect((await getMyWeeks(p.member, "2026-09-28", 2))?.lastWeek.credit.total).toBe(10);
    expect(await getMyWeeks(p.mentor, TEST_TODAY, 2)).toBeNull();
    expect(await getMyWeeks(p.teacher, TEST_TODAY, 2)).toBeNull();

    const home = await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ);
    expect(home.weeks?.thisWeek.credit.total).toBe(10);
    expect(home.weeks?.target).toBe(2);
    expect(home.history.find((h) => h.date === "2026-09-22" && h.kind === "REGULAR")).toMatchObject({ credit: 3, creditKind: "EXTRA" });
    // The saved target is used.
    await updateSettings(contextFor(t.db, p.teacher), { regularDays: ["1", "2", "4"], flexDays: ["2", "4"], reportStart: "2026-08-31", weeklyTarget: "3" });
    expect((await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ)).weeks?.target).toBe(3);
  });

  it("the week across the daylight-saving change (Sun Nov 1) is still Monday to Sunday", async () => {
    await sessionOn("2026-10-26", "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    await sessionOn("2026-11-01", "REGULAR", [{ userId: p.member.id, method: "QR", credit: 3 }]); // an extra meeting that Sunday
    await sessionOn("2026-11-02", "REGULAR", [{ userId: p.member.id, method: "QR", credit: 2 }]);
    const sunday = await getMyWeeks(p.member, "2026-11-01", 2);
    expect(sunday?.thisWeek).toEqual({ start: "2026-10-26", end: "2026-11-01", credit: { total: 9, regular: 9, extra: 0, flex: 0 } });
    const monday = await getMyWeeks(p.member, "2026-11-02", 2);
    expect(monday?.thisWeek.credit.total).toBe(2);
    expect(monday?.lastWeek.credit.total).toBe(9);
  });

  it("right after checking in, Today and the scan page show my credit (then who changed it) and my week", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    const secret = await secretOf(id);
    const token = currentCodes(secret, id, TEST_NOW).token;
    expect(await getScanLanding(p.member, token, opts)).toMatchObject({ status: "ok", session: { checkedIn: false, myCredit: null } });
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(secret, id, TEST_NOW).code });
    await setMyCredit(contextFor(t.db, p.member), { sessionId: id, option: "1/2flex" });
    const landing = await getScanLanding(p.member, token, opts);
    expect(landing).toMatchObject({
      session: { checkedIn: true, myCredit: { credit: 3, creditKind: "FLEX", option: "1/2flex", method: "CODE", changedByName: null } },
    });

    const today = await getTodayAttendance(p.member, TEST_TODAY);
    expect(today?.checkedInSessions.map((s) => [s.id, s.myCredit?.option])).toEqual([[id, "1/2flex"]]);
    expect(today?.week).toMatchObject({ start: "2026-09-21", target: 2, credit: { total: 3 } });

    await setCredit({ ...contextFor(t.db, p.bizLead), now: TEST_NOW }, { sessionId: id, userId: p.member.id, option: "1ec" });
    const after = await getTodayAttendance(p.member, TEST_TODAY);
    expect(after?.checkedInSessions[0].myCredit).toMatchObject({ option: "1ec", changedByName: "bizLead", changedAt: TEST_NOW });
    expect(after?.week?.credit).toEqual({ total: 6, regular: 0, extra: 6, flex: 0 });
    expect((await getTodayAttendance(p.mentor, TEST_TODAY))?.week ?? null).toBeNull();

    // Marked "No credit": on the list (the card says who), but not checked in — scanning is still open to them.
    await setCredit(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member.id, option: "none" });
    const marked = await getTodayAttendance(p.member, TEST_TODAY);
    expect(marked?.checkedInSessions).toEqual([]);
    expect(marked?.creditSessions.map((s) => [s.checkedIn, s.myCredit?.option, s.myCredit?.changedByName])).toEqual([[false, "none", "bizLead"]]);
    expect(marked?.openSessions.map((s) => s.checkedIn)).toEqual([false]);
    expect(await getScanLanding(p.member, token, opts)).toMatchObject({ session: { checkedIn: false, myCredit: { credit: 0, option: "none" } } });
  });

  it("someone added by hand isn't 'checked in' (the scan buttons stay, the card knows a scan counts); scanning makes them checked in", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const secret = await secretOf(id);
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member.id, option: "1/2" });
    const today = await getTodayAttendance(p.member, TEST_TODAY);
    expect(today?.checkedInSessions).toEqual([]);
    expect(today?.openSessions.map((s) => s.checkedIn)).toEqual([false]);
    expect(today?.creditSessions[0].myCredit).toMatchObject({ method: "MANUAL", option: "1/2", changedByName: "bizLead", untouchedByHand: true });
    expect((await getAttendanceHome(p.member, TEST_TODAY, TEST_TZ)).sessions.map((s) => s.checkedIn)).toEqual([false]);
    const token = currentCodes(secret, id, TEST_NOW).token;
    expect(await getScanLanding(p.member, token, opts)).toMatchObject({ session: { checkedIn: false, myCredit: { method: "MANUAL" } } });
    // Changed by another admin since: no longer "as it was added".
    await setCredit({ ...contextFor(t.db, p.captain), now: new Date(TEST_NOW.getTime() + 60_000) }, { sessionId: id, userId: p.member.id, option: "2/3" });
    expect((await getTodayAttendance(p.member, TEST_TODAY))?.creditSessions[0].myCredit?.untouchedByHand).toBe(false);
    // Scanning in: checked in now (a scan, the admin's 2/3 kept).
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(secret, id, TEST_NOW).code });
    const after = await getTodayAttendance(p.member, TEST_TODAY);
    expect(after?.checkedInSessions.map((s) => [s.myCredit?.method, s.myCredit?.option])).toEqual([["CODE", "2/3"]]);
  });

  it("the live screen counts scans apart from people added by hand, and never lists who started it as a no-show", async () => {
    await setRsvp(contextFor(t.db, p.bizLead), { date: TEST_TODAY, regular: "YES" });
    await setRsvp(contextFor(t.db, p.member), { date: TEST_TODAY, regular: "YES" });
    const { id } = await openSession(contextFor(t.db, p.bizLead), { kind: "REGULAR" });
    expect((await getRunnerSession(p.swLead, id, TEST_TODAY))?.noShows.map((x) => x.name)).toEqual(["member"]);
    expect((await getTodayNoShows(p.swLead, TEST_TODAY))?.sessions[0].people.map((x) => x.name)).toEqual(["member"]);
    await checkInWithCode(contextFor(t.db, p.member2), { code: currentCodes(await secretOf(id), id, TEST_NOW).code });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member.id, option: "1/3" });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: id, userId: p.captain.id, option: "none" });
    expect(await getRunnerSession(p.bizLead, id, TEST_TODAY)).toMatchObject({ count: 2, scannedCount: 1, handCount: 1, saidYesCount: 2 });
  });

  it("admins find a session left open on an earlier day (to close it)", async () => {
    const s = await sessionOn(addDays(TEST_TODAY, -1), "REGULAR");
    await sessionOn(addDays(TEST_TODAY, -2), "REGULAR");
    await t.db.attendanceSession.update({ where: { id: s.id }, data: { closedAt: null } });
    expect((await getAttendanceHome(p.teacher, TEST_TODAY, TEST_TZ)).recentSessions.map((r) => r.open)).toEqual([true, false]);
    expect(await getRunnerSession(p.teacher, s.id, TEST_TODAY)).toMatchObject({ open: true, isToday: false, canRun: true });
  });

  it("the live screen shows each person's credit, who changed it, and their week", async () => {
    await sessionOn("2026-09-21", "REGULAR", [{ userId: p.member.id, method: "QR", credit: 3 }]);
    await sessionOn("2026-09-14", "REGULAR", [{ userId: p.member.id, method: "QR" }]); // last week: not counted
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(await secretOf(id), id, TEST_NOW).code });
    await checkInWithCode(contextFor(t.db, p.member2), { code: currentCodes(await secretOf(id), id, TEST_NOW).code });
    await setCredit(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member2.id, option: "1/3" });
    const session = await getRunnerSession(p.teacher, id, TEST_TODAY);
    expect(session).toMatchObject({ week: { start: "2026-09-21", end: "2026-09-27" }, weeklyTarget: 2 });
    const row = (userId: string) => session?.roster.find((r) => r.id === userId);
    expect(row(p.member.id)).toMatchObject({
      credit: { credit: 6, creditKind: "REGULAR", option: "1", changedByName: null },
      week: { total: 9, regular: 9 },
    });
    expect(row(p.member2.id)).toMatchObject({ credit: { option: "1/3", changedByName: "bizLead" }, week: { total: 2 } });
  });

  it("Who's coming shows each person's week so far for the picked day's week", async () => {
    await sessionOn("2026-09-21", "REGULAR", [
      { userId: p.member.id, method: "QR" },
      { userId: p.member2.id, method: "QR", credit: 3, creditKind: "EXTRA" },
    ]);
    await sessionOn("2026-09-22", "FLEX", [{ userId: p.member.id, method: "QR", credit: 6, creditKind: "FLEX" }]);
    const overview = await getComingOverview(p.swLead, TEST_TODAY, TEST_TODAY);
    expect(overview).toMatchObject({ week: { start: "2026-09-21", end: "2026-09-27" }, weeklyTarget: 2 });
    const none = overview?.selected?.regular.NONE ?? [];
    expect(none.find((x) => x.id === p.member.id)?.week).toEqual({ total: 12, regular: 6, extra: 0, flex: 6 });
    expect(none.find((x) => x.id === p.member2.id)?.week.total).toBe(3);
    // Next week starts from nothing.
    const monday = addDays(TEST_TODAY, 4);
    const next = await getComingOverview(p.swLead, TEST_TODAY, monday);
    expect(next?.week?.start).toBe(monday);
    expect(next?.selected?.regular.NONE.find((x) => x.id === p.member.id)?.week.total).toBe(0);
  });

  it("the two-week report has each person's week 1 and week 2", async () => {
    await sessionOn("2026-09-15", "REGULAR", [{ userId: p.member.id, method: "QR", credit: 4 }]);
    await sessionOn("2026-09-17", "FLEX", [{ userId: p.member.id, method: "QR", credit: 3, creditKind: "FLEX" }]);
    await sessionOn("2026-09-22", "REGULAR", [{ userId: p.member.id, method: "QR" }, { userId: p.member2.id, method: "QR", credit: 6, creditKind: "EXTRA" }]);
    await sessionOn("2026-09-24", "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    const report = await getAttendanceReport(p.teacher, 1, reportOpts);
    expect(report?.data.weeks).toEqual([
      { start: "2026-09-14", end: "2026-09-20" },
      { start: "2026-09-21", end: "2026-09-27" },
    ]);
    expect(report?.data.weeklyTarget).toBe(2);
    const row = (id: string) => report?.data.people.find((x) => x.id === id);
    expect(row(p.member.id)?.weeks.map((w) => w.total)).toEqual([7, 12]);
    expect(row(p.member2.id)?.weeks).toEqual([
      { total: 0, regular: 0, extra: 0, flex: 0 },
      { total: 6, regular: 0, extra: 6, flex: 0 },
    ]);
    expect(row(p.member.id)).toMatchObject({ regular: { attended: 3, held: 3 }, flex: { attended: 1, held: 1 } });
  });
});

describe("no-shows on a session's page and on Today (admins)", () => {
  it("lists who said they'd come and isn't on the list, until they check in or an admin deals with them", async () => {
    await setRsvp(contextFor(t.db, p.member), { date: TEST_TODAY, regular: "YES", flex: "YES" });
    await setRsvp(contextFor(t.db, p.member2), { date: TEST_TODAY, regular: "HALF", note: "Leaving at 5" });
    const regular = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const flex = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });

    const page = await getRunnerSession(p.swLead, regular.id, TEST_TODAY);
    expect(page?.noShows.map((x) => [x.name, x.answer, x.note])).toEqual([
      ["member", "YES", ""],
      ["member2", "HALF", "Leaving at 5"],
    ]);
    expect(page?.saidYesCount).toBe(2);

    const today = await getTodayNoShows(p.swLead, TEST_TODAY);
    expect(today).toMatchObject({ anyMissing: true, canGiveExtraCredit: false });
    expect(today?.sessions.map((s) => [s.kind, s.open, s.people.map((x) => x.name)])).toEqual([
      ["REGULAR", true, ["member", "member2"]],
      ["FLEX", true, ["member"]],
    ]);
    expect((await getTodayNoShows(p.bizLead, TEST_TODAY))?.canGiveExtraCredit).toBe(true);
    for (const who of ["member", "member2"] as const) expect(await getTodayNoShows(p[who], TEST_TODAY), who).toBeNull();
    // No session that day: nothing.
    expect(await getTodayNoShows(p.swLead, addDays(TEST_TODAY, 4))).toBeNull();

    // Checked in, and marked No credit: dealt with. The page counts only who came, and lists the No credit apart.
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(await secretOf(regular.id), regular.id, TEST_NOW).code });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: regular.id, userId: p.member2.id, option: "none" });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: flex.id, userId: p.member.id, option: "1/2" });
    const after = await getRunnerSession(p.swLead, regular.id, TEST_TODAY);
    expect(after?.noShows).toEqual([]);
    expect(after?.count).toBe(1);
    expect(after?.roster.map((r) => [r.name, r.method, r.credit.option])).toEqual(
      expect.arrayContaining([
        ["member", "CODE", "1"],
        ["member2", "MANUAL", "none"],
      ]),
    );
    expect(await getTodayNoShows(p.swLead, TEST_TODAY)).toMatchObject({ anyMissing: false });
    // And the session's History shows the admins' changes.
    expect(after?.history.map((c) => [c.action, c.userName, c.changedByName, c.toCredit])).toEqual([["ADDED", "member2", "swLead", 0]]);
  });
});

describe("the change log (/attendance/changes)", () => {
  async function someChanges() {
    const a = await sessionOn("2026-09-15", "REGULAR", [{ userId: p.member.id, method: "QR" }]);
    const b = await sessionOn("2026-09-22", "FLEX", [{ userId: p.member2.id, method: "QR", credit: 6, creditKind: "FLEX" }]);
    const early = { ...contextFor(t.db, p.swLead), now: new Date(TEST_NOW.getTime() - 60_000) };
    await setCredit(early, { sessionId: a.id, userId: p.member.id, option: "1/2" }); // oldest
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: a.id, userId: p.member2.id, option: "1ec" });
    await setCredit({ ...contextFor(t.db, p.teacher), now: new Date(TEST_NOW.getTime() + 60_000) }, { sessionId: b.id, userId: p.member2.id, option: "none" });
    await removePerson({ ...contextFor(t.db, p.teacher), now: new Date(TEST_NOW.getTime() + 120_000) }, { sessionId: a.id, userId: p.member.id }); // newest
    return { a, b };
  }

  it("admins only: newest first, as sentences' data, with each filter", async () => {
    await someChanges();
    const all = { page: 1 };
    for (const who of ["member", "member2", "pendingTeacher"] as const) {
      expect(await listAttendanceChanges(p[who], all), who).toBeNull();
      expect(await getChangeFilterChoices(p[who]), who).toBeNull();
      expect(await listAttendanceChangesForCsv(p[who], all), who).toBeNull();
    }
    const list = await listAttendanceChanges(p.swLead, all);
    expect(list).toMatchObject({ total: 4, page: 1, pageCount: 1 });
    expect(list?.rows.map((r) => [r.action, r.userName, r.changedByName, r.sessionDate])).toEqual([
      ["REMOVED", "member", "teacher", "2026-09-15"],
      ["CREDIT_CHANGED", "member2", "teacher", "2026-09-22"],
      ["ADDED", "member2", "bizLead", "2026-09-15"],
      ["CREDIT_CHANGED", "member", "swLead", "2026-09-15"],
    ]);
    const only = async (f: Partial<Parameters<typeof listAttendanceChanges>[1]>) =>
      (await listAttendanceChanges(p.mentor, { page: 1, ...f }))?.rows.map((r) => [r.action, r.userName]);
    expect(await only({ person: p.member2.id })).toEqual([
      ["CREDIT_CHANGED", "member2"],
      ["ADDED", "member2"],
    ]);
    expect(await only({ by: p.teacher.id })).toEqual([
      ["REMOVED", "member"],
      ["CREDIT_CHANGED", "member2"],
    ]);
    expect(await only({ action: "ADDED" })).toEqual([["ADDED", "member2"]]);
    // Dates are the attendance's day.
    expect(await only({ from: "2026-09-20" })).toEqual([["CREDIT_CHANGED", "member2"]]);
    expect(await only({ to: "2026-09-15", action: "CREDIT_CHANGED" })).toEqual([["CREDIT_CHANGED", "member"]]);
    expect(await only({ from: "2026-09-16", to: "2026-09-21" })).toEqual([]);
    expect(await only({ person: "nobody" })).toEqual([]);
    expect(list?.rows.map((r) => r.changedById)).toEqual([p.teacher.id, p.teacher.id, p.bizLead.id, p.swLead.id]);

    // The menus offer only people in the log.
    expect(await getChangeFilterChoices(p.owner)).toEqual({
      people: [
        { id: p.member.id, name: "member" },
        { id: p.member2.id, name: "member2" },
      ],
      admins: [
        { id: p.bizLead.id, name: "bizLead" },
        { id: p.swLead.id, name: "swLead" },
        { id: p.teacher.id, name: "teacher" },
      ],
    });
    // The CSV gets everything matching (the same order).
    expect((await listAttendanceChangesForCsv(p.captain, { page: 1, by: p.teacher.id }))?.map((r) => r.action)).toEqual(["REMOVED", "CREDIT_CHANGED"]);
  });

  it("the kind filter tells 'marked not here' and 'scanned in' apart from added by hand and credit changed", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member.id, option: "none" });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member2.id, option: "1/3" });
    const later = { ...contextFor(t.db, p.member), now: new Date(TEST_NOW.getTime() + 60_000) };
    await checkInWithCode(later, { code: currentCodes(await secretOf(id), id, later.now).code });
    await setCredit({ ...contextFor(t.db, p.bizLead), now: new Date(TEST_NOW.getTime() + 120_000) }, { sessionId: id, userId: p.member2.id, option: "2/3" });
    const kinds = async (f: Partial<Parameters<typeof listAttendanceChanges>[1]>) =>
      (await listAttendanceChanges(p.teacher, { page: 1, ...f }))?.rows.map((r) => [r.action, r.userName, r.changedByName]);
    expect(await kinds({ action: "NOT_HERE" })).toEqual([["ADDED", "member", "swLead"]]);
    expect(await kinds({ action: "ADDED" })).toEqual([["ADDED", "member2", "swLead"]]);
    expect(await kinds({ action: "SCANNED_IN" })).toEqual([["CREDIT_CHANGED", "member", "member"]]);
    expect(await kinds({ action: "CREDIT_CHANGED" })).toEqual([["CREDIT_CHANGED", "member2", "bizLead"]]);
    expect(await kinds({ action: "SCANNED_IN", by: p.member.id })).toHaveLength(1);
    expect(await kinds({ action: "SCANNED_IN", by: p.swLead.id })).toEqual([]);
    expect(await kinds({ action: "CREDIT_CHANGED", person: p.member.id })).toEqual([]);
  });

  it("pages of 50 (a page past the end shows the last one)", async () => {
    const s = await sessionOn("2026-09-15", "REGULAR");
    await t.db.attendanceChange.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        sessionId: s.id,
        sessionDate: dateOnlyToDb("2026-09-15"),
        sessionKind: "REGULAR" as const,
        userId: p.member.id,
        userName: "member",
        changedById: p.teacher.id,
        action: "CREDIT_CHANGED" as const,
        fromCredit: 6,
        fromKind: "REGULAR" as const,
        toCredit: 3,
        toKind: "REGULAR" as const,
        createdAt: new Date(TEST_NOW.getTime() - i * 1000),
      })),
    });
    const first = await listAttendanceChanges(p.teacher, { page: 1 });
    expect(first).toMatchObject({ total: 55, page: 1, pageCount: 2 });
    expect(first?.rows).toHaveLength(50);
    const second = await listAttendanceChanges(p.teacher, { page: 9 });
    expect(second).toMatchObject({ page: 2 });
    expect(second?.rows).toHaveLength(5);
    expect(second?.rows.at(-1)?.createdAt).toEqual(new Date(TEST_NOW.getTime() - 54_000));
  });

  it("the two-week report lists its period's changes (by the attendance's day), and No credit counts as not coming", async () => {
    const { a } = await someChanges();
    await setRsvp(
      { ...contextFor(t.db, p.member), now: new Date("2026-09-14T19:00:00Z") },
      { date: "2026-09-15", regular: "YES" },
    );
    const report = await getAttendanceReport(p.swLead, 1, reportOpts);
    expect(report?.changes?.total).toBe(4);
    expect(report?.changes?.rows.map((r) => r.action)).toEqual(["REMOVED", "CREDIT_CHANGED", "ADDED", "CREDIT_CHANGED"]);
    const earlier = await getAttendanceReport(p.swLead, 0, reportOpts);
    expect(earlier?.changes).toEqual({ rows: [], total: 0 });
    // The CSV can ask for more (or fewer) than the page shows; the total stays.
    const two = await getAttendanceReport(p.swLead, 1, { ...reportOpts, changesMax: 2 });
    expect([two?.changes?.rows.length, two?.changes?.total]).toEqual([2, 4]);
    // member was taken off; member2 came with 1 EC on the 15th, and got No credit on the 22nd (Flex).
    const row = (id: string) => report?.data.people.find((x) => x.id === id);
    expect(row(p.member.id)).toMatchObject({ regular: { attended: 0, held: 1 }, saidYesMissed: 1 });
    expect(row(p.member2.id)).toMatchObject({ regular: { attended: 1, held: 1 }, flex: { attended: 0, held: 1 } });
    expect(row(p.member2.id)?.weeks.map((w) => w.total)).toEqual([6, 0]);
    expect(report?.data.sessions.find((x) => x.id === a.id)).toMatchObject({ present: 1 });
  });
});
