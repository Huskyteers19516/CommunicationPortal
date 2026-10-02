import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssignmentStatus, Priority, Subteam } from "@/generated/prisma/enums";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { type BoardSection, type BoardTask, BOARD_PAST_LIMIT, getBoardTask, getTaskBoard } from "@/server/queries/board";
import { getTodayView } from "@/server/queries/checklist";
import { isFull, signupBadge, spotsSummary } from "@/lib/signup";
import { getAskAboutTask, getAskTaskOptions } from "@/server/queries/questions";
import { finishTask, reopenTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let p: Record<
  | "captain"
  | "swLead"
  | "buildLead"
  | "bizLead"
  | "swMember"
  | "buildMember"
  | "buildMember2"
  | "buildMember3"
  | "bizMember",
  Actor
>;
const cat: Record<string, string> = {};
const ids: Record<string, string> = {};

const SECRET_SUBMISSION = "secret-submission-note";
const SECRET_REVIEW = "secret-review-note";

interface Spec {
  title: string;
  subteam: Subteam | null;
  day: number;
  creator: Actor;
  priority?: Priority;
  category?: string;
  signupOpen?: boolean;
  signupLimit?: number | null;
  people?: [Actor, AssignmentStatus, { self?: boolean }?][];
}

async function task(key: string, spec: Spec) {
  const row = await t.db.task.create({
    data: {
      title: spec.title,
      subteam: spec.subteam,
      dueDate: dateOnlyToDb(addDays(TEST_TODAY, spec.day)),
      priority: spec.priority ?? "NORMAL",
      createdById: spec.creator.id,
      categoryId: spec.category ? cat[spec.category] : null,
      signupMode: !!spec.signupOpen || spec.signupLimit != null || (spec.people ?? []).some(([, , o]) => o?.self),
      signupOpen: spec.signupOpen ?? false,
      signupLimit: spec.signupLimit ?? null,
      description: `About ${spec.title}`,
      assignments: {
        create: (spec.people ?? []).map(([who, status, opts]) => ({
          userId: who.id,
          status,
          selfAssigned: opts?.self ?? false,
          submittedAt: status === "TODO" ? null : TEST_NOW,
          submissionNote: status === "TODO" ? null : SECRET_SUBMISSION,
          reviewNote: status === "APPROVED" || status === "REJECTED" ? SECRET_REVIEW : null,
        })),
      },
    },
  });
  ids[key] = row.id;
}

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    captain: await makeUser(db, { role: "CAPTAIN", name: "Cap Captain" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Lead" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Bo Lead" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Sky Kid" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ava Build" }),
    buildMember2: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ben Build" }),
    buildMember3: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Cy Build" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Bea Biz" }),
  };
  const category = async (key: string, subteam: Subteam | null, name: string, position: number) => {
    cat[key] = (await db.taskCategory.create({ data: { subteam, name, nameKey: name.toLowerCase(), position } })).id;
  };
  await category("intake", "BUILD", "Intake", 0);
  await category("outtake", "BUILD", "Outtake", 1);
  await category("empty", "BUILD", "Empty one", 2);
  await category("events", null, "Events", 0);

  await task("intake", {
    title: "Rebuild intake",
    subteam: "BUILD",
    day: 2,
    creator: p.buildLead,
    category: "intake",
    people: [
      [p.buildMember, "APPROVED"],
      [p.buildMember3, "REJECTED"],
      [p.buildMember2, "SUBMITTED"],
      [p.buildLead, "TODO"],
    ],
  });
  await task("signup", {
    title: "Outtake bracket sign-up",
    subteam: "BUILD",
    day: 3,
    creator: p.buildLead,
    category: "outtake",
    signupOpen: true,
    signupLimit: 3,
    people: [[p.buildMember2, "TODO", { self: true }]],
  });
  await task("full", {
    title: "Full sign-up",
    subteam: "BUILD",
    day: 3,
    creator: p.buildLead,
    category: "outtake",
    signupOpen: true,
    signupLimit: 1,
    people: [[p.buildMember3, "TODO", { self: true }]],
  });
  await task("uncat", { title: "Sweep the shop", subteam: "BUILD", day: 0, creator: p.buildLead, people: [[p.buildMember, "TODO"]] });
  await task("swHigh", { title: "Zeta tune PID", subteam: "SOFTWARE", day: 1, priority: "HIGH", creator: p.swLead, people: [[p.swMember, "TODO"]] });
  await task("swLow", { title: "Alpha docs", subteam: "SOFTWARE", day: 1, priority: "LOW", creator: p.swLead, people: [[p.swMember, "TODO"]] });
  await task("swNormal", { title: "Beta review", subteam: "SOFTWARE", day: 1, creator: p.swLead, people: [[p.swMember, "TODO"]] });
  await task("bizDone", { title: "Sponsor emails", subteam: "BUSINESS", day: -5, creator: p.bizLead, people: [[p.bizMember, "APPROVED"]] });
  await task("bizOverdue", { title: "Portfolio draft", subteam: "BUSINESS", day: -5, creator: p.bizLead, people: [[p.bizMember, "TODO"]] });
  await task("bizEmptyPast", { title: "Nobody did this", subteam: "BUSINESS", day: -2, creator: p.bizLead });
  await task("old", { title: "Ancient task", subteam: "BUILD", day: -40, creator: p.buildLead, people: [[p.buildMember, "TODO"]] });
  await task("team", {
    title: "Volunteer at the league meet",
    subteam: null,
    day: 5,
    creator: p.captain,
    category: "events",
    signupOpen: true,
    people: [[p.swMember, "TODO", { self: true }]],
  });
  // Overdue, but someone is still on it: stays active.
  await task("pastSignup", {
    title: "Past sign-up",
    subteam: "BUILD",
    day: -1,
    creator: p.buildLead,
    signupOpen: true,
    signupLimit: 5,
    people: [[p.buildMember3, "TODO", { self: true }]],
  });
});

afterAll(async () => {
  await t?.drop();
});

const board = (actor: Actor, filters: Partial<Parameters<typeof getTaskBoard>[1]> = {}) =>
  getTaskBoard(actor, { view: "active", today: TEST_TODAY, ...filters }, t.db);

function section(sections: BoardSection[], key: string) {
  const s = sections.find((x) => x.key === key);
  if (!s) throw new Error(`no section ${key}`);
  return s;
}

function allTasks(sections: BoardSection[]): BoardTask[] {
  return sections.flatMap((s) => [...s.categories.flatMap((c) => c.tasks), ...s.uncategorized]);
}

function find(sections: BoardSection[], key: string): BoardTask {
  const found = allTasks(sections).find((x) => x.id === ids[key]);
  if (!found) throw new Error(`task ${key} not on the board`);
  return found;
}

describe("getTaskBoard", () => {
  it("shows every subteam's active tasks to everyone, grouped into sections and categories", async () => {
    const b = await board(p.swMember);
    expect(b.sections.map((s) => [s.key, s.label])).toEqual([
      ["SOFTWARE", "Software"],
      ["BUILD", "Build"],
      ["BUSINESS", "Business"],
      ["TEAM", "Whole team"],
    ]);
    const buildSection = section(b.sections, "BUILD");
    // Members only see categories that have tasks.
    expect(buildSection.categories.map((c) => c.name)).toEqual(["Intake", "Outtake"]);
    expect(buildSection.categories[1].tasks.map((x) => x.title)).toEqual(["Full sign-up", "Outtake bracket sign-up"]);
    expect(buildSection.uncategorized.map((x) => x.title)).toEqual(["Past sign-up", "Sweep the shop"]);
    expect(buildSection.taskCount).toBe(5);
    expect(section(b.sections, "TEAM").categories.map((c) => c.name)).toEqual(["Events"]);
    expect(b.total).toBe(allTasks(b.sections).length);
    expect(b.truncated).toBe(false);
  });

  it("keeps past-due tasks active while someone isn't approved, and moves finished or old ones to Past", async () => {
    const active = allTasks((await board(p.bizMember)).sections).map((x) => x.id);
    expect(active).toContain(ids.bizOverdue);
    expect(active).not.toContain(ids.bizDone);
    expect(active).not.toContain(ids.bizEmptyPast);
    expect(active).not.toContain(ids.old);

    const past = await board(p.bizMember, { view: "past" });
    const pastIds = allTasks(past.sections).map((x) => x.id);
    expect(pastIds.sort()).toEqual([ids.bizDone, ids.bizEmptyPast, ids.old].sort());
    // Past view: no empty categories even for managers.
    const asLead = await board(p.buildLead, { view: "past" });
    expect(section(asLead.sections, "BUILD").categories).toEqual([]);
  });

  it("sorts active tasks by due date, then priority (high first), then title", async () => {
    const sw = section((await board(p.swMember)).sections, "SOFTWARE");
    expect(sw.uncategorized.map((x) => x.title)).toEqual(["Zeta tune PID", "Beta review", "Alpha docs"]);
  });

  it("shows each person's public status only — no notes, and 'sent back' reads as 'to do'", async () => {
    const b = await board(p.bizMember);
    const intake = find(b.sections, "intake");
    expect(intake.people).toEqual([
      { id: p.buildMember.id, name: "Ava Build", publicStatus: "done", selfAssigned: false, isMe: false },
      { id: p.buildMember2.id, name: "Ben Build", publicStatus: "checked", selfAssigned: false, isMe: false },
      { id: p.buildLead.id, name: "Blake Lead", publicStatus: "todo", selfAssigned: false, isMe: false },
      { id: p.buildMember3.id, name: "Cy Build", publicStatus: "todo", selfAssigned: false, isMe: false },
    ]);
    expect(intake.counts).toEqual({ total: 4, done: 1, checked: 1, todo: 2, closed: 0 });
    const json = JSON.stringify(b);
    expect(json).not.toContain(SECRET_SUBMISSION);
    expect(json).not.toContain(SECRET_REVIEW);
    expect(json).not.toMatch(/REJECTED|submissionNote|reviewNote/);

    const detail = await getBoardTask(p.bizMember, ids.intake, { today: TEST_TODAY }, t.db);
    const detailJson = JSON.stringify(detail);
    expect(detailJson).not.toContain(SECRET_SUBMISSION);
    expect(detailJson).not.toContain(SECRET_REVIEW);
  });

  it("works out sign-up, leave and manage rights per viewer", async () => {
    const asMember = await board(p.buildMember);
    const signup = find(asMember.sections, "signup");
    expect(signup).toMatchObject({ signupOpen: true, signupLimit: 3, spotsTaken: 1, full: false, canSignUp: true, canLeave: false });
    expect(find(asMember.sections, "full")).toMatchObject({ full: true, canSignUp: false });
    expect(find(asMember.sections, "pastSignup").canSignUp).toBe(false); // past due
    expect(find(asMember.sections, "team").canSignUp).toBe(true); // whole team: anyone
    expect(find(asMember.sections, "intake")).toMatchObject({ isMine: true, canSignUp: false, canLeave: false, canManage: false });

    // Already signed up: can leave instead.
    const asSignedUp = await board(p.buildMember2);
    expect(find(asSignedUp.sections, "signup")).toMatchObject({ isMine: true, canSignUp: false, canLeave: true });
    expect(find(asSignedUp.sections, "signup").people[0]).toMatchObject({ isMe: true, selfAssigned: true });

    // Other subteams can't sign up for Build tasks.
    const asSw = await board(p.swMember);
    expect(find(asSw.sections, "signup").canSignUp).toBe(false);

    // Managers.
    const asLead = await board(p.buildLead);
    expect(asLead.sections.map((s) => s.canManage)).toEqual([false, true, false, false]);
    expect(find(asLead.sections, "intake").canManage).toBe(true);
    expect(find(asLead.sections, "swHigh").canManage).toBe(false);
    const asCaptain = await board(p.captain);
    expect(asCaptain.sections.every((s) => s.canManage)).toBe(true);
  });

  it("shows empty categories to managers of that subteam only", async () => {
    const lead = section((await board(p.buildLead)).sections, "BUILD");
    expect(lead.categories.map((c) => c.name)).toEqual(["Intake", "Outtake", "Empty one"]);
    const otherLead = section((await board(p.swLead)).sections, "BUILD");
    expect(otherLead.categories.map((c) => c.name)).toEqual(["Intake", "Outtake"]);
    // Not while filtering.
    const filtered = section((await board(p.buildLead, { mine: true })).sections, "BUILD");
    expect(filtered.categories.map((c) => c.name)).toEqual(["Intake"]);
  });

  it("filters by subteam, 'Mine', and 'Open for sign-up'", async () => {
    const buildOnly = await board(p.swMember, { subteam: "BUILD" });
    expect(buildOnly.sections.map((s) => s.key)).toEqual(["BUILD"]);
    const teamOnly = await board(p.swMember, { subteam: "TEAM" });
    expect(teamOnly.sections.map((s) => s.key)).toEqual(["TEAM"]);
    expect(allTasks(teamOnly.sections).map((x) => x.id)).toEqual([ids.team]);

    const mine = await board(p.buildMember, { mine: true });
    expect(allTasks(mine.sections).map((x) => x.id).sort()).toEqual([ids.intake, ids.uncat].sort());

    // Open, not full, not past due.
    const open = await board(p.buildMember, { open: true });
    expect(allTasks(open.sections).map((x) => x.id).sort()).toEqual([ids.signup, ids.team].sort());
    // Your own sign-ups stay while you can still leave them (even once full), so the card doesn't vanish on "Sign up".
    const signedUp = await board(p.buildMember3, { open: true });
    expect(allTasks(signedUp.sections).map((x) => x.id).sort()).toEqual([ids.signup, ids.full, ids.team].sort());
    expect(find(signedUp.sections, "full")).toMatchObject({ full: true, canLeave: true });
    // Open + Mine: just your open sign-ups.
    const mineOpen = await board(p.buildMember3, { open: true, mine: true });
    expect(allTasks(mineOpen.sections).map((x) => x.id)).toEqual([ids.full]);
  });

  it("flags truncated lists", async () => {
    const extra = await t.db.task.createMany({
      data: Array.from({ length: BOARD_PAST_LIMIT + 1 }, (_, i) => ({
        title: `Filler ${i}`,
        subteam: "BUSINESS" as const,
        dueDate: dateOnlyToDb(addDays(TEST_TODAY, -60)),
        createdById: p.bizLead.id,
      })),
    });
    expect(extra.count).toBe(BOARD_PAST_LIMIT + 1);
    const past = await board(p.bizMember, { view: "past" });
    expect(past.truncated).toBe(true);
    expect(past.total).toBe(BOARD_PAST_LIMIT);
    // Most recent first: the real past tasks come before the fillers.
    expect(allTasks(past.sections).map((x) => x.id)).toContain(ids.bizEmptyPast);
    await t.db.task.deleteMany({ where: { title: { startsWith: "Filler " } } });
  });
});

describe("getBoardTask", () => {
  it("returns one task with its description, creator, and people for anyone", async () => {
    const detail = await getBoardTask(p.bizMember, ids.signup, { today: TEST_TODAY }, t.db);
    expect(detail).toMatchObject({
      id: ids.signup,
      title: "Outtake bracket sign-up",
      description: "About Outtake bracket sign-up",
      category: { id: cat.outtake, name: "Outtake" },
      createdBy: { id: p.buildLead.id, name: "Blake Lead" },
      spotsTaken: 1,
      canSignUp: false,
      signupNote: "Only Build members can sign up.",
    });
    expect((await getBoardTask(p.buildMember, ids.signup, { today: TEST_TODAY }, t.db))?.signupNote).toBeNull();
    expect((await getBoardTask(p.buildMember, ids.full, { today: TEST_TODAY }, t.db))?.signupNote).toBe("All spots are taken.");
    expect((await getBoardTask(p.buildMember, ids.pastSignup, { today: TEST_TODAY }, t.db))?.signupNote).toBe("The due date has passed.");
    // Assigned (non-sign-up) tasks have no sign-up note at all.
    expect((await getBoardTask(p.bizMember, ids.intake, { today: TEST_TODAY }, t.db))?.signupNote).toBeNull();
  });

  it("returns null for missing ids", async () => {
    expect(await getBoardTask(p.swMember, "missing", { today: TEST_TODAY }, t.db)).toBeNull();
    expect(await getBoardTask(p.swMember, "", { today: TEST_TODAY }, t.db)).toBeNull();
  });
});

describe("checklist items carry their category", () => {
  it("adds categoryName to Today items", async () => {
    const view = await getTodayView(p.buildMember2, TEST_TODAY, t.db);
    const items = [...view.upcoming, ...view.today];
    expect(items.find((i) => i.task.id === ids.intake)?.task.categoryName).toBe("Intake");
    expect(items.find((i) => i.task.id === ids.signup)?.task.categoryName).toBe("Outtake");
  });
});

describe("asking about a dashboard task", () => {
  it("adds a task the asker isn't on to the question form's options when linked with ?taskId=", async () => {
    // The software member isn't on the Build intake task, but can ask about it from the dashboard.
    const plain = await getAskTaskOptions(p.swMember, { today: TEST_TODAY }, t.db);
    expect(plain.map((o) => o.taskId)).not.toContain(ids.intake);
    const withTask = await getAskTaskOptions(p.swMember, { today: TEST_TODAY, includeTaskId: ids.intake }, t.db);
    expect(withTask[0]).toEqual({ taskId: ids.intake, title: "Rebuild intake", dueDate: addDays(TEST_TODAY, 2), upcoming: true });
    expect(withTask).toHaveLength(plain.length + 1);
    // Past tasks go first among the recent ones; tasks already listed and unknown ids change nothing.
    const past = await getAskTaskOptions(p.swMember, { today: TEST_TODAY, includeTaskId: ids.bizOverdue }, t.db);
    expect(past.find((o) => o.taskId === ids.bizOverdue)).toMatchObject({ upcoming: false });
    const own = await getAskTaskOptions(p.swMember, { today: TEST_TODAY, includeTaskId: ids.swHigh }, t.db);
    expect(own).toEqual(plain);
    expect(await getAskTaskOptions(p.swMember, { today: TEST_TODAY, includeTaskId: "missing" }, t.db)).toEqual(plain);
  });

  it("offers the Business leader for questions about their whole-team task (not the captain by default)", async () => {
    await task("carWash", { title: "Car wash crew", subteam: null, day: 4, creator: p.bizLead, people: [[p.buildMember, "TODO"]] });
    expect(await getAskAboutTask(p.buildMember, ids.carWash, t.db)).toMatchObject({
      subteam: null,
      createdByName: "Bo Lead",
      poster: { id: p.bizLead.id, name: "Bo Lead" },
    });
    // Not to themselves; and their Business tasks go to the Business leaders as usual.
    expect((await getAskAboutTask(p.bizLead, ids.carWash, t.db))?.poster).toBeNull();
    await task("bizFlyers", { title: "Flyers", subteam: "BUSINESS", day: 4, creator: p.bizLead });
    expect((await getAskAboutTask(p.buildMember, ids.bizFlyers, t.db))?.poster).toBeNull();
    // Someone who can't take questions anymore isn't offered.
    const former = await makeUser(t.db, { role: "BUSINESS_LEADER", status: "DISABLED", name: "Former Lead" });
    await task("oldDrive", { title: "Old drive", subteam: null, day: 4, creator: former });
    expect((await getAskAboutTask(p.buildMember, ids.oldDrive, t.db))?.poster).toBeNull();
  });

  it("tells the form the task's subteam, who posted it, and whether anyone else leads that subteam", async () => {
    expect(await getAskAboutTask(p.swMember, ids.intake, t.db)).toEqual({
      id: ids.intake,
      title: "Rebuild intake",
      subteam: "BUILD",
      createdByName: "Blake Lead",
      subteamHasLeaders: true,
      poster: null,
    });
    // Blake is the only Build leader: nobody else to ask.
    expect((await getAskAboutTask(p.buildLead, ids.intake, t.db))?.subteamHasLeaders).toBe(false);
    // Whole-team tasks go to the captain.
    expect(await getAskAboutTask(p.buildMember, ids.team, t.db)).toMatchObject({
      subteam: null,
      createdByName: "Cap Captain",
      subteamHasLeaders: false,
      poster: null,
    });
    expect(await getAskAboutTask(p.swMember, "missing", t.db)).toBeNull();
    expect(await getAskAboutTask(p.swMember, undefined, t.db)).toBeNull();
    expect(await getAskAboutTask(p.swMember, "x".repeat(65), t.db)).toBeNull();
  });
});

describe("sign-up labels", () => {
  const info = (open: boolean, limit: number | null, taken: number) => ({
    signupMode: true,
    signupOpen: open,
    signupLimit: limit,
    spotsTaken: taken,
  });

  it("badges say what's going on, and nothing for assigned tasks", () => {
    expect(signupBadge({ ...info(true, 3, 1), signupMode: false })).toBeNull();
    expect(signupBadge(info(true, 3, 1))?.label).toBe("Sign-up · 1 of 3 spots taken");
    expect(signupBadge(info(true, 1, 0))?.label).toBe("Sign-up · 0 of 1 spot taken");
    expect(signupBadge(info(true, 2, 2))).toEqual({ label: "Sign-up · full", tone: "gray" });
    expect(signupBadge(info(true, null, 5))?.label).toBe("Sign-up · open");
    expect(signupBadge(info(false, 2, 0))?.label).toBe("Sign-ups closed");
    expect(isFull(info(true, 2, 2))).toBe(true);
  });

  it("the spots line only counts down while sign-ups are open", () => {
    expect(spotsSummary(info(true, 2, 0))).toBe("0 of 2 spots taken · 2 left");
    expect(spotsSummary(info(true, 2, 2))).toBe("2 of 2 spots taken · full");
    expect(spotsSummary(info(false, 2, 0))).toBe("0 of 2 spots taken");
    expect(spotsSummary(info(true, null, 1))).toBe("1 person on it · no limit");
    expect(spotsSummary(info(false, null, 3))).toBe("3 people on it");
  });
});

describe("tasks marked finished", () => {
  it("are past whatever their due date, say who finished them, and count everyone counted as done (2/2)", async () => {
    await task("drivetrain", {
      title: "Drivetrain construction",
      subteam: "BUILD",
      day: 2,
      creator: p.buildLead,
      people: [
        [p.buildMember, "APPROVED"],
        [p.buildMember2, "TODO"],
      ],
    });
    expect(allTasks((await board(p.buildMember2)).sections).map((x) => x.id)).toContain(ids.drivetrain);
    await finishTask(contextFor(t.db, p.buildLead), { taskId: ids.drivetrain, credit: "everyone" });

    expect(allTasks((await board(p.buildMember2)).sections).map((x) => x.id)).not.toContain(ids.drivetrain);
    const past = await board(p.buildMember2, { view: "past" });
    expect(find(past.sections, "drivetrain")).toMatchObject({
      counts: { total: 2, done: 2, checked: 0, todo: 0, closed: 0 },
      completedAt: TEST_NOW,
      completedByName: "Blake Lead",
      isMine: true,
      canManage: false,
    });
    expect(find(past.sections, "drivetrain")).toMatchObject({ completedById: p.buildLead.id, countedWhenFinished: 0 });
    // Only people who manage it see how many "Reopen task" would put back (the one counted for everyone).
    expect(find((await board(p.buildLead, { view: "past" })).sections, "drivetrain")).toMatchObject({
      canManage: true,
      countedWhenFinished: 1,
    });
    // Gone from the other person's Today, done.
    const today = await getTodayView(p.buildMember2, TEST_TODAY, t.db);
    expect([...today.overdue, ...today.today, ...today.upcoming, ...today.waiting].map((i) => i.task.id)).not.toContain(ids.drivetrain);
  });

  it("'Just close it': people who weren't done show as closed, and nobody signs up or leaves", async () => {
    await task("closedSignup", {
      title: "Closed sign-up",
      subteam: "BUILD",
      day: 3,
      creator: p.buildLead,
      signupOpen: true,
      signupLimit: 5,
      people: [
        [p.buildMember3, "TODO", { self: true }],
        [p.buildMember2, "SUBMITTED"],
      ],
    });
    await finishTask(contextFor(t.db, p.buildLead), { taskId: ids.closedSignup, credit: "none" });

    const asSignedUp = find((await board(p.buildMember3, { view: "past" })).sections, "closedSignup");
    expect(asSignedUp.people.map((x) => [x.name, x.publicStatus])).toEqual([
      ["Ben Build", "closed"],
      ["Cy Build", "closed"],
    ]);
    expect(asSignedUp).toMatchObject({ counts: { total: 2, done: 0, checked: 0, todo: 0, closed: 2 }, signupOpen: false, canLeave: false });
    const asOther = await getBoardTask(p.buildMember, ids.closedSignup, { today: TEST_TODAY }, t.db);
    expect(asOther).toMatchObject({ canSignUp: false, signupOpen: false, signupNote: "This task is finished, so sign-ups are closed." });
    expect(allTasks((await board(p.buildMember, { open: true })).sections).map((x) => x.id)).not.toContain(ids.closedSignup);

    await reopenTask(contextFor(t.db, p.buildLead), { taskId: ids.closedSignup });
    const reopened = find((await board(p.buildMember3)).sections, "closedSignup");
    expect(reopened).toMatchObject({ signupOpen: true, canLeave: true, completedAt: null });
    expect(reopened.people.map((x) => x.publicStatus)).toEqual(["checked", "todo"]);
    expect((await getBoardTask(p.buildMember, ids.closedSignup, { today: TEST_TODAY }, t.db))?.canSignUp).toBe(true);
  });
});

describe("who adds tasks where", () => {
  it("the Business leader adds tasks to Whole team without managing its categories; other leaders don't", async () => {
    const rights = async (actor: Actor) =>
      (await board(actor)).sections.map((s) => [s.key, { tasks: s.canCreateTasks, categories: s.canManage }]);
    expect(await rights(p.bizLead)).toEqual([
      ["SOFTWARE", { tasks: false, categories: false }],
      ["BUILD", { tasks: false, categories: false }],
      ["BUSINESS", { tasks: true, categories: true }],
      ["TEAM", { tasks: true, categories: false }],
    ]);
    expect(await rights(p.buildLead)).toEqual([
      ["SOFTWARE", { tasks: false, categories: false }],
      ["BUILD", { tasks: true, categories: true }],
      ["BUSINESS", { tasks: false, categories: false }],
      ["TEAM", { tasks: false, categories: false }],
    ]);
    expect((await board(p.captain)).sections.every((s) => s.canCreateTasks && s.canManage)).toBe(true);
    expect((await board(p.bizMember)).sections.some((s) => s.canCreateTasks || s.canManage)).toBe(false);
  });
});
