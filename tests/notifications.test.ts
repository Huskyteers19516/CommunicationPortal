import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Subteam } from "@/generated/prisma/enums";
import type { Actor } from "@/server/actor";
import type { Db } from "@/server/db";
import type { EmailMessage, EmailTransport } from "@/server/email/transport";
import { type DeliverOptions, deliverNotification } from "@/server/notifications/deliver";
import type { NotificationEvent } from "@/server/notifications/events";
import { cleanSubject, escapeHtml, excerpt, EXCERPT_MAX } from "@/server/notifications/templates";
import { createTestDb, type TestDb } from "./helpers/db";
import { makeTask, makeUser, TEST_NOW, TEST_TZ } from "./helpers/factories";

const APP_URL = "https://portal.example.org";
const SETTINGS_FOOTER = `You're getting this because of your notification settings. Change them at ${APP_URL}/settings`;

let t: TestDb;
let p: Record<
  | "admin"
  | "adminNoSignup"
  | "adminDisabled"
  | "captain"
  | "captainQuiet"
  | "captainDisabled"
  | "mentor"
  | "mentorDisabled"
  | "mentorQuiet"
  | "swLead"
  | "buildLead1"
  | "buildLead2"
  | "buildLeadQuiet"
  | "buildLeadPending"
  | "buildLeadDisabled"
  | "bizLeadPending"
  | "maya"
  | "swMember",
  Actor
>;

function fakeTransport() {
  const sent: EmailMessage[] = [];
  const transport: EmailTransport = {
    name: "fake",
    send: async (m) => {
      sent.push(m);
    },
  };
  return { sent, transport };
}

const throwingTransport: EmailTransport = {
  name: "broken",
  send: async () => {
    throw new Error("SMTP down");
  },
};

/** Deliver with a recording transport and return what was "sent". */
async function run(event: NotificationEvent, options: DeliverOptions = {}): Promise<EmailMessage[]> {
  const { sent, transport } = fakeTransport();
  await deliverNotification(t.db, event, { transport, appUrl: APP_URL, teamTimezone: TEST_TZ, now: TEST_NOW, ...options });
  return sent;
}

const recipients = (sent: EmailMessage[]) => sent.map((m) => m.to).sort();
const emailsOf = (...people: Actor[]) => people.map((u) => u.email).sort();

async function makeQuestion(
  db: Db,
  asker: Actor,
  data: { subteam?: Subteam | null; recipientId?: string | null; title?: string; body?: string; taskId?: string } = {},
) {
  return db.question.create({
    data: {
      title: data.title ?? "How do I tune the PID?",
      body: data.body ?? "The arm oscillates when it reaches the top.",
      askerId: asker.id,
      subteam: data.subteam === undefined ? asker.subteam : data.subteam,
      recipientId: data.recipientId ?? null,
      taskId: data.taskId ?? null,
    },
  });
}

let clock = Date.parse("2026-09-24T10:00:00Z");
async function makeReply(questionId: string, author: Actor, body = "Try lowering kP first.") {
  clock += 60_000;
  return t.db.questionReply.create({ data: { questionId, authorId: author.id, body, createdAt: new Date(clock) } });
}

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    admin: await makeUser(db, { name: "Ada Admin", role: "MEMBER", subteam: "BUSINESS", isAdmin: true }),
    adminNoSignup: await makeUser(db, { role: "MENTOR", isAdmin: true, prefs: { emailOnSignup: false } }),
    adminDisabled: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true, status: "DISABLED" }),
    captain: await makeUser(db, { name: "Casey Captain", role: "CAPTAIN" }),
    captainQuiet: await makeUser(db, { role: "CAPTAIN", prefs: { emailOnQuestion: false } }),
    captainDisabled: await makeUser(db, { role: "CAPTAIN", status: "DISABLED" }),
    mentor: await makeUser(db, { name: "Morgan Mentor", role: "MENTOR" }),
    mentorDisabled: await makeUser(db, { role: "MENTOR", status: "DISABLED" }),
    mentorQuiet: await makeUser(db, { role: "MENTOR", prefs: { emailOnQuestion: false } }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER" }),
    buildLead1: await makeUser(db, { name: "Alex Kim", role: "BUILD_LEADER" }),
    buildLead2: await makeUser(db, { name: "Blair Build", role: "BUILD_LEADER" }),
    buildLeadQuiet: await makeUser(db, { role: "BUILD_LEADER", prefs: { emailOnQuestion: false } }),
    buildLeadPending: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING" }),
    buildLeadDisabled: await makeUser(db, { role: "BUILD_LEADER", status: "DISABLED" }),
    bizLeadPending: await makeUser(db, { role: "BUSINESS_LEADER", status: "PENDING" }),
    maya: await makeUser(db, { name: "Maya Chen", role: "MEMBER", subteam: "BUILD" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE" }),
  };
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.emailLog.deleteMany();
});

// ---------------------------------------------------------------------------------------------

describe("template helpers", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>Tom & Jerry</a>`)).toBe(
      "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;Tom &amp; Jerry&lt;/a&gt;",
    );
  });

  it("collapses newlines and control characters in subjects", () => {
    expect(cleanSubject("Hello\r\nBcc: evil@example.com\t\u0000 end")).toBe("Hello Bcc: evil@example.com end");
    expect(cleanSubject("a b")).toBe("a b");
    expect(Array.from(cleanSubject("x".repeat(500))).length).toBeLessThanOrEqual(180);
  });

  it("caps excerpts at 500 characters and tidies whitespace", () => {
    const long = "word ".repeat(300);
    const e = excerpt(long);
    expect(Array.from(e).length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(e.endsWith("…")).toBe(true);
    expect(excerpt("line 1\r\n\r\n\r\n\r\nline 2  ")).toBe("line 1\n\nline 2");
  });
});

// ---------------------------------------------------------------------------------------------

describe("question.asked", () => {
  it("goes only to the addressed person when recipientId is set", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", recipientId: p.mentor.id });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(recipients(sent)).toEqual(emailsOf(p.mentor));
    expect(sent[0].text).toContain("asked you a question");
  });

  it("goes to ACTIVE leaders of the subteam who want question emails", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    const sent = await run({ type: "question.asked", questionId: q.id });
    // Not the opted-out, pending, or disabled build leaders; not captains or other subteams.
    expect(recipients(sent)).toEqual(emailsOf(p.buildLead1, p.buildLead2));
  });

  it("goes to ACTIVE captains for whole-team questions", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: null });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(recipients(sent)).toEqual(emailsOf(p.captain));
    expect(sent[0].text).toContain("for the whole team");
  });

  it("falls back to captains when the subteam has no ACTIVE leader yet", async () => {
    const bizMember = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS" });
    const q = await makeQuestion(t.db, bizMember, { subteam: "BUSINESS" });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(recipients(sent)).toEqual(emailsOf(p.captain));
  });

  it("falls back to the subteam when the addressed person is no longer active", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", recipientId: p.mentorDisabled.id });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(recipients(sent)).toEqual(emailsOf(p.buildLead1, p.buildLead2));
  });

  it("never emails the asker (a leader asking their own subteam)", async () => {
    const q = await makeQuestion(t.db, p.buildLead1, { subteam: "BUILD" });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(recipients(sent)).toEqual(emailsOf(p.buildLead2));
  });

  it("falls back to captains when the asker is the subteam's only leader", async () => {
    const q = await makeQuestion(t.db, p.swLead, { subteam: "SOFTWARE" });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(recipients(sent)).toEqual(emailsOf(p.captain));
  });

  it("respects an opted-out recipient (and does not fall back to someone else)", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", recipientId: p.mentorQuiet.id });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(sent).toEqual([]);
    expect(await t.db.emailLog.count()).toBe(0);
  });

  it("renders the subject, an excerpt of the question, one link, and the settings footer", async () => {
    const task = await makeTask(t.db, p.buildLead1, { title: "Wire the drivetrain", assigneeIds: [p.maya.id] });
    const body = `Start. ${"x".repeat(900)} SECRET-END`;
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", recipientId: p.buildLead1.id, body, taskId: task.id });
    const [m] = await run({ type: "question.asked", questionId: q.id });
    expect(m.subject).toBe("New question from Maya Chen: How do I tune the PID?");
    expect(m.kind).toBe("question.asked");
    expect(m.text).toContain("Maya Chen (Build member) asked you a question.");
    expect(m.text).toContain("About task: Wire the drivetrain");
    expect(m.text).toContain("Start.");
    expect(m.text).not.toContain("SECRET-END");
    expect(m.html).not.toContain("SECRET-END");
    expect(m.text).toContain(`${APP_URL}/questions/${q.id}`);
    expect(m.html).toContain(`href="${APP_URL}/questions/${q.id}"`);
    expect(m.text).toContain(SETTINGS_FOOTER);
    expect(m.html).toContain(`${APP_URL}/settings`);
    // Brand frame
    expect(m.html).toContain("THE HUSKYTEERS &middot; 19516");
    // White text sits on the darker brand green (#3A8543, 4.55:1); #4CA256 is only a thin accent.
    expect(m.html).toContain('bgcolor="#3A8543"');
    expect(m.html).not.toContain('bgcolor="#4CA256"');
    expect(m.html).not.toContain("background-color:#4CA256");
    expect(m.html).toContain("max-width:560px");
  });

  it("does nothing when the question was deleted", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    await t.db.question.delete({ where: { id: q.id } });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(sent).toEqual([]);
    expect(await t.db.emailLog.count()).toBe(0);
  });
});

describe("question.asked fallbacks without a captain", () => {
  let t2: TestDb;
  beforeAll(async () => {
    t2 = await createTestDb();
  });
  afterAll(async () => {
    await t2.drop();
  });

  it("falls back to ACTIVE admins, then to nobody", async () => {
    const asker = await makeUser(t2.db, { role: "MEMBER", subteam: "BUILD" });
    await makeUser(t2.db, { role: "CAPTAIN", status: "PENDING" });
    await makeUser(t2.db, { role: "BUILD_LEADER", status: "PENDING" });
    const q = await makeQuestion(t2.db, asker, { subteam: "BUILD" });
    const run2 = async () => {
      const { sent, transport } = fakeTransport();
      await deliverNotification(t2.db, { type: "question.asked", questionId: q.id }, { transport, appUrl: APP_URL });
      return sent;
    };

    // Nobody to tell: no crash, no email.
    expect(await run2()).toEqual([]);

    const admin = await makeUser(t2.db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true });
    await makeUser(t2.db, { role: "MENTOR", isAdmin: true, status: "DISABLED" });
    expect(recipients(await run2())).toEqual(emailsOf(admin));
  });
});

// ---------------------------------------------------------------------------------------------

describe("question.replied", () => {
  it("emails the asker when staff reply", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    const r = await makeReply(q.id, p.captain, "Lower kP.\nThen raise kD slowly.");
    const sent = await run({ type: "question.replied", questionId: q.id, replyId: r.id });
    expect(recipients(sent)).toEqual(emailsOf(p.maya));
    expect(sent[0].subject).toBe("Casey Captain replied: How do I tune the PID?");
    expect(sent[0].text).toContain("> Lower kP.\n> Then raise kD slowly.");
    expect(sent[0].text).toContain(`${APP_URL}/questions/${q.id}`);
    expect(sent[0].kind).toBe("question.replied");
  });

  it("skips the asker when they opted out of reply emails or are no longer active", async () => {
    const quiet = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", prefs: { emailOnReply: false } });
    const q1 = await makeQuestion(t.db, quiet, { subteam: "BUILD" });
    const r1 = await makeReply(q1.id, p.buildLead1);
    expect(await run({ type: "question.replied", questionId: q1.id, replyId: r1.id })).toEqual([]);

    const gone = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const q2 = await makeQuestion(t.db, gone, { subteam: "BUILD" });
    const r2 = await makeReply(q2.id, p.buildLead1);
    await t.db.user.update({ where: { id: gone.id }, data: { status: "DISABLED" } });
    expect(await run({ type: "question.replied", questionId: q2.id, replyId: r2.id })).toEqual([]);
  });

  it("emails the staff side plus earlier staff repliers when the asker follows up — once each", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    await makeReply(q.id, p.captain);
    await makeReply(q.id, p.buildLead1); // also a build leader: must be emailed only once
    await makeReply(q.id, p.mentorQuiet); // replied earlier but opted out of question emails
    await makeReply(q.id, p.maya, "Thanks! What about kI?");
    const followUp = await makeReply(q.id, p.maya, "Still oscillating.");
    // A later staff reply is not an "earlier replier" of this follow-up.
    await makeReply(q.id, p.mentor);

    const sent = await run({ type: "question.replied", questionId: q.id, replyId: followUp.id });
    expect(recipients(sent)).toEqual(emailsOf(p.buildLead1, p.buildLead2, p.captain));
    expect(sent.find((m) => m.to === p.captain.email)?.subject).toBe("Maya Chen followed up: How do I tune the PID?");
  });

  it("goes to the addressed person and earlier repliers, never the asker", async () => {
    const q = await makeQuestion(t.db, p.buildLead1, { subteam: "BUILD", recipientId: p.mentor.id });
    await makeReply(q.id, p.buildLead2);
    const followUp = await makeReply(q.id, p.buildLead1, "Any update?");
    const sent = await run({ type: "question.replied", questionId: q.id, replyId: followUp.id });
    expect(recipients(sent)).toEqual(emailsOf(p.mentor, p.buildLead2));
  });

  it("skips earlier repliers who can no longer see the question or are inactive", async () => {
    const exLead = await makeUser(t.db, { role: "BUILD_LEADER" });
    const leftTeam = await makeUser(t.db, { role: "BUILD_LEADER" });
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", recipientId: p.buildLead2.id });
    await makeReply(q.id, exLead);
    await makeReply(q.id, leftTeam);
    // exLead stepped down to a Software member (can't see Build questions); leftTeam was disabled.
    await t.db.user.update({ where: { id: exLead.id }, data: { role: "MEMBER", subteam: "SOFTWARE" } });
    await t.db.user.update({ where: { id: leftTeam.id }, data: { status: "DISABLED" } });
    const followUp = await makeReply(q.id, p.maya);
    const sent = await run({ type: "question.replied", questionId: q.id, replyId: followUp.id });
    expect(recipients(sent)).toEqual(emailsOf(p.buildLead2));
  });

  it("does nothing when the reply was deleted or belongs to another question", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    const other = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    const r = await makeReply(q.id, p.captain);
    expect(await run({ type: "question.replied", questionId: other.id, replyId: r.id })).toEqual([]);
    await t.db.questionReply.delete({ where: { id: r.id } });
    expect(await run({ type: "question.replied", questionId: q.id, replyId: r.id })).toEqual([]);
    expect(await t.db.emailLog.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

describe("task.submitted", () => {
  async function submitted(creator: Actor, assignee: Actor, note: string | null = "Zip-tied all the wires.") {
    const task = await makeTask(t.db, creator, {
      title: "Wire the drivetrain",
      subteam: "BUILD",
      dueDate: "2026-09-26",
      assigneeIds: [assignee.id],
    });
    const a = task.assignments[0];
    await t.db.taskAssignment.update({
      where: { id: a.id },
      data: { status: "SUBMITTED", submittedAt: TEST_NOW, submissionNote: note },
    });
    return { task, assignmentId: a.id };
  }

  it("emails the task creator with the note and a review link", async () => {
    const { task, assignmentId } = await submitted(p.buildLead1, p.maya);
    const sent = await run({ type: "task.submitted", assignmentId });
    expect(recipients(sent)).toEqual(emailsOf(p.buildLead1));
    const [m] = sent;
    expect(m.subject).toBe("Maya Chen checked off “Wire the drivetrain”");
    expect(m.text).toContain("Zip-tied all the wires.");
    expect(m.text).toContain("Due: Sat, Sep 26");
    expect(m.text).toContain(`${APP_URL}/manage/tasks/${task.id}`);
    expect(m.html).toContain(`href="${APP_URL}/manage/tasks/${task.id}"`);
    expect(m.text).toContain(SETTINGS_FOOTER);
  });

  it("respects the creator's emailOnSubmission preference", async () => {
    const quietLead = await makeUser(t.db, {
      role: "BUILD_LEADER",
      prefs: { emailOnSubmission: false, emailOnQuestion: false },
    });
    const { assignmentId } = await submitted(quietLead, p.maya);
    expect(await run({ type: "task.submitted", assignmentId })).toEqual([]);
  });

  it("tells nobody when all-scope staff check off their own item (they can approve it themselves)", async () => {
    const own = await submitted(p.captain, p.captain);
    expect(await run({ type: "task.submitted", assignmentId: own.assignmentId })).toEqual([]);
  });

  it("does nothing if the submission was withdrawn or deleted", async () => {
    const { task, assignmentId } = await submitted(p.buildLead1, p.maya);
    await t.db.taskAssignment.update({ where: { id: assignmentId }, data: { status: "TODO", submittedAt: null } });
    expect(await run({ type: "task.submitted", assignmentId })).toEqual([]);
    await t.db.task.delete({ where: { id: task.id } });
    expect(await run({ type: "task.submitted", assignmentId })).toEqual([]);
    expect(await t.db.emailLog.count()).toBe(0);
  });
});

describe("task.submitted reviewers when the creator can't review it", () => {
  let t3: TestDb;
  let q: Record<
    | "admin"
    | "captain"
    | "mentor"
    | "buildA"
    | "buildB"
    | "buildQuiet"
    | "buildDisabled"
    | "swLead"
    | "maya"
    | "swMember",
    Actor
  >;

  beforeAll(async () => {
    t3 = await createTestDb();
    const db = t3.db;
    q = {
      admin: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true }),
      captain: await makeUser(db, { role: "CAPTAIN" }),
      mentor: await makeUser(db, { role: "MENTOR" }),
      buildA: await makeUser(db, { name: "Alex Build", role: "BUILD_LEADER" }),
      buildB: await makeUser(db, { name: "Blair Build", role: "BUILD_LEADER" }),
      buildQuiet: await makeUser(db, { role: "BUILD_LEADER", prefs: { emailOnSubmission: false } }),
      buildDisabled: await makeUser(db, { role: "BUILD_LEADER", status: "DISABLED" }),
      swLead: await makeUser(db, { role: "SOFTWARE_LEADER" }),
      maya: await makeUser(db, { name: "Maya Chen", role: "MEMBER", subteam: "BUILD" }),
      swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE" }),
    };
  });
  afterAll(async () => {
    await t3.drop();
  });

  async function deliver(event: NotificationEvent): Promise<EmailMessage[]> {
    const { sent, transport } = fakeTransport();
    await deliverNotification(t3.db, event, { transport, appUrl: APP_URL, teamTimezone: TEST_TZ, now: TEST_NOW });
    return sent;
  }

  /** `creator` makes a task for `assignee`, who checks it off. Returns the event to deliver. */
  async function checkedOff(creator: Actor, assignee: Actor, subteam: Subteam | null) {
    const task = await makeTask(t3.db, creator, { title: "Log shop hours", subteam, assigneeIds: [assignee.id] });
    const a = task.assignments[0];
    await t3.db.taskAssignment.update({ where: { id: a.id }, data: { status: "SUBMITTED", submittedAt: TEST_NOW } });
    return { task, event: { type: "task.submitted", assignmentId: a.id } as const };
  }

  async function setUser(u: Actor, data: { status?: "ACTIVE" | "DISABLED"; role?: "MEMBER" }) {
    await t3.db.user.update({ where: { id: u.id }, data });
  }

  it("only emails the creator when they can review it, not every leader of the subteam", async () => {
    const byCaptain = await checkedOff(q.captain, q.maya, "BUILD");
    expect(recipients(await deliver(byCaptain.event))).toEqual(emailsOf(q.captain));

    const byLeader = await checkedOff(q.buildA, q.maya, "BUILD");
    expect(recipients(await deliver(byLeader.event))).toEqual(emailsOf(q.buildA));

    // Whole-team task: the creator (a mentor) reviews it; the member's subteam leaders aren't spammed.
    const wholeTeam = await checkedOff(q.mentor, q.maya, null);
    expect(recipients(await deliver(wholeTeam.event))).toEqual(emailsOf(q.mentor));
  });

  it("falls back to the subteam's ACTIVE leaders (with emails on) when the creator was disabled", async () => {
    const leaving = await makeUser(t3.db, { role: "BUILD_LEADER" });
    const { task, event } = await checkedOff(leaving, q.maya, "BUILD");
    await setUser(leaving, { status: "DISABLED" });
    const sent = await deliver(event);
    expect(recipients(sent)).toEqual(emailsOf(q.buildA, q.buildB));
    for (const m of sent) {
      expect(m.subject).toBe("Maya Chen checked off “Log shop hours”");
      expect(m.text).toContain(`${APP_URL}/manage/tasks/${task.id}`);
    }
  });

  it("falls back to the subteam's leaders when the creator stepped down to member", async () => {
    const steppedDown = await makeUser(t3.db, { role: "BUILD_LEADER" });
    const { event } = await checkedOff(steppedDown, q.maya, "BUILD");
    await setUser(steppedDown, { role: "MEMBER" });
    expect(recipients(await deliver(event))).toEqual(emailsOf(q.buildA, q.buildB));
  });

  it("asks the other leaders when a leader checks off their own item (they can't approve it)", async () => {
    const { event } = await checkedOff(q.buildA, q.buildA, "BUILD");
    expect(recipients(await deliver(event))).toEqual(emailsOf(q.buildB));
  });

  it("falls back to captains when the subteam has no other ACTIVE leader", async () => {
    const formerSw = await makeUser(t3.db, { role: "SOFTWARE_LEADER" });
    const { event } = await checkedOff(formerSw, q.swMember, "SOFTWARE");
    await setUser(formerSw, { status: "DISABLED" });
    await setUser(q.swLead, { status: "DISABLED" });
    try {
      expect(recipients(await deliver(event))).toEqual(emailsOf(q.captain));
    } finally {
      await setUser(q.swLead, { status: "ACTIVE" });
    }
  });

  it("falls back to admins when there is no leader and no ACTIVE captain", async () => {
    const formerBiz = await makeUser(t3.db, { role: "BUSINESS_LEADER" });
    const bizMember = await makeUser(t3.db, { role: "MEMBER", subteam: "BUSINESS" });
    const { event } = await checkedOff(formerBiz, bizMember, "BUSINESS");
    await setUser(formerBiz, { status: "DISABLED" });
    await setUser(q.captain, { status: "DISABLED" });
    try {
      expect(recipients(await deliver(event))).toEqual(emailsOf(q.admin));
    } finally {
      await setUser(q.captain, { status: "ACTIVE" });
    }
  });

  it("whole-team task: falls back to the submitter's own subteam leaders, linking to the Review queue", async () => {
    const formerMentor = await makeUser(t3.db, { role: "MENTOR" });
    const build = await checkedOff(formerMentor, q.maya, null);
    const software = await checkedOff(formerMentor, q.swMember, null);
    const mentorsItem = await checkedOff(formerMentor, q.mentor, null);
    await setUser(formerMentor, { status: "DISABLED" });

    const sent = await deliver(build.event);
    expect(recipients(sent)).toEqual(emailsOf(q.buildA, q.buildB));
    for (const m of sent) {
      // Subteam leaders review their members' whole-team items but can't open the task page.
      expect(m.text).toContain(`${APP_URL}/manage/review`);
      expect(m.text).not.toContain(`/manage/tasks/${build.task.id}`);
      expect(m.html).toContain(`href="${APP_URL}/manage/review"`);
    }

    expect(recipients(await deliver(software.event))).toEqual(emailsOf(q.swLead));

    // No subteam (a mentor's own item): captains, who can open the task.
    const toCaptain = await deliver(mentorsItem.event);
    expect(recipients(toCaptain)).toEqual(emailsOf(q.captain));
    expect(toCaptain[0].text).toContain(`${APP_URL}/manage/tasks/${mentorsItem.task.id}`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("task.reviewed", () => {
  async function reviewed(
    reviewer: Actor,
    assignee: Actor,
    status: "APPROVED" | "REJECTED" | "TODO",
    note: string | null = null,
  ) {
    const task = await makeTask(t.db, reviewer, { title: "Wire the drivetrain", subteam: "BUILD", assigneeIds: [assignee.id] });
    const a = task.assignments[0];
    await t.db.taskAssignment.update({
      where: { id: a.id },
      data: { status, reviewedById: reviewer.id, reviewedAt: TEST_NOW, reviewNote: note },
    });
    return a.id;
  }

  it("tells the assignee their work was approved", async () => {
    const assignmentId = await reviewed(p.buildLead1, p.maya, "APPROVED", "Clean wiring!");
    const sent = await run({ type: "task.reviewed", assignmentId });
    expect(recipients(sent)).toEqual(emailsOf(p.maya));
    expect(sent[0].subject).toBe("Approved: Wire the drivetrain");
    expect(sent[0].text).toContain("Alex Kim approved “Wire the drivetrain”");
    expect(sent[0].text).toContain("Clean wiring!");
    expect(sent[0].text).toContain(`${APP_URL}/today`);
    expect(sent[0].html).toContain(`href="${APP_URL}/today"`);
  });

  it("sends back the reviewer's note when changes are requested", async () => {
    const assignmentId = await reviewed(p.buildLead1, p.maya, "REJECTED", "Label both motor cables.");
    const [m] = await run({ type: "task.reviewed", assignmentId });
    expect(m.subject).toBe("Changes requested: Wire the drivetrain");
    expect(m.text).toContain("Label both motor cables.");
    expect(m.html).toContain("Label both motor cables.");
    expect(m.text).toContain("check it off again");
  });

  it("respects emailOnReview and skips inactive assignees and self-reviews", async () => {
    const quiet = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", prefs: { emailOnReview: false } });
    expect(await run({ type: "task.reviewed", assignmentId: await reviewed(p.buildLead1, quiet, "APPROVED") })).toEqual([]);

    const disabled = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
    expect(await run({ type: "task.reviewed", assignmentId: await reviewed(p.buildLead1, disabled, "APPROVED") })).toEqual([]);

    // Captains may approve their own item; they don't need an email about it.
    expect(await run({ type: "task.reviewed", assignmentId: await reviewed(p.captain, p.captain, "APPROVED") })).toEqual([]);
  });

  it("does nothing if the item was reopened or deleted since the review", async () => {
    const assignmentId = await reviewed(p.buildLead1, p.maya, "TODO", "Old note");
    expect(await run({ type: "task.reviewed", assignmentId })).toEqual([]);
    await t.db.taskAssignment.delete({ where: { id: assignmentId } });
    expect(await run({ type: "task.reviewed", assignmentId })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("task.assigned", () => {
  it("emails opted-in ACTIVE assignees except the creator (no actorId), once each", async () => {
    const creator = await makeUser(t.db, { name: "Casey Two", role: "MENTOR", prefs: { emailOnAssigned: true } });
    const keen = await makeUser(t.db, { name: "Kai Keen", role: "MEMBER", subteam: "BUILD", prefs: { emailOnAssigned: true } });
    const defaultPrefs = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" }); // emailOnAssigned defaults to off
    const disabled = await makeUser(t.db, {
      role: "MEMBER",
      subteam: "BUILD",
      status: "DISABLED",
      prefs: { emailOnAssigned: true },
    });
    const notAssigned = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", prefs: { emailOnAssigned: true } });
    const task = await makeTask(t.db, creator, {
      title: "Wire the drivetrain",
      description: "Use the 14 AWG wire.\nKeep it tidy.",
      subteam: null,
      priority: "HIGH",
      dueDate: "2026-09-25",
      assigneeIds: [creator.id, keen.id, defaultPrefs.id, disabled.id],
    });

    const sent = await run({
      type: "task.assigned",
      taskId: task.id,
      userIds: [creator.id, keen.id, keen.id, defaultPrefs.id, disabled.id, notAssigned.id],
    });
    expect(recipients(sent)).toEqual(emailsOf(keen));
    const [m] = sent;
    expect(m.subject).toBe("New task: Wire the drivetrain");
    expect(m.text).toContain("Hi Kai,");
    expect(m.text).toContain("Casey Two assigned you “Wire the drivetrain”.");
    expect(m.text).toContain("Due: Fri, Sep 25 (tomorrow)");
    expect(m.text).toContain("Priority: High");
    expect(m.text).toContain("Subteam: Whole team");
    expect(m.text).toContain("> Use the 14 AWG wire.\n> Keep it tidy.");
    expect(m.text).toContain(`${APP_URL}/today`);
    expect(m.kind).toBe("task.assigned");
  });

  it("excludes whoever made the change (actorId), and tells the creator when someone else added them", async () => {
    const creator = await makeUser(t.db, { role: "SOFTWARE_LEADER", prefs: { emailOnAssigned: true } });
    const editor = await makeUser(t.db, { role: "CAPTAIN", prefs: { emailOnAssigned: true } });
    const task = await makeTask(t.db, creator, {
      title: "Update the auto path",
      subteam: "SOFTWARE",
      assigneeIds: [creator.id, editor.id],
    });

    const sent = await run({
      type: "task.assigned",
      taskId: task.id,
      userIds: [creator.id, editor.id],
      actorId: editor.id,
    });
    expect(recipients(sent)).toEqual(emailsOf(creator));
  });

  it("does nothing when the task was deleted", async () => {
    const keen = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", prefs: { emailOnAssigned: true } });
    const task = await makeTask(t.db, p.buildLead1, { assigneeIds: [keen.id] });
    await t.db.task.delete({ where: { id: task.id } });
    expect(await run({ type: "task.assigned", taskId: task.id, userIds: [keen.id] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("account.pending", () => {
  /** Everyone with admin access (owners + leaders, captain, mentors, teachers), ACTIVE, who wants sign-up emails. */
  async function adminAccessEmails(exceptId: string) {
    const rows = await t.db.user.findMany({
      where: {
        status: "ACTIVE",
        emailOnSignup: true,
        id: { not: exceptId },
        OR: [{ isAdmin: true }, { role: { in: ["SOFTWARE_LEADER", "BUILD_LEADER", "BUSINESS_LEADER", "CAPTAIN", "MENTOR", "TEACHER"] } }],
      },
      select: { email: true },
    });
    return rows.map((r) => r.email).sort();
  }

  it("asks everyone with admin access who wants sign-up emails", async () => {
    const sam = await makeUser(t.db, {
      name: "Sam Lee",
      email: "sam.lee@example.com",
      role: "BUILD_LEADER",
      status: "PENDING",
    });
    const sent = await run({ type: "account.pending", userId: sam.id });
    const to = recipients(sent);
    expect(to).toEqual(await adminAccessEmails(sam.id));
    // Owners, leaders, the captain, and mentors — but not members, turned-off, pending, or disabled accounts.
    for (const u of [p.admin, p.captain, p.mentor, p.buildLead1, p.swLead]) expect(to).toContain(u.email);
    for (const u of [p.adminNoSignup, p.adminDisabled, p.captainDisabled, p.buildLeadPending, p.maya, p.swMember]) {
      expect(to).not.toContain(u.email);
    }
    const m = sent.find((x) => x.to === p.admin.email)!;
    expect(m.subject).toBe("Approval needed: Sam Lee signed up as Build Leader");
    expect(m.text).toContain("Email: sam.lee@example.com");
    expect(m.text).toContain("Subteam: Build");
    expect(m.text).toContain(`${APP_URL}/admin`);
    expect(m.text).toContain(SETTINGS_FOOTER);
  });

  it("never emails the new user and does nothing once they are no longer pending", async () => {
    const pendingAdmin = await makeUser(t.db, { role: "MENTOR", status: "PENDING", isAdmin: true });
    const sent = await run({ type: "account.pending", userId: pendingAdmin.id });
    expect(recipients(sent)).toEqual(await adminAccessEmails(pendingAdmin.id));
    expect(recipients(sent)).not.toContain(pendingAdmin.email);

    const approved = await makeUser(t.db, { role: "TEACHER", status: "ACTIVE" });
    expect(await run({ type: "account.pending", userId: approved.id })).toEqual([]);
  });

  it("does nothing when the user was deleted", async () => {
    const gone = await makeUser(t.db, { role: "TEACHER", status: "PENDING" });
    await t.db.user.delete({ where: { id: gone.id } });
    expect(await run({ type: "account.pending", userId: gone.id })).toEqual([]);
  });
});

describe("account.approved", () => {
  it("always welcomes the approved user, ignoring preferences", async () => {
    const sam = await makeUser(t.db, {
      name: "Sam Lee",
      role: "BUILD_LEADER",
      prefs: {
        emailOnQuestion: false,
        emailOnSubmission: false,
        emailOnReply: false,
        emailOnReview: false,
        emailOnAssigned: false,
        emailOnSignup: false,
      },
    });
    const sent = await run({ type: "account.approved", userId: sam.id });
    expect(recipients(sent)).toEqual(emailsOf(sam));
    const [m] = sent;
    expect(m.subject).toBe("You're approved — welcome to the Huskyteers Portal");
    expect(m.text).toContain("Build Leader");
    expect(m.text).toContain(`${APP_URL}/login`);
    expect(m.html).toContain(`href="${APP_URL}/login"`);
    // Not preference-based, so no settings footer.
    expect(m.text).not.toContain("notification settings");
  });

  it("skips accounts that are not active, and deleted users", async () => {
    const disabled = await makeUser(t.db, { role: "MENTOR", status: "DISABLED" });
    expect(await run({ type: "account.approved", userId: disabled.id })).toEqual([]);
    expect(await run({ type: "account.approved", userId: "does-not-exist" })).toEqual([]);
  });
});

describe("password.reset", () => {
  const resetUrl = `${APP_URL}/reset-password?token=abc123`;

  it("always sends the reset link (even with every preference off), including to pending accounts", async () => {
    const quiet = await makeUser(t.db, {
      name: "Quinn Quiet",
      role: "MEMBER",
      subteam: "BUILD",
      prefs: { emailOnReply: false, emailOnReview: false, emailOnQuestion: false },
    });
    const sent = await run({ type: "password.reset", userId: quiet.id, resetUrl });
    expect(recipients(sent)).toEqual(emailsOf(quiet));
    const [m] = sent;
    expect(m.subject).toBe("Reset your Huskyteers Portal password");
    expect(m.text).toContain(`Reset password: ${resetUrl}`);
    expect(m.html).toContain(`href="${escapeHtml(resetUrl)}"`);
    expect(m.text).toContain("This link expires in 1 hour. If you didn't ask for this, ignore this email.");

    const pending = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    expect(recipients(await run({ type: "password.reset", userId: pending.id, resetUrl }))).toEqual(emailsOf(pending));
  });

  it("skips DISABLED accounts and deleted users", async () => {
    const disabled = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
    expect(await run({ type: "password.reset", userId: disabled.id, resetUrl })).toEqual([]);
    expect(await run({ type: "password.reset", userId: "does-not-exist", resetUrl })).toEqual([]);
  });

  it("never links to a non-http URL", async () => {
    const user = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const [m] = await run({ type: "password.reset", userId: user.id, resetUrl: "javascript:alert(1)" });
    expect(m.html).not.toContain("javascript:");
    expect(m.text).not.toContain("javascript:");
    expect(m.html).toContain(`href="${APP_URL}"`);
  });
});

// ---------------------------------------------------------------------------------------------

describe("safety and formatting", () => {
  it("escapes user content in HTML", async () => {
    const evilCreator = await makeUser(t.db, { name: `Eve <img src=x onerror="alert(1)">`, role: "MENTOR" });
    const keen = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", prefs: { emailOnAssigned: true } });
    const task = await makeTask(t.db, evilCreator, {
      title: `<script>alert("x")</script> & <b>bold</b>`,
      description: `<a href="javascript:alert(1)">click</a>`,
      subteam: null,
      assigneeIds: [keen.id],
    });
    const [m] = await run({ type: "task.assigned", taskId: task.id, userIds: [keen.id] });
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<b>bold</b>");
    expect(m.html).not.toContain("<img");
    expect(m.html).not.toContain('<a href="javascript');
    expect(m.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(m.html).toContain("Eve &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    // The plain-text part keeps the text as typed.
    expect(m.text).toContain(`<script>alert("x")</script> & <b>bold</b>`);
  });

  it("strips newlines from subjects so they can't inject headers", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", title: "Help\r\nBcc: attacker@evil.test\nX-Spam: yes" });
    const sent = await run({ type: "question.asked", questionId: q.id });
    expect(sent.length).toBeGreaterThan(0);
    for (const m of sent) {
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.subject).toBe("New question from Maya Chen: Help Bcc: attacker@evil.test X-Spam: yes");
    }
    const log = await t.db.emailLog.findFirst({ where: { kind: "question.asked" } });
    expect(log?.subject).not.toMatch(/[\r\n]/);
  });

  it("builds links from appUrl (trailing slash trimmed) and defaults to env.appUrl", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", recipientId: p.buildLead1.id });
    const [custom] = await run({ type: "question.asked", questionId: q.id }, { appUrl: "https://team.example.com/" });
    expect(custom.text).toContain(`https://team.example.com/questions/${q.id}`);
    expect(custom.text).not.toContain("https://team.example.com//");
    expect(custom.text).toContain("Change them at https://team.example.com/settings");

    const { sent, transport } = fakeTransport();
    await deliverNotification(t.db, { type: "question.asked", questionId: q.id }, { transport });
    expect(sent[0].text).toContain(`http://localhost:3000/questions/${q.id}`); // APP_URL from .env.test
  });

  it("always includes a plain-text part and an HTML part", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    const sent = await run({ type: "question.asked", questionId: q.id });
    for (const m of sent) {
      expect(m.text.length).toBeGreaterThan(50);
      expect(m.text).not.toContain("<");
      expect(m.html.startsWith("<!DOCTYPE html>")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("email log", () => {
  it("records SENT emails with their kind", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    await run({ type: "question.asked", questionId: q.id });
    const logs = await t.db.emailLog.findMany({ orderBy: { to: "asc" } });
    expect(logs.map((l) => l.to)).toEqual(emailsOf(p.buildLead1, p.buildLead2));
    expect(logs.every((l) => l.status === "SENT" && l.kind === "question.asked" && l.error === null)).toBe(true);
    expect(logs[0].subject).toBe("New question from Maya Chen: How do I tune the PID?");
  });

  it("records FAILED with the error for every recipient when the transport throws, without throwing", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      deliverNotification(t.db, { type: "question.asked", questionId: q.id }, { transport: throwingTransport, appUrl: APP_URL }),
    ).resolves.toBeUndefined();
    spy.mockRestore();
    const logs = await t.db.emailLog.findMany();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === "FAILED" && l.error === "SMTP down")).toBe(true);
  });

  it("keeps sending to others when one recipient fails", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD" });
    const sent: string[] = [];
    const flaky: EmailTransport = {
      name: "flaky",
      send: async (m) => {
        if (m.to === p.buildLead1.email) throw new Error("Mailbox full");
        sent.push(m.to);
      },
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await deliverNotification(t.db, { type: "question.asked", questionId: q.id }, { transport: flaky, appUrl: APP_URL });
    spy.mockRestore();
    expect(sent).toEqual([p.buildLead2.email]);
    const logs = await t.db.emailLog.findMany();
    expect(logs.find((l) => l.to === p.buildLead1.email)).toMatchObject({ status: "FAILED", error: "Mailbox full" });
    expect(logs.find((l) => l.to === p.buildLead2.email)).toMatchObject({ status: "SENT", error: null });
  });

  it("records SKIPPED when there is no transport (null, or none configured)", async () => {
    const q = await makeQuestion(t.db, p.maya, { subteam: "BUILD", recipientId: p.buildLead1.id });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await deliverNotification(t.db, { type: "question.asked", questionId: q.id }, { transport: null, appUrl: APP_URL });

    // transport omitted -> getTransport(), which is null when no SMTP/Resend settings exist.
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("RESEND_API_KEY", "");
    await deliverNotification(t.db, { type: "question.asked", questionId: q.id }, { appUrl: APP_URL });
    vi.unstubAllEnvs();
    info.mockRestore();

    const logs = await t.db.emailLog.findMany();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.status === "SKIPPED" && l.to === p.buildLead1.email)).toBe(true);
  });
});

describe("password.changed", () => {
  it("always tells the account owner (ignores prefs), links to the reset page, skips DISABLED", async () => {
    const quiet = await makeUser(t.db, {
      prefs: { emailOnReply: false, emailOnReview: false, emailOnAssigned: false, emailOnQuestion: false, emailOnSubmission: false },
    });
    const [m, ...rest] = await run({ type: "password.changed", userId: quiet.id });
    expect(rest).toEqual([]);
    expect(m.to).toBe(quiet.email);
    expect(m.kind).toBe("password.changed");
    expect(m.subject).toMatch(/password was changed/i);
    expect(m.text).toContain(`${APP_URL}/forgot-password`);
    expect(m.text).not.toContain(SETTINGS_FOOTER);

    const disabled = await makeUser(t.db, { status: "DISABLED" });
    expect(await run({ type: "password.changed", userId: disabled.id })).toEqual([]);
    expect(await run({ type: "password.changed", userId: "does-not-exist" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("resource approvals", () => {
  let r: TestDb;
  let q: Record<
    | "owner"
    | "ownerQuiet"
    | "ownerDisabled"
    | "captain"
    | "captainQuiet"
    | "mentor"
    | "buildLead1"
    | "buildLead2"
    | "buildLeadQuiet"
    | "buildLeadPending"
    | "swLeadQuiet"
    | "bizLeadPending"
    | "maya"
    | "swMember"
    | "bizMember",
    Actor
  >;

  async function runR(event: NotificationEvent, options: DeliverOptions = {}): Promise<EmailMessage[]> {
    const { sent, transport } = fakeTransport();
    await deliverNotification(r.db, event, { transport, appUrl: APP_URL, teamTimezone: TEST_TZ, now: TEST_NOW, ...options });
    return sent;
  }

  async function quiet(user: Actor, prefs: { emailOnResource?: boolean; emailOnReview?: boolean }) {
    await r.db.user.update({ where: { id: user.id }, data: prefs });
    return user;
  }

  async function share(by: Actor, data: { title?: string; url?: string; file?: boolean; status?: "PENDING" | "APPROVED" | "REJECTED" } = {}) {
    return r.db.resource.create({
      data: {
        title: data.title ?? "Intake code",
        description: "Our intake OpMode.\nWorks with the new servo.",
        url: data.file ? "" : (data.url ?? "https://github.com/huskyteers/intake"),
        type: "CODE",
        status: data.status ?? "PENDING",
        createdById: by.id,
        file: data.file
          ? { create: { filename: "Intake.java", contentType: "text/x-java", size: 2048, data: new TextEncoder().encode("class Intake {}") } }
          : undefined,
      },
    });
  }

  beforeAll(async () => {
    r = await createTestDb();
    const db = r.db;
    q = {
      owner: await makeUser(db, { name: "Olivia Owner", role: "MEMBER", subteam: "BUSINESS", isAdmin: true }),
      ownerQuiet: await makeUser(db, { role: "MENTOR", isAdmin: true }),
      ownerDisabled: await makeUser(db, { role: "MENTOR", isAdmin: true, status: "DISABLED" }),
      captain: await makeUser(db, { name: "Casey Captain", role: "CAPTAIN" }),
      captainQuiet: await makeUser(db, { role: "CAPTAIN" }),
      mentor: await makeUser(db, { role: "MENTOR" }),
      buildLead1: await makeUser(db, { name: "Alex Kim", role: "BUILD_LEADER" }),
      buildLead2: await makeUser(db, { role: "BUILD_LEADER" }),
      buildLeadQuiet: await makeUser(db, { role: "BUILD_LEADER" }),
      buildLeadPending: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING" }),
      swLeadQuiet: await makeUser(db, { role: "SOFTWARE_LEADER" }),
      bizLeadPending: await makeUser(db, { role: "BUSINESS_LEADER", status: "PENDING" }),
      maya: await makeUser(db, { name: "Maya Chen", role: "MEMBER", subteam: "BUILD" }),
      swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE" }),
      bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS" }),
    };
    await quiet(q.ownerQuiet, { emailOnResource: false });
    await quiet(q.captainQuiet, { emailOnResource: false });
    await quiet(q.buildLeadQuiet, { emailOnResource: false });
    await quiet(q.swLeadQuiet, { emailOnResource: false });
  });
  afterAll(async () => {
    await r.drop();
  });

  beforeEach(async () => {
    await r.db.emailLog.deleteMany();
  });

  it("resource.submitted asks the owners and the member's subteam leaders who want the email", async () => {
    const res = await share(q.maya, { file: true });
    const sent = await runR({ type: "resource.submitted", resourceId: res.id });
    expect(recipients(sent)).toEqual(emailsOf(q.owner, q.buildLead1, q.buildLead2));
    const m = sent.find((x) => x.to === q.buildLead1.email)!;
    expect(m.kind).toBe("resource.submitted");
    expect(m.subject).toBe("Approval needed: Maya Chen shared “Intake code”");
    expect(m.text).toContain("Hi Alex,");
    expect(m.text).toContain("Maya Chen (Build member) shared “Intake code”");
    expect(m.text).toContain("Type: Code");
    expect(m.text).toContain("File: Intake.java (2.0 KB)");
    expect(m.text).toContain("> Our intake OpMode.\n> Works with the new servo.");
    expect(m.text).toContain(`Review it: ${APP_URL}/resources/${res.id}`);
    expect(m.text).toContain(SETTINGS_FOOTER);
    expect(m.html).toContain(`href="${APP_URL}/resources/${res.id}"`);
  });

  it("falls back to the captains when nobody active leads the subteam, or the member has no subteam", async () => {
    const link = await share(q.bizMember, { url: "https://sponsors.example.com/deck" });
    const sent = await runR({ type: "resource.submitted", resourceId: link.id });
    expect(recipients(sent)).toEqual(emailsOf(q.owner, q.captain));
    expect(sent[0].text).toContain("Link: https://sponsors.example.com/deck");

    const noSubteam = await makeUser(r.db, { role: "MEMBER", subteam: null });
    const other = await share(noSubteam);
    expect(recipients(await runR({ type: "resource.submitted", resourceId: other.id }))).toEqual(emailsOf(q.owner, q.captain));
  });

  it("a leader who turned the email off doesn't push it onto the captains", async () => {
    const res = await share(q.swMember);
    expect(recipients(await runR({ type: "resource.submitted", resourceId: res.id }))).toEqual(emailsOf(q.owner));
  });

  it("never emails the person who shared it, and skips resources that are no longer waiting", async () => {
    const own = await share(q.owner);
    expect(recipients(await runR({ type: "resource.submitted", resourceId: own.id }))).toEqual(emailsOf(q.captain));

    const approved = await share(q.maya, { status: "APPROVED" });
    expect(await runR({ type: "resource.submitted", resourceId: approved.id })).toEqual([]);
    const gone = await share(q.maya);
    await r.db.resource.delete({ where: { id: gone.id } });
    expect(await runR({ type: "resource.submitted", resourceId: gone.id })).toEqual([]);
    const orphan = await share(q.maya);
    await r.db.resource.update({ where: { id: orphan.id }, data: { createdById: null } });
    expect(await runR({ type: "resource.submitted", resourceId: orphan.id })).toEqual([]);
  });

  it("is never posted to Discord", async () => {
    const res = await share(q.maya);
    const calls: string[] = [];
    await runR(
      { type: "resource.submitted", resourceId: res.id },
      { discord: { webhookUrl: "https://discord.com/api/webhooks/1/abc", fetch: async (url) => (calls.push(url), new Response(null, { status: 204 })) } },
    );
    expect(calls).toEqual([]);
  });

  it("resource.reviewed tells the member it was approved, with the reviewer's note", async () => {
    const res = await share(q.maya);
    await r.db.resource.update({
      where: { id: res.id },
      data: { status: "APPROVED", reviewedById: q.buildLead1.id, reviewedAt: TEST_NOW, reviewNote: "Nice, thanks!" },
    });
    const [m, ...rest] = await runR({ type: "resource.reviewed", resourceId: res.id });
    expect(rest).toEqual([]);
    expect(m.to).toBe(q.maya.email);
    expect(m.kind).toBe("resource.reviewed");
    expect(m.subject).toBe("Your resource “Intake code” was approved");
    expect(m.text).toContain("Alex Kim approved “Intake code”");
    expect(m.text).toContain("> Nice, thanks!");
    expect(m.text).toContain(`${APP_URL}/resources/${res.id}`);
    expect(m.text).toContain(SETTINGS_FOOTER);
  });

  it("resource.reviewed explains a turned-down resource", async () => {
    const res = await share(q.maya, { title: "Robot photos" });
    await r.db.resource.update({
      where: { id: res.id },
      data: { status: "REJECTED", reviewedById: q.captain.id, reviewedAt: TEST_NOW, reviewNote: "That folder is private." },
    });
    const [m] = await runR({ type: "resource.reviewed", resourceId: res.id });
    expect(m.subject).toBe("Your resource “Robot photos” was sent back");
    expect(m.text).toContain("Casey Captain looked at “Robot photos” and sent it back to you.");
    expect(m.text).toContain("Why:\n> That folder is private.");
    expect(m.text).toContain("send it again");
  });

  it("resource.reviewed respects emailOnReview and skips stale or self reviews", async () => {
    const res = await share(q.swMember);
    // Sent back for approval again (edited) before the email went out.
    expect(await runR({ type: "resource.reviewed", resourceId: res.id })).toEqual([]);

    await r.db.resource.update({ where: { id: res.id }, data: { status: "APPROVED", reviewedById: q.swMember.id } });
    expect(await runR({ type: "resource.reviewed", resourceId: res.id })).toEqual([]);

    await r.db.resource.update({ where: { id: res.id }, data: { reviewedById: q.captain.id } });
    expect(recipients(await runR({ type: "resource.reviewed", resourceId: res.id }))).toEqual(emailsOf(q.swMember));
    await quiet(q.swMember, { emailOnReview: false });
    expect(await runR({ type: "resource.reviewed", resourceId: res.id })).toEqual([]);

    expect(await runR({ type: "resource.reviewed", resourceId: "does-not-exist" })).toEqual([]);
  });
});
