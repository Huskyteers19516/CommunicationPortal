import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import {
  getAskTaskOptions,
  getQuestionThread,
  getRecipientOptions,
  listInbox,
  listMyQuestions,
} from "@/server/queries/questions";
import {
  askQuestion,
  deleteQuestion,
  QUESTION_RATE_LIMITS,
  replyToQuestion,
  setQuestionStatus,
} from "@/server/services/questions";
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
  | "pendingLead"
  | "disabledMentor",
  Actor
>;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    admin: await makeUser(db, { name: "Ada Admin", role: "MEMBER", subteam: "BUSINESS", isAdmin: true }),
    captain: await makeUser(db, { name: "Cara Captain", role: "CAPTAIN" }),
    mentor: await makeUser(db, { name: "Milo Mentor", role: "MENTOR" }),
    teacher: await makeUser(db, { name: "Tess Teacher", role: "TEACHER" }),
    swLead: await makeUser(db, { name: "Sam Software", role: "SOFTWARE_LEADER" }),
    buildLead1: await makeUser(db, { name: "Bo Build", role: "BUILD_LEADER" }),
    buildLead2: await makeUser(db, { name: "Bea Build", role: "BUILD_LEADER" }),
    bizLead: await makeUser(db, { name: "Bix Business", role: "BUSINESS_LEADER" }),
    swMember: await makeUser(db, { name: "Sid Member", role: "MEMBER", subteam: "SOFTWARE" }),
    buildMember: await makeUser(db, { name: "Ben Member", role: "MEMBER", subteam: "BUILD" }),
    buildMember2: await makeUser(db, { name: "Bree Member", role: "MEMBER", subteam: "BUILD" }),
    bizMember: await makeUser(db, { name: "Biz Member", role: "MEMBER", subteam: "BUSINESS" }),
    pendingLead: await makeUser(db, { name: "Pat Pending", role: "BUILD_LEADER", status: "PENDING" }),
    disabledMentor: await makeUser(db, { name: "Dee Disabled", role: "MENTOR", status: "DISABLED" }),
  };
});

afterAll(async () => {
  await t?.drop();
});

const ctx = (actor: Actor, now?: Date) => {
  const c = contextFor(t.db, actor);
  if (now) c.now = now;
  return c;
};

const later = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * 60_000);

async function ask(actor: Actor, input: Record<string, unknown> = {}) {
  const { id } = await askQuestion(ctx(actor), { title: "How do I tune the arm?", body: "I tried PID.", to: "subteam", ...input });
  return id;
}

function fieldErrorsOf(e: unknown): Record<string, string> {
  expect(e).toBeInstanceOf(ValidationError);
  return (e as ValidationError).fieldErrors;
}

async function catchError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("Expected the call to throw");
}

describe("askQuestion", () => {
  it("asks the asker's subteam leaders by default and emits question.asked", async () => {
    const c = ctx(p.buildMember);
    const { id } = await askQuestion(c, { title: "  Arm keeps slipping  ", body: "Tried tightening the set screw.", to: "subteam" });
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(q).toMatchObject({
      title: "Arm keeps slipping",
      body: "Tried tightening the set screw.",
      askerId: p.buildMember.id,
      recipientId: null,
      subteam: "BUILD",
      taskId: null,
      status: "OPEN",
    });
    expect(q.lastActivityAt).toEqual(TEST_NOW);
    expect(c.notifier.events).toEqual([{ type: "question.asked", questionId: id }]);
  });

  it("defaults `to` to subteam when missing", async () => {
    const id = await ask(p.swMember, { to: undefined });
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(q.subteam).toBe("SOFTWARE");
    expect(q.recipientId).toBeNull();
  });

  it("asks the whole team (captain) with subteam ''", async () => {
    const id = await ask(p.buildMember, { subteam: "" });
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(q.subteam).toBeNull();
    expect(q.recipientId).toBeNull();
  });

  it("asks another subteam's leaders when a topic is picked", async () => {
    const id = await ask(p.buildMember, { subteam: "SOFTWARE" });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).subteam).toBe("SOFTWARE");
  });

  it("staff without a subteam default to whole team", async () => {
    const id = await ask(p.mentor, { to: "person", recipientId: p.captain.id });
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(q.subteam).toBeNull();
    expect(q.recipientId).toBe(p.captain.id);
  });

  it("asks a specific staff person (subteam defaults to the asker's)", async () => {
    const c = ctx(p.buildMember);
    const { id } = await askQuestion(c, { title: "Q", body: "B", to: "person", recipientId: p.swLead.id });
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(q.recipientId).toBe(p.swLead.id);
    expect(q.subteam).toBe("BUILD");
    expect(c.notifier.ofType("question.asked")).toEqual([{ type: "question.asked", questionId: id }]);
  });

  it("a leader can ask the captain", async () => {
    const id = await ask(p.buildLead1, { to: "person", recipientId: p.captain.id, subteam: "" });
    const q = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(q).toMatchObject({ askerId: p.buildLead1.id, recipientId: p.captain.id, subteam: null });
  });

  it("an admin with a member role can be a recipient", async () => {
    const id = await ask(p.buildMember, { to: "person", recipientId: p.admin.id });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).recipientId).toBe(p.admin.id);
  });

  it("requires a recipient when asking a person", async () => {
    const c = ctx(p.buildMember);
    const e = await catchError(() => askQuestion(c, { title: "Q", body: "B", to: "person", recipientId: "" }));
    expect(fieldErrorsOf(e).recipientId).toBe("Choose who should answer.");
    expect(c.notifier.events).toHaveLength(0);
  });

  it.each([
    ["a member", () => p.buildMember2.id],
    ["a pending leader", () => p.pendingLead.id],
    ["a disabled mentor", () => p.disabledMentor.id],
    ["an unknown id", () => "does-not-exist"],
  ])("rejects %s as the recipient", async (_label, recipientId) => {
    const c = ctx(p.buildMember);
    const e = await catchError(() => askQuestion(c, { title: "Q", body: "B", to: "person", recipientId: recipientId() }));
    expect(fieldErrorsOf(e).recipientId).toMatch(/leader, mentor, or teacher/);
    expect(c.notifier.events).toHaveLength(0);
  });

  it("rejects asking yourself", async () => {
    const e = await catchError(() => askQuestion(ctx(p.buildLead1), { title: "Q", body: "B", to: "person", recipientId: p.buildLead1.id }));
    expect(fieldErrorsOf(e).recipientId).toBe("You can't send a question to yourself.");
  });

  it("validates title, body, to, and subteam", async () => {
    const c = ctx(p.buildMember);
    const e1 = await catchError(() => askQuestion(c, { title: "   ", body: "", to: "subteam" }));
    const errors = fieldErrorsOf(e1);
    expect(errors.title).toBe("Title is required.");
    expect(errors.body).toMatch(/details/i);

    const e2 = await catchError(() => askQuestion(c, { title: "x".repeat(161), body: "B" }));
    expect(fieldErrorsOf(e2).title).toMatch(/at most 160/);

    const e3 = await catchError(() => askQuestion(c, { title: "Q", body: "x".repeat(5001) }));
    expect(fieldErrorsOf(e3).body).toMatch(/5000/);

    const e4 = await catchError(() => askQuestion(c, { title: "Q", body: "B", to: "everyone" }));
    expect(fieldErrorsOf(e4).to).toBe("Choose who should answer.");

    const e5 = await catchError(() => askQuestion(c, { title: "Q", body: "B", subteam: "ROBOTS" }));
    expect(fieldErrorsOf(e5).subteam).toBe("Pick a topic from the list.");

    expect(c.notifier.events).toHaveLength(0);
  });

  it("accepts FormData input", async () => {
    const fd = new FormData();
    fd.set("title", "From a form");
    fd.set("body", "Body");
    fd.set("to", "subteam");
    fd.set("subteam", "BUSINESS");
    fd.set("taskId", "");
    const { id } = await askQuestion(ctx(p.bizMember), fd);
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).subteam).toBe("BUSINESS");
  });

  it("links a task the asker is assigned to", async () => {
    const task = await makeTask(t.db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    const id = await ask(p.buildMember, { taskId: task.id });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).taskId).toBe(task.id);
  });

  it("links a task the asker manages but isn't assigned to", async () => {
    const task = await makeTask(t.db, p.buildLead2, { subteam: "BUILD", assigneeIds: [p.buildMember.id] });
    const id = await ask(p.buildLead1, { to: "person", recipientId: p.captain.id, taskId: task.id });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).taskId).toBe(task.id);
  });

  it("links any task on the Task dashboard, but not one that doesn't exist", async () => {
    // Everyone can see every task on the Task dashboard, so asking about another subteam's task is fine.
    const other = await makeTask(t.db, p.swLead, { subteam: "SOFTWARE", assigneeIds: [p.swMember.id] });
    const id = await ask(p.buildMember, { taskId: other.id });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).taskId).toBe(other.id);
    const c = ctx(p.buildMember);
    const e = await catchError(() => askQuestion(c, { title: "Q", body: "B", taskId: "nope" }));
    expect(fieldErrorsOf(e).taskId).toBe("That task no longer exists.");
    expect(c.notifier.events).toHaveLength(0);
  });

  it("asks the leaders of another subteam's task (Ask a question about this on the Task dashboard)", async () => {
    const asker = await makeUser(t.db, { name: "Curious Coder", role: "MEMBER", subteam: "SOFTWARE" });
    const buildTask = await makeTask(t.db, p.buildLead1, { subteam: "BUILD" });
    const c = ctx(asker);
    const { id } = await askQuestion(c, { title: "Which bolts?", body: "b", to: "subteam", subteam: "BUILD", taskId: buildTask.id });
    expect(await t.db.question.findUniqueOrThrow({ where: { id } })).toMatchObject({ subteam: "BUILD", taskId: buildTask.id, recipientId: null });
    expect(c.notifier.events).toEqual([{ type: "question.asked", questionId: id }]);
    // Build leaders get it; the asker's own (Software) leader doesn't.
    expect(await getQuestionThread(p.buildLead1, id, t.db)).not.toBeNull();
    expect(await getQuestionThread(p.swLead, id, t.db)).toBeNull();

    // A whole-team task goes to the captain (subteam "").
    const teamTask = await makeTask(t.db, p.captain, { subteam: null });
    const q2 = await askQuestion(ctx(asker), { title: "Team?", body: "b", to: "subteam", subteam: "", taskId: teamTask.id });
    expect(await t.db.question.findUniqueOrThrow({ where: { id: q2.id } })).toMatchObject({ subteam: null, taskId: teamTask.id });
    expect(await getQuestionThread(p.captain, q2.id, t.db)).not.toBeNull();
  });

  it("rejects accounts that aren't active", async () => {
    const pending = { ...p.pendingLead };
    const e = await catchError(() => askQuestion(ctx(pending), { title: "Q", body: "B" }));
    expect(e).toBeInstanceOf(ForbiddenError);
  });
});

describe("visibility and replies", () => {
  let qid: string;
  beforeAll(async () => {
    qid = await ask(p.buildMember, { title: "Visibility question" });
  });

  it("another member can't view or reply (not found)", async () => {
    expect(await getQuestionThread(p.buildMember2, qid, t.db)).toBeNull();
    const c = ctx(p.buildMember2);
    await expect(replyToQuestion(c, { questionId: qid, body: "me too" })).rejects.toBeInstanceOf(NotFoundError);
    expect(c.notifier.events).toHaveLength(0);
  });

  it("a leader of another subteam can't view or reply", async () => {
    expect(await getQuestionThread(p.swLead, qid, t.db)).toBeNull();
    await expect(replyToQuestion(ctx(p.swLead), { questionId: qid, body: "hi" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(replyToQuestion(ctx(p.bizLead), { questionId: qid, body: "hi" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the subteam's leader can view and reply → ANSWERED + question.replied", async () => {
    const thread = await getQuestionThread(p.buildLead2, qid, t.db);
    expect(thread?.permissions.canReply).toBe(true);

    const c = ctx(p.buildLead2, later(30));
    const { replyId } = await replyToQuestion(c, { questionId: qid, body: "  Check the gear mesh.  " });
    const q = await t.db.question.findUniqueOrThrow({ where: { id: qid }, include: { replies: true } });
    expect(q.status).toBe("ANSWERED");
    expect(q.lastActivityAt).toEqual(later(30));
    expect(q.replies).toHaveLength(1);
    expect(q.replies[0]).toMatchObject({ id: replyId, authorId: p.buildLead2.id, body: "Check the gear mesh." });
    expect(c.notifier.events).toEqual([{ type: "question.replied", questionId: qid, replyId }]);
  });

  it("the asker's follow-up makes it OPEN again", async () => {
    const c = ctx(p.buildMember, later(60));
    const { replyId } = await replyToQuestion(c, { questionId: qid, body: "Still slipping." });
    const q = await t.db.question.findUniqueOrThrow({ where: { id: qid } });
    expect(q.status).toBe("OPEN");
    expect(q.lastActivityAt).toEqual(later(60));
    expect(c.notifier.ofType("question.replied")).toEqual([{ type: "question.replied", questionId: qid, replyId }]);
  });

  it.each(["captain", "mentor", "teacher", "admin"] as const)("%s can view and reply", async (who) => {
    expect(await getQuestionThread(p[who], qid, t.db)).not.toBeNull();
    await replyToQuestion(ctx(p[who]), { questionId: qid, body: `Answer from ${who}` });
    expect((await t.db.question.findUniqueOrThrow({ where: { id: qid } })).status).toBe("ANSWERED");
  });

  it("the addressed recipient can view and reply even outside their subteam", async () => {
    const id = await ask(p.buildMember, { to: "person", recipientId: p.swLead.id });
    expect(await getQuestionThread(p.swLead, id, t.db)).not.toBeNull();
    await replyToQuestion(ctx(p.swLead), { questionId: id, body: "Sure" });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).status).toBe("ANSWERED");
    // The asker's subteam leaders can see it too.
    expect(await getQuestionThread(p.buildLead1, id, t.db)).not.toBeNull();
    // A different software person can't.
    expect(await getQuestionThread(p.swMember, id, t.db)).toBeNull();
  });

  it("whole-team questions are visible to all-scope staff only", async () => {
    const id = await ask(p.buildMember, { subteam: "" });
    expect(await getQuestionThread(p.captain, id, t.db)).not.toBeNull();
    expect(await getQuestionThread(p.buildLead1, id, t.db)).toBeNull();
    await expect(replyToQuestion(ctx(p.buildLead1), { questionId: id, body: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a recipient who is no longer staff can view but not reply", async () => {
    const q = await t.db.question.create({
      data: { title: "Old", body: "b", askerId: p.bizMember.id, recipientId: p.buildMember2.id, subteam: "BUSINESS" },
    });
    expect(await getQuestionThread(p.buildMember2, q.id, t.db)).toMatchObject({ permissions: { canReply: false } });
    await expect(replyToQuestion(ctx(p.buildMember2), { questionId: q.id, body: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setQuestionStatus(ctx(p.buildMember2), { questionId: q.id, status: "RESOLVED" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("validates the reply", async () => {
    const e = await catchError(() => replyToQuestion(ctx(p.buildLead1), { questionId: qid, body: "   " }));
    expect(fieldErrorsOf(e).body).toBe("Write a reply first.");
    const e2 = await catchError(() => replyToQuestion(ctx(p.buildLead1), { questionId: qid, body: "x".repeat(5001) }));
    expect(fieldErrorsOf(e2).body).toMatch(/5000/);
    await expect(replyToQuestion(ctx(p.buildLead1), { questionId: "missing", body: "hi" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(replyToQuestion(ctx(p.buildLead1), { body: "hi" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("status transitions", () => {
  it("resolve from OPEN, conflict when already resolved, reopen, conflict when already open", async () => {
    const id = await ask(p.buildMember);
    const c = ctx(p.buildMember, later(5));
    await setQuestionStatus(c, { questionId: id, status: "RESOLVED" });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).status).toBe("RESOLVED");

    await expect(setQuestionStatus(c, { questionId: id, status: "RESOLVED" })).rejects.toBeInstanceOf(ConflictError);

    await setQuestionStatus(ctx(p.buildMember, later(90)), { questionId: id, status: "OPEN" });
    const reopened = await t.db.question.findUniqueOrThrow({ where: { id } });
    expect(reopened.status).toBe("OPEN");
    expect(reopened.lastActivityAt).toEqual(later(90));

    await expect(setQuestionStatus(c, { questionId: id, status: "OPEN" })).rejects.toBeInstanceOf(ConflictError);
    expect(c.notifier.events).toHaveLength(0);
  });

  it("staff can resolve an ANSWERED question and reopen it", async () => {
    const id = await ask(p.buildMember);
    await replyToQuestion(ctx(p.buildLead1), { questionId: id, body: "Done?" });
    const c = ctx(p.buildLead1);
    await setQuestionStatus(c, { questionId: id, status: "RESOLVED" });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).status).toBe("RESOLVED");
    await setQuestionStatus(c, { questionId: id, status: "OPEN" });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
    expect(c.notifier.events).toHaveLength(0);
  });

  it("replying to a resolved question reopens it", async () => {
    const id = await ask(p.buildMember);
    await setQuestionStatus(ctx(p.buildMember), { questionId: id, status: "RESOLVED" });
    await replyToQuestion(ctx(p.buildLead1), { questionId: id, body: "One more thing" });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).status).toBe("ANSWERED");
    await setQuestionStatus(ctx(p.buildMember), { questionId: id, status: "RESOLVED" });
    await replyToQuestion(ctx(p.buildMember), { questionId: id, body: "Actually…" });
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
  });

  it("denies people who can't see the question and rejects bad statuses", async () => {
    const id = await ask(p.buildMember);
    await expect(setQuestionStatus(ctx(p.buildMember2), { questionId: id, status: "RESOLVED" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setQuestionStatus(ctx(p.swLead), { questionId: id, status: "RESOLVED" })).rejects.toBeInstanceOf(NotFoundError);
    const e = await catchError(() => setQuestionStatus(ctx(p.buildMember), { questionId: id, status: "ANSWERED" }));
    expect(fieldErrorsOf(e).status).toBeDefined();
    expect((await t.db.question.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
  });
});

describe("deleteQuestion", () => {
  it("the asker can delete a question without replies", async () => {
    const id = await ask(p.buildMember);
    await deleteQuestion(ctx(p.buildMember), { questionId: id });
    expect(await t.db.question.findUnique({ where: { id } })).toBeNull();
  });

  it("not once someone replied", async () => {
    const id = await ask(p.buildMember);
    await replyToQuestion(ctx(p.buildLead1), { questionId: id, body: "Hi" });
    await expect(deleteQuestion(ctx(p.buildMember), { questionId: id })).rejects.toBeInstanceOf(ConflictError);
    expect(await t.db.question.findUnique({ where: { id } })).not.toBeNull();
  });

  it("staff who aren't the asker can't delete; others get not found", async () => {
    const id = await ask(p.buildMember);
    await expect(deleteQuestion(ctx(p.buildLead1), { questionId: id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteQuestion(ctx(p.captain), { questionId: id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteQuestion(ctx(p.buildMember2), { questionId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteQuestion(ctx(p.swLead), { questionId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteQuestion(ctx(p.buildMember), { questionId: "missing" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await t.db.question.findUnique({ where: { id } })).not.toBeNull();
  });

  it("admins can delete any question, even with replies", async () => {
    const id = await ask(p.buildMember);
    await replyToQuestion(ctx(p.buildLead1), { questionId: id, body: "Hi" });
    await deleteQuestion(ctx(p.admin), { questionId: id });
    expect(await t.db.question.findUnique({ where: { id } })).toBeNull();
    expect(await t.db.questionReply.count({ where: { questionId: id } })).toBe(0);
  });
});

describe("queries", () => {
  // A fresh, isolated set of people so counts are predictable.
  let q: Record<"lead" | "lead2" | "sw" | "cap" | "m1" | "m2" | "swm", Actor>;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const db = t.db;
    q = {
      lead: await makeUser(db, { name: "Q Lead", role: "BUSINESS_LEADER" }),
      lead2: await makeUser(db, { name: "Q Lead Two", role: "BUSINESS_LEADER" }),
      sw: await makeUser(db, { name: "Q Software", role: "SOFTWARE_LEADER" }),
      cap: await makeUser(db, { name: "Q Captain", role: "CAPTAIN" }),
      m1: await makeUser(db, { name: "Q Member One", role: "MEMBER", subteam: "BUSINESS" }),
      m2: await makeUser(db, { name: "Q Member Two", role: "MEMBER", subteam: "BUSINESS" }),
      swm: await makeUser(db, { name: "Q Sw Member", role: "MEMBER", subteam: "SOFTWARE" }),
    };
    const at = (minutes: number) => ctx(q.m1, later(minutes));
    ids.old = (await askQuestion(at(-120), { title: "Old open", body: "b" })).id;
    ids.newer = (await askQuestion(at(-10), { title: "Newer open", body: "b" })).id;
    ids.answered = (await askQuestion(at(-60), { title: "Answered", body: "b" })).id;
    await replyToQuestion(ctx(q.lead2, later(-5)), { questionId: ids.answered, body: "Here you go" });
    ids.resolved = (await askQuestion(at(-200), { title: "Resolved", body: "b" })).id;
    await setQuestionStatus(ctx(q.m1), { questionId: ids.resolved, status: "RESOLVED" });
    ids.m2 = (await askQuestion(ctx(q.m2, later(-30)), { title: "From m2", body: "b" })).id;
    ids.own = (await askQuestion(ctx(q.lead, later(-300)), { title: "Lead's own", body: "b", subteam: "BUSINESS" })).id;
    ids.sw = (await askQuestion(ctx(q.swm, later(-500)), { title: "Software one", body: "b" })).id;
    ids.toLead = (await askQuestion(ctx(q.swm, later(-400)), { title: "Sw to biz lead", body: "b", to: "person", recipientId: q.lead.id, subteam: "SOFTWARE" })).id;
  });

  it("listInbox: scope, excludes own, OPEN oldest-first, counts per status", async () => {
    const inbox = await listInbox(q.lead, { status: "OPEN", page: 1 }, t.db);
    const openIds = inbox.items.map((i) => i.id);
    expect(openIds).not.toContain(ids.own);
    expect(openIds).not.toContain(ids.sw);
    expect(openIds).toContain(ids.toLead);
    // Oldest first among what's in scope.
    const times = inbox.items.map((i) => i.lastActivityAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(openIds.indexOf(ids.old)).toBeLessThan(openIds.indexOf(ids.newer));
    expect(inbox.items.find((i) => i.id === ids.toLead)?.toMe).toBe(true);
    expect(inbox.items.find((i) => i.id === ids.old)).toMatchObject({ asker: { id: q.m1.id, name: "Q Member One" }, replyCount: 0 });

    const businessQuestions = await t.db.question.findMany({
      where: { OR: [{ subteam: "BUSINESS" }, { recipientId: q.lead.id }], askerId: { not: q.lead.id } },
      select: { status: true },
    });
    const expected = { OPEN: 0, ANSWERED: 0, RESOLVED: 0 };
    for (const b of businessQuestions) expected[b.status]++;
    expect(inbox.counts).toMatchObject({ ...expected, all: businessQuestions.length });
    expect(inbox.total).toBe(expected.OPEN);

    const answered = await listInbox(q.lead, { status: "ANSWERED", page: 1 }, t.db);
    expect(answered.items.map((i) => i.id)).toContain(ids.answered);
    expect(answered.items.every((i) => i.status === "ANSWERED")).toBe(true);

    const all = await listInbox(q.lead, { status: "all", page: 1 }, t.db);
    const allTimes = all.items.map((i) => i.lastActivityAt.getTime());
    expect([...allTimes].sort((a, b) => b - a)).toEqual(allTimes);
    expect(all.items.map((i) => i.id)).toContain(ids.resolved);
  });

  it("listInbox: captain sees every subteam except their own; members get nothing", async () => {
    const own = (await askQuestion(ctx(q.cap), { title: "Captain's own", body: "b", to: "person", recipientId: q.sw.id })).id;
    const cap = await listInbox(q.cap, { status: "all", page: 1 }, t.db);
    const capIds = cap.items.map((i) => i.id);
    expect(capIds).toEqual(expect.arrayContaining([ids.sw, ids.old, ids.own]));
    expect(capIds).not.toContain(own);

    const member = await listInbox(q.m1, { status: "all", page: 1 }, t.db);
    expect(member.items).toHaveLength(0);
    expect(member.counts.all).toBe(0);

    const swInbox = await listInbox(q.sw, { status: "OPEN", page: 1 }, t.db);
    expect(swInbox.items.map((i) => i.id)).toEqual(expect.arrayContaining([ids.sw, own]));
    expect(swInbox.items.map((i) => i.id)).not.toContain(ids.old);
  });

  it("listMyQuestions: only mine, newest activity first, with reply info", async () => {
    const mine = await listMyQuestions(q.m1, { page: 1 }, t.db);
    expect(mine.items.map((i) => i.id)).toEqual([ids.answered, ids.newer, ids.old, ids.resolved]);
    const answered = mine.items[0];
    expect(answered).toMatchObject({
      status: "ANSWERED",
      replyCount: 1,
      recipientName: null,
      subteam: "BUSINESS",
      lastReply: { authorName: "Q Lead Two", byMe: false },
    });
    expect(mine.counts).toMatchObject({ OPEN: 2, ANSWERED: 1, RESOLVED: 1, all: 4 });
    expect(mine.total).toBe(4);
    expect(mine.pageCount).toBe(1);

    const filtered = await listMyQuestions(q.m1, { status: "ANSWERED", page: 1 }, t.db);
    expect(filtered.items.map((i) => i.id)).toEqual([ids.answered]);

    const toPerson = await listMyQuestions(q.swm, { page: 1 }, t.db);
    expect(toPerson.items.find((i) => i.id === ids.toLead)?.recipientName).toBe("Q Lead");
  });

  it("getQuestionThread: replies with staff flags and per-viewer permissions", async () => {
    await replyToQuestion(ctx(q.m1, later(1)), { questionId: ids.answered, body: "Thanks! One more?" });
    const asker = await getQuestionThread(q.m1, ids.answered, t.db);
    expect(asker).not.toBeNull();
    expect(asker!.replies.map((r) => [r.author.name, r.isStaff, r.isAsker, r.isMine])).toEqual([
      ["Q Lead Two", true, false, false],
      ["Q Member One", false, true, true],
    ]);
    expect(asker!.permissions).toEqual({ canReply: true, canResolve: true, canReopen: false, canDelete: false });
    expect(asker!.viewer).toEqual({ isAsker: true, isStaff: false });

    const lead = await getQuestionThread(q.lead, ids.answered, t.db);
    expect(lead!.permissions).toEqual({ canReply: true, canResolve: true, canReopen: false, canDelete: false });

    const fresh = await getQuestionThread(q.m1, ids.newer, t.db);
    expect(fresh!.permissions.canDelete).toBe(true);
    const resolved = await getQuestionThread(q.m1, ids.resolved, t.db);
    expect(resolved!.permissions).toMatchObject({ canResolve: false, canReopen: true });

    expect(await getQuestionThread(q.m2, ids.answered, t.db)).toBeNull();
    expect(await getQuestionThread(q.m1, "missing", t.db)).toBeNull();
  });

  it("getQuestionThread: only managers get a manageable task link", async () => {
    const task = await makeTask(t.db, q.lead, { subteam: "BUSINESS", assigneeIds: [q.m1.id] });
    const id = (await askQuestion(ctx(q.m1), { title: "About a task", body: "b", taskId: task.id })).id;
    expect((await getQuestionThread(q.m1, id, t.db))!.task).toEqual({ id: task.id, title: task.title, canManage: false });
    expect((await getQuestionThread(q.lead, id, t.db))!.task).toEqual({ id: task.id, title: task.title, canManage: true });
  });

  it("getRecipientOptions: active staff except me, my subteam leaders first", async () => {
    const groups = await getRecipientOptions(p.buildMember, t.db);
    expect(groups.map((g) => g.key)).toEqual(["subteam", "captain", "mentors", "leaders", "admins"]);
    expect(groups[0].label).toBe("Your subteam leaders");
    const allIds = groups.flatMap((g) => g.options.map((o) => o.id));
    expect(groups[0].options.map((o) => o.id)).toEqual(expect.arrayContaining([p.buildLead1.id, p.buildLead2.id]));
    expect(groups[0].options.every((o) => o.roleLabel === "Build Leader")).toBe(true);
    expect(allIds).toEqual(expect.arrayContaining([p.captain.id, p.mentor.id, p.teacher.id, p.swLead.id, p.bizLead.id, p.admin.id]));
    for (const excluded of [p.buildMember, p.buildMember2, p.swMember, p.pendingLead, p.disabledMentor]) {
      expect(allIds).not.toContain(excluded.id);
    }
    expect(groups.find((g) => g.key === "admins")?.options).toEqual([{ id: p.admin.id, name: "Ada Admin", roleLabel: "Site admin" }]);

    const forLead = await getRecipientOptions(p.buildLead1, t.db);
    const leadIds = forLead.flatMap((g) => g.options.map((o) => o.id));
    expect(leadIds).not.toContain(p.buildLead1.id);
    expect(forLead[0].options.map((o) => o.id)).toContain(p.buildLead2.id);

    const forMentor = await getRecipientOptions(p.mentor, t.db);
    expect(forMentor[0].key).toBe("captain");
    expect(forMentor.flatMap((g) => g.options.map((o) => o.id))).not.toContain(p.mentor.id);
  });

  it("getAskTaskOptions: my assignments from the last 30 days and upcoming", async () => {
    const me = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const upcoming = await makeTask(t.db, p.buildLead1, { title: "Upcoming", dueDate: addDays(TEST_TODAY, 3), assigneeIds: [me.id] });
    const today = await makeTask(t.db, p.buildLead1, { title: "Today", dueDate: TEST_TODAY, assigneeIds: [me.id] });
    const recent = await makeTask(t.db, p.buildLead1, { title: "Recent", dueDate: addDays(TEST_TODAY, -10), assigneeIds: [me.id] });
    await makeTask(t.db, p.buildLead1, { title: "Too old", dueDate: addDays(TEST_TODAY, -45), assigneeIds: [me.id] });
    await makeTask(t.db, p.buildLead1, { title: "Someone else's", dueDate: TEST_TODAY, assigneeIds: [p.buildMember2.id] });

    const options = await getAskTaskOptions(me, { today: TEST_TODAY }, t.db);
    expect(options).toEqual([
      { taskId: today.id, title: "Today", dueDate: TEST_TODAY, upcoming: true },
      { taskId: upcoming.id, title: "Upcoming", dueDate: addDays(TEST_TODAY, 3), upcoming: true },
      { taskId: recent.id, title: "Recent", dueDate: addDays(TEST_TODAY, -10), upcoming: false },
    ]);
  });
});

// These run last and clean up after themselves: they create many questions, which would otherwise
// push older ones off the first page of the inbox queries above.

describe("inbox order", () => {
  it("an asker's follow-up on a question that's still open keeps its place in the Open queue", async () => {
    const first = await makeUser(t.db, { name: "Early Asker", role: "MEMBER", subteam: "SOFTWARE" });
    const second = await makeUser(t.db, { name: "Later Asker", role: "MEMBER", subteam: "SOFTWARE" });
    const a = (await askQuestion(ctx(first, later(-600)), { title: "Asked first", body: "b" })).id;
    const b = (await askQuestion(ctx(second, later(-590)), { title: "Asked second", body: "b" })).id;
    const openOrder = async () => (await listInbox(p.swLead, { status: "OPEN" }, t.db)).items.map((i) => i.id);
    const question = (id: string) => t.db.question.findUniqueOrThrow({ where: { id }, select: { status: true, lastActivityAt: true } });

    // More detail while nobody has answered yet: still OPEN, still waiting since it was asked, leaders still notified.
    const c = ctx(first, later(-580));
    const { replyId } = await replyToQuestion(c, { questionId: a, body: "More detail" });
    expect(await question(a)).toEqual({ status: "OPEN", lastActivityAt: later(-600) });
    expect(c.notifier.events).toEqual([{ type: "question.replied", questionId: a, replyId }]);
    let order = await openOrder();
    expect(order).toContain(a);
    expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));

    // A staff answer is fresh activity…
    await replyToQuestion(ctx(p.swLead, later(-570)), { questionId: a, body: "Try this" });
    expect(await question(a)).toEqual({ status: "ANSWERED", lastActivityAt: later(-570) });

    // …and so is the follow-up that puts it back in the queue (it starts waiting again from here).
    await replyToQuestion(ctx(first, later(-560)), { questionId: a, body: "Didn't work" });
    expect(await question(a)).toEqual({ status: "OPEN", lastActivityAt: later(-560) });
    order = await openOrder();
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(a));

    // Further detail while it waits doesn't push it back again.
    await replyToQuestion(ctx(first, later(-550)), { questionId: a, body: "Here's a photo" });
    expect(await question(a)).toEqual({ status: "OPEN", lastActivityAt: later(-560) });

    // Replying to a resolved question reopens it, which counts as fresh activity.
    await setQuestionStatus(ctx(first, later(-540)), { questionId: a, status: "RESOLVED" });
    await replyToQuestion(ctx(first, later(-530)), { questionId: a, body: "It came back" });
    expect(await question(a)).toEqual({ status: "OPEN", lastActivityAt: later(-530) });

    await t.db.question.deleteMany({ where: { id: { in: [a, b] } } });
  });
});

describe("rate limits", () => {
  it("askQuestion: 20 questions per person per hour; invalid attempts don't count", async () => {
    const me = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE" });
    const other = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE" });
    const { limit } = QUESTION_RATE_LIMITS.ask;
    expect(limit).toBe(20);

    // Fixing a mistake doesn't use up the allowance.
    await expect(askQuestion(ctx(me), { title: "", body: "b" })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      askQuestion(ctx(me), { title: "Q", body: "b", to: "person", recipientId: p.buildMember2.id }),
    ).rejects.toBeInstanceOf(ValidationError);

    for (let i = 0; i < limit; i++) await askQuestion(ctx(me, later(i)), { title: `Question ${i}`, body: "b" });

    const c = ctx(me, later(30));
    const e = await catchError(() => askQuestion(c, { title: "One too many", body: "b" }));
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).userMessage).toMatch(/questions in the last hour/);
    expect(c.notifier.events).toHaveLength(0);
    expect(await t.db.question.count({ where: { askerId: me.id } })).toBe(limit);

    // The limit is per person…
    await askQuestion(ctx(other, later(30)), { title: "Mine", body: "b" });
    // …and resets after the hour.
    await askQuestion(ctx(me, later(61)), { title: "Next hour", body: "b" });
    expect(await t.db.question.count({ where: { askerId: me.id } })).toBe(limit + 1);

    await t.db.question.deleteMany({ where: { askerId: { in: [me.id, other.id] } } });
  });

  it("replyToQuestion: 60 replies per person per hour", async () => {
    const me = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE" });
    const id = await ask(me);
    const { limit } = QUESTION_RATE_LIMITS.reply;
    expect(limit).toBe(60);

    for (let i = 0; i < limit; i++) await replyToQuestion(ctx(me), { questionId: id, body: `Detail ${i}` });

    const c = ctx(me, later(59));
    const e = await catchError(() => replyToQuestion(c, { questionId: id, body: "One too many" }));
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).userMessage).toMatch(/replies in the last hour/);
    expect(c.notifier.events).toHaveLength(0);
    expect(await t.db.questionReply.count({ where: { questionId: id } })).toBe(limit);

    // Staff answering the same thread have their own allowance.
    await replyToQuestion(ctx(p.swLead, later(59)), { questionId: id, body: "Answer" });
    // The asker can post again once the hour is over.
    await replyToQuestion(ctx(me, later(61)), { questionId: id, body: "Thanks!" });
    expect(await t.db.questionReply.count({ where: { questionId: id } })).toBe(limit + 2);

    await t.db.question.deleteMany({ where: { id } });
  });
});
