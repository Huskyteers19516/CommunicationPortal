import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Subteam } from "@/generated/prisma/enums";
import { addDays } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { leaveTask, SIGNUP_RATE_LIMIT, signUpForTask } from "@/server/services/signups";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeTask, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let p: Record<"captain" | "buildLead" | "swLead" | "swMember" | "bizMember" | "disabledBuild", Actor>;
/** Build members (plenty, for the race). */
let build: Actor[];

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Build" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Software" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Sky Member" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Billie Member" }),
    disabledBuild: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Dana Disabled" }),
  };
  build = [];
  for (let i = 0; i < 8; i++) build.push(await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: `Build Kid ${i}` }));
});

afterAll(async () => {
  await t?.drop();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);

/** A sign-up task (open by default) with optional pre-assigned people. */
async function signupTask(
  opts: { subteam?: Subteam | null; limit?: number | null; open?: boolean; dueDate?: string; assigneeIds?: string[] } = {},
) {
  const task = await makeTask(t.db, opts.subteam === null ? p.captain : p.buildLead, {
    subteam: opts.subteam === undefined ? "BUILD" : opts.subteam,
    dueDate: opts.dueDate ?? addDays(TEST_TODAY, 3),
    assigneeIds: opts.assigneeIds ?? [],
  });
  await t.db.task.update({ where: { id: task.id }, data: { signupOpen: opts.open ?? true, signupLimit: opts.limit ?? null } });
  return task;
}

async function mine(taskId: string, userId: string) {
  return t.db.taskAssignment.findUnique({ where: { taskId_userId: { taskId, userId } } });
}

async function errorOf(promise: Promise<unknown>) {
  const err = await promise.catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error & { userMessage: string };
}

describe("signUpForTask", () => {
  it("puts a subteam member on an open task as a self sign-up, without emailing anyone", async () => {
    const task = await signupTask({ limit: 3 });
    const ctx = ctxFor(build[0]);
    await signUpForTask(ctx, { taskId: task.id });
    expect(await mine(task.id, build[0].id)).toMatchObject({ status: "TODO", selfAssigned: true, submittedAt: null });
    expect(ctx.notifier.events).toEqual([]);
  });

  it("refuses closed tasks and other subteams' tasks, with a clear reason", async () => {
    const closed = await signupTask({ open: false });
    let err = await errorOf(signUpForTask(ctxFor(build[0]), { taskId: closed.id }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.userMessage).toBe("Sign-ups for this task are closed.");

    const buildTask = await signupTask();
    for (const who of [p.swMember, p.bizMember, p.swLead, p.captain]) {
      err = await errorOf(signUpForTask(ctxFor(who), { taskId: buildTask.id }));
      expect(err, who.name).toBeInstanceOf(ForbiddenError);
      expect(err.userMessage).toBe("This task is for the Build subteam.");
    }
    // A leader of that subteam can sign up like anyone in it.
    await signUpForTask(ctxFor(p.buildLead), { taskId: buildTask.id });
    expect(await mine(buildTask.id, p.buildLead.id)).not.toBeNull();
  });

  it("lets anyone sign up for an open whole-team task", async () => {
    const team = await signupTask({ subteam: null });
    for (const who of [p.swMember, p.bizMember, build[1], p.captain]) await signUpForTask(ctxFor(who), { taskId: team.id });
    expect(await t.db.taskAssignment.count({ where: { taskId: team.id, selfAssigned: true } })).toBe(4);
  });

  it("refuses once the due date has passed (team timezone), but allows due today", async () => {
    const yesterday = await signupTask({ dueDate: addDays(TEST_TODAY, -1) });
    const err = await errorOf(signUpForTask(ctxFor(build[0]), { taskId: yesterday.id }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("This task's due date has passed.");
    const today = await signupTask({ dueDate: TEST_TODAY });
    await expect(signUpForTask(ctxFor(build[0]), { taskId: today.id })).resolves.toBeUndefined();
  });

  it("refuses people already on it (signed up or assigned)", async () => {
    const task = await signupTask({ assigneeIds: [build[2].id] });
    let err = await errorOf(signUpForTask(ctxFor(build[2]), { taskId: task.id }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("You're already on this task.");
    await signUpForTask(ctxFor(build[3]), { taskId: task.id });
    err = await errorOf(signUpForTask(ctxFor(build[3]), { taskId: task.id }));
    expect(err.userMessage).toBe("You're already on this task.");
  });

  it("counts everyone on the task toward the limit", async () => {
    const task = await signupTask({ limit: 2, assigneeIds: [build[0].id] });
    await signUpForTask(ctxFor(build[1]), { taskId: task.id });
    const err = await errorOf(signUpForTask(ctxFor(build[2]), { taskId: task.id }));
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.userMessage).toBe("This task is full.");
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id } })).toBe(2);
  });

  it("gives the last spot to exactly one of several people racing for it", async () => {
    const task = await signupTask({ limit: 3, assigneeIds: [build[0].id, build[1].id] });
    const racers = build.slice(2, 8);
    const results = await Promise.allSettled(racers.map((who) => signUpForTask(ctxFor(who), { taskId: task.id })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(ConflictError);
        expect((r.reason as ConflictError).userMessage).toBe("This task is full.");
      }
    }
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id } })).toBe(3);
  });

  it("handles missing tasks, inactive accounts, and bad input", async () => {
    await expect(signUpForTask(ctxFor(build[0]), { taskId: "missing" })).rejects.toThrow(NotFoundError);
    const task = await signupTask();
    await expect(signUpForTask(ctxFor(p.disabledBuild), { taskId: task.id })).rejects.toThrow(ForbiddenError);
    await expect(signUpForTask(ctxFor(build[0]), {})).rejects.toThrow(ValidationError);
  });

  it("is rate limited per person", async () => {
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Busy Kid" });
    await t.db.rateLimit.create({ data: { key: `signup:${busy.id}`, count: SIGNUP_RATE_LIMIT.limit, windowStart: TEST_NOW } });
    const task = await signupTask();
    await expect(signUpForTask(ctxFor(busy), { taskId: task.id })).rejects.toThrow(RateLimitError);
    expect(await mine(task.id, busy.id)).toBeNull();
  });
});

describe("leaveTask", () => {
  it("takes you off a task you signed up for and frees the spot", async () => {
    const task = await signupTask({ limit: 1 });
    await signUpForTask(ctxFor(build[4]), { taskId: task.id });
    await expect(signUpForTask(ctxFor(build[5]), { taskId: task.id })).rejects.toThrow("This task is full.");

    const ctx = ctxFor(build[4]);
    await leaveTask(ctx, { taskId: task.id });
    expect(await mine(task.id, build[4].id)).toBeNull();
    expect(ctx.notifier.events).toEqual([]);
    await signUpForTask(ctxFor(build[5]), { taskId: task.id });
    expect(await mine(task.id, build[5].id)).not.toBeNull();
  });

  it("works even after sign-ups close", async () => {
    const task = await signupTask();
    await signUpForTask(ctxFor(build[6]), { taskId: task.id });
    await t.db.task.update({ where: { id: task.id }, data: { signupOpen: false } });
    await leaveTask(ctxFor(build[6]), { taskId: task.id });
    expect(await mine(task.id, build[6].id)).toBeNull();
  });

  it("won't drop a task a leader assigned you", async () => {
    const task = await signupTask({ assigneeIds: [build[0].id] });
    const err = await errorOf(leaveTask(ctxFor(build[0]), { taskId: task.id }));
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.userMessage).toBe("A leader assigned you this task — ask them if you need to drop it.");
    expect(await mine(task.id, build[0].id)).not.toBeNull();
  });

  it("won't drop a task you already checked off or that was reviewed", async () => {
    for (const [status, message] of [
      ["SUBMITTED", /already checked this off/],
      ["APPROVED", /already approved/],
      ["REJECTED", /already reviewed/],
    ] as const) {
      const task = await signupTask();
      await signUpForTask(ctxFor(build[7]), { taskId: task.id });
      await t.db.taskAssignment.updateMany({ where: { taskId: task.id }, data: { status, submittedAt: TEST_NOW } });
      const err = await errorOf(leaveTask(ctxFor(build[7]), { taskId: task.id }));
      expect(err, status).toBeInstanceOf(ConflictError);
      expect(err.userMessage).toMatch(message);
      expect(await mine(task.id, build[7].id)).not.toBeNull();
    }
  });

  it("says so when you aren't on the task (or it doesn't exist)", async () => {
    const task = await signupTask({ assigneeIds: [build[0].id] });
    const err = await errorOf(leaveTask(ctxFor(build[1]), { taskId: task.id }));
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.userMessage).toBe("You're not on this task.");
    await expect(leaveTask(ctxFor(build[1]), { taskId: "missing" })).rejects.toThrow(NotFoundError);
    await expect(leaveTask(ctxFor(p.disabledBuild), { taskId: task.id })).rejects.toThrow(ForbiddenError);
  });
});
