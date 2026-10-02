import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssignmentStatus } from "@/generated/prisma/enums";
import { addDays } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import {
  getAssignableUsers,
  getManagedTaskDetail,
  getReviewQueue,
  getTaskDuplicate,
  getTaskFormOptions,
  listManagedTasks,
} from "@/server/queries/tasks";
import {
  approveMany,
  createTask,
  deleteTask,
  finishTask,
  NEW_CATEGORY,
  removeAssignment,
  reopenAssignment,
  reopenTask,
  reviewAssignment,
  setSignupOpen,
  updateTask,
} from "@/server/services/tasks";
import { submitAssignment } from "@/server/services/checklist";
import { leaveTask, signUpForTask } from "@/server/services/signups";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeTask, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let p: Record<
  | "admin"
  | "captain"
  | "mentor"
  | "teacher"
  | "swLead"
  | "buildLead1"
  | "buildLead2"
  | "bizLead"
  | "swMember"
  | "buildMember"
  | "buildMember2"
  | "bizMember"
  | "disabledBuild"
  | "pendingBuildLead",
  Actor
>;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    admin: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true, name: "Ada Admin" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Morgan Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Taylor Teacher" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Software" }),
    buildLead1: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Build" }),
    buildLead2: await makeUser(db, { role: "BUILD_LEADER", name: "Bailey Build" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Bo Business" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Sky Member" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Brook Member" }),
    buildMember2: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Bren Member" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Billie Member" }),
    disabledBuild: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Dana Disabled" }),
    pendingBuildLead: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING", name: "Pat Pending" }),
  };
});

afterAll(async () => {
  await t?.drop();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);

function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Cut aluminum channel",
    description: "Use the chop saw.\nWear goggles.",
    subteam: "BUILD",
    dueDate: addDays(TEST_TODAY, 3),
    priority: "HIGH",
    assigneeIds: [p.buildMember.id, p.buildMember2.id],
    ...overrides,
  };
}

async function submit(assignmentId: string, note: string | null = "Done!") {
  await t.db.taskAssignment.update({
    where: { id: assignmentId },
    data: { status: "SUBMITTED", submittedAt: TEST_NOW, submissionNote: note },
  });
}

async function assignmentOf(taskId: string, userId: string) {
  return t.db.taskAssignment.findUniqueOrThrow({ where: { taskId_userId: { taskId, userId } } });
}

/** A db whose $transaction first deletes the task — another leader deleting it mid-save. */
function deletesTaskBeforeTransaction(db: Db, taskId: string): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "$transaction") {
        return async (...args: unknown[]) => {
          await target.task.deleteMany({ where: { id: taskId } });
          return Reflect.apply(target.$transaction, target, args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("createTask", () => {
  it("lets a leader create a task for their own subteam", async () => {
    const ctx = ctxFor(p.buildLead1);
    const { id } = await createTask(ctx, taskInput());
    const task = await t.db.task.findUniqueOrThrow({ where: { id }, include: { assignments: true } });
    expect(task).toMatchObject({
      title: "Cut aluminum channel",
      description: "Use the chop saw.\nWear goggles.",
      subteam: "BUILD",
      priority: "HIGH",
      createdById: p.buildLead1.id,
    });
    expect(task.dueDate.toISOString().slice(0, 10)).toBe(addDays(TEST_TODAY, 3));
    expect(task.assignments.map((a) => a.userId).sort()).toEqual([p.buildMember.id, p.buildMember2.id].sort());
    expect(task.assignments.every((a) => a.status === "TODO")).toBe(true);
    expect(ctx.notifier.events).toEqual([
      { type: "task.assigned", taskId: id, userIds: [p.buildMember.id, p.buildMember2.id], actorId: p.buildLead1.id },
    ]);
  });

  it("dedupes assignees, defaults priority to NORMAL and description to empty", async () => {
    const ctx = ctxFor(p.buildLead1);
    const { id } = await createTask(ctx, {
      title: "  Sweep the shop  ",
      subteam: "BUILD",
      dueDate: TEST_TODAY,
      assigneeIds: [p.buildMember.id, p.buildMember.id],
    });
    const task = await t.db.task.findUniqueOrThrow({ where: { id }, include: { assignments: true } });
    expect(task.title).toBe("Sweep the shop");
    expect(task.priority).toBe("NORMAL");
    expect(task.description).toBe("");
    expect(task.assignments).toHaveLength(1);
    expect(ctx.notifier.ofType("task.assigned")[0].userIds).toEqual([p.buildMember.id]);
  });

  it("accepts a single assignee id as a plain string (one checked box)", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assigneeIds: p.buildMember.id }));
    expect(await t.db.taskAssignment.count({ where: { taskId: id } })).toBe(1);
  });

  it("forbids a leader from creating a task for another subteam or the whole team", async () => {
    await expect(createTask(ctxFor(p.buildLead1), taskInput({ subteam: "SOFTWARE", assigneeIds: [p.swMember.id] }))).rejects.toThrow(
      ForbiddenError,
    );
    await expect(createTask(ctxFor(p.buildLead1), taskInput({ subteam: "" }))).rejects.toThrow(ForbiddenError);
    await expect(createTask(ctxFor(p.swLead), taskInput())).rejects.toThrow(ForbiddenError);
  });

  it("lets the Business leader create Business tasks for Business members (and only them)", async () => {
    const ctx = ctxFor(p.bizLead);
    const { id } = await createTask(ctx, taskInput({ subteam: "BUSINESS", assigneeIds: [p.bizMember.id] }));
    const task = await t.db.task.findUniqueOrThrow({ where: { id }, include: { assignments: true } });
    expect(task).toMatchObject({ subteam: "BUSINESS", createdById: p.bizLead.id });
    expect(task.assignments.map((a) => a.userId)).toEqual([p.bizMember.id]);
    expect(ctx.notifier.events).toEqual([{ type: "task.assigned", taskId: id, userIds: [p.bizMember.id], actorId: p.bizLead.id }]);
    // A Business task is still for Business people only.
    const err = await createTask(ctx, taskInput({ subteam: "BUSINESS", assigneeIds: [p.buildMember.id] })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.assigneeIds).toContain("Brook Member");
    await expect(createTask(ctx, taskInput({ subteam: "BUILD", assigneeIds: [p.buildMember.id] }))).rejects.toThrow(ForbiddenError);
  });

  it("forbids members (even with a valid-looking payload)", async () => {
    const ctx = ctxFor(p.buildMember);
    await expect(createTask(ctx, taskInput())).rejects.toThrow(ForbiddenError);
    await expect(createTask(ctx, {})).rejects.toThrow(ForbiddenError);
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("lets captain, mentor, teacher and admin create whole-team tasks for anyone", async () => {
    for (const who of [p.captain, p.mentor, p.teacher, p.admin]) {
      const ctx = ctxFor(who);
      const { id } = await createTask(
        ctx,
        taskInput({ subteam: "", assigneeIds: [p.swMember.id, p.buildMember.id, p.bizMember.id, p.captain.id] }),
      );
      const task = await t.db.task.findUniqueOrThrow({ where: { id }, select: { subteam: true, _count: { select: { assignments: true } } } });
      expect(task.subteam).toBeNull();
      expect(task._count.assignments).toBe(4);
    }
  });

  it("rejects assignees outside the leader's subteam, naming them", async () => {
    const err = await createTask(ctxFor(p.buildLead1), taskInput({ assigneeIds: [p.buildMember.id, p.swMember.id] })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.assigneeIds).toContain("Sky Member");
    expect((err as ValidationError).fieldErrors.assigneeIds).toContain("isn't in your subteam");
  });

  it("rejects inactive (disabled / pending) assignees", async () => {
    const err = await createTask(ctxFor(p.captain), taskInput({ assigneeIds: [p.disabledBuild.id, p.pendingBuildLead.id] })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.assigneeIds).toContain("Dana Disabled");
    expect((err as ValidationError).fieldErrors.assigneeIds).toContain("aren't active");
  });

  it("rejects unknown assignee ids", async () => {
    const err = await createTask(ctxFor(p.captain), taskInput({ assigneeIds: ["does-not-exist"] })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.assigneeIds).toMatch(/no longer exists/);
  });

  it("validates title, date, priority, subteam and assignees", async () => {
    const ctx = ctxFor(p.buildLead1);
    const fieldErrors = async (input: Record<string, unknown>) => {
      const err = await createTask(ctx, taskInput(input)).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).fieldErrors;
    };
    expect((await fieldErrors({ title: "   " })).title).toBe("Title is required.");
    expect((await fieldErrors({ title: "x".repeat(141) })).title).toMatch(/at most 140/);
    expect((await fieldErrors({ description: "x".repeat(5001) })).description).toMatch(/at most 5000/);
    expect((await fieldErrors({ dueDate: "2026-02-30" })).dueDate).toBe("Pick a valid date.");
    expect((await fieldErrors({ dueDate: "" })).dueDate).toBe("Pick a valid date.");
    expect((await fieldErrors({ dueDate: addDays(TEST_TODAY, -31) })).dueDate).toMatch(/30 days ago/);
    expect((await fieldErrors({ dueDate: addDays(TEST_TODAY, 366) })).dueDate).toMatch(/next year/);
    expect((await fieldErrors({ assigneeIds: [] })).assigneeIds).toBe("Pick at least one person.");
    expect((await fieldErrors({ assigneeIds: undefined })).assigneeIds).toBe("Pick at least one person.");
    expect((await fieldErrors({ priority: "URGENT" })).priority).toBe("Pick a priority.");
    expect((await fieldErrors({ subteam: "ROBOTS" })).subteam).toBe("Pick a subteam.");
    const many = Array.from({ length: 151 }, (_, i) => `id-${i}`);
    expect((await fieldErrors({ assigneeIds: many })).assigneeIds).toMatch(/up to 150/);
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("accepts the edges of the allowed date range", async () => {
    const ctx = ctxFor(p.buildLead1);
    await expect(createTask(ctx, taskInput({ dueDate: addDays(TEST_TODAY, -30) }))).resolves.toHaveProperty("id");
    await expect(createTask(ctx, taskInput({ dueDate: addDays(TEST_TODAY, 365) }))).resolves.toHaveProperty("id");
  });
});

describe("updateTask", () => {
  it("adds new people as TODO, removes dropped people, keeps the rest untouched", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id, p.buildMember2.id] });
    const kept = await assignmentOf(task.id, p.buildMember.id);
    await submit(kept.id, "All cut");

    const ctx = ctxFor(p.buildLead1);
    await updateTask(ctx, {
      taskId: task.id,
      ...taskInput({ title: "Cut channel (v2)", priority: "LOW", assigneeIds: [p.buildMember.id, p.buildLead2.id] }),
    });

    const after = await t.db.task.findUniqueOrThrow({ where: { id: task.id }, include: { assignments: true } });
    expect(after.title).toBe("Cut channel (v2)");
    expect(after.priority).toBe("LOW");
    const byUser = new Map(after.assignments.map((a) => [a.userId, a]));
    expect([...byUser.keys()].sort()).toEqual([p.buildMember.id, p.buildLead2.id].sort());
    expect(byUser.get(p.buildMember.id)).toMatchObject({ id: kept.id, status: "SUBMITTED", submissionNote: "All cut" });
    expect(byUser.get(p.buildLead2.id)?.status).toBe("TODO");
    expect(ctx.notifier.events).toEqual([
      { type: "task.assigned", taskId: task.id, userIds: [p.buildLead2.id], actorId: p.buildLead1.id },
    ]);
  });

  it("emits no event when nobody new is added", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id, p.buildMember2.id] });
    const ctx = ctxFor(p.buildLead1);
    await updateTask(ctx, { taskId: task.id, ...taskInput({ assigneeIds: [p.buildMember.id] }) });
    expect(ctx.notifier.events).toHaveLength(0);
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id } })).toBe(1);
  });

  it("cannot move a task to a foreign subteam or the whole team", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    await expect(
      updateTask(ctxFor(p.buildLead1), { taskId: task.id, ...taskInput({ subteam: "SOFTWARE", assigneeIds: [p.buildMember.id] }) }),
    ).rejects.toThrow(ForbiddenError);
    await expect(updateTask(ctxFor(p.buildLead1), { taskId: task.id, ...taskInput({ subteam: "" }) })).rejects.toThrow(ForbiddenError);
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).subteam).toBe("BUILD");
  });

  it("lets the captain move a task to the whole team", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    await updateTask(ctxFor(p.captain), { taskId: task.id, ...taskInput({ subteam: "", assigneeIds: [p.buildMember.id, p.swMember.id] }) });
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).subteam).toBeNull();
  });

  it("hides tasks the actor can't manage and forbids members", async () => {
    const task = await makeTask(t.db, p.swLead, { subteam: "SOFTWARE", assigneeIds: [p.swMember.id] });
    await expect(updateTask(ctxFor(p.buildLead1), { taskId: task.id, ...taskInput() })).rejects.toThrow(NotFoundError);
    await expect(updateTask(ctxFor(p.swMember), { taskId: task.id, ...taskInput() })).rejects.toThrow(ForbiddenError);
    await expect(updateTask(ctxFor(p.buildLead1), { taskId: "missing", ...taskInput() })).rejects.toThrow(NotFoundError);
  });

  it("only checks newly added people against assign rules", async () => {
    // Captain assigned a software member to a build task; the build leader can still edit it.
    const task = await makeTask(t.db, p.captain, { subteam: "BUILD", assigneeIds: [p.buildMember.id, p.swMember.id] });
    await updateTask(ctxFor(p.buildLead1), {
      taskId: task.id,
      ...taskInput({ assigneeIds: [p.buildMember.id, p.swMember.id, p.buildMember2.id] }),
    });
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id } })).toBe(3);
    // …but can't add someone outside their subteam.
    await expect(
      updateTask(ctxFor(p.buildLead1), { taskId: task.id, ...taskInput({ assigneeIds: [p.buildMember.id, p.bizMember.id] }) }),
    ).rejects.toThrow(ValidationError);
  });

  it("allows keeping an old due date but not moving to another out-of-range date", async () => {
    const old = addDays(TEST_TODAY, -60);
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", dueDate: old, assigneeIds: [p.buildMember.id] });
    await updateTask(ctxFor(p.buildLead1), {
      taskId: task.id,
      ...taskInput({ title: "Renamed", dueDate: old, assigneeIds: [p.buildMember.id] }),
    });
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe("Renamed");
    await expect(
      updateTask(ctxFor(p.buildLead1), { taskId: task.id, ...taskInput({ dueDate: addDays(TEST_TODAY, -59) }) }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("updateTask: self-removal and races", () => {
  it("doesn't let a subteam leader drop themselves from the assignee list", async () => {
    // The captain assigned this build task to the build leader.
    const task = await makeTask(t.db, p.captain, { subteam: "BUILD", assigneeIds: [p.buildLead1.id, p.buildMember.id] });
    const ctx = ctxFor(p.buildLead1);
    const err = await updateTask(ctx, { taskId: task.id, ...taskInput({ assigneeIds: [p.buildMember.id] }) }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.assigneeIds).toBe(
      "You can't remove yourself from a task. Ask another leader or the captain.",
    );
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id, userId: p.buildLead1.id } })).toBe(1);

    // Keeping themselves while editing everything else is fine.
    await updateTask(ctx, { taskId: task.id, ...taskInput({ title: "Kept", assigneeIds: [p.buildLead1.id, p.buildMember.id] }) });
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe("Kept");
    // Another build leader can take them off.
    await updateTask(ctxFor(p.buildLead2), { taskId: task.id, ...taskInput({ assigneeIds: [p.buildMember.id] }) });
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id, userId: p.buildLead1.id } })).toBe(0);
  });

  it("lets all-scope staff drop themselves", async () => {
    const task = await makeTask(t.db, p.captain, { subteam: "BUILD", assigneeIds: [p.captain.id, p.buildMember.id] });
    await updateTask(ctxFor(p.captain), { taskId: task.id, ...taskInput({ assigneeIds: [p.buildMember.id] }) });
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id, userId: p.captain.id } })).toBe(0);
  });

  it("reports a task deleted mid-save as 'no longer exists', not a crash", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    const ctx = { ...ctxFor(p.buildLead1), db: deletesTaskBeforeTransaction(t.db, task.id) };
    const err = await updateTask(ctx, { taskId: task.id, ...taskInput({ assigneeIds: [p.buildMember.id, p.buildMember2.id] }) }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).userMessage).toBe("That task no longer exists.");
    expect(ctx.notifier.events).toHaveLength(0);
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id } })).toBe(0);
  });
});

describe("deleteTask", () => {
  it("lets managers delete; cascades assignments and keeps linked questions", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    const q = await t.db.question.create({
      data: { title: "How long?", body: "?", askerId: p.buildMember.id, subteam: "BUILD", taskId: task.id },
    });
    await deleteTask(ctxFor(p.buildLead2), { taskId: task.id }); // another build leader manages build tasks
    expect(await t.db.task.findUnique({ where: { id: task.id } })).toBeNull();
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id } })).toBe(0);
    expect((await t.db.question.findUniqueOrThrow({ where: { id: q.id } })).taskId).toBeNull();
  });

  it("denies other subteams' leaders and members", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    await expect(deleteTask(ctxFor(p.swLead), { taskId: task.id })).rejects.toThrow(NotFoundError);
    await expect(deleteTask(ctxFor(p.bizLead), { taskId: task.id })).rejects.toThrow(NotFoundError);
    await expect(deleteTask(ctxFor(p.buildMember), { taskId: task.id })).rejects.toThrow(ForbiddenError);
    await expect(deleteTask(ctxFor(p.captain), { taskId: "" })).rejects.toThrow(ValidationError);
    expect(await t.db.task.findUnique({ where: { id: task.id } })).not.toBeNull();
  });

  it("lets a leader delete a task they created even outside their subteam scope", async () => {
    // A leader who created a task keeps managing it (canManageTask: creator).
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    await t.db.task.update({ where: { id: task.id }, data: { subteam: "SOFTWARE" } });
    await deleteTask(ctxFor(p.buildLead1), { taskId: task.id });
    expect(await t.db.task.findUnique({ where: { id: task.id } })).toBeNull();
  });
});

describe("reviewAssignment", () => {
  async function submittedBuildItem(userId = p.buildMember.id, creator = p.buildLead1) {
    const task = await makeTask(t.db, creator, { subteam: "BUILD", assigneeIds: [userId] });
    const a = task.assignments[0];
    await submit(a.id);
    return a;
  }

  it("approves a submission and notifies", async () => {
    const a = await submittedBuildItem();
    const ctx = ctxFor(p.buildLead1);
    await reviewAssignment(ctx, { assignmentId: a.id, decision: "approve", note: "Nice work" });
    const after = await t.db.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ status: "APPROVED", reviewedById: p.buildLead1.id, reviewedAt: TEST_NOW, reviewNote: "Nice work" });
    expect(ctx.notifier.events).toEqual([{ type: "task.reviewed", assignmentId: a.id }]);
  });

  it("sends back with a required note", async () => {
    const a = await submittedBuildItem();
    const ctx = ctxFor(p.buildLead2);
    const err = await reviewAssignment(ctx, { assignmentId: a.id, decision: "reject", note: "  " }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.note).toBe("Tell them what to change.");
    expect(ctx.notifier.events).toHaveLength(0);

    await reviewAssignment(ctx, { assignmentId: a.id, decision: "reject", note: "Deburr the edges" });
    const after = await t.db.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ status: "REJECTED", reviewNote: "Deburr the edges", reviewedById: p.buildLead2.id });
    expect(ctx.notifier.ofType("task.reviewed")).toEqual([{ type: "task.reviewed", assignmentId: a.id }]);
  });

  it("validates the decision", async () => {
    const a = await submittedBuildItem();
    await expect(reviewAssignment(ctxFor(p.buildLead1), { assignmentId: a.id, decision: "maybe" })).rejects.toThrow(ValidationError);
  });

  it("does not let a subteam leader review their own submission, but the captain can", async () => {
    const a = await submittedBuildItem(p.buildLead1.id, p.buildLead1);
    await expect(reviewAssignment(ctxFor(p.buildLead1), { assignmentId: a.id, decision: "approve" })).rejects.toThrow(ForbiddenError);
    await reviewAssignment(ctxFor(p.captain), { assignmentId: a.id, decision: "approve" });
    expect(await t.db.taskAssignment.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      status: "APPROVED",
      reviewedById: p.captain.id,
    });

    // Another build leader can review a fellow leader's item too.
    const b = await submittedBuildItem(p.buildLead1.id, p.buildLead1);
    await reviewAssignment(ctxFor(p.buildLead2), { assignmentId: b.id, decision: "approve" });
    expect((await t.db.taskAssignment.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("APPROVED");

    const own = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [p.captain.id] });
    await submit(own.assignments[0].id);
    await reviewAssignment(ctxFor(p.captain), { assignmentId: own.assignments[0].id, decision: "approve" });
    expect((await t.db.taskAssignment.findUniqueOrThrow({ where: { id: own.assignments[0].id } })).status).toBe("APPROVED");
  });

  it("hides items from leaders of other subteams and forbids members", async () => {
    const a = await submittedBuildItem();
    await expect(reviewAssignment(ctxFor(p.swLead), { assignmentId: a.id, decision: "approve" })).rejects.toThrow(NotFoundError);
    await expect(reviewAssignment(ctxFor(p.buildMember2), { assignmentId: a.id, decision: "approve" })).rejects.toThrow(ForbiddenError);
    // The assignee themself can't approve their own item either.
    await expect(reviewAssignment(ctxFor(p.buildMember), { assignmentId: a.id, decision: "approve" })).rejects.toThrow(ForbiddenError);
    await expect(reviewAssignment(ctxFor(p.captain), { assignmentId: "nope", decision: "approve" })).rejects.toThrow(NotFoundError);
    expect((await t.db.taskAssignment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("SUBMITTED");
  });

  it("raises a ConflictError on double review", async () => {
    const a = await submittedBuildItem();
    await reviewAssignment(ctxFor(p.buildLead1), { assignmentId: a.id, decision: "approve" });
    const ctx = ctxFor(p.captain);
    await expect(reviewAssignment(ctx, { assignmentId: a.id, decision: "reject", note: "Hmm" })).rejects.toThrow(ConflictError);
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("raises a ConflictError when approving an item that isn't submitted", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    await expect(
      reviewAssignment(ctxFor(p.buildLead1), { assignmentId: task.assignments[0].id, decision: "approve" }),
    ).rejects.toThrow(ConflictError);
  });
});

describe("approveMany", () => {
  it("approves what it can and skips the rest", async () => {
    const task = await makeTask(t.db, p.buildLead1, {
      subteam: "BUILD",
      assigneeIds: [p.buildMember.id, p.buildMember2.id, p.buildLead1.id, p.buildLead2.id],
    });
    const [m1, m2, self, todo] = [p.buildMember, p.buildMember2, p.buildLead1, p.buildLead2].map(
      (u) => task.assignments.find((a) => a.userId === u.id)!,
    );
    await submit(m1.id);
    await submit(m2.id);
    await submit(self.id); // own item: skipped for a subteam leader
    const sw = await makeTask(t.db, p.swLead, { subteam: "SOFTWARE", assigneeIds: [p.swMember.id] });
    await submit(sw.assignments[0].id); // other subteam: skipped

    const ctx = ctxFor(p.buildLead1);
    const result = await approveMany(ctx, {
      assignmentIds: [m1.id, m2.id, m1.id, self.id, todo.id, sw.assignments[0].id, "missing"],
    });
    expect(result).toEqual({ approved: 2, skipped: 4 });
    expect(ctx.notifier.ofType("task.reviewed").map((e) => e.assignmentId).sort()).toEqual([m1.id, m2.id].sort());
    const statuses = await t.db.taskAssignment.findMany({ where: { id: { in: [m1.id, m2.id, self.id, todo.id] } } });
    const byId = new Map(statuses.map((s) => [s.id, s]));
    expect(byId.get(m1.id)).toMatchObject({ status: "APPROVED", reviewedById: p.buildLead1.id, reviewedAt: TEST_NOW });
    expect(byId.get(m2.id)?.status).toBe("APPROVED");
    expect(byId.get(self.id)?.status).toBe("SUBMITTED");
    expect(byId.get(todo.id)?.status).toBe("TODO");
    expect((await t.db.taskAssignment.findUniqueOrThrow({ where: { id: sw.assignments[0].id } })).status).toBe("SUBMITTED");

    // Running it again approves nothing.
    const again = await approveMany(ctxFor(p.buildLead1), { assignmentIds: [m1.id, m2.id] });
    expect(again).toEqual({ approved: 0, skipped: 2 });
  });

  it("validates input and forbids members", async () => {
    await expect(approveMany(ctxFor(p.captain), { assignmentIds: [] })).rejects.toThrow(ValidationError);
    const many = Array.from({ length: 201 }, (_, i) => `id-${i}`);
    await expect(approveMany(ctxFor(p.captain), { assignmentIds: many })).rejects.toThrow(ValidationError);
    await expect(approveMany(ctxFor(p.buildMember), { assignmentIds: ["x"] })).rejects.toThrow(ForbiddenError);
  });
});

describe("reopenAssignment", () => {
  it("moves an approved item back to TODO and keeps the note", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    const a = task.assignments[0];
    await submit(a.id);
    await reviewAssignment(ctxFor(p.buildLead1), { assignmentId: a.id, decision: "approve", note: "Good" });

    const ctx = ctxFor(p.buildLead2);
    await reopenAssignment(ctx, { assignmentId: a.id });
    const after = await t.db.taskAssignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ status: "TODO", reviewedAt: null, reviewedById: null, reviewNote: "Good" });
    expect(ctx.notifier.events).toHaveLength(0);

    // Not approved anymore -> conflict.
    await expect(reopenAssignment(ctx, { assignmentId: a.id })).rejects.toThrow(ConflictError);
  });

  it("denies non-managers and your own item for subteam leaders", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildLead1.id] });
    const a = task.assignments[0];
    await t.db.taskAssignment.update({ where: { id: a.id }, data: { status: "APPROVED" } });
    await expect(reopenAssignment(ctxFor(p.buildLead1), { assignmentId: a.id })).rejects.toThrow(ForbiddenError);
    await expect(reopenAssignment(ctxFor(p.swLead), { assignmentId: a.id })).rejects.toThrow(NotFoundError);
    await expect(reopenAssignment(ctxFor(p.buildMember), { assignmentId: a.id })).rejects.toThrow(ForbiddenError);
    await reopenAssignment(ctxFor(p.mentor), { assignmentId: a.id });
    expect((await t.db.taskAssignment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("TODO");
  });
});

describe("removeAssignment", () => {
  it("deletes one person's item for managers only", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id, p.buildMember2.id] });
    const [a, b] = task.assignments;
    await expect(removeAssignment(ctxFor(p.swLead), { assignmentId: a.id })).rejects.toThrow(NotFoundError);
    await expect(removeAssignment(ctxFor(p.buildMember), { assignmentId: a.id })).rejects.toThrow(ForbiddenError);
    await removeAssignment(ctxFor(p.buildLead1), { assignmentId: a.id });
    expect(await t.db.taskAssignment.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await t.db.taskAssignment.findUnique({ where: { id: b.id } })).not.toBeNull();
    await expect(removeAssignment(ctxFor(p.buildLead1), { assignmentId: a.id })).rejects.toThrow(NotFoundError);
  });

  it("doesn't let a subteam leader remove their own item, even on a task they manage", async () => {
    const task = await makeTask(t.db, p.captain, { subteam: "BUILD", assigneeIds: [p.buildLead1.id, p.buildMember.id] });
    const own = await assignmentOf(task.id, p.buildLead1.id);
    await submit(own.id);
    const err = await removeAssignment(ctxFor(p.buildLead1), { assignmentId: own.id }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).userMessage).toBe("You can't remove yourself from a task. Ask another leader or the captain.");
    expect(await t.db.taskAssignment.findUnique({ where: { id: own.id } })).not.toBeNull();

    // Another build leader or the captain can.
    await removeAssignment(ctxFor(p.buildLead2), { assignmentId: own.id });
    expect(await t.db.taskAssignment.findUnique({ where: { id: own.id } })).toBeNull();
    const captainTask = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [p.captain.id] });
    await removeAssignment(ctxFor(p.captain), { assignmentId: captainTask.assignments[0].id });
    expect(await t.db.taskAssignment.count({ where: { taskId: captainTask.id } })).toBe(0);
  });
});

describe("whole-team tasks: subteam leaders review their own members", () => {
  async function teamTask(assignees: Actor[], submitted: Actor[] = assignees) {
    const task = await makeTask(t.db, p.teacher, { subteam: null, title: "Log shop hours", assigneeIds: assignees.map((a) => a.id) });
    const byUser = new Map(task.assignments.map((a) => [a.userId, a.id]));
    for (const u of submitted) await submit(byUser.get(u.id)!);
    return { task, item: (u: Actor) => byUser.get(u.id)! };
  }

  it("lets a build leader approve and send back build members' items, but not other subteams'", async () => {
    const { task, item } = await teamTask([p.buildMember, p.buildMember2, p.swMember]);
    const ctx = ctxFor(p.buildLead1);
    await reviewAssignment(ctx, { assignmentId: item(p.buildMember), decision: "approve" });
    await reviewAssignment(ctx, { assignmentId: item(p.buildMember2), decision: "reject", note: "Add Saturday's hours" });
    expect(await t.db.taskAssignment.findUniqueOrThrow({ where: { id: item(p.buildMember) } })).toMatchObject({
      status: "APPROVED",
      reviewedById: p.buildLead1.id,
    });
    expect(await t.db.taskAssignment.findUniqueOrThrow({ where: { id: item(p.buildMember2) } })).toMatchObject({
      status: "REJECTED",
      reviewNote: "Add Saturday's hours",
    });
    expect(ctx.notifier.ofType("task.reviewed")).toHaveLength(2);

    // A software member's item is invisible to the build leader…
    await expect(reviewAssignment(ctx, { assignmentId: item(p.swMember), decision: "approve" })).rejects.toThrow(NotFoundError);
    await expect(reviewAssignment(ctxFor(p.bizLead), { assignmentId: item(p.buildMember2), decision: "approve" })).rejects.toThrow(
      NotFoundError,
    );
    // …but the software leader can review it.
    await reviewAssignment(ctxFor(p.swLead), { assignmentId: item(p.swMember), decision: "approve" });
    expect((await t.db.taskAssignment.findUniqueOrThrow({ where: { id: item(p.swMember) } })).status).toBe("APPROVED");

    // Reviewing doesn't mean managing: the task itself stays with all-scope staff.
    await expect(removeAssignment(ctx, { assignmentId: item(p.buildMember2) })).rejects.toThrow(NotFoundError);
    await expect(
      updateTask(ctx, { taskId: task.id, ...taskInput({ subteam: "", assigneeIds: [p.buildMember.id] }) }),
    ).rejects.toThrow(NotFoundError);
    await expect(deleteTask(ctx, { taskId: task.id })).rejects.toThrow(NotFoundError);
  });

  it("lets a build leader reopen a build member's approved item", async () => {
    const { item } = await teamTask([p.buildMember]);
    await reviewAssignment(ctxFor(p.buildLead1), { assignmentId: item(p.buildMember), decision: "approve" });
    await expect(reopenAssignment(ctxFor(p.swLead), { assignmentId: item(p.buildMember) })).rejects.toThrow(NotFoundError);
    await reopenAssignment(ctxFor(p.buildLead2), { assignmentId: item(p.buildMember) });
    expect((await t.db.taskAssignment.findUniqueOrThrow({ where: { id: item(p.buildMember) } })).status).toBe("TODO");
  });

  it("never lets a subteam leader review their own item", async () => {
    const { item } = await teamTask([p.buildLead1, p.buildLead2]);
    const err = await reviewAssignment(ctxFor(p.buildLead1), { assignmentId: item(p.buildLead1), decision: "approve" }).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).userMessage).toMatch(/can't review your own checklist item/);
    // A fellow build leader can.
    await reviewAssignment(ctxFor(p.buildLead2), { assignmentId: item(p.buildLead1), decision: "approve" });
    await expect(reopenAssignment(ctxFor(p.buildLead1), { assignmentId: item(p.buildLead1) })).rejects.toThrow(ForbiddenError);
  });

  it("approveMany approves own members' items and skips the rest", async () => {
    const { item } = await teamTask([p.buildMember, p.buildMember2, p.buildLead1, p.swMember]);
    const ctx = ctxFor(p.buildLead1);
    const result = await approveMany(ctx, {
      assignmentIds: [item(p.buildMember), item(p.buildMember2), item(p.buildLead1), item(p.swMember)],
    });
    expect(result).toEqual({ approved: 2, skipped: 2 });
    const rows = await t.db.taskAssignment.findMany({ where: { id: { in: [item(p.buildLead1), item(p.swMember)] } } });
    expect(rows.every((r) => r.status === "SUBMITTED")).toBe(true);
    expect(ctx.notifier.ofType("task.reviewed").map((e) => e.assignmentId).sort()).toEqual(
      [item(p.buildMember), item(p.buildMember2)].sort(),
    );
  });

  it("shows them in the leader's review queue without a link to the task", async () => {
    const { task, item } = await teamTask([p.buildMember, p.buildLead1, p.swMember]);
    const lead = await getReviewQueue(p.buildLead1, {}, t.db);
    const group = lead.groups.find((g) => g.task.id === task.id);
    expect(group?.task).toMatchObject({ title: "Log shop hours", subteam: null, canManage: false });
    expect(group?.items.map((i) => i.id)).toEqual([item(p.buildMember)]);
    expect(lead.groups.filter((g) => g.task.subteam === "BUILD").every((g) => g.task.canManage)).toBe(true);

    const sw = await getReviewQueue(p.swLead, {}, t.db);
    expect(sw.groups.find((g) => g.task.id === task.id)?.items.map((i) => i.id)).toEqual([item(p.swMember)]);

    const teacher = await getReviewQueue(p.teacher, {}, t.db);
    const all = teacher.groups.find((g) => g.task.id === task.id);
    expect(all?.task.canManage).toBe(true);
    expect(all?.items).toHaveLength(3);
  });
});

describe("getTaskDuplicate", () => {
  it("prefills a copy with today's date and only the people the actor can still assign", async () => {
    const task = await makeTask(t.db, p.captain, {
      title: "Sweep the shop",
      description: "Put tools away.",
      subteam: "BUILD",
      priority: "HIGH",
      dueDate: addDays(TEST_TODAY, -3),
      assigneeIds: [p.buildMember.id, p.swMember.id, p.disabledBuild.id, p.buildLead1.id],
    });
    const today = addDays(TEST_TODAY, 1);

    const lead = await getTaskDuplicate(p.buildLead1, task.id, { today }, t.db);
    expect(lead).toEqual({
      sourceId: task.id,
      sourceTitle: "Sweep the shop",
      title: "Sweep the shop",
      description: "Put tools away.",
      subteam: "BUILD",
      priority: "HIGH",
      dueDate: today,
      categoryId: "",
      assignMode: "assign",
      signupLimit: null,
      // Sky (software) is out of scope and Dana is disabled.
      assigneeIds: [p.buildLead1.id, p.buildMember.id],
    });

    const captain = await getTaskDuplicate(p.captain, task.id, { today }, t.db);
    expect(captain?.assigneeIds.sort()).toEqual([p.buildLead1.id, p.buildMember.id, p.swMember.id].sort());
  });

  it("keeps whole-team for all-scope staff and falls back to the leader's subteam when they can't create for the original", async () => {
    const team = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [p.bizMember.id] });
    expect((await getTaskDuplicate(p.mentor, team.id, { today: TEST_TODAY }, t.db))?.subteam).toBe("");

    // Created by the build leader, later moved to Business: still theirs to manage, but new copies go to Build.
    const moved = await makeTask(t.db, p.buildLead1, { subteam: "BUSINESS", assigneeIds: [p.bizMember.id] });
    const copy = await getTaskDuplicate(p.buildLead1, moved.id, { today: TEST_TODAY }, t.db);
    expect(copy).toMatchObject({ subteam: "BUILD", assigneeIds: [] });
  });

  it("returns null for tasks the actor can't manage (so ?from is ignored)", async () => {
    const team = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [p.buildMember.id] });
    const sw = await makeTask(t.db, p.swLead, { subteam: "SOFTWARE", assigneeIds: [p.swMember.id] });
    expect(await getTaskDuplicate(p.buildLead1, team.id, {}, t.db)).toBeNull();
    expect(await getTaskDuplicate(p.buildLead1, sw.id, {}, t.db)).toBeNull();
    expect(await getTaskDuplicate(p.swMember, sw.id, {}, t.db)).toBeNull();
    expect(await getTaskDuplicate(p.captain, "missing", {}, t.db)).toBeNull();
    expect(await getTaskDuplicate(p.captain, "", {}, t.db)).toBeNull();
  });
});

describe("queries", () => {
  let fresh: TestDb;
  let q: Record<"captain" | "swLead" | "buildLead" | "buildLead2" | "bizLead" | "swMember" | "buildMember" | "bizMember", Actor>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    fresh = await createTestDb();
    const db = fresh.db;
    q = {
      captain: await makeUser(db, { role: "CAPTAIN", name: "Cap" }),
      swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sw Lead" }),
      buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Build Lead" }),
      buildLead2: await makeUser(db, { role: "BUILD_LEADER", name: "Build Lead Two" }),
      bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Biz Lead" }),
      swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Sw Kid" }),
      buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Build Kid" }),
      bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Biz Kid" }),
    };
    await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Gone Kid" });

    const build = await makeTask(db, q.buildLead, {
      title: "Build upcoming",
      subteam: "BUILD",
      dueDate: addDays(TEST_TODAY, 2),
      assigneeIds: [q.buildMember.id, q.buildLead2.id, q.buildLead.id],
    });
    ids.build = build.id;
    const [bm, bl2, blSelf] = [q.buildMember, q.buildLead2, q.buildLead].map((u) => build.assignments.find((a) => a.userId === u.id)!);
    ids.bm = bm.id;
    ids.bl2 = bl2.id;
    ids.blSelf = blSelf.id;
    await db.taskAssignment.update({ where: { id: bm.id }, data: { status: "APPROVED" } });
    await db.taskAssignment.update({
      where: { id: bl2.id },
      data: { status: "SUBMITTED", submittedAt: new Date(TEST_NOW.getTime() - 3_600_000), submissionNote: "done", reviewNote: "Try again" },
    });
    await db.taskAssignment.update({ where: { id: blSelf.id }, data: { status: "SUBMITTED", submittedAt: TEST_NOW } });

    const buildPast = await makeTask(db, q.captain, { title: "Build past", subteam: "BUILD", dueDate: addDays(TEST_TODAY, -2) });
    ids.buildPast = buildPast.id;
    const sw = await makeTask(db, q.swLead, {
      title: "Software today",
      subteam: "SOFTWARE",
      dueDate: TEST_TODAY,
      assigneeIds: [q.swMember.id],
    });
    ids.sw = sw.id;
    await db.taskAssignment.update({
      where: { id: sw.assignments[0].id },
      data: { status: "SUBMITTED", submittedAt: new Date(TEST_NOW.getTime() - 7_200_000) },
    });
    // A task the build leader created that has since moved to Business: still theirs to manage.
    const moved = await makeTask(db, q.buildLead, { title: "Moved to business", subteam: "BUSINESS", dueDate: addDays(TEST_TODAY, 5) });
    ids.moved = moved.id;
    const team = await makeTask(db, q.captain, {
      title: "Whole team later",
      subteam: null,
      dueDate: addDays(TEST_TODAY, 10),
      assigneeIds: [q.swMember.id, q.buildMember.id, q.bizMember.id],
    });
    ids.team = team.id;

    // Questions linked to the build task: one in build scope, one addressed to the captain only.
    await db.question.create({
      data: { title: "Which saw?", body: "?", askerId: q.buildMember.id, subteam: "BUILD", taskId: build.id },
    });
    await db.question.create({
      data: { title: "Private to captain", body: "?", askerId: q.buildMember.id, subteam: null, recipientId: q.captain.id, taskId: build.id },
    });
  });

  afterAll(async () => {
    await fresh?.drop();
  });

  it("getTaskFormOptions offers whole team to all-scope staff and the Business leader (who can't add whole-team categories)", () => {
    expect(getTaskFormOptions(q.bizLead)).toEqual({
      subteams: [
        { value: "BUSINESS", label: "Business" },
        { value: "", label: "Whole team" },
      ],
      defaultSubteam: "BUSINESS",
      newCategorySubteams: ["BUSINESS"],
    });
    expect(getTaskFormOptions(q.swLead).subteams.map((s) => s.value)).toEqual(["SOFTWARE"]);
    expect(getTaskFormOptions(q.captain).subteams.map((s) => s.value)).toEqual(["", "SOFTWARE", "BUILD", "BUSINESS"]);
    expect(getTaskFormOptions(q.captain).defaultSubteam).toBe("");
    expect(getTaskFormOptions(q.buildLead)).toEqual({
      subteams: [{ value: "BUILD", label: "Build" }],
      defaultSubteam: "BUILD",
      newCategorySubteams: ["BUILD"],
    });
    expect(getTaskFormOptions(q.captain).newCategorySubteams).toEqual(["", "SOFTWARE", "BUILD", "BUSINESS"]);
    expect(getTaskFormOptions(q.buildMember).subteams).toEqual([]);
  });

  it("getTaskFormOptions for the edit form offers only subteams the actor would still manage the task in", () => {
    const values = (actor: Actor, createdById: string) => getTaskFormOptions(actor, { createdById }).subteams.map((s) => s.value);
    // The Business leader's own task can go whole-team; the captain's Business task can't (they'd lose it).
    expect(values(q.bizLead, q.bizLead.id)).toEqual(["BUSINESS", ""]);
    expect(values(q.bizLead, q.captain.id)).toEqual(["BUSINESS"]);
    expect(values(q.captain, q.bizLead.id)).toEqual(["", "SOFTWARE", "BUILD", "BUSINESS"]);
    expect(values(q.buildLead, q.captain.id)).toEqual(["BUILD"]);
  });

  it("getAssignableUsers groups ACTIVE people by subteam within scope", async () => {
    const leaderGroups = await getAssignableUsers(q.buildLead, fresh.db);
    expect(leaderGroups.map((g) => g.key)).toEqual(["BUILD"]);
    expect(leaderGroups[0].people.map((u) => u.name)).toEqual(["Build Kid", "Build Lead", "Build Lead Two"]);
    expect(leaderGroups[0].people[1].role).toBe("BUILD_LEADER");

    const captainGroups = await getAssignableUsers(q.captain, fresh.db);
    expect(captainGroups.map((g) => g.label)).toEqual(["Software", "Build", "Business", "Staff"]);
    expect(captainGroups.find((g) => g.key === "STAFF")?.people.map((u) => u.name)).toEqual(["Cap"]);
    expect(captainGroups.flatMap((g) => g.people).some((u) => u.name === "Gone Kid")).toBe(false);

    expect(await getAssignableUsers(q.buildMember, fresh.db)).toEqual([]);
  });

  it("getAssignableUsers gives the Business leader everyone, marking who fits only whole-team tasks", async () => {
    const groups = await getAssignableUsers(q.bizLead, fresh.db);
    expect(groups.map((g) => g.key)).toEqual(["SOFTWARE", "BUILD", "BUSINESS", "STAFF"]);
    const everyone = groups.flatMap((g) => g.people);
    expect(everyone.some((u) => u.name === "Gone Kid")).toBe(false);
    expect(everyone.filter((u) => !u.wholeTeamOnly).map((u) => u.name).sort()).toEqual(["Biz Kid", "Biz Lead"]);
    expect(everyone.find((u) => u.name === "Build Kid")?.wholeTeamOnly).toBe(true);
    expect(everyone.find((u) => u.name === "Cap")?.wholeTeamOnly).toBe(true);
    // Nobody else gets the mark.
    for (const who of [q.captain, q.buildLead, q.swLead]) {
      const people = (await getAssignableUsers(who, fresh.db)).flatMap((g) => g.people);
      expect(people.some((u) => u.wholeTeamOnly), who.name).toBe(false);
    }
  });

  it("listManagedTasks scopes leaders to their subteam plus their own tasks", async () => {
    const all = await listManagedTasks(q.buildLead, { view: "all", today: TEST_TODAY }, fresh.db);
    expect(all.tasks.map((x) => x.title).sort()).toEqual(["Build past", "Build upcoming", "Moved to business"]);

    const sw = await listManagedTasks(q.swLead, { view: "all", today: TEST_TODAY }, fresh.db);
    expect(sw.tasks.map((x) => x.title)).toEqual(["Software today"]);

    const member = await listManagedTasks(q.buildMember, { view: "all", today: TEST_TODAY }, fresh.db);
    expect(member.tasks).toEqual([]);

    const captain = await listManagedTasks(q.captain, { view: "all", today: TEST_TODAY }, fresh.db);
    expect(captain.total).toBe(5);
  });

  it("listManagedTasks splits upcoming/past, filters, and counts statuses with groupBy", async () => {
    const upcoming = await listManagedTasks(q.captain, { view: "upcoming", today: TEST_TODAY }, fresh.db);
    expect(upcoming.tasks.map((x) => x.title)).toEqual(["Software today", "Build upcoming", "Moved to business", "Whole team later"]);
    const past = await listManagedTasks(q.captain, { view: "past", today: TEST_TODAY }, fresh.db);
    expect(past.tasks.map((x) => x.title)).toEqual(["Build past"]);

    const build = upcoming.tasks.find((x) => x.id === ids.build)!;
    expect(build.counts).toEqual({ total: 3, todo: 0, submitted: 2, approved: 1, rejected: 0, closed: 0 });
    expect(build.createdByName).toBe("Build Lead");
    expect(build.dueDate).toBe(addDays(TEST_TODAY, 2));
    expect(upcoming.tasks.find((x) => x.id === ids.team)!.counts).toEqual({ total: 3, todo: 3, submitted: 0, approved: 0, rejected: 0, closed: 0 });
    expect(upcoming.tasks.find((x) => x.id === ids.moved)!.counts.total).toBe(0);

    const team = await listManagedTasks(q.captain, { view: "all", subteam: "TEAM", today: TEST_TODAY }, fresh.db);
    expect(team.tasks.map((x) => x.id)).toEqual([ids.team]);
    const buildOnly = await listManagedTasks(q.captain, { view: "all", subteam: "BUILD", today: TEST_TODAY }, fresh.db);
    expect(buildOnly.tasks.map((x) => x.id).sort()).toEqual([ids.build, ids.buildPast].sort());
    const mine = await listManagedTasks(q.buildLead, { view: "all", mine: true, today: TEST_TODAY }, fresh.db);
    expect(mine.tasks.map((x) => x.id).sort()).toEqual([ids.build, ids.moved].sort());
    expect(mine.tasks.every((x) => x.isMine)).toBe(true);
  });

  it("listManagedTasks paginates at 50 and clamps the page", async () => {
    const res = await listManagedTasks(q.captain, { view: "all", page: 99, today: TEST_TODAY }, fresh.db);
    expect(res.page).toBe(1);
    expect(res.pageCount).toBe(1);
  });

  it("getManagedTaskDetail returns assignments, counts, and only visible questions", async () => {
    const detail = await getManagedTaskDetail(q.buildLead, ids.build, fresh.db);
    expect(detail).not.toBeNull();
    expect(detail!.createdBy.name).toBe("Build Lead");
    expect(detail!.counts).toEqual({ total: 3, todo: 0, submitted: 2, approved: 1, rejected: 0, closed: 0 });
    expect(detail!.assignments.map((a) => a.user.name)).toEqual(["Build Kid", "Build Lead", "Build Lead Two"]);
    const self = detail!.assignments.find((a) => a.id === ids.blSelf)!;
    expect(self.canReview).toBe(false); // own submission
    expect(self.canRemove).toBe(false); // …and can't take themselves off it either
    expect(detail!.assignments.filter((a) => a.id !== ids.blSelf).every((a) => a.canRemove)).toBe(true);
    expect(detail!.assignments.find((a) => a.id === ids.bl2)!).toMatchObject({ canReview: true, reviewNote: "Try again" });
    expect(detail!.questions.map((x) => x.title)).toEqual(["Which saw?"]);

    const asCaptain = await getManagedTaskDetail(q.captain, ids.build, fresh.db);
    expect(asCaptain!.questions.map((x) => x.title).sort()).toEqual(["Private to captain", "Which saw?"]);
    expect(asCaptain!.assignments.every((a) => a.canReview && a.canRemove)).toBe(true);

    expect(await getManagedTaskDetail(q.swLead, ids.build, fresh.db)).toBeNull();
    expect(await getManagedTaskDetail(q.buildMember, ids.build, fresh.db)).toBeNull();
    expect(await getManagedTaskDetail(q.captain, "missing", fresh.db)).toBeNull();
  });

  it("getReviewQueue shows scoped submissions oldest first, grouped by task", async () => {
    const lead = await getReviewQueue(q.buildLead, {}, fresh.db);
    // Build leader: sees Build Lead Two's submission, not their own, not software's.
    expect(lead.total).toBe(1);
    expect(lead.groups).toHaveLength(1);
    expect(lead.groups[0].task).toMatchObject({
      id: ids.build,
      title: "Build upcoming",
      subteam: "BUILD",
      dueDate: addDays(TEST_TODAY, 2),
      canManage: true,
    });
    expect(lead.groups[0].items).toEqual([
      expect.objectContaining({ id: ids.bl2, submissionNote: "done", previousReviewNote: "Try again" }),
    ]);

    const captain = await getReviewQueue(q.captain, {}, fresh.db);
    expect(captain.total).toBe(3);
    expect(captain.groups.map((g) => g.task.title)).toEqual(["Software today", "Build upcoming"]);
    expect(captain.groups[1].items.map((i) => i.id)).toEqual([ids.bl2, ids.blSelf]);

    const filtered = await getReviewQueue(q.captain, { subteam: "SOFTWARE" }, fresh.db);
    expect(filtered.total).toBe(1);
    expect(await getReviewQueue(q.buildMember, {}, fresh.db)).toEqual({ total: 0, shown: 0, groups: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// Task dashboard: sign-up tasks and categories

describe("createTask: sign-up tasks", () => {
  it("creates a sign-up task with nobody on it yet, and emails nobody", async () => {
    const ctx = ctxFor(p.buildLead1);
    const { id } = await createTask(ctx, taskInput({ assignMode: "signup", assigneeIds: [], signupLimit: "3" }));
    const task = await t.db.task.findUniqueOrThrow({ where: { id }, include: { assignments: true } });
    expect(task).toMatchObject({ signupOpen: true, signupLimit: 3 });
    expect(task.assignments).toHaveLength(0);
    expect(ctx.notifier.events).toEqual([]);
  });

  it("treats an empty spots field as no limit", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", assigneeIds: [], signupLimit: "" }));
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ signupOpen: true, signupLimit: null });
  });

  it("counts pre-filled people toward the spots; only they get the 'assigned' email", async () => {
    const ctx = ctxFor(p.buildLead1);
    const { id } = await createTask(ctx, taskInput({ assignMode: "signup", signupLimit: "2", assigneeIds: [p.buildMember.id] }));
    const rows = await t.db.taskAssignment.findMany({ where: { taskId: id } });
    expect(rows).toMatchObject([{ userId: p.buildMember.id, selfAssigned: false, status: "TODO" }]);
    expect(ctx.notifier.events).toEqual([{ type: "task.assigned", taskId: id, userIds: [p.buildMember.id], actorId: p.buildLead1.id }]);

    const err = await createTask(
      ctxFor(p.buildLead1),
      taskInput({ assignMode: "signup", signupLimit: "1", assigneeIds: [p.buildMember.id, p.buildMember2.id] }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.signupLimit).toBe(
      "2 people are on this task, but it only has 1 spot. Add spots or take people off.",
    );
  });

  it("validates the number of spots and the mode", async () => {
    const fieldErrors = async (input: Record<string, unknown>) => {
      const err = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", assigneeIds: [], ...input })).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).fieldErrors;
    };
    for (const bad of ["0", "-2", "2.5", "abc", "151"]) {
      expect((await fieldErrors({ signupLimit: bad })).signupLimit, bad).toBe("Enter 1 to 150 spots, or leave it empty for no limit.");
    }
    expect((await fieldErrors({ assignMode: "lottery" })).assignMode).toBe("Choose who does this task.");
    await expect(
      createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", assigneeIds: [], signupLimit: "150" })),
    ).resolves.toHaveProperty("id");
  });

  it("'Assign people' closes sign-ups and ignores spots, and still needs someone", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "assign", signupLimit: "4" }));
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ signupOpen: false, signupLimit: null });
    const err = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "assign", assigneeIds: [] })).catch((e) => e);
    expect((err as ValidationError).fieldErrors.assigneeIds).toBe("Pick at least one person.");
  });
});

describe("createTask / updateTask: categories", () => {
  let intake: string;
  let swVision: string;
  let events: string;

  beforeAll(async () => {
    const make = (subteam: "BUILD" | "SOFTWARE" | null, name: string) =>
      t.db.taskCategory.create({ data: { subteam, name, nameKey: name.toLowerCase(), position: 0 } }).then((c) => c.id);
    intake = await make("BUILD", "Intake");
    swVision = await make("SOFTWARE", "Vision");
    events = await make(null, "Events");
  });

  it("stores a category from the task's own subteam", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ categoryId: intake }));
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).categoryId).toBe(intake);
    const team = await createTask(ctxFor(p.captain), taskInput({ subteam: "", categoryId: events }));
    expect((await t.db.task.findUniqueOrThrow({ where: { id: team.id } })).categoryId).toBe(events);
  });

  it("rejects a category from another subteam, or one that no longer exists", async () => {
    const fieldErrors = async (actor: Actor, input: Record<string, unknown>) => {
      const err = await createTask(ctxFor(actor), taskInput(input)).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).fieldErrors;
    };
    expect((await fieldErrors(p.buildLead1, { categoryId: swVision })).categoryId).toBe("Pick a category from Build.");
    expect((await fieldErrors(p.captain, { subteam: "", categoryId: intake })).categoryId).toBe("Pick a category from the whole-team list.");
    expect((await fieldErrors(p.captain, { subteam: "BUILD", categoryId: events })).categoryId).toBe("Pick a category from Build.");
    expect((await fieldErrors(p.buildLead1, { categoryId: "missing" })).categoryId).toMatch(/no longer exists/);
  });

  it("creates a new category from the form, or reuses one with the same name", async () => {
    const before = await t.db.taskCategory.count({ where: { subteam: "BUILD" } });
    const reuse = await createTask(ctxFor(p.buildLead1), taskInput({ categoryId: "__new__", newCategory: "  INTAKE " }));
    expect((await t.db.task.findUniqueOrThrow({ where: { id: reuse.id } })).categoryId).toBe(intake);
    expect(await t.db.taskCategory.count({ where: { subteam: "BUILD" } })).toBe(before);

    const fresh = await createTask(ctxFor(p.buildLead2), taskInput({ categoryId: "__new__", newCategory: "Drive   train" }));
    const task = await t.db.task.findUniqueOrThrow({ where: { id: fresh.id }, include: { category: true } });
    expect(task.category).toMatchObject({ subteam: "BUILD", name: "Drive train", createdById: p.buildLead2.id });

    const err = await createTask(ctxFor(p.buildLead1), taskInput({ categoryId: "__new__", newCategory: "  " })).catch((e) => e);
    expect((err as ValidationError).fieldErrors.newCategory).toBe("Name the new category.");
    const long = await createTask(ctxFor(p.buildLead1), taskInput({ categoryId: "__new__", newCategory: "x".repeat(41) })).catch((e) => e);
    expect((long as ValidationError).fieldErrors.newCategory).toMatch(/at most 40/);
  });

  it("keeps the category on edit, and refuses a mismatch after moving the task", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    await updateTask(ctxFor(p.buildLead1), { taskId: task.id, ...taskInput({ categoryId: intake, assigneeIds: [p.buildMember.id] }) });
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).categoryId).toBe(intake);

    const err = await updateTask(ctxFor(p.captain), {
      taskId: task.id,
      ...taskInput({ subteam: "SOFTWARE", categoryId: intake, assigneeIds: [p.buildMember.id] }),
    }).catch((e) => e);
    expect((err as ValidationError).fieldErrors.categoryId).toBe("Pick a category from Software.");
    await updateTask(ctxFor(p.captain), {
      taskId: task.id,
      ...taskInput({ subteam: "SOFTWARE", categoryId: "", assigneeIds: [p.buildMember.id] }),
    });
    expect(await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ subteam: "SOFTWARE", categoryId: null });
  });
});

describe("updateTask: people signing up while the edit form is open", () => {
  /** A Build sign-up task (limit optional) with some people already on it. */
  async function openTask(people: string[], limit: number | null = null) {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", assigneeIds: people, signupLimit: limit ?? "" }));
    return id;
  }
  const edit = (taskId: string, assigneeIds: string[], previous: string[] | null, extra: Record<string, unknown> = {}) => {
    const ctx = ctxFor(p.buildLead1);
    const input = {
      taskId,
      ...taskInput({ assignMode: "signup", assigneeIds, signupLimit: "", ...extra }),
      ...(previous ? { previousAssigneeIds: previous, previousAssigneeIdsSent: "1" } : {}),
    };
    return { ctx, run: () => updateTask(ctx, input) };
  };
  const peopleOn = async (taskId: string) =>
    (await t.db.taskAssignment.findMany({ where: { taskId }, select: { userId: true } })).map((a) => a.userId).sort();

  it("keeps people who signed up after the form loaded, and only emails the people the leader added", async () => {
    const id = await openTask([p.buildMember.id]);
    await signUpForTask(ctxFor(p.buildMember2), { taskId: id }); // while the form is open
    const { ctx, run } = edit(id, [p.buildMember.id, p.buildLead2.id], [p.buildMember.id]);
    await run();
    expect(await peopleOn(id)).toEqual([p.buildMember.id, p.buildMember2.id, p.buildLead2.id].sort());
    expect(ctx.notifier.events).toEqual([{ type: "task.assigned", taskId: id, userIds: [p.buildLead2.id], actorId: p.buildLead1.id }]);
    const selfSignup = await assignmentOf(id, p.buildMember2.id);
    expect(selfSignup.selfAssigned).toBe(true);
  });

  it("doesn't add back people who left after the form loaded", async () => {
    const id = await openTask([]);
    await signUpForTask(ctxFor(p.buildMember), { taskId: id });
    await signUpForTask(ctxFor(p.buildMember2), { taskId: id });
    // Form loads with both; then one of them leaves.
    await leaveTask(ctxFor(p.buildMember2), { taskId: id });
    const { run } = edit(id, [p.buildMember.id, p.buildMember2.id], [p.buildMember.id, p.buildMember2.id]);
    await run();
    expect(await peopleOn(id)).toEqual([p.buildMember.id]);
  });

  it("still removes people the leader unchecked", async () => {
    const id = await openTask([p.buildMember.id, p.buildMember2.id]);
    const { run } = edit(id, [p.buildMember.id], [p.buildMember.id, p.buildMember2.id]);
    await run();
    expect(await peopleOn(id)).toEqual([p.buildMember.id]);
  });

  it("an empty list from the form counts when the marker is sent", async () => {
    const id = await openTask([]);
    await signUpForTask(ctxFor(p.buildMember), { taskId: id });
    await edit(id, [], []).run();
    expect(await peopleOn(id)).toEqual([p.buildMember.id]);
  });

  it("without the marker, the list is the full set (as before)", async () => {
    const id = await openTask([]);
    await signUpForTask(ctxFor(p.buildMember), { taskId: id });
    await edit(id, [], null).run();
    expect(await peopleOn(id)).toEqual([]);
  });

  it("checks the spots against everyone who'll be on it, late sign-ups included", async () => {
    const id = await openTask([p.buildMember.id], 3);
    await signUpForTask(ctxFor(p.buildMember2), { taskId: id });
    const err = await edit(id, [p.buildMember.id, p.buildLead2.id], [p.buildMember.id], { signupLimit: "2" })
      .run()
      .catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.signupLimit).toMatch(/^3 people are on this task, but it only has 2 spots/);
    expect(await peopleOn(id)).toEqual([p.buildMember.id, p.buildMember2.id].sort());
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).signupLimit).toBe(3);
  });

  it("still stops a subteam leader from taking themselves off", async () => {
    const id = await openTask([p.buildLead1.id, p.buildMember.id]);
    const err = await edit(id, [p.buildMember.id], [p.buildLead1.id, p.buildMember.id])
      .run()
      .catch((e) => e);
    expect((err as ValidationError).fieldErrors.assigneeIds).toBe("You can't remove yourself from a task. Ask another leader or the captain.");
  });

  it("switching to 'Assign people' closes sign-ups and clears the spots", async () => {
    const id = await openTask([p.buildMember.id], 4);
    await updateTask(ctxFor(p.buildLead1), {
      taskId: id,
      ...taskInput({ assignMode: "assign", assigneeIds: [p.buildMember.id] }),
      previousAssigneeIds: [p.buildMember.id],
      previousAssigneeIdsSent: "1",
    });
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ signupOpen: false, signupLimit: null });
  });
});

describe("setSignupOpen", () => {
  it("editing a sign-up task keeps sign-ups closed if a leader closed them; switching an assigned task to sign-up opens them", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", signupLimit: "3", assigneeIds: [] }));
    await setSignupOpen(ctxFor(p.buildLead1), { taskId: id, open: "false" });
    await updateTask(ctxFor(p.buildLead1), {
      taskId: id,
      ...taskInput({ title: "Renamed", assignMode: "signup", signupLimit: "3", assigneeIds: [] }),
      previousAssigneeIds: [],
      previousAssigneeIdsSent: "1",
    });
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Renamed", signupOpen: false, signupLimit: 3 });

    const assigned = await createTask(ctxFor(p.buildLead1), taskInput({ assigneeIds: [p.buildMember.id] }));
    await updateTask(ctxFor(p.buildLead1), {
      taskId: assigned.id,
      ...taskInput({ assignMode: "signup", assigneeIds: [p.buildMember.id] }),
      previousAssigneeIds: [p.buildMember.id],
      previousAssigneeIdsSent: "1",
    });
    expect((await t.db.task.findUniqueOrThrow({ where: { id: assigned.id } })).signupOpen).toBe(true);
  });

  it("the mode is stored: a closed sign-up task with nobody on it stays a sign-up task", async () => {
    const lead = ctxFor(p.buildLead1);
    const { id } = await createTask(lead, taskInput({ assignMode: "signup", signupLimit: "", assigneeIds: [] }));
    await setSignupOpen(lead, { taskId: id, open: "false" });
    const detail = await getManagedTaskDetail(p.buildLead1, id, t.db);
    expect(detail).toMatchObject({ assignMode: "signup", signupOpen: false });
    // Saving it (still "Let people sign up", nobody on it) works and keeps sign-ups closed.
    await updateTask(lead, {
      taskId: id,
      ...taskInput({ title: "Still closed", assignMode: "signup", signupLimit: "", assigneeIds: [] }),
      previousAssigneeIds: [],
      previousAssigneeIdsSent: "1",
    });
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ signupMode: true, signupOpen: false });
  });

  it("switching a sign-up task to 'Assign people' sticks: self sign-ups become assigned and can't leave", async () => {
    const lead = ctxFor(p.buildLead1);
    const { id } = await createTask(lead, taskInput({ assignMode: "signup", signupLimit: "3", assigneeIds: [] }));
    await signUpForTask(ctxFor(p.buildMember), { taskId: id });
    await updateTask(lead, {
      taskId: id,
      ...taskInput({ assignMode: "assign", assigneeIds: [p.buildMember.id] }),
      previousAssigneeIds: [p.buildMember.id],
      previousAssigneeIdsSent: "1",
    });
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ signupMode: false, signupOpen: false, signupLimit: null });
    expect((await getManagedTaskDetail(p.buildLead1, id, t.db))?.assignMode).toBe("assign");
    expect((await t.db.taskAssignment.findFirstOrThrow({ where: { taskId: id } })).selfAssigned).toBe(false);
    await expect(leaveTask(ctxFor(p.buildMember), { taskId: id })).rejects.toBeInstanceOf(ForbiddenError);
    // An assigned task can't be "opened" for sign-ups without editing it into a sign-up task.
    await expect(setSignupOpen(lead, { taskId: id, open: "true" })).rejects.toBeInstanceOf(ConflictError);
  });

  it("lets task managers close and reopen sign-ups", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", assigneeIds: [] }));
    await setSignupOpen(ctxFor(p.buildLead2), { taskId: id, open: "false" });
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).signupOpen).toBe(false);
    await expect(signUpForTask(ctxFor(p.buildMember), { taskId: id })).rejects.toThrow("Sign-ups for this task are closed.");
    await setSignupOpen(ctxFor(p.captain), { taskId: id, open: "true" });
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).signupOpen).toBe(true);
  });

  it("hides the task from other subteams' leaders and forbids members", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", assigneeIds: [] }));
    await expect(setSignupOpen(ctxFor(p.swLead), { taskId: id, open: "false" })).rejects.toThrow(NotFoundError);
    await expect(setSignupOpen(ctxFor(p.buildMember), { taskId: id, open: "false" })).rejects.toThrow(ForbiddenError);
    await expect(setSignupOpen(ctxFor(p.buildLead1), { taskId: "missing", open: "false" })).rejects.toThrow(NotFoundError);
    await expect(setSignupOpen(ctxFor(p.buildLead1), { taskId: id, open: "maybe" })).rejects.toThrow(ValidationError);
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).signupOpen).toBe(true);
  });
});

describe("queries: category and sign-up details", () => {
  it("list rows, task detail, and duplicates carry the category and sign-up settings", async () => {
    const lead = await makeUser(t.db, { role: "BUILD_LEADER", name: "Query Lead" });
    const { id } = await createTask(
      ctxFor(lead),
      taskInput({ assignMode: "signup", signupLimit: "5", assigneeIds: [p.buildMember.id], categoryId: "__new__", newCategory: "Lift" }),
    );
    await signUpForTask(ctxFor(p.buildMember2), { taskId: id });
    const category = await t.db.taskCategory.findFirstOrThrow({ where: { subteam: "BUILD", nameKey: "lift" } });

    const list = await listManagedTasks(lead, { view: "upcoming", mine: true, today: TEST_TODAY }, t.db);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({
      category: { id: category.id, name: "Lift" },
      signupMode: true,
      signupOpen: true,
      signupLimit: 5,
      counts: { total: 2, todo: 2 },
    });

    const detail = await getManagedTaskDetail(lead, id, t.db);
    expect(detail).toMatchObject({ category: { id: category.id, name: "Lift" }, signupOpen: true, signupLimit: 5, assignMode: "signup" });
    expect(detail!.assignments.map((a) => [a.user.id, a.selfAssigned])).toEqual(
      expect.arrayContaining([
        [p.buildMember.id, false],
        [p.buildMember2.id, true],
      ]),
    );

    // Copies keep the category, mode and spots — but not the people who signed themselves up.
    const copy = await getTaskDuplicate(lead, id, { today: TEST_TODAY }, t.db);
    expect(copy).toMatchObject({ categoryId: category.id, assignMode: "signup", signupLimit: 5, assigneeIds: [p.buildMember.id] });

    // Closed with sign-ups still reads as a sign-up task.
    await setSignupOpen(ctxFor(lead), { taskId: id, open: false });
    expect((await getManagedTaskDetail(lead, id, t.db))?.assignMode).toBe("signup");
  });
});

// ---------- "Mark task finished" ----------

/** Put one person's item into a state (with the review fields a real review leaves). */
async function setItem(
  taskId: string,
  user: Actor,
  status: AssignmentStatus,
  extra: { reviewer?: Actor; reviewNote?: string | null; submissionNote?: string | null } = {},
) {
  const reviewed = status === "APPROVED" || status === "REJECTED";
  return t.db.taskAssignment.update({
    where: { taskId_userId: { taskId, userId: user.id } },
    data: {
      status,
      submittedAt: status === "TODO" ? null : new Date(TEST_NOW.getTime() - 7_200_000),
      submissionNote: extra.submissionNote ?? null,
      reviewedById: reviewed ? (extra.reviewer ?? p.buildLead2).id : null,
      reviewedAt: reviewed ? new Date(TEST_NOW.getTime() - 3_600_000) : null,
      reviewNote: extra.reviewNote ?? null,
    },
  });
}

describe("finishTask / reopenTask", () => {
  let grant: Actor;
  let paige: Actor;
  let sam: Actor;
  let riley: Actor;

  beforeAll(async () => {
    grant = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Grant Gears" });
    paige = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Paige Pinion" });
    sam = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Sam Sprocket" });
    riley = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Riley Rivet" });
  });

  /** The leader's example: a Build task, Paige approved one by one, Grant still to do. */
  async function drivetrain(more: Actor[] = []) {
    const task = await makeTask(t.db, p.buildLead1, {
      title: "Drivetrain construction",
      subteam: "BUILD",
      assigneeIds: [grant.id, paige.id, ...more.map((u) => u.id)],
    });
    await setItem(task.id, paige, "APPROVED", { reviewNote: "Looks great" });
    return task.id;
  }

  it("counts it as done for everyone still on it: to do, checked off, and sent back become approved", async () => {
    const taskId = await drivetrain([sam, riley]);
    await setItem(taskId, sam, "SUBMITTED", { submissionNote: "Wheels on", reviewNote: "Earlier: tighten the bolts" });
    await setItem(taskId, riley, "REJECTED", { reviewNote: "Redo the chain" });

    const ctx = ctxFor(p.buildLead1);
    expect(await finishTask(ctx, { taskId, credit: "everyone" })).toEqual({ credited: 3, closed: 0 });
    expect(ctx.notifier.events).toEqual([]); // nobody is emailed

    expect(await t.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({
      completedAt: TEST_NOW,
      completedById: p.buildLead1.id,
    });
    const counted = { status: "APPROVED", finishedWithTask: true, reviewedById: p.buildLead1.id, reviewedAt: TEST_NOW };
    expect(await assignmentOf(taskId, grant.id)).toMatchObject({ ...counted, statusBeforeFinish: "TODO", reviewNote: null });
    expect(await assignmentOf(taskId, sam.id)).toMatchObject({
      ...counted,
      statusBeforeFinish: "SUBMITTED",
      submissionNote: "Wheels on",
      reviewNote: "Earlier: tighten the bolts",
    });
    expect(await assignmentOf(taskId, riley.id)).toMatchObject({ ...counted, statusBeforeFinish: "REJECTED", reviewNote: "Redo the chain" });
    // Paige was approved one by one: untouched.
    expect(await assignmentOf(taskId, paige.id)).toMatchObject({
      status: "APPROVED",
      finishedWithTask: false,
      statusBeforeFinish: null,
      reviewedById: p.buildLead2.id,
      reviewNote: "Looks great",
    });

    const detail = (await getManagedTaskDetail(p.buildLead1, taskId, t.db))!;
    expect(detail.counts).toEqual({ total: 4, todo: 0, submitted: 0, approved: 4, rejected: 0, closed: 0 });
    expect(detail.completedAt).toEqual(TEST_NOW);
    expect(detail.completedBy).toEqual({ id: p.buildLead1.id, name: "Blake Build" });
    expect(detail.assignments.filter((a) => a.finishedWithTask).map((a) => a.user.name)).toEqual([
      "Grant Gears",
      "Riley Rivet",
      "Sam Sprocket",
    ]);
    expect(detail.assignments.some((a) => a.closed)).toBe(false);
  });

  it("reopening puts back exactly what finishing changed", async () => {
    const taskId = await drivetrain([sam, riley]);
    await setItem(taskId, sam, "SUBMITTED", { submissionNote: "Wheels on" });
    await setItem(taskId, riley, "REJECTED", { reviewNote: "Redo the chain" });
    const before = await t.db.taskAssignment.findMany({ where: { taskId }, orderBy: { userId: "asc" } });

    await finishTask(ctxFor(p.buildLead1), { taskId, credit: "everyone" });
    const ctx = ctxFor(p.buildLead2);
    expect(await reopenTask(ctx, { taskId })).toEqual({ restored: 3 });
    expect(ctx.notifier.events).toEqual([]);

    expect(await t.db.task.findUniqueOrThrow({ where: { id: taskId } })).toMatchObject({ completedAt: null, completedById: null });
    const after = await t.db.taskAssignment.findMany({ where: { taskId }, orderBy: { userId: "asc" } });
    const byUser = new Map(after.map((a) => [a.userId, a]));
    expect(byUser.get(grant.id)).toMatchObject({ status: "TODO", reviewedById: null, reviewedAt: null, finishedWithTask: false, statusBeforeFinish: null });
    expect(byUser.get(sam.id)).toMatchObject({ status: "SUBMITTED", submissionNote: "Wheels on", finishedWithTask: false, statusBeforeFinish: null });
    expect(byUser.get(sam.id)!.submittedAt).toEqual(before.find((a) => a.userId === sam.id)!.submittedAt);
    // Sent back keeps its feedback (the review fields finishing set are cleared).
    expect(byUser.get(riley.id)).toMatchObject({ status: "REJECTED", reviewNote: "Redo the chain", reviewedById: null, reviewedAt: null });
    // Approved one by one: as it was.
    const paigeBefore = before.find((a) => a.userId === paige.id)!;
    expect(byUser.get(paige.id)).toMatchObject({
      status: "APPROVED",
      reviewedById: paigeBefore.reviewedById,
      reviewedAt: paigeBefore.reviewedAt,
      reviewNote: "Looks great",
    });
  });

  it("'Just close it' leaves every item as it is: not approved means closed, no credit", async () => {
    const taskId = await drivetrain([sam]);
    await setItem(taskId, sam, "SUBMITTED");
    expect(await finishTask(ctxFor(p.buildLead1), { taskId, credit: "none" })).toEqual({ credited: 0, closed: 2 });

    expect((await assignmentOf(taskId, grant.id)).status).toBe("TODO");
    expect((await assignmentOf(taskId, sam.id)).status).toBe("SUBMITTED");
    const all = await t.db.taskAssignment.findMany({ where: { taskId } });
    expect(all.every((a) => !a.finishedWithTask && a.statusBeforeFinish === null)).toBe(true);

    const detail = (await getManagedTaskDetail(p.buildLead1, taskId, t.db))!;
    expect(detail.counts).toEqual({ total: 3, todo: 0, submitted: 0, approved: 1, rejected: 0, closed: 2 });
    expect(detail.assignments.filter((a) => a.closed).map((a) => a.user.name)).toEqual(["Grant Gears", "Sam Sprocket"]);
    // Out of the review queue — a manager can still approve it on the task page.
    expect((await getReviewQueue(p.buildLead1, {}, t.db)).groups.some((g) => g.task.id === taskId)).toBe(false);
    const samItem = await assignmentOf(taskId, sam.id);
    expect(await approveMany(ctxFor(p.buildLead1), { assignmentIds: [samItem.id] })).toEqual({ approved: 0, skipped: 1 });

    expect(await reopenTask(ctxFor(p.buildLead1), { taskId })).toEqual({ restored: 0 });
    const reopened = (await getManagedTaskDetail(p.buildLead1, taskId, t.db))!;
    expect(reopened.counts).toEqual({ total: 3, todo: 1, submitted: 1, approved: 1, rejected: 0, closed: 0 });
    expect((await getReviewQueue(p.buildLead1, {}, t.db)).groups.some((g) => g.task.id === taskId)).toBe(true);
  });

  it("finishing twice is a conflict that says who did it; so is reopening an open task", async () => {
    const taskId = await drivetrain();
    await finishTask(ctxFor(p.buildLead1), { taskId, credit: "none" });
    const err = await finishTask(ctxFor(p.buildLead2), { taskId, credit: "everyone" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toMatch(/^Blake Build already marked this task finished/);
    // Nothing was counted by the refused second try.
    expect((await assignmentOf(taskId, grant.id)).status).toBe("TODO");

    await reopenTask(ctxFor(p.buildLead1), { taskId });
    await expect(reopenTask(ctxFor(p.buildLead1), { taskId })).rejects.toThrow(ConflictError);
  });

  it("two leaders finishing at once: exactly one wins", async () => {
    const taskId = await drivetrain();
    const results = await Promise.allSettled([
      finishTask(ctxFor(p.buildLead1), { taskId, credit: "everyone" }),
      finishTask(ctxFor(p.buildLead2), { taskId, credit: "none" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
  });

  it("a check-off racing the finish never lands on the finished task", async () => {
    for (let i = 0; i < 5; i++) {
      const taskId = await drivetrain();
      const item = await assignmentOf(taskId, grant.id);
      const [submitted, finished] = await Promise.allSettled([
        submitAssignment(contextFor(t.db, grant), { assignmentId: item.id }),
        finishTask(ctxFor(p.buildLead1), { taskId, credit: "everyone" }),
      ]);
      expect(finished.status).toBe("fulfilled");
      const after = await assignmentOf(taskId, grant.id);
      expect(after).toMatchObject({ status: "APPROVED", finishedWithTask: true });
      if (submitted.status === "fulfilled") expect(after.statusBeforeFinish).toBe("SUBMITTED");
      else {
        expect(submitted.reason).toBeInstanceOf(ConflictError);
        expect(after.statusBeforeFinish).toBe("TODO");
      }
    }
  });

  it("a subteam leader's own item isn't counted for everyone (like reviewing); all-scope staff's is", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [grant.id, p.buildLead1.id] });
    expect(await finishTask(ctxFor(p.buildLead1), { taskId: task.id, credit: "everyone" })).toEqual({ credited: 1, closed: 1 });
    expect((await assignmentOf(task.id, grant.id)).status).toBe("APPROVED");
    expect(await assignmentOf(task.id, p.buildLead1.id)).toMatchObject({ status: "TODO", finishedWithTask: false });

    const team = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [grant.id, p.captain.id] });
    expect(await finishTask(ctxFor(p.captain), { taskId: team.id, credit: "everyone" })).toEqual({ credited: 2, closed: 0 });
    expect((await assignmentOf(team.id, p.captain.id)).status).toBe("APPROVED");
  });

  it("a subteam leader's own checked-off item: 'count for everyone' is refused until someone else approves it", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [grant.id, p.buildLead1.id] });
    const own = await setItem(task.id, p.buildLead1, "SUBMITTED");
    const err = await finishTask(ctxFor(p.buildLead1), { taskId: task.id, credit: "everyone" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe(
      "Your own item is waiting for review. Ask another leader or the captain to approve it first, or choose “Just close it”.",
    );
    // Nothing changed: still open, Grant not counted, and the leader's item is still in the other leader's queue.
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).toBeNull();
    expect((await assignmentOf(task.id, grant.id)).status).toBe("TODO");
    expect((await getReviewQueue(p.buildLead2, {}, t.db)).groups.find((g) => g.task.id === task.id)?.items.map((i) => i.id)).toEqual([
      own.id,
    ]);

    // Once another leader approves it, counting for everyone works.
    await reviewAssignment(ctxFor(p.buildLead2), { assignmentId: own.id, decision: "approve" });
    expect(await finishTask(ctxFor(p.buildLead1), { taskId: task.id, credit: "everyone" })).toEqual({ credited: 1, closed: 0 });
  });

  it("a subteam leader may still just close a task with their own item waiting; all-scope staff's own item counts", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [grant.id, p.buildLead1.id] });
    await setItem(task.id, p.buildLead1, "SUBMITTED");
    expect(await finishTask(ctxFor(p.buildLead1), { taskId: task.id, credit: "none" })).toEqual({ credited: 0, closed: 2 });

    const team = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [grant.id, p.captain.id] });
    await setItem(team.id, p.captain, "SUBMITTED");
    expect(await finishTask(ctxFor(p.captain), { taskId: team.id, credit: "everyone" })).toEqual({ credited: 2, closed: 0 });
    expect(await assignmentOf(team.id, p.captain.id)).toMatchObject({ status: "APPROVED", statusBeforeFinish: "SUBMITTED" });
  });

  it("finishing it again from a stale tab says 'You' to whoever finished it", async () => {
    const taskId = await drivetrain();
    await finishTask(ctxFor(p.buildLead1), { taskId, credit: "none" });
    await expect(finishTask(ctxFor(p.buildLead1), { taskId, credit: "everyone" })).rejects.toThrow(
      "You already marked this task finished. Refresh to see the latest.",
    );
  });

  it("only people who manage the task finish or reopen it", async () => {
    const task = await makeTask(t.db, p.captain, { subteam: "BUILD", assigneeIds: [grant.id] });
    for (const who of [p.swLead, p.bizLead]) {
      await expect(finishTask(ctxFor(who), { taskId: task.id, credit: "none" }), who.name).rejects.toThrow(NotFoundError);
    }
    for (const who of [p.buildMember, grant]) {
      await expect(finishTask(ctxFor(who), { taskId: task.id, credit: "none" }), who.name).rejects.toThrow(ForbiddenError);
    }
    // Another Build leader manages it.
    await finishTask(ctxFor(p.buildLead2), { taskId: task.id, credit: "none" });
    await expect(reopenTask(ctxFor(p.swLead), { taskId: task.id })).rejects.toThrow(NotFoundError);
    await expect(reopenTask(ctxFor(grant), { taskId: task.id })).rejects.toThrow(ForbiddenError);
    await reopenTask(ctxFor(p.mentor), { taskId: task.id });

    const fieldErrors = async (input: Record<string, unknown>) => {
      const err = await finishTask(ctxFor(p.captain), input).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      return (err as ValidationError).fieldErrors;
    };
    expect((await fieldErrors({ taskId: task.id })).credit).toBe("Choose whether it counts as done for everyone.");
    expect((await fieldErrors({ taskId: task.id, credit: "some" })).credit).toBe("Choose whether it counts as done for everyone.");
    expect((await fieldErrors({ credit: "none" })).taskId).toBeDefined();
    await expect(finishTask(ctxFor(p.captain), { taskId: "missing", credit: "none" })).rejects.toThrow(NotFoundError);
    expect((await t.db.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).toBeNull();
  });

  it("on a finished task an item still waiting can be approved (then it counts) but not sent back", async () => {
    const taskId = await drivetrain([sam]);
    await setItem(taskId, sam, "SUBMITTED");
    await finishTask(ctxFor(p.buildLead1), { taskId, credit: "none" });
    const item = await assignmentOf(taskId, sam.id);

    await expect(reviewAssignment(ctxFor(p.buildLead1), { assignmentId: item.id, decision: "reject", note: "More" })).rejects.toThrow(
      /can't be sent back/,
    );
    const ctx = ctxFor(p.buildLead1);
    await reviewAssignment(ctx, { assignmentId: item.id, decision: "approve" });
    expect(await assignmentOf(taskId, sam.id)).toMatchObject({ status: "APPROVED", finishedWithTask: false, reviewedById: p.buildLead1.id });
    expect(ctx.notifier.events).toEqual([{ type: "task.reviewed", assignmentId: item.id }]);
    // Reopening the task leaves an item approved one by one alone.
    expect(await reopenTask(ctxFor(p.buildLead1), { taskId })).toEqual({ restored: 0 });
    expect((await assignmentOf(taskId, sam.id)).status).toBe("APPROVED");
  });

  it("a send-back racing the finish is refused instead of landing on the finished task", async () => {
    const taskId = await drivetrain([sam]);
    await setItem(taskId, sam, "SUBMITTED");
    const item = await assignmentOf(taskId, sam.id);
    // The task gets marked finished right between the checks and the write.
    const racing = new Proxy(t.db, {
      get(target, prop) {
        if (prop === "taskAssignment") {
          return new Proxy(target.taskAssignment, {
            get(delegate, key) {
              if (key === "updateMany") {
                return async (args: Parameters<Db["taskAssignment"]["updateMany"]>[0]) => {
                  await target.task.update({ where: { id: taskId }, data: { completedAt: TEST_NOW, completedById: p.buildLead2.id } });
                  return delegate.updateMany(args);
                };
              }
              const value = Reflect.get(delegate, key);
              return typeof value === "function" ? value.bind(delegate) : value;
            },
          });
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = { ...ctxFor(p.buildLead1), db: racing };
    await expect(reviewAssignment(ctx, { assignmentId: item.id, decision: "reject", note: "More" })).rejects.toThrow(/can't be sent back/);
    expect((await assignmentOf(taskId, sam.id)).status).toBe("SUBMITTED");
    expect(ctx.notifier.events).toEqual([]);
  });

  it("reopening one counted item takes its credit back for good (it stays closed while the task is finished)", async () => {
    const taskId = await drivetrain();
    await finishTask(ctxFor(p.buildLead1), { taskId, credit: "everyone" });
    const item = await assignmentOf(taskId, grant.id);
    expect(await reopenAssignment(ctxFor(p.buildLead2), { assignmentId: item.id })).toEqual({ taskFinished: true });
    expect(await assignmentOf(taskId, grant.id)).toMatchObject({
      status: "TODO",
      finishedWithTask: false,
      statusBeforeFinish: null,
      reviewedById: null,
    });
    const detail = (await getManagedTaskDetail(p.buildLead1, taskId, t.db))!;
    expect(detail.counts).toMatchObject({ approved: 1, closed: 1, todo: 0 });

    expect(await reopenTask(ctxFor(p.buildLead1), { taskId })).toEqual({ restored: 0 });
    expect((await assignmentOf(taskId, grant.id)).status).toBe("TODO");
    // On an open task, reopening an item says it's back on their list.
    await setItem(taskId, grant, "APPROVED");
    expect(await reopenAssignment(ctxFor(p.buildLead2), { assignmentId: item.id })).toEqual({ taskFinished: false });
  });

  it("a finished task can still be edited, but nobody new can be added and sign-ups can't be opened", async () => {
    const { id } = await createTask(ctxFor(p.buildLead1), taskInput({ assignMode: "signup", assigneeIds: [p.buildMember.id] }));
    await finishTask(ctxFor(p.buildLead1), { taskId: id, credit: "none" });

    const ctx = ctxFor(p.buildLead1);
    await updateTask(ctx, taskInput({ taskId: id, title: "Renamed after finishing", assignMode: "signup", assigneeIds: [p.buildMember.id] }));
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: "Renamed after finishing", completedAt: TEST_NOW });

    const err = await updateTask(
      ctx,
      taskInput({ taskId: id, assignMode: "signup", assigneeIds: [p.buildMember.id, p.buildMember2.id] }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.assigneeIds).toMatch(/marked finished, so nobody new can be added/);
    expect(await t.db.taskAssignment.count({ where: { taskId: id } })).toBe(1);
    expect(ctx.notifier.events).toEqual([]);

    // Taking someone off is fine.
    await updateTask(ctx, taskInput({ taskId: id, assignMode: "signup", assigneeIds: [] }));
    expect(await t.db.taskAssignment.count({ where: { taskId: id } })).toBe(0);

    await setSignupOpen(ctx, { taskId: id, open: false });
    await expect(setSignupOpen(ctx, { taskId: id, open: true })).rejects.toThrow(/Reopen the task to open sign-ups/);
    await reopenTask(ctx, { taskId: id });
    await setSignupOpen(ctx, { taskId: id, open: true });
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).signupOpen).toBe(true);
  });

  it("duplicating a finished task makes an open one; deleting a finished task works", async () => {
    const taskId = await drivetrain();
    await finishTask(ctxFor(p.buildLead1), { taskId, credit: "everyone" });
    const copy = (await getTaskDuplicate(p.buildLead1, taskId, { today: TEST_TODAY }, t.db))!;
    expect(copy.assigneeIds.sort()).toEqual([grant.id, paige.id].sort());
    const { id } = await createTask(ctxFor(p.buildLead1), { ...copy, subteam: copy.subteam, signupLimit: "" });
    expect(await t.db.task.findUniqueOrThrow({ where: { id } })).toMatchObject({ completedAt: null, completedById: null });
    expect(await t.db.taskAssignment.findMany({ where: { taskId: id } })).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "TODO", finishedWithTask: false })]),
    );

    await deleteTask(ctxFor(p.buildLead1), { taskId });
    expect(await t.db.task.count({ where: { id: taskId } })).toBe(0);
  });

  it("the manage list: finished tasks are past (even when due later) and say so", async () => {
    const lead = await makeUser(t.db, { role: "BUILD_LEADER", name: "List Lead" });
    const later = await makeTask(t.db, lead, { title: "Finished early", subteam: "BUILD", dueDate: addDays(TEST_TODAY, 5), assigneeIds: [grant.id] });
    await makeTask(t.db, lead, { title: "Still going", subteam: "BUILD", dueDate: addDays(TEST_TODAY, 5), assigneeIds: [grant.id] });
    await finishTask(ctxFor(lead), { taskId: later.id, credit: "none" });

    const upcoming = await listManagedTasks(lead, { view: "upcoming", mine: true, today: TEST_TODAY }, t.db);
    expect(upcoming.tasks.map((x) => x.title)).toEqual(["Still going"]);
    const past = await listManagedTasks(lead, { view: "past", mine: true, today: TEST_TODAY }, t.db);
    expect(past.tasks.map((x) => [x.title, x.finished])).toEqual([["Finished early", true]]);
    expect(past.tasks[0].counts).toEqual({ total: 1, todo: 0, submitted: 0, approved: 0, rejected: 0, closed: 1 });
  });
});

// ---------- The Business leader's whole-team tasks ----------

describe("the Business leader's whole-team tasks", () => {
  it("creates a whole-team task for anyone ACTIVE: a build member, a software member, the captain", async () => {
    const ctx = ctxFor(p.bizLead);
    const people = [p.buildMember.id, p.swMember.id, p.bizMember.id, p.captain.id, p.buildLead1.id];
    const { id } = await createTask(ctx, taskInput({ title: "Car wash", subteam: "", assigneeIds: people }));
    const task = await t.db.task.findUniqueOrThrow({ where: { id }, include: { assignments: true } });
    expect(task).toMatchObject({ subteam: null, createdById: p.bizLead.id });
    expect(task.assignments.map((a) => a.userId).sort()).toEqual([...people].sort());
    expect(ctx.notifier.events).toEqual([{ type: "task.assigned", taskId: id, userIds: people, actorId: p.bizLead.id }]);

    const err = await createTask(ctx, taskInput({ subteam: "", assigneeIds: [p.disabledBuild.id] })).catch((e) => e);
    expect((err as ValidationError).fieldErrors.assigneeIds).toContain("isn't active");
  });

  it("keeps Business tasks Business-only, and says how to add the others", async () => {
    const err = await createTask(ctxFor(p.bizLead), taskInput({ subteam: "BUSINESS", assigneeIds: [p.bizMember.id, p.buildMember.id] })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.assigneeIds).toBe(
      "Can't assign this task: Brook Member isn't in Business — make it a whole-team task to add them.",
    );
  });

  it("other subteam leaders still can't create whole-team tasks", async () => {
    for (const who of [p.swLead, p.buildLead1]) {
      const err = await createTask(ctxFor(who), taskInput({ subteam: "", assigneeIds: [p.buildMember.id] })).catch((e) => e);
      expect(err, who.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).message).toBe(
        "Only the captain, mentors, teachers, and the Business leader can create whole-team tasks.",
      );
    }
  });

  it("manages the whole-team tasks they created — edit, review, finish, delete — but not the captain's", async () => {
    const lead = ctxFor(p.bizLead);
    const { id } = await createTask(lead, taskInput({ subteam: "", assigneeIds: [p.buildMember.id, p.swMember.id] }));
    await updateTask(lead, taskInput({ taskId: id, subteam: "", assigneeIds: [p.buildMember.id, p.swMember.id, p.bizMember.id] }));
    expect(await t.db.taskAssignment.count({ where: { taskId: id } })).toBe(3);

    const sw = await assignmentOf(id, p.swMember.id);
    await submit(sw.id);
    expect((await getReviewQueue(p.bizLead, {}, t.db)).groups.find((g) => g.task.id === id)).toMatchObject({ task: { canManage: true } });
    await reviewAssignment(lead, { assignmentId: sw.id, decision: "approve" });
    // The Build leader still reviews their own members' items on it.
    const build = await assignmentOf(id, p.buildMember.id);
    await submit(build.id);
    await reviewAssignment(ctxFor(p.buildLead1), { assignmentId: build.id, decision: "approve" });

    expect(await finishTask(lead, { taskId: id, credit: "everyone" })).toEqual({ credited: 1, closed: 0 });
    await reopenTask(lead, { taskId: id });
    expect(await getManagedTaskDetail(p.bizLead, id, t.db)).not.toBeNull();
    await deleteTask(lead, { taskId: id });

    const captains = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [p.bizMember.id] });
    expect(await getManagedTaskDetail(p.bizLead, captains.id, t.db)).toBeNull();
    await expect(updateTask(lead, taskInput({ taskId: captains.id, subteam: "", assigneeIds: [p.bizMember.id] }))).rejects.toThrow(
      NotFoundError,
    );
    await expect(finishTask(lead, { taskId: captains.id, credit: "none" })).rejects.toThrow(NotFoundError);
    await expect(deleteTask(lead, { taskId: captains.id })).rejects.toThrow(NotFoundError);
  });

  it("moves their tasks between Business and the whole team; only new people are checked against the new subteam", async () => {
    const lead = ctxFor(p.bizLead);
    const { id } = await createTask(lead, taskInput({ subteam: "BUSINESS", assigneeIds: [p.bizMember.id] }));
    await updateTask(lead, taskInput({ taskId: id, subteam: "", assigneeIds: [p.bizMember.id, p.swMember.id] }));
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).subteam).toBeNull();
    // Back to Business: the software member already on it stays, but nobody else from outside Business joins.
    await updateTask(lead, taskInput({ taskId: id, subteam: "BUSINESS", assigneeIds: [p.bizMember.id, p.swMember.id] }));
    const err = await updateTask(
      lead,
      taskInput({ taskId: id, subteam: "BUSINESS", assigneeIds: [p.bizMember.id, p.swMember.id, p.buildMember.id] }),
    ).catch((e) => e);
    expect((err as ValidationError).fieldErrors.assigneeIds).toMatch(/Brook Member isn't in Business/);
    // Other leaders still can't make a task whole-team.
    const build = await createTask(ctxFor(p.buildLead1), taskInput());
    await expect(updateTask(ctxFor(p.buildLead1), taskInput({ taskId: build.id, subteam: "" }))).rejects.toThrow(
      "Only the captain, mentors, teachers, and the Business leader can make a task whole-team.",
    );
  });

  it("can't make a Business task someone else created whole-team (they'd lose it, with anyone added)", async () => {
    const captains = await createTask(ctxFor(p.captain), taskInput({ subteam: "BUSINESS", assigneeIds: [p.bizMember.id] }));
    const lead = ctxFor(p.bizLead);
    const err = await updateTask(
      lead,
      taskInput({ taskId: captains.id, subteam: "", assigneeIds: [p.bizMember.id, p.buildMember.id, p.swMember.id] }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).message).toBe(
      "Only whoever created this task, or the captain, mentors, and teachers, can make it whole-team.",
    );
    const after = await t.db.task.findUniqueOrThrow({ where: { id: captains.id }, include: { assignments: true } });
    expect(after.subteam).toBe("BUSINESS");
    expect(after.assignments.map((a) => a.userId)).toEqual([p.bizMember.id]);
    expect(lead.notifier.events).toEqual([]);
    // They still manage (and can edit) it as a Business task.
    await updateTask(lead, taskInput({ taskId: captains.id, subteam: "BUSINESS", title: "Still Business", assigneeIds: [p.bizMember.id] }));
    expect(await getManagedTaskDetail(p.bizLead, captains.id, t.db)).toMatchObject({ title: "Still Business", subteam: "BUSINESS" });
    // The captain can make it whole-team.
    await updateTask(ctxFor(p.captain), taskInput({ taskId: captains.id, subteam: "", assigneeIds: [p.bizMember.id] }));
    expect((await t.db.task.findUniqueOrThrow({ where: { id: captains.id } })).subteam).toBeNull();
  });

  it("picks existing whole-team categories, but doesn't add to that list", async () => {
    const outreach = await t.db.taskCategory.create({ data: { subteam: null, name: "Outreach", nameKey: "outreach" } });
    const lead = ctxFor(p.bizLead);
    const { id } = await createTask(lead, taskInput({ subteam: "", categoryId: outreach.id, assigneeIds: [p.buildMember.id] }));
    expect((await t.db.task.findUniqueOrThrow({ where: { id } })).categoryId).toBe(outreach.id);

    const err = await createTask(
      lead,
      taskInput({ subteam: "", categoryId: NEW_CATEGORY, newCategory: "Fundraising", assigneeIds: [p.buildMember.id] }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.newCategory).toBe(
      "Only the captain, mentors, and teachers add whole-team categories. Pick one from the list.",
    );
    expect(await t.db.taskCategory.count({ where: { subteam: null, nameKey: "fundraising" } })).toBe(0);
    // Their own Business list is theirs to add to.
    await createTask(lead, taskInput({ subteam: "BUSINESS", categoryId: NEW_CATEGORY, newCategory: "Sponsors", assigneeIds: [p.bizMember.id] }));
    expect(await t.db.taskCategory.count({ where: { subteam: "BUSINESS", nameKey: "sponsors" } })).toBe(1);
  });

  it("duplicating their whole-team task keeps the whole team and everyone on it", async () => {
    const { id } = await createTask(ctxFor(p.bizLead), taskInput({ subteam: "", assigneeIds: [p.buildMember.id, p.swMember.id] }));
    const copy = await getTaskDuplicate(p.bizLead, id, { today: TEST_TODAY }, t.db);
    expect(copy).toMatchObject({ subteam: "" });
    expect(copy!.assigneeIds.sort()).toEqual([p.buildMember.id, p.swMember.id].sort());
    // The captain's whole-team tasks aren't theirs to copy.
    const captains = await makeTask(t.db, p.captain, { subteam: null, assigneeIds: [p.buildMember.id, p.swMember.id] });
    expect(await getTaskDuplicate(p.bizLead, captains.id, { today: TEST_TODAY }, t.db)).toBeNull();
  });
});
