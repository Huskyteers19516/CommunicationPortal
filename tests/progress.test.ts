import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssignmentStatus } from "@/generated/prisma/enums";
import { addDays, type DateOnly } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import {
  completionRate,
  getMemberProgress,
  getOverview,
  getTeamProgress,
  parseProgressRange,
  parseSubteamFilter,
  progressRangeBounds,
  TEAM_PROGRESS_PAGE_SIZE,
} from "@/server/queries/progress";
import { getReviewQueue } from "@/server/queries/tasks";
import { finishTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeTask, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let p: Record<
  | "captain"
  | "mentor"
  | "buildLead"
  | "swLead"
  | "buildA"
  | "buildB"
  | "swA"
  | "bizA"
  | "disabledBuild"
  | "pendingBuildLead",
  Actor
>;
let tasks: Record<string, { id: string }>;

const d = (n: number): DateOnly => addDays(TEST_TODAY, n);
const minutesAgo = (m: number) => new Date(TEST_NOW.getTime() - m * 60_000);

async function setStatus(
  taskId: string,
  userId: string,
  status: AssignmentStatus,
  times: { submittedAt?: Date; reviewedAt?: Date; reviewedById?: string; reviewNote?: string } = {},
) {
  await t.db.taskAssignment.update({ where: { taskId_userId: { taskId, userId } }, data: { status, ...times } });
}

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    captain: await makeUser(db, { role: "CAPTAIN", name: "Cameron Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Morgan Mentor" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Casey Lead" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    buildA: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Alex Builder" }),
    buildB: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "blake Builder" }), // lower-case: sort ignores case
    swA: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Riley Coder" }),
    bizA: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Dana Biz" }),
    disabledBuild: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Old Builder" }),
    pendingBuildLead: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING", name: "Pending Lead" }),
  };

  // Tasks spread over several days relative to TEST_TODAY (2026-09-24).
  tasks = {
    t1: await makeTask(db, p.buildLead, { title: "Build today", subteam: "BUILD", dueDate: d(0), assigneeIds: [p.buildA.id, p.buildB.id, p.buildLead.id] }),
    t2: await makeTask(db, p.swLead, { title: "Software today", subteam: "SOFTWARE", dueDate: d(0), assigneeIds: [p.swA.id] }),
    t3: await makeTask(db, p.captain, { title: "Team today", subteam: null, dueDate: d(0), priority: "HIGH", assigneeIds: [p.buildA.id, p.swA.id, p.bizA.id] }),
    t4: await makeTask(db, p.buildLead, { title: "Build yesterday", subteam: "BUILD", dueDate: d(-1), assigneeIds: [p.buildA.id, p.buildB.id, p.disabledBuild.id] }),
    t5: await makeTask(db, p.buildLead, { title: "Build week edge", subteam: "BUILD", dueDate: d(-6), assigneeIds: [p.buildA.id, p.buildB.id] }),
    t6: await makeTask(db, p.buildLead, { title: "Build past week", subteam: "BUILD", dueDate: d(-7), assigneeIds: [p.buildA.id, p.buildB.id] }),
    t7: await makeTask(db, p.swLead, { title: "Software month edge", subteam: "SOFTWARE", dueDate: d(-29), assigneeIds: [p.swA.id] }),
    t8: await makeTask(db, p.swLead, { title: "Software past month", subteam: "SOFTWARE", dueDate: d(-30), assigneeIds: [p.swA.id] }),
    t9: await makeTask(db, p.buildLead, { title: "Build tomorrow", subteam: "BUILD", dueDate: d(1), assigneeIds: [p.buildA.id] }),
    t10: await makeTask(db, p.captain, { title: "Captain build task", subteam: "BUILD", dueDate: d(-2), assigneeIds: [p.buildA.id] }),
  };
  const { t1, t3, t4, t5, t6, t7, t10 } = tasks;

  // t1 (today): buildA approved, buildB submitted, buildLead to do.
  await setStatus(t1.id, p.buildA.id, "APPROVED", { submittedAt: minutesAgo(120), reviewedAt: minutesAgo(60), reviewedById: p.buildLead.id });
  await setStatus(t1.id, p.buildB.id, "SUBMITTED", { submittedAt: minutesAgo(30) });
  // t2 (today): swA to do.
  // t3 (today, whole team): buildA submitted, swA approved, bizA to do.
  await setStatus(t3.id, p.buildA.id, "SUBMITTED", { submittedAt: minutesAgo(10) });
  await setStatus(t3.id, p.swA.id, "APPROVED", { submittedAt: minutesAgo(20), reviewedAt: minutesAgo(5), reviewedById: p.captain.id });
  // t4 (yesterday): buildA to do (overdue), buildB sent back (overdue), disabled member to do (not counted).
  await setStatus(t4.id, p.buildB.id, "REJECTED", {
    submittedAt: minutesAgo(3000),
    reviewedAt: minutesAgo(1440),
    reviewedById: p.buildLead.id,
    reviewNote: "Add photos please",
  });
  // t5 (6 days ago): buildA submitted (not overdue — waiting on review), buildB approved.
  await setStatus(t5.id, p.buildA.id, "SUBMITTED", { submittedAt: minutesAgo(4320) });
  await setStatus(t5.id, p.buildB.id, "APPROVED", { submittedAt: minutesAgo(6000), reviewedAt: minutesAgo(5760) });
  // t6 (7 days ago): buildA to do (overdue), buildB approved.
  await setStatus(t6.id, p.buildB.id, "APPROVED", { submittedAt: minutesAgo(8000), reviewedAt: minutesAgo(7200) });
  // t7 (29 days ago): swA sent back (overdue). t8 (30 days ago): swA to do (overdue).
  await setStatus(t7.id, p.swA.id, "REJECTED", { submittedAt: minutesAgo(9000), reviewedAt: minutesAgo(8640) });
  // t9 (tomorrow): buildA to do (not overdue).
  // t10 (2 days ago, BUILD task by the captain): buildA approved.
  await setStatus(t10.id, p.buildA.id, "APPROVED", { submittedAt: minutesAgo(3000), reviewedAt: minutesAgo(2880), reviewedById: p.captain.id });

  // Questions: one open per subteam inbox, plus one already answered.
  await db.question.create({ data: { title: "Build q", body: "b", askerId: p.buildA.id, subteam: "BUILD" } });
  await db.question.create({ data: { title: "Software q", body: "b", askerId: p.swA.id, subteam: "SOFTWARE" } });
  await db.question.create({ data: { title: "Answered", body: "b", askerId: p.buildB.id, subteam: "BUILD", status: "ANSWERED" } });

  await db.user.update({ where: { id: p.buildA.id }, data: { lastSeenAt: minutesAgo(90) } });
});

afterAll(async () => {
  await t?.drop();
});

describe("range helpers", () => {
  it("parses ranges and subteams defensively", () => {
    expect(parseProgressRange("today")).toBe("today");
    expect(parseProgressRange("month")).toBe("month");
    expect(parseProgressRange(["week", "today"])).toBe("week");
    expect(parseProgressRange("year")).toBe("week");
    expect(parseProgressRange(undefined)).toBe("week");
    expect(parseSubteamFilter("BUILD")).toBe("BUILD");
    expect(parseSubteamFilter("build")).toBeUndefined();
    expect(parseSubteamFilter("")).toBeUndefined();
  });

  it("computes inclusive day bounds", () => {
    expect(progressRangeBounds("today", TEST_TODAY)).toEqual({ from: "2026-09-24", to: "2026-09-24" });
    expect(progressRangeBounds("week", TEST_TODAY)).toEqual({ from: "2026-09-18", to: "2026-09-24" });
    expect(progressRangeBounds("month", TEST_TODAY)).toEqual({ from: "2026-08-26", to: "2026-09-24" });
  });

  it("completion rate handles zero totals", () => {
    expect(completionRate(0, 0)).toBeNull();
    expect(completionRate(0, 4)).toBe(0);
    expect(completionRate(1, 3)).toBe(33);
    expect(completionRate(2, 3)).toBe(67);
    expect(completionRate(5, 5)).toBe(100);
  });
});

describe("getOverview", () => {
  it("scopes a subteam leader to their own subteam", async () => {
    const o = await getOverview(p.buildLead, TEST_TODAY, t.db);
    // Build tasks with SUBMITTED items (t1 buildB, t5 buildA), plus their own member's item on the
    // whole-team t3 (buildA) — subteam leaders review those too.
    expect(o.reviewQueueCount).toBe(3);
    expect(o.openQuestionCount).toBe(1);
    // Build people's items due today: t1 x3 + t3 buildA.
    expect(o.dueToday).toEqual({ total: 4, approved: 1, submitted: 2 });
    // buildA: t4 + t6, buildB: t4 (REJECTED). Disabled member and submitted/approved items don't count.
    expect(o.overdueOpenCount).toBe(3);
    expect(o.todaysTasks.map((x) => x.title)).toEqual(["Build today"]);
    expect(o.todaysTaskTotal).toBe(1);
    expect(o.todaysTasks[0].counts).toEqual({ total: 3, approved: 1, submitted: 1, rejected: 0, todo: 1, closed: 0 });
    expect(o.attention.map((a) => [a.name, a.overdueCount])).toEqual([
      ["Alex Builder", 2],
      ["blake Builder", 1],
    ]);
  });

  it("gives the captain the whole team", async () => {
    const o = await getOverview(p.captain, TEST_TODAY, t.db);
    expect(o.reviewQueueCount).toBe(3);
    expect(o.openQuestionCount).toBe(2);
    expect(o.dueToday).toEqual({ total: 7, approved: 2, submitted: 2 });
    expect(o.overdueOpenCount).toBe(5); // + swA t7 (REJECTED) and t8 (TODO)
    // High priority first.
    expect(o.todaysTasks.map((x) => x.title)).toEqual(["Team today", "Build today", "Software today"]);
    expect(o.todaysTasks[0].counts).toEqual({ total: 3, approved: 1, submitted: 1, rejected: 0, todo: 1, closed: 0 });
    expect(o.attention).toHaveLength(3);
    expect(o.attention[0].overdueCount).toBe(2);
    expect(new Set(o.attention.slice(0, 2).map((a) => a.id))).toEqual(new Set([p.buildA.id, p.swA.id]));
    expect(o.attention[2]).toMatchObject({ id: p.buildB.id, overdueCount: 1 });
  });

  it("mentor sees the same whole-team numbers", async () => {
    const o = await getOverview(p.mentor, TEST_TODAY, t.db);
    expect(o.dueToday.total).toBe(7);
    expect(o.overdueOpenCount).toBe(5);
    expect(o.todaysTaskTotal).toBe(3);
  });

  it("lists recent submissions and reviews in scope, newest first", async () => {
    const lead = await getOverview(p.buildLead, TEST_TODAY, t.db);
    expect(lead.recentActivity.map((a) => [a.task.title, a.person.name, a.status])).toEqual([
      ["Team today", "Alex Builder", "SUBMITTED"], // 10 min ago — whole-team task, but it's their member
      ["Build today", "blake Builder", "SUBMITTED"], // 30 min
      ["Build today", "Alex Builder", "APPROVED"], // 60 min
      ["Build yesterday", "blake Builder", "REJECTED"], // 1 day
      ["Captain build task", "Alex Builder", "APPROVED"], // 2 days
      ["Build week edge", "Alex Builder", "SUBMITTED"], // 3 days
      ["Build week edge", "blake Builder", "APPROVED"], // 4 days
      ["Build past week", "blake Builder", "APPROVED"], // 5 days
    ]);
    // Nothing from the software subteam leaks in.
    expect(lead.recentActivity.some((a) => a.person.id === p.swA.id)).toBe(false);
    const first = lead.recentActivity[0];
    expect(first.at).toEqual(minutesAgo(10));
    expect(first.canManageTask).toBe(false); // whole-team task created by the captain
    expect(first.canViewPerson).toBe(true);
    const approved = lead.recentActivity[2];
    expect(approved.at).toEqual(minutesAgo(60)); // reviewedAt, not submittedAt
    expect(approved.reviewerName).toBe("Casey Lead");
    expect(approved.canManageTask).toBe(true);

    const captain = await getOverview(p.captain, TEST_TODAY, t.db);
    expect(captain.recentActivity).toHaveLength(10);
    expect(captain.recentActivity[0]).toMatchObject({ status: "APPROVED", person: { id: p.swA.id }, reviewerName: "Cameron Captain" });
    expect(captain.recentActivity.every((a) => a.canManageTask && a.canViewPerson)).toBe(true);
  });

  it("returns nothing for a plain member", async () => {
    const o = await getOverview(p.buildA, TEST_TODAY, t.db);
    expect(o).toMatchObject({
      reviewQueueCount: 0,
      openQuestionCount: 0,
      dueToday: { total: 0, approved: 0, submitted: 0 },
      overdueOpenCount: 0,
      todaysTasks: [],
      todaysTaskTotal: 0,
      attention: [],
      recentActivity: [],
    });
  });
});

describe("getTeamProgress", () => {
  it("counts the week (today-6..today inclusive) for a subteam leader", async () => {
    const tp = await getTeamProgress(p.buildLead, { range: "week" }, TEST_TODAY, t.db);
    expect(tp).toMatchObject({ range: "week", from: "2026-09-18", to: "2026-09-24", subteam: "BUILD", canFilterSubteam: false });
    // Members AND the leader, ACTIVE only, sorted by name (case-insensitive).
    expect(tp.rows.map((r) => r.user.name)).toEqual(["Alex Builder", "blake Builder", "Casey Lead"]);
    const [alex, blake, casey] = tp.rows;
    // Alex: t1 approved, t3 submitted, t4 todo, t5 submitted (6 days ago = edge), t10 approved. Not t6 (7 days) or t9 (tomorrow).
    expect(alex).toMatchObject({ total: 5, approved: 2, submitted: 2, rejected: 0, todo: 1, overdue: 2, completionRate: 40 });
    expect(alex.user.lastSeenAt).toEqual(minutesAgo(90));
    expect(blake).toMatchObject({ total: 3, approved: 1, submitted: 1, rejected: 1, todo: 0, overdue: 1, completionRate: 33 });
    expect(casey).toMatchObject({ total: 1, approved: 0, todo: 1, overdue: 0, completionRate: 0 });
    expect(casey.user.lastSeenAt).toBeNull();
    expect(tp.totals).toMatchObject({ total: 9, approved: 3, submitted: 3, overdue: 3, completionRate: 33 });
    expect(tp.subteams.map((s) => s.subteam)).toEqual(["BUILD"]);
    expect(tp.subteams[0]).toMatchObject({ people: 3, total: 9, approved: 3 });
  });

  it("today and month ranges are inclusive, overdue ignores the range", async () => {
    const today = await getTeamProgress(p.buildLead, { range: "today" }, TEST_TODAY, t.db);
    const alexToday = today.rows.find((r) => r.user.id === p.buildA.id)!;
    expect(alexToday).toMatchObject({ total: 2, approved: 1, submitted: 1, overdue: 2 });

    const month = await getTeamProgress(p.buildLead, { range: "month" }, TEST_TODAY, t.db);
    const alexMonth = month.rows.find((r) => r.user.id === p.buildA.id)!;
    expect(alexMonth).toMatchObject({ total: 6, overdue: 2 }); // + t6

    const capMonth = await getTeamProgress(p.captain, { range: "month" }, TEST_TODAY, t.db);
    const riley = capMonth.rows.find((r) => r.user.id === p.swA.id)!;
    // t2, t3 (today), t7 (29 days ago = edge). t8 (30 days ago) is outside but still overdue.
    expect(riley).toMatchObject({ total: 3, approved: 1, rejected: 1, todo: 1, overdue: 2 });
    const capWeek = await getTeamProgress(p.captain, { range: "week" }, TEST_TODAY, t.db);
    expect(capWeek.rows.find((r) => r.user.id === p.swA.id)).toMatchObject({ total: 2, overdue: 2 });
  });

  it("a subteam leader cannot switch subteams via the URL", async () => {
    const tp = await getTeamProgress(p.buildLead, { range: "week", subteam: "SOFTWARE" }, TEST_TODAY, t.db);
    expect(tp.subteam).toBe("BUILD");
    expect(tp.rows.every((r) => r.user.subteam === "BUILD")).toBe(true);
    expect(tp.rows.map((r) => r.user.id)).not.toContain(p.swA.id);
    expect(tp.subteams.map((s) => s.subteam)).toEqual(["BUILD"]);

    const sw = await getTeamProgress(p.swLead, { subteam: "BUILD" }, TEST_TODAY, t.db);
    expect(sw.rows.map((r) => r.user.name)).toEqual(["Riley Coder", "Sam Lead"]);
  });

  it("all-scope staff see everyone and may filter by subteam", async () => {
    const tp = await getTeamProgress(p.captain, { range: "week" }, TEST_TODAY, t.db);
    expect(tp.canFilterSubteam).toBe(true);
    expect(tp.subteam).toBeNull();
    // Software, Build, Business, then people without a subteam. Disabled/pending accounts are left out.
    expect(tp.rows.map((r) => r.user.name)).toEqual([
      "Riley Coder",
      "Sam Lead",
      "Alex Builder",
      "blake Builder",
      "Casey Lead",
      "Dana Biz",
      "Cameron Captain",
      "Morgan Mentor",
    ]);
    const cameron = tp.rows.find((r) => r.user.id === p.captain.id)!;
    expect(cameron).toMatchObject({ total: 0, overdue: 0, completionRate: null });
    // Strip: all three subteams; the no-subteam group is hidden because they have no items.
    expect(tp.subteams.map((s) => [s.subteam, s.people, s.approved, s.total, s.completionRate])).toEqual([
      ["SOFTWARE", 2, 1, 2, 50],
      ["BUILD", 3, 3, 9, 33],
      ["BUSINESS", 1, 0, 1, 0],
    ]);
    expect(tp.totals).toMatchObject({ total: 12, approved: 4, overdue: 5 });

    const build = await getTeamProgress(p.mentor, { range: "week", subteam: "BUILD" }, TEST_TODAY, t.db);
    expect(build.subteam).toBe("BUILD");
    expect(build.rows.map((r) => r.user.id)).toEqual([p.buildA.id, p.buildB.id, p.buildLead.id]);
    expect(build.peopleCount).toBe(3);
    expect(build.totals).toMatchObject({ total: 9, approved: 3 });
    // The strip still shows every subteam so the filter doesn't hide the big picture.
    expect(build.subteams).toHaveLength(3);

    const bogus = await getTeamProgress(p.captain, { range: "nope", subteam: "ROBOTS" }, TEST_TODAY, t.db);
    expect(bogus.range).toBe("week");
    expect(bogus.subteam).toBeNull();
  });

  it("returns no one for a plain member", async () => {
    const tp = await getTeamProgress(p.buildA, { range: "week" }, TEST_TODAY, t.db);
    expect(tp.rows).toEqual([]);
    expect(tp.subteams).toEqual([]);
    expect(tp.totals).toMatchObject({ total: 0, completionRate: null });
  });
});

describe("getMemberProgress", () => {
  it("lists items in range plus all overdue ones, newest due first", async () => {
    const mp = await getMemberProgress(p.buildLead, p.buildA.id, { range: "week" }, TEST_TODAY, t.db);
    expect(mp).not.toBeNull();
    expect(mp!.user).toMatchObject({ id: p.buildA.id, name: "Alex Builder", role: "MEMBER", subteam: "BUILD" });
    expect(mp!.summary).toMatchObject({ total: 5, approved: 2, submitted: 2, todo: 1, overdue: 2, completionRate: 40 });
    expect(mp!.assignments.map((a) => [a.task.title, a.task.dueDate, a.status])).toEqual([
      ["Team today", d(0), "SUBMITTED"],
      ["Build today", d(0), "APPROVED"],
      ["Build yesterday", d(-1), "TODO"],
      ["Captain build task", d(-2), "APPROVED"],
      ["Build week edge", d(-6), "SUBMITTED"],
      ["Build past week", d(-7), "TODO"], // outside the week, but overdue
    ]);
    const byTitle = Object.fromEntries(mp!.assignments.map((a) => [a.task.title, a]));
    expect(byTitle["Build past week"]).toMatchObject({ overdue: true, inRange: false });
    expect(byTitle["Build yesterday"]).toMatchObject({ overdue: true, inRange: true });
    expect(byTitle["Build week edge"]).toMatchObject({ overdue: false, inRange: true });
    // Links only where the leader can manage the task.
    expect(byTitle["Team today"].canManageTask).toBe(false);
    expect(byTitle["Captain build task"].canManageTask).toBe(true);
    expect(byTitle["Build today"]).toMatchObject({ canManageTask: true, reviewerName: "Casey Lead" });
    expect(mp!.truncated).toBe(false);
  });

  it("shows review notes and respects the month range", async () => {
    const blake = await getMemberProgress(p.captain, p.buildB.id, { range: "today" }, TEST_TODAY, t.db);
    const sentBack = blake!.assignments.find((a) => a.task.title === "Build yesterday")!;
    expect(sentBack).toMatchObject({ status: "REJECTED", reviewNote: "Add photos please", overdue: true, inRange: false });

    const riley = await getMemberProgress(p.captain, p.swA.id, { range: "month" }, TEST_TODAY, t.db);
    expect(riley!.assignments.map((a) => a.task.title)).toEqual([
      "Team today",
      "Software today",
      "Software month edge",
      "Software past month",
    ]);
    expect(riley!.summary).toMatchObject({ total: 3, overdue: 2 });
  });

  it("returns null for people outside the actor's scope", async () => {
    expect(await getMemberProgress(p.buildLead, p.swA.id, {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.buildLead, p.captain.id, {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.swLead, p.buildA.id, {}, TEST_TODAY, t.db)).toBeNull();
    // Inactive accounts are not shown, even to all-scope staff.
    expect(await getMemberProgress(p.captain, p.disabledBuild.id, {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.buildLead, p.pendingBuildLead.id, {}, TEST_TODAY, t.db)).toBeNull();
    // Unknown / malformed ids.
    expect(await getMemberProgress(p.captain, "does-not-exist", {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.captain, "", {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.captain, "x".repeat(500), {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.captain, { id: p.buildA.id }, {}, TEST_TODAY, t.db)).toBeNull();
  });

  it("returns null for members, even about themselves", async () => {
    expect(await getMemberProgress(p.buildA, p.buildA.id, {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.buildA, p.buildB.id, {}, TEST_TODAY, t.db)).toBeNull();
    expect(await getMemberProgress(p.bizA, p.buildA.id, {}, TEST_TODAY, t.db)).toBeNull();
  });

  it("lets leaders and all-scope staff see people in scope, including themselves", async () => {
    const self = await getMemberProgress(p.buildLead, p.buildLead.id, { range: "today" }, TEST_TODAY, t.db);
    expect(self!.summary).toMatchObject({ total: 1, todo: 1 });
    const mentor = await getMemberProgress(p.mentor, p.bizA.id, { range: "today" }, TEST_TODAY, t.db);
    expect(mentor!.assignments.map((a) => a.task.title)).toEqual(["Team today"]);
    expect(mentor!.assignments[0].canManageTask).toBe(true);
  });
});

describe("'Waiting for your review' count", () => {
  // Runs after the overview/progress tests: adds more submissions (due tomorrow, submitted long ago,
  // so they don't change any of the numbers checked above).
  it("matches the review queue (/manage/review) for every role, including whole-team items", async () => {
    const wholeTeam = await makeTask(t.db, p.mentor, {
      title: "Whole team tomorrow",
      subteam: null,
      dueDate: d(1),
      assigneeIds: [p.buildLead.id, p.buildB.id, p.swA.id, p.bizA.id],
    });
    const swTask = await makeTask(t.db, p.swLead, { title: "Software tomorrow", subteam: "SOFTWARE", dueDate: d(1), assigneeIds: [p.swLead.id] });
    for (const userId of [p.buildLead.id, p.buildB.id, p.swA.id]) {
      await setStatus(wholeTeam.id, userId, "SUBMITTED", { submittedAt: minutesAgo(100_000) });
    }
    // The software leader's own item on their own task (only all-scope staff may review it).
    await setStatus(swTask.id, p.swLead.id, "SUBMITTED", { submittedAt: minutesAgo(100_000) });

    const expected: [keyof typeof p, number][] = [
      // t1 buildB, t5 buildA, t3 buildA + buildB on the new whole-team task. Not their own item, not swA's.
      ["buildLead", 4],
      // swA on the new whole-team task. Not their own item on their own task.
      ["swLead", 1],
      // Everything submitted: t1, t3, t5 + 3 whole-team items + the software leader's own item.
      ["captain", 7],
      ["mentor", 7],
      ["buildA", 0],
    ];
    for (const [who, count] of expected) {
      const actor = p[who];
      const [overview, queue] = await Promise.all([getOverview(actor, TEST_TODAY, t.db), getReviewQueue(actor, {}, t.db)]);
      expect({ who, overview: overview.reviewQueueCount }).toEqual({ who, overview: count });
      expect({ who, queue: queue.total }).toEqual({ who, queue: count });
    }

    // The build leader's queue holds exactly those items (and never their own).
    const queue = await getReviewQueue(p.buildLead, {}, t.db);
    const items = queue.groups.flatMap((g) => g.items.map((i) => `${g.task.title}: ${i.user.name}`)).sort();
    expect(items).toEqual([
      "Build today: blake Builder",
      "Build week edge: Alex Builder",
      "Team today: Alex Builder",
      "Whole team tomorrow: blake Builder",
    ]);

    // Reviewing a whole-team item doesn't make the task manageable: the member page keeps it unlinked.
    const alex = await getMemberProgress(p.buildLead, p.buildA.id, { range: "today" }, TEST_TODAY, t.db);
    expect(alex!.assignments.find((a) => a.task.title === "Team today")).toMatchObject({ status: "SUBMITTED", canManageTask: false });
  });
});

describe("team progress paging", () => {
  // Runs last: adds enough people to need a second page.
  it("pages people 50 at a time", async () => {
    for (let i = 0; i < TEAM_PROGRESS_PAGE_SIZE; i++) {
      await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS", name: `Zed ${String(i).padStart(2, "0")}` });
    }
    const page1 = await getTeamProgress(p.captain, { range: "week" }, TEST_TODAY, t.db);
    expect(page1.peopleCount).toBe(58);
    expect(page1.pageCount).toBe(2);
    expect(page1.rows).toHaveLength(50);
    const page2 = await getTeamProgress(p.captain, { range: "week", page: 2 }, TEST_TODAY, t.db);
    expect(page2.page).toBe(2);
    expect(page2.rows).toHaveLength(8);
    expect(page2.rows.at(-1)!.user.id).toBe(p.mentor.id);
    const clamped = await getTeamProgress(p.captain, { range: "week", page: 99 }, TEST_TODAY, t.db);
    expect(clamped.page).toBe(2);
    // Totals and the strip cover everyone, not just the current page.
    expect(page1.subteams.find((s) => s.subteam === "BUSINESS")!.people).toBe(51);
  });
});

describe("tasks marked finished", () => {
  // Its own database, so the numbers above stay as they are.
  let fresh: TestDb;
  let q: Record<"lead" | "grant" | "paige" | "sam", Actor>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    fresh = await createTestDb();
    const db = fresh.db;
    q = {
      lead: await makeUser(db, { role: "BUILD_LEADER", name: "Fin Lead" }),
      grant: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Grant" }),
      paige: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Paige" }),
      sam: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Sam" }),
    };
    const ctx = contextFor(db, q.lead);
    // Yesterday, "Just close it": Grant never did it, Paige was approved, Sam checked off but wasn't reviewed.
    const closed = await makeTask(db, q.lead, { title: "Closed", subteam: "BUILD", dueDate: d(-1), assigneeIds: [q.grant.id, q.paige.id, q.sam.id] });
    await db.taskAssignment.update({
      where: { taskId_userId: { taskId: closed.id, userId: q.paige.id } },
      data: { status: "APPROVED", reviewedAt: minutesAgo(30), reviewedById: q.lead.id },
    });
    await db.taskAssignment.update({
      where: { taskId_userId: { taskId: closed.id, userId: q.sam.id } },
      data: { status: "SUBMITTED", submittedAt: minutesAgo(20) },
    });
    await finishTask(ctx, { taskId: closed.id, credit: "none" });
    // Two days ago, counted for everyone.
    const counted = await makeTask(db, q.lead, { title: "Counted", subteam: "BUILD", dueDate: d(-2), assigneeIds: [q.grant.id] });
    await finishTask(ctx, { taskId: counted.id, credit: "everyone" });
    // Three days ago and still open: really overdue.
    const open = await makeTask(db, q.lead, { title: "Still open", subteam: "BUILD", dueDate: d(-3), assigneeIds: [q.grant.id] });
    // Due today, closed.
    const today = await makeTask(db, q.lead, { title: "Closed today", subteam: "BUILD", dueDate: d(0), assigneeIds: [q.paige.id] });
    await finishTask(ctx, { taskId: today.id, credit: "none" });
    Object.assign(ids, { closed: closed.id, counted: counted.id, open: open.id, today: today.id });
  });

  afterAll(async () => {
    await fresh?.drop();
  });

  it("team progress: counted items are approved; closed ones count in the total but aren't done, waiting, or overdue", async () => {
    const tp = await getTeamProgress(q.lead, { range: "week" }, TEST_TODAY, fresh.db);
    const row = (u: Actor) => tp.rows.find((r) => r.user.id === u.id)!;
    expect(row(q.grant)).toMatchObject({ total: 3, approved: 1, todo: 1, submitted: 0, rejected: 0, closed: 1, overdue: 1, completionRate: 33 });
    expect(row(q.paige)).toMatchObject({ total: 2, approved: 1, closed: 1, overdue: 0 });
    expect(row(q.sam)).toMatchObject({ total: 1, approved: 0, submitted: 0, closed: 1, overdue: 0, completionRate: 0 });
    expect(tp.totals).toMatchObject({ total: 6, approved: 2, closed: 3, todo: 1, submitted: 0, overdue: 1 });
  });

  it("one person's progress marks closed and counted items, and only open ones are overdue", async () => {
    const mp = (await getMemberProgress(q.lead, q.grant.id, { range: "week" }, TEST_TODAY, fresh.db))!;
    expect(mp.summary).toMatchObject({ total: 3, approved: 1, closed: 1, todo: 1, overdue: 1 });
    const byTask = new Map(mp.assignments.map((a) => [a.task.id, a]));
    expect(byTask.get(ids.closed)).toMatchObject({ status: "TODO", closed: true, overdue: false, finishedWithTask: false });
    expect(byTask.get(ids.counted)).toMatchObject({ status: "APPROVED", closed: false, overdue: false, finishedWithTask: true });
    expect(byTask.get(ids.open)).toMatchObject({ status: "TODO", closed: false, overdue: true });
  });

  it("the overview: not overdue, not waiting for review, closed today's task says so; marking finished isn't 'activity'", async () => {
    const o = await getOverview(q.lead, TEST_TODAY, fresh.db);
    expect(o.overdueOpenCount).toBe(1);
    expect(o.attention.map((a) => [a.name, a.overdueCount])).toEqual([["Grant", 1]]);
    expect(o.reviewQueueCount).toBe(0);
    expect((await getReviewQueue(q.lead, {}, fresh.db)).total).toBe(0);
    expect(o.dueToday).toEqual({ total: 1, approved: 0, submitted: 0 });
    expect(o.todaysTasks).toMatchObject([{ id: ids.today, finished: true, counts: { total: 1, closed: 1, todo: 0 } }]);
    // Paige's one-by-one approval and Sam's check-off are activity; Grant counted with the whole task isn't.
    expect(o.recentActivity.map((a) => [a.person.name, a.status])).toEqual([
      ["Sam", "SUBMITTED"],
      ["Paige", "APPROVED"],
    ]);
  });
});
