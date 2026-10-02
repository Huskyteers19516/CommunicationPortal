import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/server/actor";
import { verifyPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/tokens";
import type { EmailMessage, EmailTransport } from "@/server/email/transport";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import {
  getEmailConfigStatus,
  getPendingUsers,
  getRecentDecisions,
  getSeatUsage,
  getUserDetail,
  listEmailLogs,
  listUsers,
  parseUserFilters,
} from "@/server/queries/admin";
import {
  HAS_ACTIVITY_MESSAGE,
  approveUser,
  deleteUser,
  rejectUser,
  revokeSessions,
  sendPasswordResetLink,
  sendTestEmail,
  updateUser,
} from "@/server/services/admin";
import { createTestDb, type TestDb } from "./helpers/db";
import { TEST_NOW, contextFor, makeTask, makeUser } from "./helpers/factories";

let t: TestDb;
let admin: Actor;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t?.drop();
});

// Every test starts from an empty team with one ACTIVE admin (a mentor).
beforeEach(async () => {
  await t.db.task.deleteMany();
  await t.db.user.deleteMany();
  await t.db.emailLog.deleteMany();
  await t.db.rateLimit.deleteMany();
  admin = await makeUser(t.db, { name: "Ada Admin", role: "MENTOR", isAdmin: true });
});

const adminCtx = () => contextFor(t.db, admin);

async function addSession(userId: string) {
  return t.db.session.create({
    data: { tokenHash: hashToken(`${userId}-${Math.random()}`), userId, expiresAt: new Date(TEST_NOW.getTime() + 86_400_000) },
  });
}

async function statusOf(userId: string) {
  return (await t.db.user.findUniqueOrThrow({ where: { id: userId } })).status;
}

describe("approveUser", () => {
  it("approves a pending leader and emits account.approved", async () => {
    const pending = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });
    const ctx = adminCtx();
    await approveUser(ctx, { userId: pending.id });

    const u = await t.db.user.findUniqueOrThrow({ where: { id: pending.id } });
    expect(u).toMatchObject({ status: "ACTIVE", role: "BUILD_LEADER", subteam: "BUILD", approvedById: admin.id });
    expect(u.approvedAt).toEqual(TEST_NOW);
    expect(ctx.notifier.events).toEqual([{ type: "account.approved", userId: pending.id }]);
  });

  it("can approve with a different position (subteam normalized)", async () => {
    const a = await makeUser(t.db, { role: "CAPTAIN", status: "PENDING" });
    await approveUser(adminCtx(), { userId: a.id, role: "MEMBER", subteam: "SOFTWARE" });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({
      role: "MEMBER",
      subteam: "SOFTWARE",
      status: "ACTIVE",
    });

    // Leaders get their role's subteam no matter what was picked.
    const b = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    await approveUser(adminCtx(), { userId: b.id, role: "SOFTWARE_LEADER", subteam: "BUSINESS" });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      role: "SOFTWARE_LEADER",
      subteam: "SOFTWARE",
    });

    // Captain/mentor/teacher never keep a subteam.
    const c = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });
    await approveUser(adminCtx(), { userId: c.id, role: "TEACHER", subteam: "BUILD" });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ role: "TEACHER", subteam: null });
  });

  it("requires a subteam when approving as a Member", async () => {
    const p = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    const ctx = adminCtx();
    const err = await approveUser(ctx, { userId: p.id, role: "MEMBER", subteam: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.subteam).toMatch(/subteam/i);
    expect(await statusOf(p.id)).toBe("PENDING");
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("rejects bad input", async () => {
    const p = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    await expect(approveUser(adminCtx(), { userId: p.id, role: "WIZARD" })).rejects.toBeInstanceOf(ValidationError);
    await expect(approveUser(adminCtx(), { userId: "" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("can approve a previously rejected sign-up", async () => {
    const r = await makeUser(t.db, { role: "TEACHER", status: "REJECTED" });
    await approveUser(adminCtx(), { userId: r.id });
    expect(await statusOf(r.id)).toBe("ACTIVE");
  });

  it("conflicts for active or disabled accounts, 404s for unknown ids", async () => {
    const active = await makeUser(t.db, { role: "MENTOR" });
    const disabled = await makeUser(t.db, { role: "MENTOR", status: "DISABLED" });
    const ctx = adminCtx();
    await expect(approveUser(ctx, { userId: active.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(approveUser(ctx, { userId: disabled.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(approveUser(ctx, { userId: "does-not-exist" })).rejects.toBeInstanceOf(NotFoundError);
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("enforces seat limits (ACTIVE holders only) unless overridden", async () => {
    for (let i = 0; i < 3; i++) await makeUser(t.db, { role: "BUILD_LEADER" });
    await makeUser(t.db, { role: "BUILD_LEADER", status: "DISABLED" }); // doesn't hold a seat
    const pending = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });

    const ctx = adminCtx();
    const err = await approveUser(ctx, { userId: pending.id }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe(
      "Build Leader already has 3 of 3 seats filled. Tick “Approve anyway” to go over the limit.",
    );
    expect(await statusOf(pending.id)).toBe("PENDING");
    expect(ctx.notifier.events).toHaveLength(0);

    await approveUser(ctx, { userId: pending.id, overrideSeatLimit: "on" });
    expect(await statusOf(pending.id)).toBe("ACTIVE");
    expect(ctx.notifier.ofType("account.approved")).toHaveLength(1);
  });

  it("checks the seat of the position being approved, not the requested one", async () => {
    await makeUser(t.db, { role: "CAPTAIN" });
    const p = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    await expect(approveUser(adminCtx(), { userId: p.id, role: "CAPTAIN" })).rejects.toThrow(
      "Captain already has 1 of 1 seat filled.",
    );
    // Approving as a role without a limit is fine.
    await approveUser(adminCtx(), { userId: p.id });
    expect(await statusOf(p.id)).toBe("ACTIVE");
  });
});

describe("rejectUser", () => {
  it("moves PENDING to REJECTED without notifying", async () => {
    const p = await makeUser(t.db, { role: "CAPTAIN", status: "PENDING" });
    const ctx = adminCtx();
    await rejectUser(ctx, { userId: p.id });
    expect(await statusOf(p.id)).toBe("REJECTED");
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("conflicts when the account isn't pending; 404 for unknown", async () => {
    const active = await makeUser(t.db, { role: "MEMBER" });
    const rejected = await makeUser(t.db, { role: "MENTOR", status: "REJECTED" });
    await expect(rejectUser(adminCtx(), { userId: active.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(rejectUser(adminCtx(), { userId: rejected.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(rejectUser(adminCtx(), { userId: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await statusOf(active.id)).toBe("ACTIVE");
  });
});

describe("non-admins are denied everything", () => {
  // Leaders, the captain, mentors, and teachers have admin access through their position (see below).
  const roles = [
    { label: "member", input: { role: "MEMBER" as const } },
    { label: "member on another subteam", input: { role: "MEMBER" as const, subteam: "SOFTWARE" as const } },
  ];

  for (const { label, input } of roles) {
    it(`${label}`, async () => {
      const actor = await makeUser(t.db, input);
      const pending = await makeUser(t.db, { role: "SOFTWARE_LEADER", status: "PENDING" });
      const other = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
      await addSession(other.id);
      const ctx = contextFor(t.db, actor);

      const calls: Array<() => Promise<unknown>> = [
        () => approveUser(ctx, { userId: pending.id }),
        () => rejectUser(ctx, { userId: pending.id }),
        () => updateUser(ctx, { userId: other.id, name: "Hacked", role: "CAPTAIN", status: "ACTIVE", isAdmin: "on" }),
        () => updateUser(ctx, { userId: actor.id, name: actor.name, role: actor.role, subteam: actor.subteam ?? "", status: "ACTIVE", isAdmin: "on" }),
        () => sendPasswordResetLink(ctx, { userId: other.id }),
        () => revokeSessions(ctx, { userId: other.id }),
        () => deleteUser(ctx, { userId: pending.id }),
        () => sendTestEmail(ctx, { transport: null }),
      ];
      for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ForbiddenError);

      // Queries too.
      await expect(getPendingUsers(actor, t.db)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getSeatUsage(actor, t.db)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getRecentDecisions(actor, 10, t.db)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listUsers(actor, { page: 1 }, t.db)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getUserDetail(actor, other.id, t.db)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listEmailLogs(actor, { page: 1 }, t.db)).rejects.toBeInstanceOf(ForbiddenError);
      expect(() => getEmailConfigStatus(actor)).toThrow(ForbiddenError);

      // Nothing changed.
      expect(await statusOf(pending.id)).toBe("PENDING");
      const o = await t.db.user.findUniqueOrThrow({ where: { id: other.id } });
      expect(o).toMatchObject({ name: other.name, role: "MEMBER", isAdmin: false });
      expect(await t.db.user.findUniqueOrThrow({ where: { id: actor.id } })).toMatchObject({ isAdmin: false });
      expect(await t.db.session.count({ where: { userId: other.id } })).toBe(1);
      expect(await t.db.passwordResetToken.count()).toBe(0);
      expect(await t.db.emailLog.count()).toBe(0);
      expect(ctx.notifier.events).toHaveLength(0);
    });
  }
});

describe("leaders, the captain, mentors, and teachers have admin access, with guardrails", () => {
  const roles = [
    { label: "build leader", input: { role: "BUILD_LEADER" as const }, rank: 1 },
    { label: "software leader", input: { role: "SOFTWARE_LEADER" as const }, rank: 1 },
    { label: "captain", input: { role: "CAPTAIN" as const }, rank: 2 },
    { label: "mentor", input: { role: "MENTOR" as const }, rank: 2 },
    { label: "teacher", input: { role: "TEACHER" as const }, rank: 2 },
  ];
  const edit = (u: Actor, over: Record<string, unknown> = {}) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    subteam: u.subteam ?? "",
    status: u.status,
    ...(u.isAdmin ? { isAdmin: "on" } : {}),
    ...over,
  });

  for (const { label, input, rank } of roles) {
    it(`${label}: approves sign-ups up to their rank and manages accounts below it — never owners`, async () => {
      const actor = await makeUser(t.db, input);
      const ctx = contextFor(t.db, actor);
      const member = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
      await addSession(admin.id);

      // Sign-ups: leaders approve leaders (and below); the captain/mentors/teachers approve anyone but owners.
      const pendingLeader = await makeUser(t.db, { role: "BUSINESS_LEADER", status: "PENDING" });
      const pendingMentor = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
      expect((await getPendingUsers(actor, t.db)).total).toBe(2);
      await approveUser(ctx, { userId: pendingLeader.id });
      expect(await statusOf(pendingLeader.id)).toBe("ACTIVE");
      if (rank >= 2) {
        await approveUser(ctx, { userId: pendingMentor.id });
        expect(await statusOf(pendingMentor.id)).toBe("ACTIVE");
      } else {
        await expect(approveUser(ctx, { userId: pendingMentor.id })).rejects.toBeInstanceOf(ForbiddenError);
        await expect(rejectUser(ctx, { userId: pendingMentor.id })).rejects.toBeInstanceOf(ForbiddenError);
        // …and can't approve a leader sign-up *as* a mentor either.
        const another = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });
        const e = await approveUser(ctx, { userId: another.id, role: "MENTOR" }).catch((err) => err);
        expect(e).toBeInstanceOf(ValidationError);
        expect(await statusOf(pendingMentor.id)).toBe("PENDING");
        expect(await statusOf(another.id)).toBe("PENDING");
      }

      // Members' accounts: yes.
      await updateUser(ctx, edit(member, { name: "Renamed" }));
      expect((await t.db.user.findUniqueOrThrow({ where: { id: member.id } })).name).toBe("Renamed");
      // Promotions only to positions below their own.
      const promote = await updateUser(ctx, edit(member, { name: "Renamed", role: "SOFTWARE_LEADER" })).catch((err) => err);
      if (rank >= 2) {
        expect(promote).toBeUndefined();
        expect((await t.db.user.findUniqueOrThrow({ where: { id: member.id } })).role).toBe("SOFTWARE_LEADER");
      } else {
        expect(promote).toBeInstanceOf(ValidationError);
        expect((await t.db.user.findUniqueOrThrow({ where: { id: member.id } })).role).toBe("MEMBER");
      }
      const toMentor = await updateUser(ctx, edit(member, { role: "MENTOR" })).catch((err) => err);
      expect(toMentor).toBeInstanceOf(ValidationError);

      // Accounts at or above their own rank: no (a leader can't disable a mentor or take over the captain).
      const peer = await makeUser(t.db, { role: rank >= 2 ? "TEACHER" : "BUILD_LEADER" });
      await expect(updateUser(ctx, edit(peer, { status: "DISABLED" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateUser(ctx, edit(peer, { email: "mine@example.com" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(sendPasswordResetLink(ctx, { userId: peer.id })).rejects.toBeInstanceOf(ForbiddenError);
      expect(await statusOf(peer.id)).toBe("ACTIVE");
      expect((await getUserDetail(actor, peer.id, t.db))?.canManage).toBe(false);

      // Only owners change someone else's email (new email + "forgot password" = account takeover).
      const emailChange = await updateUser(ctx, edit(member, { name: "Renamed", email: "someone-new@example.com" })).catch((err) => err);
      expect(emailChange).toBeInstanceOf(ValidationError);
      expect((await t.db.user.findUniqueOrThrow({ where: { id: member.id } })).email).toBe(member.email);

      // The Owner box is ignored for non-owners (nobody gets promoted).
      await updateUser(ctx, edit(member, { isAdmin: "on" }));
      expect((await t.db.user.findUniqueOrThrow({ where: { id: member.id } })).isAdmin).toBe(false);

      // Reset links go by email only; the link itself is never handed to a non-owner.
      const reset = await sendPasswordResetLink(ctx, { userId: member.id });
      expect(reset.resetUrl).toBeNull();
      expect(ctx.notifier.ofType("password.reset").map((ev) => ev.userId)).toContain(member.id);

      // Owners' accounts are off-limits.
      const calls: Array<() => Promise<unknown>> = [
        () => updateUser(ctx, edit(admin, { name: "Hacked" })),
        () => updateUser(ctx, edit(admin, { status: "DISABLED" })),
        () => sendPasswordResetLink(ctx, { userId: admin.id }),
        () => revokeSessions(ctx, { userId: admin.id }),
      ];
      for (const call of calls) await expect(call()).rejects.toThrow("Only an owner can change an owner's account.");
      expect(await t.db.user.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({
        name: "Ada Admin",
        status: "ACTIVE",
        isAdmin: true,
      });
      expect(await t.db.session.count({ where: { userId: admin.id } })).toBe(1);
      expect((await getUserDetail(actor, admin.id, t.db))?.canManage).toBe(false);
      expect((await getUserDetail(actor, member.id, t.db))?.canManage).toBe(true);

      // The email log stays with the owners.
      await expect(listEmailLogs(actor, { page: 1 }, t.db)).rejects.toBeInstanceOf(ForbiddenError);

      // They can't change their own position (that could lock them out of Admin)…
      const e = await updateUser(ctx, edit(actor, { role: "MEMBER", subteam: "BUILD" })).catch((err) => err);
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).fieldErrors.role).toMatch(/own position/);
      expect((await t.db.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe(input.role);
      // …but can still fix their own name.
      await updateUser(ctx, edit(actor, { name: "New Name" }));
      expect((await t.db.user.findUniqueOrThrow({ where: { id: actor.id } })).name).toBe("New Name");
    });
  }

  it("a leader can't reject, approve, or delete a pending owner (owners only)", async () => {
    const leader = await makeUser(t.db, { role: "BUILD_LEADER" });
    const pendingOwner = await makeUser(t.db, { role: "MEMBER", status: "PENDING", isAdmin: true });
    await expect(rejectUser(contextFor(t.db, leader), { userId: pendingOwner.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteUser(contextFor(t.db, leader), { userId: pendingOwner.id })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveUser(contextFor(t.db, leader), { userId: pendingOwner.id })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await statusOf(pendingOwner.id)).toBe("PENDING");
  });

  it("a stale edit by a non-owner can't undo a promotion to owner that happened meanwhile", async () => {
    const leader = await makeUser(t.db, { role: "CAPTAIN" });
    const target = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    // The owner promotes the target after the captain loaded it (simulated by promoting first, then saving
    // the captain's form, which was built from the old row).
    await updateUser(adminCtx(), edit(target, { isAdmin: "on" }));
    await expect(updateUser(contextFor(t.db, leader), edit(target, { name: "Stale save" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await t.db.user.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ isAdmin: true, name: target.name });
  });

  it("owners can make and unmake owners", async () => {
    const leader = await makeUser(t.db, { role: "BUILD_LEADER" });
    await updateUser(adminCtx(), edit(leader, { isAdmin: "on" }));
    expect((await t.db.user.findUniqueOrThrow({ where: { id: leader.id } })).isAdmin).toBe(true);
    await updateUser(adminCtx(), edit(leader, { isAdmin: undefined }));
    expect((await t.db.user.findUniqueOrThrow({ where: { id: leader.id } })).isAdmin).toBe(false);
  });
});

describe("updateUser", () => {
  const base = (u: Actor) => ({
    userId: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    subteam: u.subteam ?? "",
    status: u.status,
    isAdmin: u.isAdmin ? "on" : undefined,
  });

  it("updates name, position, subteam, and admin flag", async () => {
    const m = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const ctx = adminCtx();
    await updateUser(ctx, { ...base(m), name: "  Sam Smith ", subteam: "BUSINESS", isAdmin: "on" });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({
      name: "Sam Smith",
      subteam: "BUSINESS",
      isAdmin: true,
    });

    // Member -> leader: subteam follows the role.
    await updateUser(ctx, { ...base(m), role: "BUSINESS_LEADER", subteam: "SOFTWARE" });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({
      role: "BUSINESS_LEADER",
      subteam: "BUSINESS",
      isAdmin: false,
    });

    // Leader -> member keeps their subteam if none picked.
    await updateUser(ctx, { ...base(m), role: "MEMBER", subteam: "" });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ role: "MEMBER", subteam: "BUSINESS" });
    expect(ctx.notifier.events).toHaveLength(0);
  });

  it("validates input", async () => {
    const m = await makeUser(t.db, { role: "MEMBER" });
    const err = await updateUser(adminCtx(), { ...base(m), name: "   ", status: "SLEEPING" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(Object.keys((err as ValidationError).fieldErrors).sort()).toEqual(["name", "status"]);

    const mentor = await makeUser(t.db, { role: "MENTOR" });
    const e2 = await updateUser(adminCtx(), { ...base(mentor), role: "MEMBER", subteam: "" }).catch((e) => e);
    expect(e2).toBeInstanceOf(ValidationError);
    expect((e2 as ValidationError).fieldErrors.subteam).toBeTruthy();

    await expect(updateUser(adminCtx(), { ...base(m), userId: "missing" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("won't let an admin remove their own admin flag or deactivate themselves", async () => {
    const e1 = await updateUser(adminCtx(), { ...base(admin), isAdmin: undefined }).catch((e) => e);
    expect(e1).toBeInstanceOf(ValidationError);
    expect((e1 as ValidationError).fieldErrors.isAdmin).toBeTruthy();

    for (const status of ["DISABLED", "PENDING", "REJECTED"]) {
      const e2 = await updateUser(adminCtx(), { ...base(admin), status }).catch((e) => e);
      expect(e2).toBeInstanceOf(ValidationError);
      expect((e2 as ValidationError).fieldErrors.status).toBeTruthy();
    }
    expect(await t.db.user.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({ isAdmin: true, status: "ACTIVE" });

    // Editing your own name is fine.
    await updateUser(adminCtx(), { ...base(admin), name: "Ada Lovelace" });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: admin.id } })).name).toBe("Ada Lovelace");
  });

  it("can demote or disable another admin while one active admin remains", async () => {
    const other = await makeUser(t.db, { role: "TEACHER", isAdmin: true });
    await updateUser(adminCtx(), { ...base(other), isAdmin: undefined });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: other.id } })).isAdmin).toBe(false);
  });

  it("always keeps at least one active admin", async () => {
    // A stale session: the actor was an admin when the request started but isn't anymore.
    const stale = await makeUser(t.db, { role: "MENTOR" });
    const staleCtx = contextFor(t.db, { ...stale, isAdmin: true });
    const e1 = await updateUser(staleCtx, { ...base(admin), isAdmin: undefined }).catch((e) => e);
    expect(e1).toBeInstanceOf(ConflictError);
    expect((e1 as ConflictError).message).toMatch(/at least one active owner/);
    const e2 = await updateUser(staleCtx, { ...base(admin), isAdmin: "on", status: "DISABLED" }).catch((e) => e);
    expect(e2).toBeInstanceOf(ConflictError);
    // Rolled back.
    expect(await t.db.user.findUniqueOrThrow({ where: { id: admin.id } })).toMatchObject({ isAdmin: true, status: "ACTIVE" });
  });

  it("disabling someone puts the parts they were making back up for grabs", async () => {
    const maker = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const part = await t.db.part.create({
      data: { name: "Spacer", status: "CLAIMED", claimedById: maker.id, claimedAt: TEST_NOW, requestedById: admin.id },
    });
    await updateUser(adminCtx(), { ...base(maker), status: "DISABLED" });
    expect(await t.db.part.findUniqueOrThrow({ where: { id: part.id } })).toMatchObject({ status: "NEEDED", claimedById: null });
    await t.db.part.deleteMany({ where: { id: part.id } });
  });

  it("disabling or rejecting deletes that person's sessions", async () => {
    const m = await makeUser(t.db, { role: "MEMBER" });
    const r = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    const keep = await makeUser(t.db, { role: "MEMBER" });
    await addSession(m.id);
    await addSession(m.id);
    await addSession(r.id);
    await addSession(keep.id);

    await updateUser(adminCtx(), { ...base(m), status: "DISABLED" });
    await updateUser(adminCtx(), { ...base(r), status: "REJECTED" });
    await updateUser(adminCtx(), { ...base(keep), name: "Still here" });

    expect(await statusOf(m.id)).toBe("DISABLED");
    expect(await t.db.session.count({ where: { userId: m.id } })).toBe(0);
    expect(await t.db.session.count({ where: { userId: r.id } })).toBe(0);
    expect(await t.db.session.count({ where: { userId: keep.id } })).toBe(1);
  });

  it("PENDING -> ACTIVE counts as an approval", async () => {
    const p = await makeUser(t.db, { role: "TEACHER", status: "PENDING" });
    const ctx = adminCtx();
    await updateUser(ctx, { ...base(p), status: "ACTIVE" });
    const u = await t.db.user.findUniqueOrThrow({ where: { id: p.id } });
    expect(u).toMatchObject({ status: "ACTIVE", approvedById: admin.id, approvedAt: TEST_NOW });
    expect(ctx.notifier.events).toEqual([{ type: "account.approved", userId: p.id }]);

    // Re-activating a disabled account is not an approval.
    const d = await makeUser(t.db, { role: "MEMBER", status: "DISABLED" });
    const ctx2 = adminCtx();
    await updateUser(ctx2, { ...base(d), status: "ACTIVE" });
    expect(await statusOf(d.id)).toBe("ACTIVE");
    expect(ctx2.notifier.events).toHaveLength(0);
  });

  it("checks seat limits when moving into a limited role or re-activating", async () => {
    await makeUser(t.db, { role: "SOFTWARE_LEADER" });
    const m = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE" });
    await expect(updateUser(adminCtx(), { ...base(m), role: "SOFTWARE_LEADER" })).rejects.toThrow(
      "Software Leader already has 1 of 1 seat filled",
    );
    expect((await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).role).toBe("MEMBER");

    // Moving them in as DISABLED takes no seat.
    await updateUser(adminCtx(), { ...base(m), role: "SOFTWARE_LEADER", status: "DISABLED" });
    const disabled = { ...m, role: "SOFTWARE_LEADER" as const, subteam: "SOFTWARE" as const, status: "DISABLED" as const };
    // Re-activating needs a free seat…
    await expect(updateUser(adminCtx(), { ...base(disabled), status: "ACTIVE" })).rejects.toBeInstanceOf(ConflictError);
    // …or the override.
    await updateUser(adminCtx(), { ...base(disabled), status: "ACTIVE", overrideSeatLimit: "on" });
    expect(await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ role: "SOFTWARE_LEADER", status: "ACTIVE" });

    // An existing seat holder editing other fields is not re-checked (even though seats are now over-full).
    await updateUser(adminCtx(), { ...base(disabled), status: "ACTIVE", name: "Renamed" });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).name).toBe("Renamed");
  });

  it("the seat-limit retry with “Approve anyway” actually activates the account", async () => {
    // The edit form re-submits what was chosen (status ACTIVE) plus the override after the seat error.
    for (let i = 0; i < 3; i++) await makeUser(t.db, { role: "BUILD_LEADER" });
    const p = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });
    const ctx = adminCtx();
    await expect(updateUser(ctx, { ...base(p), status: "ACTIVE" })).rejects.toBeInstanceOf(ConflictError);
    expect(await statusOf(p.id)).toBe("PENDING");
    await updateUser(ctx, { ...base(p), status: "ACTIVE", overrideSeatLimit: "on" });
    expect(await statusOf(p.id)).toBe("ACTIVE");
    expect(ctx.notifier.ofType("account.approved")).toHaveLength(1);
  });

  it("changes someone's email (normalized) and cancels their unused reset links", async () => {
    const m = await makeUser(t.db, { role: "MEMBER", email: "maya.patel@gmial.com" });
    await sendPasswordResetLink(adminCtx(), { userId: m.id });
    expect(await t.db.passwordResetToken.count({ where: { userId: m.id, usedAt: null } })).toBe(1);

    await updateUser(adminCtx(), { ...base(m), email: "  Maya.Patel@Gmail.com " });
    expect((await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).email).toBe("maya.patel@gmail.com");
    expect(await t.db.passwordResetToken.count({ where: { userId: m.id, usedAt: null } })).toBe(0);

    // Saving without changing the email leaves new reset links alone.
    await sendPasswordResetLink(adminCtx(), { userId: m.id });
    await updateUser(adminCtx(), { ...base(m), email: "maya.patel@gmail.com", name: "Maya P." });
    expect(await t.db.passwordResetToken.count({ where: { userId: m.id, usedAt: null } })).toBe(1);
  });

  it("rejects an invalid, missing, or already-used email with a field error", async () => {
    const m = await makeUser(t.db, { role: "MEMBER", email: "sam@example.com" });
    await makeUser(t.db, { role: "MEMBER", email: "taken@example.com" });

    const e1 = await updateUser(adminCtx(), { ...base(m), email: "TAKEN@example.com" }).catch((e) => e);
    expect(e1).toBeInstanceOf(ValidationError);
    expect((e1 as ValidationError).fieldErrors).toEqual({ email: "Another account already uses this email." });

    const e2 = await updateUser(adminCtx(), { ...base(m), email: "not-an-email" }).catch((e) => e);
    expect(e2).toBeInstanceOf(ValidationError);
    expect((e2 as ValidationError).fieldErrors.email).toBeTruthy();

    const e3 = await updateUser(adminCtx(), { ...base(m), email: "" }).catch((e) => e);
    expect((e3 as ValidationError).fieldErrors.email).toBeTruthy();

    expect((await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).email).toBe("sam@example.com");
  });

  it("two admins demoting each other at the same time always leave one active admin", async () => {
    const other = await makeUser(t.db, { name: "Bo Admin", role: "TEACHER", isAdmin: true });
    for (let round = 0; round < 5; round++) {
      await t.db.user.updateMany({ where: { id: { in: [admin.id, other.id] } }, data: { isAdmin: true, status: "ACTIVE" } });
      const results = await Promise.allSettled([
        updateUser(contextFor(t.db, admin), { ...base(other), isAdmin: undefined }),
        updateUser(contextFor(t.db, other), { ...base(admin), isAdmin: undefined }),
      ]);
      expect(await t.db.user.count({ where: { isAdmin: true, status: "ACTIVE" } })).toBe(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected");
      expect((failed as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    }
  });

  it("disabling one admin while another demotes the other can't leave zero admins either", async () => {
    const other = await makeUser(t.db, { name: "Cy Admin", role: "TEACHER", isAdmin: true });
    for (let round = 0; round < 3; round++) {
      await t.db.user.updateMany({ where: { id: { in: [admin.id, other.id] } }, data: { isAdmin: true, status: "ACTIVE" } });
      await Promise.allSettled([
        updateUser(contextFor(t.db, admin), { ...base(other), isAdmin: "on", status: "DISABLED" }),
        updateUser(contextFor(t.db, other), { ...base(admin), isAdmin: undefined }),
      ]);
      expect(await t.db.user.count({ where: { isAdmin: true, status: "ACTIVE" } })).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("sendPasswordResetLink", () => {
  it("issues a reset token and emits password.reset", async () => {
    const m = await makeUser(t.db, { role: "MEMBER" });
    const ctx = adminCtx();
    const { resetUrl } = await sendPasswordResetLink(ctx, { userId: m.id });
    const events = ctx.notifier.ofType("password.reset");
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe(m.id);
    expect(events[0].resetUrl).toMatch(/^http:\/\/localhost:3000\/reset-password\?token=/);
    expect(await t.db.passwordResetToken.count({ where: { userId: m.id, usedAt: null } })).toBe(1);

    // The admin gets the same one-time link back (to pass on privately), and it's the live one.
    expect(resetUrl).toBe(events[0].resetUrl);
    const token = new URL(resetUrl!).searchParams.get("token")!;
    const row = await t.db.passwordResetToken.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
    expect(row).toMatchObject({ userId: m.id, usedAt: null });
    expect(row.expiresAt).toEqual(new Date(TEST_NOW.getTime() + 60 * 60 * 1000));

    // A second link replaces the first.
    const second = await sendPasswordResetLink(ctx, { userId: m.id });
    expect(second.resetUrl).not.toBe(resetUrl);
    expect(await t.db.passwordResetToken.count({ where: { userId: m.id, usedAt: null } })).toBe(1);
  });

  it("works for pending sign-ups but not disabled accounts", async () => {
    const p = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    await sendPasswordResetLink(adminCtx(), { userId: p.id });
    const d = await makeUser(t.db, { role: "MEMBER", status: "DISABLED" });
    const ctx = adminCtx();
    await expect(sendPasswordResetLink(ctx, { userId: d.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(sendPasswordResetLink(ctx, { userId: "ghost" })).rejects.toBeInstanceOf(NotFoundError);
    expect(ctx.notifier.events).toHaveLength(0);
  });
});

describe("revokeSessions", () => {
  it("deletes all of that user's sessions and returns the count", async () => {
    const m = await makeUser(t.db, { role: "MEMBER" });
    const other = await makeUser(t.db, { role: "MEMBER" });
    await addSession(m.id);
    await addSession(m.id);
    await addSession(other.id);
    expect(await revokeSessions(adminCtx(), { userId: m.id })).toEqual({ count: 2 });
    expect(await t.db.session.count({ where: { userId: m.id } })).toBe(0);
    expect(await t.db.session.count({ where: { userId: other.id } })).toBe(1);
    expect(await revokeSessions(adminCtx(), { userId: m.id })).toEqual({ count: 0 });
    await expect(revokeSessions(adminCtx(), { userId: "ghost" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleteUser", () => {
  it("deletes pending and rejected sign-ups", async () => {
    const p = await makeUser(t.db, { role: "CAPTAIN", status: "PENDING" });
    const r = await makeUser(t.db, { role: "MENTOR", status: "REJECTED" });
    await addSession(p.id);
    await deleteUser(adminCtx(), { userId: p.id });
    await deleteUser(adminCtx(), { userId: r.id });
    expect(await t.db.user.count({ where: { id: { in: [p.id, r.id] } } })).toBe(0);
  });

  it("refuses active/disabled accounts, people who created tasks, and yourself", async () => {
    const active = await makeUser(t.db, { role: "MEMBER" });
    const disabled = await makeUser(t.db, { role: "MEMBER", status: "DISABLED" });
    const creator = await makeUser(t.db, { role: "BUILD_LEADER", status: "PENDING" });
    await makeTask(t.db, creator);

    await expect(deleteUser(adminCtx(), { userId: active.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteUser(adminCtx(), { userId: disabled.id })).rejects.toBeInstanceOf(ConflictError);
    await expect(deleteUser(adminCtx(), { userId: creator.id })).rejects.toThrow(HAS_ACTIVITY_MESSAGE);
    await expect(deleteUser(adminCtx(), { userId: admin.id })).rejects.toThrow(/your own account/);
    await expect(deleteUser(adminCtx(), { userId: "ghost" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await t.db.user.count({ where: { id: { in: [active.id, disabled.id, creator.id, admin.id] } } })).toBe(4);
  });

  it("refuses anyone with a footprint: checklist items, reviews, questions, or replies", async () => {
    const lead = await makeUser(t.db, { role: "BUILD_LEADER" });
    const other = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });

    const assignee = await makeUser(t.db, { role: "MEMBER", status: "REJECTED" });
    await makeTask(t.db, lead, { assigneeIds: [assignee.id] });

    const reviewer = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    const reviewed = await makeTask(t.db, lead, { assigneeIds: [other.id] });
    await t.db.taskAssignment.update({ where: { id: reviewed.assignments[0].id }, data: { reviewedById: reviewer.id } });

    const asker = await makeUser(t.db, { role: "MEMBER", status: "REJECTED" });
    await t.db.question.create({ data: { title: "Help", body: "?", askerId: asker.id, subteam: "BUILD" } });

    const replier = await makeUser(t.db, { role: "CAPTAIN", status: "REJECTED" });
    const q = await t.db.question.create({ data: { title: "Q", body: "?", askerId: other.id, subteam: "BUILD" } });
    await t.db.questionReply.create({ data: { questionId: q.id, authorId: replier.id, body: "An answer" } });

    for (const u of [assignee, reviewer, asker, replier]) {
      await expect(deleteUser(adminCtx(), { userId: u.id })).rejects.toThrow(HAS_ACTIVITY_MESSAGE);
      const detail = await getUserDetail(admin, u.id, t.db, TEST_NOW);
      expect(detail).toMatchObject({ canDelete: false, hasActivity: true });
    }
    expect(await t.db.user.count({ where: { id: { in: [assignee.id, reviewer.id, asker.id, replier.id] } } })).toBe(4);
    expect(await t.db.questionReply.count({ where: { questionId: q.id } })).toBe(1);
    expect(await t.db.taskAssignment.count({ where: { userId: assignee.id } })).toBe(1);
  });

  it("a long-time member set to Rejected keeps their history: delete is refused, nothing cascades", async () => {
    const lead = await makeUser(t.db, { role: "BUILD_LEADER" });
    const m = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD" });
    const task = await makeTask(t.db, lead, { assigneeIds: [m.id] });
    await t.db.taskAssignment.update({ where: { id: task.assignments[0].id }, data: { status: "APPROVED", reviewedById: lead.id } });
    const q = await t.db.question.create({ data: { title: "Help", body: "?", askerId: m.id, subteam: "BUILD" } });
    await t.db.questionReply.create({ data: { questionId: q.id, authorId: lead.id, body: "Try this" } });

    await updateUser(adminCtx(), {
      userId: m.id,
      name: m.name,
      email: m.email,
      role: "MEMBER",
      subteam: "BUILD",
      status: "REJECTED",
    });
    expect((await getUserDetail(admin, m.id, t.db, TEST_NOW))?.canDelete).toBe(false);
    await expect(deleteUser(adminCtx(), { userId: m.id })).rejects.toThrow(HAS_ACTIVITY_MESSAGE);
    expect(await t.db.question.count({ where: { id: q.id } })).toBe(1);
    expect(await t.db.questionReply.count({ where: { questionId: q.id } })).toBe(1);
    expect(await t.db.taskAssignment.count({ where: { taskId: task.id } })).toBe(1);
  });
});

describe("sendTestEmail", () => {
  class FakeTransport implements EmailTransport {
    readonly name = "fake";
    sent: EmailMessage[] = [];
    constructor(private fail = false) {}
    async send(m: EmailMessage) {
      if (this.fail) throw new Error("535 Bad credentials");
      this.sent.push(m);
    }
  }

  it("sends a branded email to the admin and logs it", async () => {
    const transport = new FakeTransport();
    expect(await sendTestEmail(adminCtx(), { transport })).toBe("SENT");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ to: admin.email, kind: "test" });
    expect(transport.sent[0].html).toContain("Huskyteers Portal");
    // White text sits on the darker brand green (#3A8543) so it passes AA contrast.
    expect(transport.sent[0].html).toContain("background:#3A8543");
    expect(transport.sent[0].html).not.toMatch(/#4ca256/i);
    const log = await t.db.emailLog.findFirstOrThrow();
    expect(log).toMatchObject({ to: admin.email, kind: "test", status: "SENT", error: null });
  });

  it("reports FAILED and SKIPPED", async () => {
    expect(await sendTestEmail(adminCtx(), { transport: new FakeTransport(true) })).toBe("FAILED");
    expect(await sendTestEmail(adminCtx(), { transport: null })).toBe("SKIPPED");
    const logs = await t.db.emailLog.findMany({ orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => l.status).sort()).toEqual(["FAILED", "SKIPPED"]);
    expect(logs.find((l) => l.status === "FAILED")?.error).toContain("Bad credentials");
  });

  it("escapes the admin's name in the HTML", async () => {
    const sneaky = await makeUser(t.db, { name: "<b>Bob</b>", role: "MENTOR", isAdmin: true });
    const transport = new FakeTransport();
    await sendTestEmail(contextFor(t.db, sneaky), { transport });
    expect(transport.sent[0].html).toContain("&lt;b&gt;Bob&lt;/b&gt;");
    expect(transport.sent[0].html).not.toContain("<b>Bob</b>");
  });
});

describe("admin queries", () => {
  it("getSeatUsage counts ACTIVE holders only", async () => {
    await makeUser(t.db, { name: "Sam", role: "BUILD_LEADER" });
    await makeUser(t.db, { name: "Alex", role: "BUILD_LEADER" });
    await makeUser(t.db, { name: "Pat", role: "BUILD_LEADER", status: "PENDING" });
    await makeUser(t.db, { name: "Dee", role: "BUILD_LEADER", status: "DISABLED" });
    await makeUser(t.db, { name: "Cap", role: "CAPTAIN" });
    await makeUser(t.db, { name: "Rex", role: "SOFTWARE_LEADER", status: "REJECTED" });

    const seats = await getSeatUsage(admin, t.db);
    const byRole = Object.fromEntries(seats.map((s) => [s.role, s]));
    expect(Object.keys(byRole).sort()).toEqual(["BUILD_LEADER", "BUSINESS_LEADER", "CAPTAIN", "SOFTWARE_LEADER"]);
    expect(byRole.BUILD_LEADER).toMatchObject({ label: "Build Leader", limit: 3, filled: 2 });
    expect(byRole.BUILD_LEADER.holders.map((h) => h.name)).toEqual(["Alex", "Sam"]);
    expect(byRole.CAPTAIN).toMatchObject({ limit: 1, filled: 1 });
    expect(byRole.SOFTWARE_LEADER).toMatchObject({ limit: 1, filled: 0, holders: [] });
  });

  it("getPendingUsers lists pending sign-ups oldest first", async () => {
    const a = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    const b = await makeUser(t.db, { role: "CAPTAIN", status: "PENDING" });
    await t.db.user.update({ where: { id: a.id }, data: { createdAt: new Date("2026-09-20T00:00:00Z") } });
    await makeUser(t.db, { role: "MENTOR", status: "REJECTED" });
    const { users, total } = await getPendingUsers(admin, t.db);
    expect(total).toBe(2);
    expect(users.map((u) => u.id)).toEqual([a.id, b.id]);
  });

  it("getRecentDecisions merges approvals and rejections, newest first", async () => {
    const p1 = await makeUser(t.db, { name: "First", role: "MENTOR", status: "PENDING" });
    const p2 = await makeUser(t.db, { name: "Second", role: "TEACHER", status: "PENDING" });
    await approveUser(contextFor(t.db, admin), { userId: p1.id });
    await rejectUser(adminCtx(), { userId: p2.id });
    // Make the approval clearly older than the rejection.
    await t.db.user.update({ where: { id: p1.id }, data: { approvedAt: new Date("2020-01-01T00:00:00Z") } });

    const decisions = await getRecentDecisions(admin, 10, t.db);
    expect(decisions.map((d) => [d.name, d.decision])).toEqual([
      ["Second", "REJECTED"],
      ["First", "APPROVED"],
    ]);
    expect(decisions[1].decidedBy).toBe(admin.name);
  });

  it("listUsers searches, filters, puts PENDING first, and paginates", async () => {
    await makeUser(t.db, { name: "Zed Pending", email: "zed@example.com", role: "CAPTAIN", status: "PENDING" });
    await makeUser(t.db, { name: "Bea Build", email: "bea@robots.org", role: "MEMBER", subteam: "BUILD" });
    await makeUser(t.db, { name: "Abe Soft", email: "abe@example.com", role: "MEMBER", subteam: "SOFTWARE" });
    await makeUser(t.db, { name: "Cal Gone", email: "cal@example.com", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });

    const all = await listUsers(admin, { page: 1 }, t.db);
    expect(all.total).toBe(5);
    expect(all.users[0].name).toBe("Zed Pending");
    expect(all.users.slice(1).map((u) => u.name)).toEqual(["Abe Soft", "Ada Admin", "Bea Build", "Cal Gone"]);

    expect((await listUsers(admin, { q: "BEA", page: 1 }, t.db)).users.map((u) => u.name)).toEqual(["Bea Build"]);
    expect((await listUsers(admin, { q: "robots.ORG", page: 1 }, t.db)).users.map((u) => u.name)).toEqual(["Bea Build"]);
    expect((await listUsers(admin, { subteam: "BUILD", page: 1 }, t.db)).users.map((u) => u.name)).toEqual([
      "Bea Build",
      "Cal Gone",
    ]);
    expect((await listUsers(admin, { status: "DISABLED", page: 1 }, t.db)).users.map((u) => u.name)).toEqual(["Cal Gone"]);
    expect((await listUsers(admin, { role: "CAPTAIN", page: 1 }, t.db)).users.map((u) => u.name)).toEqual(["Zed Pending"]);
    expect((await listUsers(admin, { q: "nobody", page: 1 }, t.db)).users).toEqual([]);

    // parseUserFilters ignores junk.
    expect(parseUserFilters({ q: "  bea ", status: "NOPE", role: "MEMBER", subteam: ["BUILD", "X"], page: "-3" })).toEqual({
      q: "bea",
      status: undefined,
      role: "MEMBER",
      subteam: "BUILD",
      page: 1,
    });
    // A NUL byte in the link (?q=%00) would make Postgres reject the search; control characters are dropped.
    expect(parseUserFilters({ q: "\u0000" }).q).toBeUndefined();
    expect(parseUserFilters({ q: "be\u0000a" }).q).toBe("bea");
    expect((await listUsers(admin, parseUserFilters({ q: "\u0000" }), t.db)).total).toBeGreaterThan(0);
  });

  it("listUsers paginates 50 per page across the pending/other boundary", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      name: `Person ${String(i).padStart(2, "0")}`,
      email: `p${i}@example.com`,
      passwordHash: "x",
      role: i < 3 ? ("MENTOR" as const) : ("MEMBER" as const),
      subteam: i < 3 ? null : ("BUILD" as const),
      status: i < 3 ? ("PENDING" as const) : ("ACTIVE" as const),
    }));
    await t.db.user.createMany({ data: rows });
    const p1 = await listUsers(admin, { page: 1 }, t.db);
    const p2 = await listUsers(admin, { page: 2 }, t.db);
    expect(p1).toMatchObject({ total: 61, page: 1, pageCount: 2 });
    expect(p1.users).toHaveLength(50);
    expect(p1.users.slice(0, 3).every((u) => u.status === "PENDING")).toBe(true);
    expect(p2.users).toHaveLength(11);
    const ids = new Set([...p1.users, ...p2.users].map((u) => u.id));
    expect(ids.size).toBe(61);
    // Out-of-range pages clamp to the last page.
    expect((await listUsers(admin, { page: 99 }, t.db)).page).toBe(2);
  });

  it("getUserDetail returns counts, and null for unknown ids", async () => {
    const lead = await makeUser(t.db, { role: "BUILD_LEADER" });
    const m = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", status: "PENDING" });
    const t1 = await makeTask(t.db, lead, { assigneeIds: [m.id] });
    await makeTask(t.db, lead, { assigneeIds: [m.id] });
    await makeTask(t.db, m, { assigneeIds: [] });
    await t.db.taskAssignment.update({ where: { id: t1.assignments[0].id }, data: { status: "APPROVED" } });
    await t.db.question.create({ data: { title: "Help", body: "?", askerId: m.id, subteam: "BUILD" } });
    await addSession(m.id);
    await t.db.session.create({ data: { tokenHash: "expired", userId: m.id, expiresAt: new Date("2020-01-01T00:00:00Z") } });

    const d = await getUserDetail(admin, m.id, t.db, TEST_NOW);
    expect(d).toMatchObject({
      id: m.id,
      assignments: { TODO: 1, SUBMITTED: 0, APPROVED: 1, REJECTED: 0 },
      tasksCreated: 1,
      questionsAsked: 1,
      activeSessions: 1,
      canDelete: false, // created a task
      isSelf: false,
    });
    expect(d?.closedAssignments).toBe(0);
    // An item never approved before a leader marked its task finished is counted apart (it isn't "to do").
    const closedTask = await makeTask(t.db, lead, { assigneeIds: [m.id] });
    await t.db.task.update({ where: { id: closedTask.id }, data: { completedAt: TEST_NOW, completedById: lead.id } });
    expect(await getUserDetail(admin, m.id, t.db, TEST_NOW)).toMatchObject({
      assignments: { TODO: 1, SUBMITTED: 0, APPROVED: 1, REJECTED: 0 },
      closedAssignments: 1,
    });
    expect(await getUserDetail(admin, "ghost", t.db)).toBeNull();
    expect((await getUserDetail(admin, admin.id, t.db))?.isSelf).toBe(true);
    const pending = await makeUser(t.db, { role: "MENTOR", status: "PENDING", email: "owner@example.com" });
    expect(await getUserDetail(admin, pending.id, t.db)).toMatchObject({ canDelete: true, hasActivity: false });
    expect(d?.hasActivity).toBe(true);

    // A pending sign-up with only a checklist item (no tasks created) still can't be deleted.
    const assigned = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", status: "PENDING" });
    await makeTask(t.db, lead, { assigneeIds: [assigned.id] });
    expect(await getUserDetail(admin, assigned.id, t.db)).toMatchObject({ canDelete: false, hasActivity: true });

    // inAdminEmails flags addresses listed in ADMIN_EMAILS (case-insensitive).
    const saved = process.env.ADMIN_EMAILS;
    try {
      process.env.ADMIN_EMAILS = "someone@else.org, Owner@Example.com";
      expect((await getUserDetail(admin, pending.id, t.db))?.inAdminEmails).toBe(true);
      expect((await getUserDetail(admin, assigned.id, t.db))?.inAdminEmails).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ADMIN_EMAILS;
      else process.env.ADMIN_EMAILS = saved;
    }
  });

  it("listEmailLogs filters by status, newest first", async () => {
    await t.db.emailLog.createMany({
      data: [
        { to: "a@x.com", subject: "One", kind: "test", status: "SENT", createdAt: new Date("2026-09-01T00:00:00Z") },
        { to: "b@x.com", subject: "Two", kind: "task.submitted", status: "FAILED", error: "boom", createdAt: new Date("2026-09-02T00:00:00Z") },
        { to: "c@x.com", subject: "Three", kind: "test", status: "SENT", createdAt: new Date("2026-09-03T00:00:00Z") },
      ],
    });
    const all = await listEmailLogs(admin, { page: 1 }, t.db);
    expect(all.logs.map((l) => l.subject)).toEqual(["Three", "Two", "One"]);
    const failed = await listEmailLogs(admin, { status: "FAILED", page: 1 }, t.db);
    expect(failed.logs.map((l) => l.error)).toEqual(["boom"]);
  });

  it("getEmailConfigStatus never exposes secrets", () => {
    const saved = { ...process.env };
    try {
      process.env.SMTP_HOST = "smtp.gmail.com";
      process.env.SMTP_PORT = "465";
      process.env.SMTP_USER = "team@gmail.com";
      process.env.SMTP_PASS = "super-secret-app-password";
      const s = getEmailConfigStatus(admin);
      expect(s.mode).toBe("smtp");
      expect(s.detail).toContain("smtp.gmail.com");
      expect(JSON.stringify(s)).not.toContain("super-secret-app-password");

      process.env.SMTP_HOST = "";
      process.env.RESEND_API_KEY = "re_secret_key";
      const r = getEmailConfigStatus(admin);
      expect(r.mode).toBe("resend");
      expect(JSON.stringify(r)).not.toContain("re_secret_key");

      process.env.RESEND_API_KEY = "";
      expect(getEmailConfigStatus(admin).mode).toBe("none");
    } finally {
      process.env = saved;
    }
  });
});

describe("npm run admin (scripts/create-admin.ts)", () => {
  const exec = promisify(execFile);
  const root = path.resolve(import.meta.dirname, "..");

  /** Runs the real script against this file's throwaway database. */
  async function runScript(args: string[]) {
    const env = { ...process.env, DATABASE_URL: `postgresql://postgres:postgres@localhost:54329/${t.name}` };
    try {
      const { stdout } = await exec(path.join(root, "node_modules/.bin/tsx"), ["scripts/create-admin.ts", ...args], {
        cwd: root,
        env,
        timeout: 25_000,
      });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("--reset-only sets a new password without touching admin, position, or status", async () => {
    const m = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE", email: "kid@example.com" });
    await addSession(m.id);
    await sendPasswordResetLink(adminCtx(), { userId: m.id });
    // Locked out after too many wrong passwords.
    await t.db.rateLimit.create({ data: { key: "login:acct:kid@example.com", count: 30, windowStart: new Date() } });

    const r = await runScript(["--reset-only", "--email", "Kid@Example.com"]);
    expect(r.code).toBe(0);
    const printed = /Password:\s+([A-Za-z0-9]{16})\b/.exec(r.stdout)?.[1];
    expect(printed).toBeTruthy();

    const u = await t.db.user.findUniqueOrThrow({ where: { id: m.id } });
    expect(u).toMatchObject({ isAdmin: false, role: "MEMBER", subteam: "SOFTWARE", status: "ACTIVE" });
    expect(await verifyPassword(printed!, u.passwordHash)).toBe(true);
    expect(await t.db.session.count({ where: { userId: m.id } })).toBe(0);
    expect(await t.db.passwordResetToken.count({ where: { userId: m.id, usedAt: null } })).toBe(0);
    // …and the account-level sign-in lockout is lifted so the new password works right away.
    expect(await t.db.rateLimit.count({ where: { key: "login:acct:kid@example.com" } })).toBe(0);

    // With --password, and for a disabled account: still no access change.
    const d = await makeUser(t.db, { role: "BUILD_LEADER", status: "DISABLED", email: "gone@example.com" });
    const r2 = await runScript(["--reset-only", "--email", "gone@example.com", "--password", "brand-new-pass-9"]);
    expect(r2.code).toBe(0);
    const du = await t.db.user.findUniqueOrThrow({ where: { id: d.id } });
    expect(du).toMatchObject({ isAdmin: false, role: "BUILD_LEADER", status: "DISABLED" });
    expect(await verifyPassword("brand-new-pass-9", du.passwordHash)).toBe(true);
  });

  it("--reset-only refuses unknown emails and position changes", async () => {
    const m = await makeUser(t.db, { role: "MEMBER", email: "kid2@example.com" });
    const before = (await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).passwordHash;

    const r1 = await runScript(["--reset-only", "--email", "nobody@example.com"]);
    expect(r1.code).toBe(2);
    expect(r1.stderr).toMatch(/No account uses nobody@example.com/);

    const r2 = await runScript(["--reset-only", "--email", "kid2@example.com", "--role", "CAPTAIN"]);
    expect(r2.code).toBe(2);
    expect((await t.db.user.findUniqueOrThrow({ where: { id: m.id } })).passwordHash).toBe(before);
    expect(await t.db.user.count()).toBe(2);
  });

  it("the default path still makes an existing account an active admin", async () => {
    const m = await makeUser(t.db, { role: "MENTOR", status: "PENDING", email: "coach@example.com" });
    const r = await runScript(["--email", "coach@example.com", "--password", "coach-pass-123"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Made existing account an admin/);
    const u = await t.db.user.findUniqueOrThrow({ where: { id: m.id } });
    expect(u).toMatchObject({ isAdmin: true, status: "ACTIVE", role: "MENTOR" });
    expect(await verifyPassword("coach-pass-123", u.passwordHash)).toBe(true);
  });
});
