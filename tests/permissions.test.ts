import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/server/actor";
import {
  canAdminister,
  canAssignTo,
  canCreateTask,
  canCreateWholeTeamTask,
  canDeleteSponsorship,
  canEditPart,
  canGrantRole,
  canManageAccount,
  canManageCategories,
  canManageParts,
  canUseSponsorships,
  canViewEmailLog,
  canWorkOnPart,
  grantableRoles,
  isOwner,
  canManageTask,
  canReviewAssignment,
  canSignUpForTask,
  canViewMemberProgress,
  canViewQuestion,
  hasAllScope,
  isStaff,
} from "@/server/permissions";
import {
  assignableUsersWhere,
  manageableMembersWhere,
  manageableTasksWhere,
  questionInboxWhere,
  reviewQueueWhere,
  visibleQuestionsWhere,
} from "@/server/scopes";
import { canTransition } from "@/server/domain/assignment";
import { createTestDb, type TestDb } from "./helpers/db";
import { makeTask, makeUser } from "./helpers/factories";

let t: TestDb;
let people: Record<string, Actor>;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  people = {
    admin: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true }),
    captain: await makeUser(db, { role: "CAPTAIN" }),
    mentor: await makeUser(db, { role: "MENTOR" }),
    teacher: await makeUser(db, { role: "TEACHER" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER" }),
    buildLead1: await makeUser(db, { role: "BUILD_LEADER" }),
    buildLead2: await makeUser(db, { role: "BUILD_LEADER" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS" }),
    pendingLead: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING" }),
    disabledMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED" }),
  };
  const p = people;
  // Tasks across subteams/creators, each with submitted assignments.
  await makeTask(db, p.swLead, { subteam: "SOFTWARE", assigneeIds: [p.swMember.id] });
  await makeTask(db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id, p.buildLead2.id] });
  await makeTask(db, p.captain, { subteam: null, assigneeIds: [p.swMember.id, p.buildMember.id, p.bizMember.id, p.captain.id] });
  await makeTask(db, p.captain, { subteam: "BUILD", assigneeIds: [p.buildLead1.id] });
  await makeTask(db, p.bizLead, { subteam: "BUSINESS", assigneeIds: [p.bizMember.id, p.bizLead.id] });
  await makeTask(db, p.bizLead, { subteam: null, assigneeIds: [p.swMember.id, p.buildMember.id, p.bizMember.id] });
  // Marked finished ("Just close it"): its submissions leave every review queue.
  await makeTask(db, p.buildLead1, { subteam: "BUILD", assigneeIds: [p.buildMember.id] }).then((task) =>
    db.task.update({ where: { id: task.id }, data: { completedAt: new Date(), completedById: p.buildLead1.id } }),
  );
  await db.taskAssignment.updateMany({ data: { status: "SUBMITTED" } });

  // Questions with every targeting shape.
  const q = (askerId: string, subteam: Actor["subteam"], recipientId: string | null) =>
    db.question.create({ data: { title: "q", body: "b", askerId, subteam, recipientId } });
  await q(p.swMember.id, "SOFTWARE", null);
  await q(p.buildMember.id, "BUILD", p.buildLead2.id);
  await q(p.bizMember.id, "BUSINESS", p.mentor.id);
  await q(p.buildMember.id, null, null);
  await q(p.swLead.id, null, p.captain.id);
  await q(p.buildLead1.id, "BUILD", null);
});

afterAll(async () => {
  await t?.drop();
});

describe("role classification", () => {
  it("staff and all-scope roles", () => {
    expect(isStaff(people.swMember)).toBe(false);
    expect(isStaff(people.swLead)).toBe(true);
    expect(isStaff(people.admin)).toBe(true); // admin even with MEMBER role
    expect(hasAllScope(people.captain)).toBe(true);
    expect(hasAllScope(people.mentor)).toBe(true);
    expect(hasAllScope(people.teacher)).toBe(true);
    expect(hasAllScope(people.buildLead1)).toBe(false);
  });
});

describe("scopes mirror permission functions", () => {
  it("manageableTasksWhere == canManageTask", async () => {
    const tasks = await t.db.task.findMany();
    for (const actor of Object.values(people)) {
      const viaDb = new Set((await t.db.task.findMany({ where: manageableTasksWhere(actor) })).map((x) => x.id));
      const viaFn = new Set(tasks.filter((task) => canManageTask(actor, task)).map((x) => x.id));
      expect([...viaDb].sort(), `actor ${actor.name}`).toEqual([...viaFn].sort());
    }
  });

  it("reviewQueueWhere == canReviewAssignment on SUBMITTED items of tasks that aren't marked finished", async () => {
    const all = await t.db.taskAssignment.findMany({ include: { task: true, user: { select: { subteam: true } } } });
    expect(all.some((a) => a.task.completedAt !== null && a.status === "SUBMITTED")).toBe(true);
    for (const actor of Object.values(people)) {
      const viaDb = new Set((await t.db.taskAssignment.findMany({ where: reviewQueueWhere(actor) })).map((x) => x.id));
      const viaFn = new Set(
        all
          .filter(
            (a) =>
              a.status === "SUBMITTED" &&
              a.task.completedAt === null &&
              canReviewAssignment(actor, a.task, { userId: a.userId, assigneeSubteam: a.user.subteam }),
          )
          .map((x) => x.id),
      );
      expect([...viaDb].sort(), `actor ${actor.name}`).toEqual([...viaFn].sort());
    }
  });

  it("subteam leaders review their own members' items on whole-team tasks, not other subteams'", async () => {
    const wholeTeam = { createdById: people.captain.id, subteam: null };
    expect(canReviewAssignment(people.buildLead1, wholeTeam, { userId: people.buildMember.id, assigneeSubteam: "BUILD" })).toBe(true);
    expect(canReviewAssignment(people.buildLead1, wholeTeam, { userId: people.swMember.id, assigneeSubteam: "SOFTWARE" })).toBe(false);
    expect(canReviewAssignment(people.buildLead1, wholeTeam, { userId: people.buildLead1.id, assigneeSubteam: "BUILD" })).toBe(false);
    // Without the assignee's subteam only the manage rule applies (safe default).
    expect(canReviewAssignment(people.buildLead1, wholeTeam, { userId: people.buildMember.id })).toBe(false);
    expect(canReviewAssignment(people.buildMember, wholeTeam, { userId: people.bizMember.id, assigneeSubteam: "BUSINESS" })).toBe(false);
    const queue = await t.db.taskAssignment.findMany({ where: reviewQueueWhere(people.buildLead1), include: { task: true, user: true } });
    expect(queue.some((a) => a.task.subteam === null && a.user.subteam === "BUILD")).toBe(true);
    expect(queue.every((a) => a.task.subteam !== null || a.user.subteam === "BUILD")).toBe(true);
  });

  it("visibleQuestionsWhere == canViewQuestion, inbox excludes own", async () => {
    const all = await t.db.question.findMany();
    for (const actor of Object.values(people)) {
      const viaDb = new Set((await t.db.question.findMany({ where: visibleQuestionsWhere(actor) })).map((x) => x.id));
      const viaFn = new Set(all.filter((q) => canViewQuestion(actor, q)).map((x) => x.id));
      expect([...viaDb].sort(), `actor ${actor.name}`).toEqual([...viaFn].sort());

      const inbox = await t.db.question.findMany({ where: questionInboxWhere(actor) });
      for (const q of inbox) {
        expect(q.askerId).not.toBe(actor.id);
        expect(canViewQuestion(actor, q)).toBe(true);
      }
      if (!isStaff(actor)) expect(inbox).toHaveLength(0);
    }
  });

  it("assignable/manageable members == canAssignTo / canViewMemberProgress", async () => {
    const users = await t.db.user.findMany();
    for (const actor of Object.values(people)) {
      for (const subteam of ["SOFTWARE", "BUILD", "BUSINESS", null] as const) {
        const assignable = new Set((await t.db.user.findMany({ where: assignableUsersWhere(actor, subteam) })).map((u) => u.id));
        const expected = new Set(users.filter((u) => isStaff(actor) && canAssignTo(actor, u, subteam)).map((u) => u.id));
        expect([...assignable].sort(), `actor ${actor.name}, ${subteam ?? "whole team"}`).toEqual([...expected].sort());
      }

      const visible = new Set((await t.db.user.findMany({ where: manageableMembersWhere(actor) })).map((u) => u.id));
      const expectedVisible = new Set(
        users.filter((u) => isStaff(actor) && u.status === "ACTIVE" && canViewMemberProgress(actor, u)).map((u) => u.id),
      );
      expect([...visible].sort(), `actor ${actor.name}`).toEqual([...expectedVisible].sort());
    }
  });
});

describe("specific rules", () => {
  it("subteam leaders manage only their subteam; whole-team tasks are all-scope only", () => {
    const wholeTeam = { createdById: people.captain.id, subteam: null };
    const build = { createdById: people.captain.id, subteam: "BUILD" as const };
    expect(canManageTask(people.buildLead2, build)).toBe(true);
    expect(canManageTask(people.swLead, build)).toBe(false);
    expect(canManageTask(people.buildLead1, wholeTeam)).toBe(false);
    expect(canManageTask(people.mentor, wholeTeam)).toBe(true);
    expect(canManageTask(people.buildMember, build)).toBe(false);
  });

  it("leaders cannot review their own submission; all-scope staff can", () => {
    const task = { createdById: people.buildLead1.id, subteam: "BUILD" as const };
    expect(canReviewAssignment(people.buildLead1, task, { userId: people.buildLead1.id })).toBe(false);
    expect(canReviewAssignment(people.buildLead2, task, { userId: people.buildLead1.id })).toBe(true);
    expect(canReviewAssignment(people.captain, task, { userId: people.captain.id })).toBe(true);
  });

  it("cannot assign to inactive users or outside own subteam", () => {
    expect(canAssignTo(people.buildLead1, people.buildMember, "BUILD")).toBe(true);
    expect(canAssignTo(people.buildLead1, people.swMember, "BUILD")).toBe(false);
    expect(canAssignTo(people.captain, people.disabledMember, null)).toBe(false);
    expect(canAssignTo(people.captain, people.pendingLead, null)).toBe(false);
  });

  it("the Business leader creates whole-team tasks and puts anyone on them; other subteam leaders don't", () => {
    const p = people;
    const lists = ["SOFTWARE", "BUILD", "BUSINESS", null] as const;
    const creates = (actor: Actor) => lists.filter((s) => canCreateTask(actor, s));
    expect(creates(p.bizLead)).toEqual(["BUSINESS", null]);
    expect(canCreateWholeTeamTask(p.bizLead)).toBe(true);
    for (const who of [p.swLead, p.buildLead1, p.buildLead2]) {
      expect(canCreateWholeTeamTask(who), who.name).toBe(false);
      expect(canCreateTask(who, null), who.name).toBe(false);
    }
    expect(creates(p.swLead)).toEqual(["SOFTWARE"]);
    expect(creates(p.buildLead1)).toEqual(["BUILD"]);
    for (const who of [p.captain, p.mentor, p.teacher, p.admin]) expect(creates(who), who.name).toEqual([...lists]);
    for (const who of [p.swMember, p.buildMember, p.bizMember]) expect(creates(who), who.name).toEqual([]);

    // Whole-team tasks: the Business leader puts anyone ACTIVE on them…
    for (const who of [p.swMember, p.buildMember, p.bizMember, p.captain, p.swLead, p.bizLead]) {
      expect(canAssignTo(p.bizLead, who, null), who.name).toBe(true);
    }
    expect(canAssignTo(p.bizLead, p.disabledMember, null)).toBe(false);
    expect(canAssignTo(p.bizLead, p.pendingLead, null)).toBe(false);
    // …but their Business tasks stay Business-only.
    expect(canAssignTo(p.bizLead, p.bizMember, "BUSINESS")).toBe(true);
    expect(canAssignTo(p.bizLead, p.buildMember, "BUSINESS")).toBe(false);
    expect(canAssignTo(p.bizLead, p.swMember, "BUSINESS")).toBe(false);
    // Other subteam leaders: their own people only, whole-team task or not.
    expect(canAssignTo(p.buildLead1, p.buildMember, null)).toBe(true);
    expect(canAssignTo(p.buildLead1, p.swMember, null)).toBe(false);
    expect(canAssignTo(p.swLead, p.buildMember, null)).toBe(false);
    // They manage (edit, review, finish) the whole-team tasks they created, not the captain's.
    expect(canManageTask(p.bizLead, { createdById: p.bizLead.id, subteam: null })).toBe(true);
    expect(canManageTask(p.bizLead, { createdById: p.captain.id, subteam: null })).toBe(false);
    // Whole-team categories stay with all-scope staff.
    expect(canManageCategories(p.bizLead, null)).toBe(false);
  });

  it("members only see their own questions", () => {
    const other = { askerId: people.bizMember.id, recipientId: null, subteam: "BUILD" as const };
    expect(canViewQuestion(people.buildMember, other)).toBe(false);
    expect(canViewQuestion(people.buildLead2, other)).toBe(true);
    expect(canViewQuestion(people.swLead, other)).toBe(false);
  });

  it("assignment state machine", () => {
    expect(canTransition("TODO", "submit")).toBe(true);
    expect(canTransition("REJECTED", "submit")).toBe(true);
    expect(canTransition("APPROVED", "submit")).toBe(false);
    expect(canTransition("SUBMITTED", "withdraw")).toBe(true);
    expect(canTransition("TODO", "approve")).toBe(false);
    expect(canTransition("SUBMITTED", "approve")).toBe(true);
    expect(canTransition("SUBMITTED", "reject")).toBe(true);
    expect(canTransition("APPROVED", "reopen")).toBe(true);
    expect(canTransition("SUBMITTED", "reopen")).toBe(false);
  });
});

describe("task dashboard rules", () => {
  it("categories: subteam leaders manage their own list; all-scope staff manage every list and the whole-team one", () => {
    const p = people;
    const lists = ["SOFTWARE", "BUILD", "BUSINESS", null] as const;
    const allowed = (actor: Actor) => lists.filter((s) => canManageCategories(actor, s));
    for (const who of [p.captain, p.mentor, p.teacher, p.admin]) expect(allowed(who)).toEqual([...lists]);
    expect(allowed(p.swLead)).toEqual(["SOFTWARE"]);
    expect(allowed(p.buildLead1)).toEqual(["BUILD"]);
    expect(allowed(p.bizLead)).toEqual(["BUSINESS"]);
    for (const who of [p.swMember, p.buildMember, p.bizMember, p.disabledMember]) expect(allowed(who)).toEqual([]);
    // Role-wise a pending leader looks like a leader — services also require an ACTIVE account.
    expect(allowed(p.pendingLead)).toEqual(["BUILD"]);
  });

  it("sign-up: open tasks for your own subteam, or whole-team tasks for anyone — never once it's marked finished", () => {
    const p = people;
    const build = { subteam: "BUILD" as const, signupOpen: true, completedAt: null };
    const team = { subteam: null, signupOpen: true, completedAt: null };
    expect(canSignUpForTask(p.buildMember, build)).toBe(true);
    expect(canSignUpForTask(p.buildLead1, build)).toBe(true);
    expect(canSignUpForTask(p.swMember, build)).toBe(false);
    expect(canSignUpForTask(p.swLead, build)).toBe(false);
    // No subteam (captain, mentors, teachers): only whole-team tasks.
    expect(canSignUpForTask(p.captain, build)).toBe(false);
    expect(canSignUpForTask(p.captain, team)).toBe(true);
    for (const who of Object.values(p)) expect(canSignUpForTask(who, team), who.name).toBe(true);
    for (const who of Object.values(p)) {
      expect(canSignUpForTask(who, { ...build, signupOpen: false }), who.name).toBe(false);
      expect(canSignUpForTask(who, { ...team, signupOpen: false }), who.name).toBe(false);
      expect(canSignUpForTask(who, { ...build, completedAt: new Date() }), who.name).toBe(false);
      expect(canSignUpForTask(who, { ...team, completedAt: new Date() }), who.name).toBe(false);
    }
  });
});

describe("admin access and its guardrails", () => {
  const acct = (a: Actor, over: Partial<{ status: Actor["status"]; isAdmin: boolean }> = {}) => ({
    id: a.id,
    role: a.role,
    status: over.status ?? a.status,
    isAdmin: over.isAdmin ?? a.isAdmin,
  });

  it("every leader, the captain, mentors, teachers, and owners have admin access; members don't", () => {
    const p = people;
    for (const who of [p.admin, p.captain, p.mentor, p.teacher, p.swLead, p.buildLead1, p.bizLead]) expect(canAdminister(who), who.name).toBe(true);
    for (const who of [p.swMember, p.buildMember, p.bizMember]) expect(canAdminister(who), who.name).toBe(false);
    expect(isOwner(p.admin)).toBe(true);
    expect(isOwner(p.captain)).toBe(false);
    expect(canViewEmailLog(p.admin)).toBe(true);
    for (const who of [p.captain, p.mentor, p.buildLead1]) expect(canViewEmailLog(who), who.name).toBe(false);
  });

  it("accounts: leaders manage members and sign-ups up to their rank; captain/mentors/teachers also manage leaders; owners manage everyone", () => {
    const p = people;
    // Build leader
    expect(canManageAccount(p.buildLead1, acct(p.buildMember))).toBe(true);
    expect(canManageAccount(p.buildLead1, acct(p.swMember))).toBe(true);
    expect(canManageAccount(p.buildLead1, acct(p.buildLead2))).toBe(false);
    expect(canManageAccount(p.buildLead1, acct(p.captain))).toBe(false);
    expect(canManageAccount(p.buildLead1, acct(p.pendingLead))).toBe(true); // a waiting leader sign-up
    expect(canManageAccount(p.buildLead1, acct(p.mentor, { status: "PENDING" }))).toBe(false);
    expect(canManageAccount(p.buildLead1, acct(p.buildLead1))).toBe(true); // yourself
    // Captain / mentor / teacher
    for (const who of [p.captain, p.mentor, p.teacher]) {
      expect(canManageAccount(who, acct(p.buildLead2)), who.name).toBe(true);
      expect(canManageAccount(who, acct(p.bizMember)), who.name).toBe(true);
      expect(canManageAccount(who, acct(p.mentor.id === who.id ? p.teacher : p.mentor)), who.name).toBe(false);
      expect(canManageAccount(who, acct(p.admin)), who.name).toBe(false); // an owner
    }
    // Owners: everyone. Members: nobody (not even themselves in Admin).
    for (const target of Object.values(p)) expect(canManageAccount(p.admin, acct(target))).toBe(true);
    expect(canManageAccount(p.buildMember, acct(p.buildMember))).toBe(false);
  });

  it("positions: below your own rank (up to it when approving); owners any", () => {
    const p = people;
    expect(grantableRoles(p.buildLead1)).toEqual(["MEMBER"]);
    expect(grantableRoles(p.buildLead1, { approving: true })).toEqual(["MEMBER", "SOFTWARE_LEADER", "BUILD_LEADER", "BUSINESS_LEADER"]);
    expect(grantableRoles(p.captain)).toEqual(["MEMBER", "SOFTWARE_LEADER", "BUILD_LEADER", "BUSINESS_LEADER"]);
    expect(canGrantRole(p.captain, "MENTOR")).toBe(false);
    expect(canGrantRole(p.captain, "MENTOR", { approving: true })).toBe(true);
    expect(grantableRoles(p.admin)).toHaveLength(7);
    expect(grantableRoles(p.buildMember, { approving: true })).toEqual([]);
  });
});

describe("sponsorships and parts queue rules", () => {
  it("sponsorships: the Business subteam and staff; deleting is for the creator, the Business leader, and all-scope staff", () => {
    const p = people;
    for (const who of [p.bizMember, p.bizLead, p.swLead, p.buildLead1, p.captain, p.mentor, p.teacher, p.admin]) {
      expect(canUseSponsorships(who), who.name).toBe(true);
    }
    for (const who of [p.swMember, p.buildMember]) expect(canUseSponsorships(who), who.name).toBe(false);

    const mine = { createdById: p.bizMember.id };
    expect(canDeleteSponsorship(p.bizMember, mine)).toBe(true);
    expect(canDeleteSponsorship(p.bizLead, mine)).toBe(true);
    expect(canDeleteSponsorship(p.captain, mine)).toBe(true);
    expect(canDeleteSponsorship(p.swLead, mine)).toBe(false); // can use the tracker, but it's not theirs
    expect(canDeleteSponsorship(p.swMember, { createdById: p.swMember.id })).toBe(false); // no access at all
    expect(canDeleteSponsorship(p.bizMember, { createdById: null })).toBe(false);
  });

  it("parts: Build leaders and all-scope staff manage the queue; requesters edit until someone grabs it; claimers finish", () => {
    const p = people;
    for (const who of [p.buildLead1, p.captain, p.mentor, p.teacher, p.admin]) expect(canManageParts(who), who.name).toBe(true);
    for (const who of [p.swLead, p.bizLead, p.buildMember, p.swMember]) expect(canManageParts(who), who.name).toBe(false);

    const waiting = { requestedById: p.swMember.id, claimedById: null, status: "NEEDED" as const };
    const grabbed = { requestedById: p.swMember.id, claimedById: p.buildMember.id, status: "CLAIMED" as const };
    expect(canEditPart(p.swMember, waiting)).toBe(true);
    expect(canEditPart(p.swMember, grabbed)).toBe(false);
    expect(canEditPart(p.buildMember, waiting)).toBe(false);
    expect(canEditPart(p.buildLead1, grabbed)).toBe(true);
    expect(canWorkOnPart(p.buildMember, grabbed)).toBe(true);
    expect(canWorkOnPart(p.swMember, grabbed)).toBe(false);
    expect(canWorkOnPart(p.buildLead2, grabbed)).toBe(true);
  });
});
