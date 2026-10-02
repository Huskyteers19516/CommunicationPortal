import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssignmentStatus, Priority } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import type { EmailMessage } from "@/server/email/transport";
import { TASK_FINISHED_CODES } from "@/lib/action-state";
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { deliverNotification } from "@/server/notifications/deliver";
import {
  getMyTasks,
  getTodayView,
  MY_TASKS_PAGE_SIZE,
  TODAY_VIEW_LIMIT,
  type ChecklistItemData,
} from "@/server/queries/checklist";
import {
  SUBMIT_RATE_LIMIT,
  submitAssignment,
  updateSubmissionNote,
  withdrawAssignment,
} from "@/server/services/checklist";
import { finishTask, reopenTask } from "@/server/services/tasks";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeTask, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

let t: TestDb;
let member: Actor;
let otherMember: Actor;
let buildLead: Actor;
let captain: Actor;
let admin: Actor;

beforeAll(async () => {
  t = await createTestDb();
  member = await makeUser(t.db, { name: "Maya Member", role: "MEMBER", subteam: "BUILD" });
  otherMember = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
  buildLead = await makeUser(t.db, { name: "Blake Lead", role: "BUILD_LEADER" });
  captain = await makeUser(t.db, { name: "Cam Captain", role: "CAPTAIN" });
  admin = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true });
});

afterAll(async () => {
  await t?.drop();
});

interface AssignOptions {
  /** Days from TEST_TODAY (negative = past). */
  due?: number;
  status?: AssignmentStatus;
  priority?: Priority;
  title?: string;
  description?: string;
  creator?: Actor;
  reviewer?: Actor;
  reviewNote?: string | null;
  reviewedAt?: Date | null;
  submissionNote?: string | null;
  submittedAt?: Date | null;
  /** Also assign the same task to these users (to prove their rows never leak). */
  alsoAssign?: Actor[];
}

/** A task assigned to `user`, with the user's assignment put into the requested state. */
async function assign(user: Actor, opts: AssignOptions = {}) {
  const creator = opts.creator ?? buildLead;
  const task = await makeTask(t.db, creator, {
    title: opts.title,
    description: opts.description,
    subteam: "BUILD",
    dueDate: addDays(TEST_TODAY, opts.due ?? 0),
    priority: opts.priority ?? "NORMAL",
    assigneeIds: [user.id, ...(opts.alsoAssign ?? []).map((u) => u.id)],
  });
  const mine = task.assignments.find((a) => a.userId === user.id)!;
  const status = opts.status ?? "TODO";
  const reviewed = status === "APPROVED" || status === "REJECTED";
  const submitted = status !== "TODO";
  await t.db.taskAssignment.update({
    where: { id: mine.id },
    data: {
      status,
      submittedAt: opts.submittedAt !== undefined ? opts.submittedAt : submitted ? new Date(TEST_NOW.getTime() - 3_600_000) : null,
      submissionNote: opts.submissionNote ?? null,
      reviewedById: reviewed ? (opts.reviewer ?? creator).id : null,
      reviewedAt: opts.reviewedAt !== undefined ? opts.reviewedAt : reviewed ? new Date(TEST_NOW.getTime() - 1_800_000) : null,
      reviewNote: opts.reviewNote ?? (status === "REJECTED" ? "Please add photos." : null),
    },
  });
  return { taskId: task.id, assignmentId: mine.id };
}

const load = (id: string) => t.db.taskAssignment.findUniqueOrThrow({ where: { id } });

// ---------------------------------------------------------------------------------------------

describe("submitAssignment", () => {
  it("checks off my own TODO item and notifies", async () => {
    const { assignmentId } = await assign(member);
    const ctx = contextFor(t.db, member);
    await submitAssignment(ctx, { assignmentId, note: "  Cut the new axle plates.  " });

    const row = await load(assignmentId);
    expect(row.status).toBe("SUBMITTED");
    expect(row.submittedAt?.toISOString()).toBe(TEST_NOW.toISOString());
    expect(row.submissionNote).toBe("Cut the new axle plates.");
    expect(ctx.notifier.events).toEqual([{ type: "task.submitted", assignmentId }]);
  });

  it("stores no note when none (or a blank one) is given", async () => {
    const a = await assign(member);
    const b = await assign(member);
    const ctx = contextFor(t.db, member);
    await submitAssignment(ctx, { assignmentId: a.assignmentId });
    await submitAssignment(ctx, { assignmentId: b.assignmentId, note: "   " });
    expect((await load(a.assignmentId)).submissionNote).toBeNull();
    expect((await load(b.assignmentId)).submissionNote).toBeNull();
    expect(ctx.notifier.ofType("task.submitted")).toHaveLength(2);
  });

  it("re-submits an item that needs changes and keeps the leader's feedback", async () => {
    const { assignmentId } = await assign(member, { status: "REJECTED", reviewNote: "Tighten the belt first." });
    const ctx = contextFor(t.db, member);
    await submitAssignment(ctx, { assignmentId, note: "Tightened." });

    const row = await load(assignmentId);
    expect(row.status).toBe("SUBMITTED");
    expect(row.reviewNote).toBe("Tighten the belt first.");
    expect(row.submissionNote).toBe("Tightened.");
    expect(row.submittedAt?.toISOString()).toBe(TEST_NOW.toISOString());
    expect(ctx.notifier.events).toEqual([{ type: "task.submitted", assignmentId }]);
  });

  it("hides other people's items (NotFoundError) from every role", async () => {
    const { assignmentId } = await assign(member);
    for (const actor of [otherMember, buildLead, captain, admin]) {
      const ctx = contextFor(t.db, actor);
      await expect(submitAssignment(ctx, { assignmentId }), actor.name).rejects.toBeInstanceOf(NotFoundError);
      expect(ctx.notifier.events).toHaveLength(0);
    }
    expect((await load(assignmentId)).status).toBe("TODO");
  });

  it("returns NotFoundError for an unknown id", async () => {
    const ctx = contextFor(t.db, member);
    await expect(submitAssignment(ctx, { assignmentId: "does-not-exist" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses items that are already submitted or approved (ConflictError)", async () => {
    for (const status of ["SUBMITTED", "APPROVED"] as const) {
      const { assignmentId } = await assign(member, { status });
      const before = await load(assignmentId);
      const ctx = contextFor(t.db, member);
      const attempt = submitAssignment(ctx, { assignmentId });
      await expect(attempt).rejects.toBeInstanceOf(ConflictError);
      await expect(attempt).rejects.toThrow("This item was already submitted or approved.");
      expect(ctx.notifier.events).toHaveLength(0);
      const after = await load(assignmentId);
      expect(after.status).toBe(status);
      expect(after.submittedAt).toEqual(before.submittedAt);
    }
  });

  it("only one of two racing submits wins", async () => {
    const { assignmentId } = await assign(member);
    const ctx = contextFor(t.db, member);
    const results = await Promise.allSettled([
      submitAssignment(ctx, { assignmentId }),
      submitAssignment(ctx, { assignmentId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect(ctx.notifier.events).toHaveLength(1);
  });

  it("validates the note length and the id", async () => {
    const { assignmentId } = await assign(member);
    const ctx = contextFor(t.db, member);

    const tooLong = submitAssignment(ctx, { assignmentId, note: "x".repeat(LIMITS.noteMax + 1) });
    await expect(tooLong).rejects.toBeInstanceOf(ValidationError);
    await tooLong.catch((e: ValidationError) => {
      expect(e.fieldErrors.note).toBe(`Note must be at most ${LIMITS.noteMax} characters.`);
    });
    expect((await load(assignmentId)).status).toBe("TODO");

    await expect(submitAssignment(ctx, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(submitAssignment(ctx, { assignmentId: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(submitAssignment(ctx, null)).rejects.toBeInstanceOf(ValidationError);
    await expect(submitAssignment(ctx, { assignmentId: 42 })).rejects.toBeInstanceOf(ValidationError);
    expect(ctx.notifier.events).toHaveLength(0);

    await submitAssignment(ctx, { assignmentId, note: "y".repeat(LIMITS.noteMax) });
    expect((await load(assignmentId)).submissionNote).toHaveLength(LIMITS.noteMax);
  });
});

describe("submitAssignment: note in the leader's email", () => {
  it("a note given at check-off reaches the task.submitted email", async () => {
    // The "Check off with a note" form sends the note with the submit, so the email planned right after has it.
    const { assignmentId } = await assign(member, { title: "Upload the CAD export" });
    const ctx = contextFor(t.db, member);
    await submitAssignment(ctx, { assignmentId, note: "Exported to the team drive: CAD/arm-v3.step" });

    const [event] = ctx.notifier.ofType("task.submitted");
    const sent: EmailMessage[] = [];
    const transport = { name: "fake", send: async (m: EmailMessage) => void sent.push(m) };
    await deliverNotification(t.db, event, { transport, appUrl: "http://localhost:3000", teamTimezone: TEST_TZ, now: TEST_NOW });

    const toLeader = sent.find((m) => m.to === buildLead.email);
    expect(toLeader?.text).toContain("Exported to the team drive: CAD/arm-v3.step");
  });
});

describe("submitAssignment: throttle", () => {
  it(`allows ${SUBMIT_RATE_LIMIT.limit} check-offs per hour (a full day's list and then some), then refuses without changing anything`, async () => {
    expect(SUBMIT_RATE_LIMIT.limit).toBeGreaterThanOrEqual(60);
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const items: string[] = [];
    for (let i = 0; i <= SUBMIT_RATE_LIMIT.limit; i++) items.push((await assign(busy)).assignmentId);
    const extra = items.pop()!;

    const ctx = contextFor(t.db, busy);
    for (const assignmentId of items) await submitAssignment(ctx, { assignmentId });
    expect(ctx.notifier.ofType("task.submitted")).toHaveLength(SUBMIT_RATE_LIMIT.limit);

    const attempt = submitAssignment(ctx, { assignmentId: extra, note: "one too many" });
    await expect(attempt).rejects.toBeInstanceOf(RateLimitError);
    await expect(attempt).rejects.toThrow(/wait a few minutes/);
    const row = await load(extra);
    expect(row.status).toBe("TODO");
    expect(row.submissionNote).toBeNull();
    expect(ctx.notifier.events).toHaveLength(SUBMIT_RATE_LIMIT.limit);

    // Check/uncheck loops count too: unchecking doesn't give the budget back.
    await withdrawAssignment(ctx, { assignmentId: items[0] });
    await expect(submitAssignment(ctx, { assignmentId: items[0] })).rejects.toBeInstanceOf(RateLimitError);

    // It's per person: a teammate checking off at the same time is unaffected.
    const { assignmentId: theirs } = await assign(otherMember);
    await submitAssignment(contextFor(t.db, otherMember), { assignmentId: theirs });
    expect((await load(theirs)).status).toBe("SUBMITTED");

    // Once the hour has passed it works again.
    const later = { ...contextFor(t.db, busy), now: new Date(TEST_NOW.getTime() + SUBMIT_RATE_LIMIT.windowMs + 1000) };
    await submitAssignment(later, { assignmentId: extra, note: "Back at it." });
    expect((await load(extra)).status).toBe("SUBMITTED");
    expect(later.notifier.events).toEqual([{ type: "task.submitted", assignmentId: extra }]);
  });

  it("doesn't count requests that fail validation", async () => {
    const quick = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const ctx = contextFor(t.db, quick);
    for (let i = 0; i < SUBMIT_RATE_LIMIT.limit + 5; i++) {
      await expect(submitAssignment(ctx, { assignmentId: "" })).rejects.toBeInstanceOf(ValidationError);
    }
    const { assignmentId } = await assign(quick);
    await submitAssignment(ctx, { assignmentId });
    expect((await load(assignmentId)).status).toBe("SUBMITTED");
  });
});

describe("withdrawAssignment", () => {
  it("unchecks a submitted item and clears the submission fields", async () => {
    const { assignmentId } = await assign(member, { status: "SUBMITTED", submissionNote: "Done!" });
    const ctx = contextFor(t.db, member);
    await withdrawAssignment(ctx, { assignmentId });

    const row = await load(assignmentId);
    expect(row.status).toBe("TODO");
    expect(row.submittedAt).toBeNull();
    expect(row.submissionNote).toBeNull();
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("keeps earlier feedback when withdrawing a re-submission", async () => {
    const { assignmentId } = await assign(member, { status: "REJECTED", reviewNote: "Wrong bolts." });
    const ctx = contextFor(t.db, member);
    await submitAssignment(ctx, { assignmentId });
    await withdrawAssignment(ctx, { assignmentId });
    const row = await load(assignmentId);
    expect(row.status).toBe("TODO");
    expect(row.reviewNote).toBe("Wrong bolts.");
  });

  it("refuses once a leader reviewed it", async () => {
    for (const status of ["APPROVED", "REJECTED"] as const) {
      const { assignmentId } = await assign(member, { status });
      const ctx = contextFor(t.db, member);
      const attempt = withdrawAssignment(ctx, { assignmentId });
      await expect(attempt).rejects.toBeInstanceOf(ConflictError);
      await expect(attempt).rejects.toThrow("A leader already reviewed this item.");
      expect((await load(assignmentId)).status).toBe(status);
    }
  });

  it("refuses an item that isn't checked", async () => {
    const { assignmentId } = await assign(member);
    await expect(withdrawAssignment(contextFor(t.db, member), { assignmentId })).rejects.toBeInstanceOf(ConflictError);
  });

  it("hides other people's items (NotFoundError)", async () => {
    const { assignmentId } = await assign(member, { status: "SUBMITTED" });
    for (const actor of [otherMember, buildLead, captain, admin]) {
      await expect(withdrawAssignment(contextFor(t.db, actor), { assignmentId }), actor.name).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }
    expect((await load(assignmentId)).status).toBe("SUBMITTED");
  });

  it("validates input", async () => {
    await expect(withdrawAssignment(contextFor(t.db, member), {})).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("updateSubmissionNote", () => {
  it("sets and clears the note while waiting for review", async () => {
    const { assignmentId } = await assign(member, { status: "SUBMITTED" });
    const ctx = contextFor(t.db, member);

    await updateSubmissionNote(ctx, { assignmentId, note: "Photos are in the team drive." });
    expect((await load(assignmentId)).submissionNote).toBe("Photos are in the team drive.");

    await updateSubmissionNote(ctx, { assignmentId, note: "" });
    const row = await load(assignmentId);
    expect(row.submissionNote).toBeNull();
    expect(row.status).toBe("SUBMITTED");
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("only works while the item is submitted", async () => {
    for (const status of ["TODO", "APPROVED", "REJECTED"] as const) {
      const { assignmentId } = await assign(member, { status });
      const attempt = updateSubmissionNote(contextFor(t.db, member), { assignmentId, note: "hi" });
      await expect(attempt, status).rejects.toBeInstanceOf(ConflictError);
      expect((await load(assignmentId)).submissionNote).toBeNull();
    }
  });

  it("validates the note length", async () => {
    const { assignmentId } = await assign(member, { status: "SUBMITTED", submissionNote: "keep me" });
    const attempt = updateSubmissionNote(contextFor(t.db, member), { assignmentId, note: "x".repeat(LIMITS.noteMax + 1) });
    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await attempt.catch((e: ValidationError) => expect(e.fieldErrors.note).toBeDefined());
    expect((await load(assignmentId)).submissionNote).toBe("keep me");
  });

  it("hides other people's items (NotFoundError)", async () => {
    const { assignmentId } = await assign(member, { status: "SUBMITTED", submissionNote: "mine" });
    for (const actor of [otherMember, buildLead, captain, admin]) {
      await expect(
        updateSubmissionNote(contextFor(t.db, actor), { assignmentId, note: "hacked" }),
        actor.name,
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await load(assignmentId)).submissionNote).toBe("mine");
  });
});

// ---------------------------------------------------------------------------------------------

const titles = (items: ChecklistItemData[]) => items.map((i) => i.task.title);

describe("getTodayView", () => {
  let user: Actor;
  let ids: Record<string, string>;

  beforeAll(async () => {
    user = await makeUser(t.db, { name: "Tia Today", role: "MEMBER", subteam: "BUILD" });
    const intruder = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const other = [intruder];
    const mk = async (title: string, opts: AssignOptions) => (await assign(user, { title, alsoAssign: other, ...opts })).assignmentId;
    ids = {
      overdueOld: await mk("overdue-2", { due: -2 }),
      overdueNew: await mk("overdue-1", { due: -1, priority: "HIGH" }),
      oldSubmitted: await mk("waiting-3", { due: -3, status: "SUBMITTED" }),
      oldApproved: await mk("approved-2", { due: -2, status: "APPROVED" }),
      rejectedOld: await mk("rejected-5", { due: -5, status: "REJECTED", reviewNote: "Redo the wiring." }),
      rejectedToday: await mk("rejected-0", { due: 0, status: "REJECTED" }),
      rejectedFar: await mk("rejected+10", { due: 10, status: "REJECTED" }),
      todayApproved: await mk("today-approved", { due: 0, status: "APPROVED", reviewer: captain, reviewNote: "Great job" }),
      todaySubmitted: await mk("today-submitted", { due: 0, status: "SUBMITTED", submissionNote: "See photos" }),
      todayTodo: await mk("today-todo", { due: 0, description: "Bring safety glasses." }),
      tomorrow: await mk("upcoming+1", { due: 1 }),
      in3Submitted: await mk("upcoming+3", { due: 3, status: "SUBMITTED" }),
      in7: await mk("upcoming+7", { due: 7 }),
      in2Approved: await mk("approved+2", { due: 2, status: "APPROVED" }),
      in8: await mk("beyond+8", { due: 8 }),
    };
    // The intruder's own copies are in different states; none of them may show up for `user`.
    await t.db.taskAssignment.updateMany({ where: { userId: intruder.id }, data: { status: "REJECTED" } });
  });

  it("groups my items into the right sections", async () => {
    const view = await getTodayView(user, TEST_TODAY, t.db);

    expect(titles(view.needsChanges)).toEqual(["rejected-5", "rejected-0", "rejected+10"]);
    expect(titles(view.overdue)).toEqual(["overdue-2", "overdue-1"]);
    expect(titles(view.today)).toEqual(["today-todo", "today-submitted", "today-approved"]);
    expect(titles(view.waiting)).toEqual(["waiting-3"]);
    expect(titles(view.upcoming)).toEqual(["upcoming+1", "upcoming+3", "upcoming+7"]);
    expect(view.hiddenOverdue).toBe(0);

    const all = [...view.needsChanges, ...view.overdue, ...view.today, ...view.waiting, ...view.upcoming];
    const shown = all.map((i) => i.assignmentId);
    expect(new Set(shown).size).toBe(shown.length); // every item appears once
    expect(shown).not.toContain(ids.oldApproved);
    expect(shown).not.toContain(ids.in2Approved);
    expect(shown).not.toContain(ids.in8);
  });

  it("summarises today (approved + waiting out of everything due today)", async () => {
    const view = await getTodayView(user, TEST_TODAY, t.db);
    expect(view.summary).toEqual({ todayTotal: 4, todayApproved: 1, todaySubmitted: 1, overdueCount: 2 });
  });

  it("returns plain, serializable items", async () => {
    const view = await getTodayView(user, TEST_TODAY, t.db);
    const approved = view.today.find((i) => i.assignmentId === ids.todayApproved)!;
    expect(approved).toMatchObject({
      status: "APPROVED",
      reviewNote: "Great job",
      reviewerName: "Cam Captain",
      task: { title: "today-approved", subteam: "BUILD", dueDate: TEST_TODAY, priority: "NORMAL", creatorName: "Blake Lead" },
    });
    expect(typeof approved.reviewedAt).toBe("string");
    const submitted = view.today.find((i) => i.assignmentId === ids.todaySubmitted)!;
    expect(submitted.submissionNote).toBe("See photos");
    expect(typeof submitted.submittedAt).toBe("string");
    expect(view.today.find((i) => i.assignmentId === ids.todayTodo)!.task.description).toBe("Bring safety glasses.");
    expect(view.needsChanges[0].reviewNote).toBe("Redo the wiring.");
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("never shows other people's items", async () => {
    const view = await getTodayView(user, TEST_TODAY, t.db);
    const rows = await t.db.taskAssignment.findMany({
      where: { id: { in: [...view.needsChanges, ...view.overdue, ...view.today, ...view.waiting, ...view.upcoming].map((i) => i.assignmentId) } },
      select: { userId: true },
    });
    expect(rows.every((r) => r.userId === user.id)).toBe(true);
  });

  it("is empty for someone with nothing assigned", async () => {
    const nobody = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    const view = await getTodayView(nobody, TEST_TODAY, t.db);
    expect(view).toEqual({
      needsChanges: [],
      overdue: [],
      today: [],
      waiting: [],
      upcoming: [],
      summary: { todayTotal: 0, todayApproved: 0, todaySubmitted: 0, overdueCount: 0 },
      hiddenOverdue: 0,
    });
  });

  it("caps very long lists but keeps the overdue count honest", async () => {
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const extra = 5;
    const count = TODAY_VIEW_LIMIT + extra;
    const taskIds = Array.from({ length: count }, (_, i) => `bulk-${busy.id}-${i}`);
    await t.db.task.createMany({
      data: taskIds.map((id, i) => ({
        id,
        title: `bulk ${i}`,
        subteam: "BUILD" as const,
        dueDate: dateOnlyToDb(addDays(TEST_TODAY, -1 - i)),
        createdById: buildLead.id,
      })),
    });
    await t.db.taskAssignment.createMany({ data: taskIds.map((taskId) => ({ taskId, userId: busy.id })) });
    await assign(busy, { title: "due today", due: 0 });

    const view = await getTodayView(busy, TEST_TODAY, t.db);
    expect(view.today).toHaveLength(1); // the newest items always make the cut
    expect(view.summary.overdueCount).toBe(count);
    expect(view.overdue).toHaveLength(TODAY_VIEW_LIMIT - 1);
    expect(view.hiddenOverdue).toBe(extra + 1);
    expect(view.overdue[view.overdue.length - 1].task.dueDate).toBe(addDays(TEST_TODAY, -1));
  });
});

describe("getMyTasks", () => {
  let user: Actor;
  let ids: Record<string, string>;

  beforeAll(async () => {
    user = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const other = [otherMember];
    const mk = async (title: string, opts: AssignOptions) => (await assign(user, { title, alsoAssign: other, ...opts })).assignmentId;
    ids = {
      a: await mk("todo-3", { due: 3 }),
      b: await mk("rejected-1", { due: -1, status: "REJECTED" }),
      c: await mk("submitted+1", { due: 1, status: "SUBMITTED" }),
      d: await mk("approved-old", { due: -10, status: "APPROVED", reviewedAt: new Date("2026-09-10T18:00:00Z") }),
      e: await mk("approved-new", { due: -20, status: "APPROVED", reviewedAt: new Date("2026-09-23T18:00:00Z") }),
      f: await mk("todo+20", { due: 20 }),
    };
    await t.db.taskAssignment.updateMany({ where: { userId: otherMember.id }, data: { status: "APPROVED", reviewedAt: TEST_NOW } });
  });

  it("open tab: to do, needs changes, and waiting — soonest first", async () => {
    const res = await getMyTasks(user, { tab: "open", page: 1 }, t.db);
    expect(titles(res.items)).toEqual(["rejected-1", "submitted+1", "todo-3", "todo+20"]);
    expect(res.counts).toEqual({ open: 4, done: 2, all: 6 });
    expect(res).toMatchObject({ tab: "open", page: 1, pageCount: 1 });
  });

  it("done tab: approved, most recently reviewed first", async () => {
    const res = await getMyTasks(user, { tab: "done", page: 1 }, t.db);
    expect(titles(res.items)).toEqual(["approved-new", "approved-old"]);
  });

  it("all tab: everything, latest due date first", async () => {
    const res = await getMyTasks(user, { tab: "all", page: 1 }, t.db);
    expect(titles(res.items)).toEqual(["todo+20", "todo-3", "submitted+1", "rejected-1", "approved-old", "approved-new"]);
  });

  it("never shows other people's items", async () => {
    for (const tab of ["open", "done", "all"] as const) {
      const res = await getMyTasks(user, { tab, page: 1 }, t.db);
      expect(res.items.map((i) => i.assignmentId).every((id) => Object.values(ids).includes(id))).toBe(true);
    }
    const theirs = await getMyTasks(otherMember, { tab: "all", page: 1 }, t.db);
    expect(theirs.items.map((i) => i.assignmentId)).not.toContain(ids.a);
  });

  it("paginates at 50 and clamps pages past the end", async () => {
    const many = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const total = MY_TASKS_PAGE_SIZE + 5;
    const taskIds = Array.from({ length: total }, (_, i) => `page-${many.id}-${i}`);
    await t.db.task.createMany({
      data: taskIds.map((id, i) => ({
        id,
        title: `p${String(i).padStart(2, "0")}`,
        subteam: "BUILD" as const,
        dueDate: dateOnlyToDb(addDays(TEST_TODAY, i)),
        createdById: buildLead.id,
      })),
    });
    await t.db.taskAssignment.createMany({ data: taskIds.map((taskId) => ({ taskId, userId: many.id })) });

    const p1 = await getMyTasks(many, { tab: "open", page: 1 }, t.db);
    expect(p1.items).toHaveLength(MY_TASKS_PAGE_SIZE);
    expect(p1.pageCount).toBe(2);
    expect(p1.items[0].task.title).toBe("p00");

    const p2 = await getMyTasks(many, { tab: "open", page: 2 }, t.db);
    expect(titles(p2.items)).toEqual(["p50", "p51", "p52", "p53", "p54"]);

    const past = await getMyTasks(many, { tab: "open", page: 99 }, t.db);
    expect(past.page).toBe(2);
    expect(past.items).toHaveLength(5);

    const done = await getMyTasks(many, { tab: "done", page: 3 }, t.db);
    expect(done).toMatchObject({ items: [], page: 1, pageCount: 1, counts: { open: total, done: 0, all: total } });
  });
});

// ---------------------------------------------------------------------------------------------

describe("tasks a leader marked finished", () => {
  const finish = (taskId: string, credit: "everyone" | "none") => finishTask(contextFor(t.db, buildLead), { taskId, credit });

  it("can't be checked off, unchecked, or have the note changed anymore", async () => {
    const user = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const todo = await assign(user, { title: "closed todo" });
    const waiting = await assign(user, { title: "closed waiting", status: "SUBMITTED", submissionNote: "Here it is" });
    await finish(todo.taskId, "none");
    await finish(waiting.taskId, "none");

    const ctx = contextFor(t.db, user);
    // Refused with a code the checklist shows as a neutral notice (not a red error), saying how it ended.
    const refused = await submitAssignment(ctx, { assignmentId: todo.assignmentId }).catch((e) => e);
    expect(refused).toBeInstanceOf(ConflictError);
    expect(refused).toMatchObject({
      code: TASK_FINISHED_CODES.closed,
      message: "Blake Lead marked the whole task finished — it was closed without credit.",
    });
    await expect(withdrawAssignment(ctx, { assignmentId: waiting.assignmentId })).rejects.toMatchObject({
      code: TASK_FINISHED_CODES.closed,
      message: "Blake Lead marked the whole task finished — your check-off wasn't approved in time, so it doesn't count.",
    });
    await expect(updateSubmissionNote(ctx, { assignmentId: waiting.assignmentId, note: "Changed" })).rejects.toThrow(ConflictError);
    expect((await load(todo.assignmentId)).status).toBe("TODO");
    expect(await load(waiting.assignmentId)).toMatchObject({ status: "SUBMITTED", submissionNote: "Here it is" });
    expect(ctx.notifier.events).toEqual([]);
    // Someone else's item still looks missing, finished or not.
    await expect(submitAssignment(contextFor(t.db, otherMember), { assignmentId: todo.assignmentId })).rejects.toThrow(NotFoundError);

    // Reopened: back to normal.
    await reopenTask(contextFor(t.db, buildLead), { taskId: todo.taskId });
    await submitAssignment(ctx, { assignmentId: todo.assignmentId });
    expect((await load(todo.assignmentId)).status).toBe("SUBMITTED");
  });

  it("a stale check-off after 'Count it as done' says it counts (not an error); the finisher is 'You'", async () => {
    const user = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const item = await assign(user, { title: "counted while open" });
    await finish(item.taskId, "everyone");
    await expect(submitAssignment(contextFor(t.db, user), { assignmentId: item.assignmentId })).rejects.toMatchObject({
      code: TASK_FINISHED_CODES.counted,
      message: "Blake Lead marked the whole task finished — it counts as done for you.",
    });
    // A leader's own item on a task they finished (just closed): "You".
    const own = await assign(buildLead, { title: "own item" });
    await finish(own.taskId, "none");
    await expect(submitAssignment(contextFor(t.db, buildLead), { assignmentId: own.assignmentId })).rejects.toThrow(
      "You marked the whole task finished — it was closed without credit.",
    );
    // Other refusals carry no code.
    const done = await assign(user, { status: "APPROVED" });
    const other = await submitAssignment(contextFor(t.db, user), { assignmentId: done.assignmentId }).catch((e) => e);
    expect(other).toBeInstanceOf(ConflictError);
    expect((other as ConflictError).code).toBeUndefined();
  });

  it("Today: closed items are gone (never overdue or waiting); items counted as done show as done", async () => {
    const user = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const closedIds = [
      await assign(user, { title: "closed today", due: 0 }),
      await assign(user, { title: "closed overdue", due: -2 }),
      await assign(user, { title: "closed sent back", due: 3, status: "REJECTED" }),
      await assign(user, { title: "closed waiting", due: -1, status: "SUBMITTED" }),
      await assign(user, { title: "closed upcoming", due: 2, status: "SUBMITTED" }),
    ];
    for (const c of closedIds) await finish(c.taskId, "none");
    const counted = await assign(user, { title: "counted today", due: 0, alsoAssign: [otherMember] });
    await finish(counted.taskId, "everyone");
    await assign(user, { title: "open today", due: 0 });

    const view = await getTodayView(user, TEST_TODAY, t.db);
    expect(titles(view.today)).toEqual(["open today", "counted today"]);
    expect([view.needsChanges, view.overdue, view.waiting, view.upcoming].map(titles)).toEqual([[], [], [], []]);
    expect(view.summary).toEqual({ todayTotal: 2, todayApproved: 1, todaySubmitted: 0, overdueCount: 0 });
    expect(view.today.find((i) => i.task.title === "counted today")).toMatchObject({
      status: "APPROVED",
      finishedWithTask: true,
      reviewerName: "Blake Lead",
      task: { finishedAt: TEST_NOW.toISOString(), finishedByName: "Blake Lead" },
    });
    expect(view.today.find((i) => i.task.title === "open today")).toMatchObject({
      finishedWithTask: false,
      task: { finishedAt: null, finishedByName: null },
    });
  });

  it("My tasks: closed items leave Open and are listed under Done", async () => {
    const user = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const closed = await assign(user, { title: "closed", due: -3 });
    await finish(closed.taskId, "none");
    const counted = await assign(user, { title: "counted", due: 1, status: "SUBMITTED" });
    await finish(counted.taskId, "everyone");
    await assign(user, { title: "still open", due: 2 });

    const open = await getMyTasks(user, { tab: "open", page: 1 }, t.db);
    expect(titles(open.items)).toEqual(["still open"]);
    expect(open.counts).toEqual({ open: 1, done: 2, all: 3 });
    const done = await getMyTasks(user, { tab: "done", page: 1 }, t.db);
    expect(titles(done.items).sort()).toEqual(["closed", "counted"]);
    expect(done.items.find((i) => i.task.title === "closed")).toMatchObject({ status: "TODO", task: { finishedByName: "Blake Lead" } });
    expect(done.items.find((i) => i.task.title === "counted")).toMatchObject({ status: "APPROVED", finishedWithTask: true });
  });

  it("My tasks → Done: most recently done first — approvals by approval time, closed items by when the task was finished", async () => {
    const user = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const hoursAgo = (h: number) => new Date(TEST_NOW.getTime() - h * 3_600_000);
    const finishAt = (taskId: string, at: Date) =>
      finishTask({ ...contextFor(t.db, buildLead), now: at }, { taskId, credit: "none" });

    await assign(user, { title: "approved 5h ago", status: "APPROVED", reviewedAt: hoursAgo(5) });
    await assign(user, { title: "approved 1h ago", status: "APPROVED", reviewedAt: hoursAgo(1) });
    // A closed to-do (no review time) and a closed send-back (reviewed long ago) are dated by the finish.
    const closedTodo = await assign(user, { title: "closed to-do, finished 3h ago" });
    await finishAt(closedTodo.taskId, hoursAgo(3));
    const closedSentBack = await assign(user, {
      title: "closed send-back, finished 2h ago",
      status: "REJECTED",
      reviewedAt: hoursAgo(48),
    });
    await finishAt(closedSentBack.taskId, hoursAgo(2));
    // Approved one by one long before its task was finished: still dated by its approval.
    const early = await assign(user, { title: "approved 10h ago, finished now", status: "APPROVED", reviewedAt: hoursAgo(10) });
    await finishAt(early.taskId, TEST_NOW);

    const done = await getMyTasks(user, { tab: "done", page: 1 }, t.db);
    expect(titles(done.items)).toEqual([
      "approved 1h ago",
      "closed send-back, finished 2h ago",
      "closed to-do, finished 3h ago",
      "approved 5h ago",
      "approved 10h ago, finished now",
    ]);
    expect(done.counts.done).toBe(5);
  });
});
