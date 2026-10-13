import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssignmentStatus } from "@/generated/prisma/enums";
import { addDays, type DateOnly } from "@/lib/dates";
import { buildOverdueReminder, MAILTO_MAX, reminderMailto } from "@/lib/overdue-reminder";
import type { Actor } from "@/server/actor";
import { ForbiddenError } from "@/server/errors";
import { getOverdueReminder } from "@/server/queries/overdue-reminder";
import { getOverview } from "@/server/queries/progress";
import { createTestDb, type TestDb } from "./helpers/db";
import { makeTask, makeUser, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let p: Record<
  "captain" | "owner" | "mentor" | "buildLead" | "swLead" | "bizLead" | "buildA" | "buildB" | "swA" | "bizA" | "disabledBuild" | "member",
  Actor
>;

const d = (n: number): DateOnly => addDays(TEST_TODAY, n);

async function setStatus(taskId: string, userId: string, status: AssignmentStatus) {
  await t.db.taskAssignment.update({ where: { taskId_userId: { taskId, userId } }, data: { status } });
}

const summary = (data: Awaited<ReturnType<typeof getOverdueReminder>>) =>
  data.people.map((person) => `${person.name}: ${person.items.map((i) => `${i.title}@${i.dueDate}`).join(", ")}`);

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    captain: await makeUser(db, { role: "CAPTAIN", name: "Cameron Captain" }),
    owner: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true, name: "Olive Owner" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Morgan Mentor" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Casey Lead" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Bea Lead" }),
    buildA: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Alex Builder", email: "alex@example.com" }),
    buildB: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "blake Builder", email: "blake@example.com" }),
    swA: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Riley Coder", email: "riley@example.com" }),
    bizA: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Dana Biz", email: "dana@example.com" }),
    disabledBuild: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Old Builder" }),
    member: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Max Member" }),
  };

  // Overdue: to do or sent back, due before today, task not finished, ACTIVE people.
  const buildOld = await makeTask(db, p.buildLead, {
    title: "Build old",
    subteam: "BUILD",
    dueDate: d(-5),
    assigneeIds: [p.buildA.id, p.buildB.id, p.disabledBuild.id],
  });
  await setStatus(buildOld.id, p.buildB.id, "REJECTED"); // sent back: still overdue
  const buildYesterday = await makeTask(db, p.buildLead, {
    title: "Build yesterday",
    subteam: "BUILD",
    dueDate: d(-1),
    assigneeIds: [p.buildA.id, p.buildB.id],
  });
  await setStatus(buildYesterday.id, p.buildB.id, "SUBMITTED"); // checked off, waiting on review: not overdue
  const teamTask = await makeTask(db, p.captain, {
    title: "Team fundraiser",
    subteam: null,
    dueDate: d(-3),
    assigneeIds: [p.buildA.id, p.swA.id, p.bizA.id, p.captain.id],
  });
  await setStatus(teamTask.id, p.bizA.id, "APPROVED"); // done: not overdue
  // Not overdue: due today / tomorrow, or on a task marked finished.
  await makeTask(db, p.buildLead, { title: "Build today", subteam: "BUILD", dueDate: d(0), assigneeIds: [p.buildA.id] });
  await makeTask(db, p.buildLead, { title: "Build tomorrow", subteam: "BUILD", dueDate: d(1), assigneeIds: [p.buildA.id] });
  const finished = await makeTask(db, p.swLead, {
    title: "Software finished",
    subteam: "SOFTWARE",
    dueDate: d(-10),
    assigneeIds: [p.swA.id],
  });
  await db.task.update({ where: { id: finished.id }, data: { completedAt: new Date(), completedById: p.swLead.id } });
  // Last year: the due date shows the year.
  await makeTask(db, p.swLead, { title: "Software ancient", subteam: "SOFTWARE", dueDate: "2025-12-30", assigneeIds: [p.swA.id] });
});

afterAll(async () => {
  await t?.drop();
});

describe("getOverdueReminder", () => {
  it("is for people with admin access only", async () => {
    await expect(getOverdueReminder(p.member, {}, TEST_TODAY, t.db)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOverdueReminder(p.buildA, { subteam: "BUILD" }, TEST_TODAY, t.db)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lists the whole team's overdue items for the captain: by name, oldest first", async () => {
    const data = await getOverdueReminder(p.captain, {}, TEST_TODAY, t.db);
    expect(data.canPickSubteam).toBe(true);
    expect(data.subteam).toBeNull();
    expect(summary(data)).toEqual([
      `Alex Builder: Build old@${d(-5)}, Team fundraiser@${d(-3)}, Build yesterday@${d(-1)}`,
      `blake Builder: Build old@${d(-5)}`,
      `Cameron Captain: Team fundraiser@${d(-3)}`,
      `Riley Coder: Software ancient@2025-12-30, Team fundraiser@${d(-3)}`,
    ]);
    expect(data.itemCount).toBe(7);
    expect(data.truncated).toBe(false);
    expect(data.people.map((person) => person.email)).toEqual([
      "alex@example.com",
      "blake@example.com",
      p.captain.email,
      "riley@example.com",
    ]);
    // People with something overdue, per group (the captain has no subteam: whole team only).
    expect(data.peopleCounts).toEqual({ all: 4, BUILD: 2, SOFTWARE: 1, BUSINESS: 0 });
  });

  it("matches the overview's overdue count", async () => {
    const [data, overview] = await Promise.all([
      getOverdueReminder(p.mentor, {}, TEST_TODAY, t.db),
      getOverview(p.mentor, TEST_TODAY, t.db),
    ]);
    expect(data.itemCount).toBe(overview.overdueOpenCount);
  });

  it("narrows to one subteam's people (whole-team tasks included)", async () => {
    const data = await getOverdueReminder(p.owner, { subteam: "BUILD" }, TEST_TODAY, t.db);
    expect(data.subteam).toBe("BUILD");
    expect(summary(data)).toEqual([
      `Alex Builder: Build old@${d(-5)}, Team fundraiser@${d(-3)}, Build yesterday@${d(-1)}`,
      `blake Builder: Build old@${d(-5)}`,
    ]);
    expect(data.itemCount).toBe(4);
    // The tabs still count every group.
    expect(data.peopleCounts.all).toBe(4);

    const business = await getOverdueReminder(p.captain, { subteam: "BUSINESS" }, TEST_TODAY, t.db);
    expect(business.people).toEqual([]);
    expect(business.itemCount).toBe(0);
  });

  it("treats an unknown ?subteam= as the whole team", async () => {
    for (const subteam of ["build", "EVERYONE", ["SOFTWARE", "BUILD"], 7]) {
      const data = await getOverdueReminder(p.captain, { subteam }, TEST_TODAY, t.db);
      // An array takes its first value, like the progress pages.
      expect(data.subteam).toBe(Array.isArray(subteam) ? "SOFTWARE" : null);
    }
  });

  it("locks subteam leaders to their own subteam, whatever the URL says", async () => {
    const data = await getOverdueReminder(p.buildLead, { subteam: "SOFTWARE" }, TEST_TODAY, t.db);
    expect(data.canPickSubteam).toBe(false);
    expect(data.subteam).toBe("BUILD");
    expect(data.people.map((person) => person.name)).toEqual(["Alex Builder", "blake Builder"]);

    const sw = await getOverdueReminder(p.swLead, {}, TEST_TODAY, t.db);
    expect(sw.subteam).toBe("SOFTWARE");
    expect(summary(sw)).toEqual([`Riley Coder: Software ancient@2025-12-30, Team fundraiser@${d(-3)}`]);
    // Their counts only cover their own people.
    expect(sw.peopleCounts).toEqual({ all: 1, BUILD: 0, SOFTWARE: 1, BUSINESS: 0 });

    const biz = await getOverdueReminder(p.bizLead, {}, TEST_TODAY, t.db);
    expect(biz.subteam).toBe("BUSINESS");
    expect(biz.people).toEqual([]);
  });
});

describe("buildOverdueReminder", () => {
  const people = [
    {
      name: "Alex  Builder",
      email: "Alex@Example.com",
      items: [
        { title: "Build\nold", dueDate: d(-5) },
        { title: "Build yesterday", dueDate: d(-1) },
      ],
    },
    { name: "Riley Coder", email: "riley@example.com", items: [{ title: "Software ancient", dueDate: "2025-12-30" as DateOnly }] },
  ];
  const input = { people, today: TEST_TODAY, myTasksUrl: "https://portal.test/my-tasks", senderName: "Cameron Captain" };

  it("writes the whole-team email", () => {
    const reminder = buildOverdueReminder({ ...input, groupLabel: null });
    expect(reminder.recipients).toBe("alex@example.com, riley@example.com");
    expect(reminder.subject).toBe("Reminder: overdue tasks (Sep 24)");
    expect(reminder.body).toBe(
      [
        "Hi everyone,",
        "These tasks are past their due date and haven't been checked off yet:",
        "Alex Builder\n- Build old — due Sat, Sep 19 (5 days late)\n- Build yesterday — due Wed, Sep 23 (1 day late)",
        "Riley Coder\n- Software ancient — due Tue, Dec 30, 2025 (268 days late)",
        "Please finish them and check them off in the portal: https://portal.test/my-tasks",
        "If you're stuck or need more time, just reply and let me know.",
        "Thanks,\nCameron Captain",
      ].join("\n\n"),
    );
  });

  it("greets one subteam", () => {
    const reminder = buildOverdueReminder({ ...input, groupLabel: "Build" });
    expect(reminder.subject).toBe("Reminder: overdue tasks for the Build team (Sep 24)");
    expect(reminder.body.startsWith("Hi Build team,\n\n")).toBe(true);
  });

  it("lists each email once", () => {
    const reminder = buildOverdueReminder({
      ...input,
      groupLabel: null,
      people: [...people, { name: "Alex again", email: "alex@example.com ", items: [{ title: "x", dueDate: d(-1) }] }],
    });
    expect(reminder.recipients).toBe("alex@example.com, riley@example.com");
  });

  it("makes a mailto: link only while it's short enough", () => {
    const reminder = buildOverdueReminder({ ...input, groupLabel: null });
    const href = reminderMailto(reminder);
    expect(href).toMatch(/^mailto:alex%40example\.com,riley%40example\.com\?subject=Reminder%3A%20overdue/);
    expect(new URL(href!).searchParams.get("body")).toBe(reminder.body);
    expect(reminderMailto({ ...reminder, body: "x".repeat(MAILTO_MAX) })).toBeNull();
  });
});
