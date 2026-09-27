import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { hashToken } from "@/server/auth/tokens";
import type { Db } from "@/server/db";
import { RateLimitError, UnauthorizedError, ValidationError } from "@/server/errors";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import {
  canAssignTo,
  canBeQuestionRecipient,
  canCreateTask,
  canReviewAssignment,
  canSignUpForTask,
  canViewQuestion,
} from "@/server/permissions";
import {
  changePassword,
  editablePrefKeys,
  resourceEmailScope,
  getSettings,
  signOutOtherDevices,
  updateNotificationPrefs,
  updateProfile,
} from "@/server/services/settings";
import { checkSeedSafety, DEMO_PASSWORD, isLocalDatabaseUrl, seed, SeedRefusedError } from "../prisma/seed";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_PASSWORD, TEST_TODAY, TEST_TZ } from "./helpers/factories";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t?.drop();
});

/** Resolves to the ValidationError's fieldErrors (fails the test if something else happens). */
async function fieldErrorsOf(p: Promise<unknown>): Promise<Record<string, string>> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ValidationError) return e.fieldErrors;
    throw e;
  }
  throw new Error("Expected a ValidationError");
}

let tokenCounter = 0;
async function makeSession(db: Db, userId: string, opts: { expired?: boolean } = {}) {
  const token = `token-${userId}-${tokenCounter++}`;
  const expiresAt = new Date(TEST_NOW.getTime() + (opts.expired ? -1 : 1) * 24 * 60 * 60 * 1000);
  await db.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  return hashToken(token);
}

const sessionHashes = async (db: Db, userId: string) =>
  (await db.session.findMany({ where: { userId }, select: { tokenHash: true } })).map((s) => s.tokenHash).sort();

const prefsOf = (db: Db, id: string) =>
  db.user.findUniqueOrThrow({
    where: { id },
    select: {
      emailOnQuestion: true,
      emailOnSubmission: true,
      emailOnReply: true,
      emailOnReview: true,
      emailOnAssigned: true,
      emailOnSignup: true,
      emailOnResource: true,
    },
  });

// ── Profile ───────────────────────────────────────────────────────────────────

describe("updateProfile", () => {
  it("saves a trimmed name and nothing else, even if other fields are submitted", async () => {
    const member = await makeUser(t.db, { role: "MEMBER", subteam: "SOFTWARE", name: "Old Name" });
    const ctx = contextFor(t.db, member);
    await updateProfile(ctx, { name: "  Maya Patel  ", email: "evil@example.com", role: "CAPTAIN", isAdmin: "on", status: "ACTIVE" });
    const row = await t.db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(row.name).toBe("Maya Patel");
    expect(row.email).toBe(member.email);
    expect(row.role).toBe("MEMBER");
    expect(row.isAdmin).toBe(false);
    expect(ctx.notifier.events).toEqual([]);
  });

  it("rejects a missing, blank, or too-long name", async () => {
    const member = await makeUser(t.db, { name: "Keep Me" });
    const ctx = contextFor(t.db, member);
    expect((await fieldErrorsOf(updateProfile(ctx, {}))).name).toBe("Name is required.");
    expect((await fieldErrorsOf(updateProfile(ctx, { name: "   " }))).name).toBe("Name is required.");
    expect((await fieldErrorsOf(updateProfile(ctx, { name: "x".repeat(81) }))).name).toMatch(/at most 80/);
    expect((await fieldErrorsOf(updateProfile(ctx, null))).name).toBe("Name is required.");
    expect((await t.db.user.findUniqueOrThrow({ where: { id: member.id } })).name).toBe("Keep Me");
  });

  it("refuses accounts that aren't active", async () => {
    const disabled = await makeUser(t.db, { status: "DISABLED", name: "Gone" });
    await expect(updateProfile(contextFor(t.db, disabled), { name: "Back" })).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await t.db.user.findUniqueOrThrow({ where: { id: disabled.id } })).name).toBe("Gone");
  });
});

// ── Password ──────────────────────────────────────────────────────────────────

describe("changePassword", () => {
  const NEW_PASSWORD = "brand-new-pass-9";

  it("rejects a wrong current password without changing anything", async () => {
    const member = await makeUser(t.db);
    const keep = await makeSession(t.db, member.id);
    const other = await makeSession(t.db, member.id);
    const errors = await fieldErrorsOf(
      changePassword(
        contextFor(t.db, member),
        { currentPassword: "not-my-password", newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
        { keepSessionTokenHash: keep },
      ),
    );
    expect(errors.currentPassword).toBe("That's not your current password.");
    const row = await t.db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(await verifyPassword(TEST_PASSWORD, row.passwordHash)).toBe(true);
    expect(await sessionHashes(t.db, member.id)).toEqual([keep, other].sort());
  });

  it("validates the new password: length, confirmation, and different from current", async () => {
    const member = await makeUser(t.db);
    const ctx = contextFor(t.db, member);
    const meta = { keepSessionTokenHash: null };

    const mismatch = await fieldErrorsOf(
      changePassword(ctx, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: "something-else" }, meta),
    );
    expect(mismatch.confirmPassword).toBe("The new passwords don't match.");

    const short = await fieldErrorsOf(changePassword(ctx, { currentPassword: TEST_PASSWORD, newPassword: "short", confirmPassword: "short" }, meta));
    expect(short.newPassword).toBe("Password must be at least 8 characters.");

    const same = await fieldErrorsOf(
      changePassword(ctx, { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD, confirmPassword: TEST_PASSWORD }, meta),
    );
    expect(same.newPassword).toMatch(/different from your current/);

    const missing = await fieldErrorsOf(changePassword(ctx, {}, meta));
    expect(missing.currentPassword).toBe("Enter your current password.");
    expect(missing.newPassword).toBeDefined();
    expect(missing.confirmPassword).toBeDefined();

    const row = await t.db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(await verifyPassword(TEST_PASSWORD, row.passwordHash)).toBe(true);
  });

  it("updates the hash, keeps this session, signs out the others, and voids reset links", async () => {
    const member = await makeUser(t.db, { role: "SOFTWARE_LEADER" });
    const bystander = await makeUser(t.db);
    const keep = await makeSession(t.db, member.id);
    await makeSession(t.db, member.id);
    await makeSession(t.db, member.id, { expired: true });
    const bystanderSession = await makeSession(t.db, bystander.id);
    await t.db.passwordResetToken.create({
      data: { tokenHash: hashToken(`reset-${member.id}`), userId: member.id, expiresAt: new Date(TEST_NOW.getTime() + 3600_000) },
    });

    const ctx = contextFor(t.db, member);
    await changePassword(
      ctx,
      { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      { keepSessionTokenHash: keep },
    );

    const row = await t.db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, row.passwordHash)).toBe(false);
    expect(await sessionHashes(t.db, member.id)).toEqual([keep]);
    expect(await sessionHashes(t.db, bystander.id)).toEqual([bystanderSession]);
    const resets = await t.db.passwordResetToken.findMany({ where: { userId: member.id } });
    expect(resets.every((r) => r.usedAt?.getTime() === TEST_NOW.getTime())).toBe(true);
    expect(ctx.notifier.events).toEqual([{ type: "password.changed", userId: member.id }]);
  });

  it("signs out every session when the current one is unknown", async () => {
    const member = await makeUser(t.db);
    await makeSession(t.db, member.id);
    await makeSession(t.db, member.id);
    await changePassword(
      contextFor(t.db, member),
      { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      { keepSessionTokenHash: null },
    );
    expect(await sessionHashes(t.db, member.id)).toEqual([]);
  });

  it("won't keep someone else's session alive via keepSessionTokenHash", async () => {
    const member = await makeUser(t.db);
    const stranger = await makeUser(t.db);
    const strangerSession = await makeSession(t.db, stranger.id);
    await makeSession(t.db, member.id);
    await changePassword(
      contextFor(t.db, member),
      { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
      { keepSessionTokenHash: strangerSession },
    );
    expect(await sessionHashes(t.db, member.id)).toEqual([]);
    expect(await sessionHashes(t.db, stranger.id)).toEqual([strangerSession]);
  });

  it("is rate limited to 10 attempts an hour", async () => {
    const member = await makeUser(t.db);
    const ctx = contextFor(t.db, member);
    const attempt = () =>
      changePassword(ctx, { currentPassword: "wrong-guess-123", newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }, { keepSessionTokenHash: null });
    for (let i = 0; i < 10; i++) await expect(attempt()).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt()).rejects.toBeInstanceOf(RateLimitError);
    // Even the right password is blocked until the window passes.
    await expect(
      changePassword(ctx, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }, { keepSessionTokenHash: null }),
    ).rejects.toBeInstanceOf(RateLimitError);
    // An hour later it works again.
    const later = { ...ctx, now: new Date(TEST_NOW.getTime() + 61 * 60 * 1000) };
    await changePassword(later, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }, { keepSessionTokenHash: null });
    const row = await t.db.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true);
  });

  it("refuses accounts that aren't active", async () => {
    const pending = await makeUser(t.db, { role: "MENTOR", status: "PENDING" });
    await expect(
      changePassword(
        contextFor(t.db, pending),
        { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
        { keepSessionTokenHash: null },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

// ── Email preferences ─────────────────────────────────────────────────────────

describe("updateNotificationPrefs", () => {
  it("members change only their own three switches; staff/admin switches are ignored even if submitted", async () => {
    const member = await makeUser(t.db, {
      role: "MEMBER",
      subteam: "BUILD",
      prefs: { emailOnQuestion: true, emailOnSubmission: true, emailOnSignup: false, emailOnReply: true, emailOnReview: true, emailOnAssigned: false },
    });
    const ctx = contextFor(t.db, member);
    // Question/submission omitted (= "off"), signup forced "on": neither may change for a member.
    await updateNotificationPrefs(ctx, { emailOnAssigned: "on", emailOnSignup: "on", emailOnReply: "on" });
    expect(await prefsOf(t.db, member.id)).toEqual({
      emailOnReply: true,
      emailOnReview: false,
      emailOnAssigned: true,
      emailOnQuestion: true,
      emailOnSubmission: true,
      emailOnSignup: false,
      emailOnResource: true,
    });
    expect(ctx.notifier.events).toEqual([]);
  });

  it("an empty form switches a member's own emails off", async () => {
    const member = await makeUser(t.db, { prefs: { emailOnAssigned: true } });
    await updateNotificationPrefs(contextFor(t.db, member), {});
    const prefs = await prefsOf(t.db, member.id);
    expect(prefs).toMatchObject({ emailOnReply: false, emailOnReview: false, emailOnAssigned: false, emailOnQuestion: true, emailOnSubmission: true });
  });

  it("leaders can change question/submission emails and, with admin access, the approval emails", async () => {
    const leader = await makeUser(t.db, { role: "BUILD_LEADER", prefs: { emailOnSignup: false } });
    await updateNotificationPrefs(contextFor(t.db, leader), {
      emailOnReply: "on",
      emailOnReview: "on",
      emailOnSubmission: "on",
      emailOnSignup: "on",
    });
    expect(await prefsOf(t.db, leader.id)).toMatchObject({
      emailOnReply: true,
      emailOnReview: true,
      emailOnAssigned: false,
      emailOnQuestion: false,
      emailOnSubmission: true,
      emailOnSignup: true,
      emailOnResource: false,
    });
  });

  it("mentors, teachers, and the captain count as staff too", async () => {
    for (const role of ["MENTOR", "TEACHER", "CAPTAIN"] as const) {
      const person = await makeUser(t.db, { role });
      await updateNotificationPrefs(contextFor(t.db, person), { emailOnQuestion: "on" });
      expect(await prefsOf(t.db, person.id)).toMatchObject({
        emailOnQuestion: true,
        emailOnSubmission: false,
        emailOnSignup: false,
        // Resource approval emails go to owners, subteam leaders, and captains — mentors/teachers don't
        // get them, so their switch isn't shown or changed.
        emailOnResource: role === "CAPTAIN" ? false : true,
      });
    }
  });

  it("admins can change the signup email (and staff emails, even with a member role)", async () => {
    const admin = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS", isAdmin: true });
    await updateNotificationPrefs(contextFor(t.db, admin), { emailOnReply: "on", emailOnQuestion: "on" });
    expect(await prefsOf(t.db, admin.id)).toEqual({
      emailOnReply: true,
      emailOnReview: false,
      emailOnAssigned: false,
      emailOnQuestion: true,
      emailOnSubmission: false,
      emailOnSignup: false,
      emailOnResource: false,
    });
    await updateNotificationPrefs(contextFor(t.db, admin), { emailOnSignup: "true" });
    expect((await prefsOf(t.db, admin.id)).emailOnSignup).toBe(true);
  });

  it("auto-save: each flip sends every visible switch, only the flipped one changes, and reloading shows it", async () => {
    // The Settings form saves on every flip, sending all switches this person can see (unchecked = missing).
    const leader = await makeUser(t.db, {
      role: "SOFTWARE_LEADER",
      prefs: { emailOnReply: true, emailOnReview: true, emailOnAssigned: false, emailOnQuestion: true, emailOnSubmission: true, emailOnSignup: false },
    });
    const ctx = contextFor(t.db, leader);
    const reload = async () => (await getSettings(t.db, leader, { currentSessionTokenHash: null, now: TEST_NOW }))!.prefs;

    // Flip "Someone checks off a task I assigned" off.
    await updateNotificationPrefs(ctx, { emailOnReply: "on", emailOnReview: "on", emailOnQuestion: "on", emailOnResource: "on" });
    expect(await reload()).toEqual({
      emailOnReply: true,
      emailOnReview: true,
      emailOnAssigned: false,
      emailOnQuestion: true,
      emailOnSubmission: false,
      emailOnSignup: false,
      emailOnResource: true,
    });

    // Then "I'm assigned a new task" on: the earlier change stays saved.
    await updateNotificationPrefs(ctx, {
      emailOnReply: "on",
      emailOnReview: "on",
      emailOnAssigned: "on",
      emailOnQuestion: "on",
      emailOnResource: "on",
    });
    expect(await reload()).toMatchObject({ emailOnAssigned: true, emailOnSubmission: false, emailOnResource: true });

    // A failed save (signed-out / inactive account) changes nothing, so the switches fall back to these values.
    const before = await reload();
    await expect(
      updateNotificationPrefs(contextFor(t.db, { ...leader, status: "DISABLED" }), { emailOnSubmission: "on" }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await reload()).toEqual(before);
  });

  it("only changes the signed-in user's row", async () => {
    const member = await makeUser(t.db);
    const other = await makeUser(t.db);
    await updateNotificationPrefs(contextFor(t.db, member), { userId: other.id, id: other.id });
    expect((await prefsOf(t.db, other.id)).emailOnReply).toBe(true);
    expect((await prefsOf(t.db, member.id)).emailOnReply).toBe(false);
  });

  it("editablePrefKeys by role", () => {
    const base = { id: "x", subteam: null };
    expect(editablePrefKeys({ ...base, role: "MEMBER", subteam: "BUILD", isAdmin: false })).toEqual([
      "emailOnReply",
      "emailOnReview",
      "emailOnAssigned",
    ]);
    // Leaders have admin access, so they also get the approval emails.
    expect(editablePrefKeys({ ...base, role: "SOFTWARE_LEADER", subteam: "SOFTWARE", isAdmin: false })).toEqual([
      "emailOnReply",
      "emailOnReview",
      "emailOnAssigned",
      "emailOnQuestion",
      "emailOnSubmission",
      "emailOnSignup",
      "emailOnResource",
    ]);
    expect(editablePrefKeys({ ...base, role: "CAPTAIN", isAdmin: true })).toContain("emailOnSignup");
    expect(editablePrefKeys({ ...base, role: "MENTOR", isAdmin: false })).toContain("emailOnSignup");
    expect(editablePrefKeys({ ...base, role: "MENTOR", isAdmin: false })).not.toContain("emailOnResource");
    expect(editablePrefKeys({ ...base, role: "MENTOR", isAdmin: true })).toContain("emailOnResource");
  });

  it("resourceEmailScope: whose shared resources email this person (matches resourceSubmittedRecipients)", () => {
    const base = { id: "x", subteam: null };
    // Owners: every member's.
    expect(resourceEmailScope({ ...base, role: "MEMBER", subteam: "BUILD", isAdmin: true })).toEqual({ kind: "all" });
    expect(resourceEmailScope({ ...base, role: "BUILD_LEADER", subteam: "BUILD", isAdmin: true })).toEqual({ kind: "all" });
    // Subteam leaders: their own subteam's members.
    expect(resourceEmailScope({ ...base, role: "BUILD_LEADER", subteam: "BUILD", isAdmin: false })).toEqual({
      kind: "subteam",
      subteam: "BUILD",
    });
    expect(resourceEmailScope({ ...base, role: "SOFTWARE_LEADER", isAdmin: false })).toEqual({ kind: "subteam", subteam: "SOFTWARE" });
    // The captain: only when a member's subteam has no active leader (or they have no subteam).
    expect(resourceEmailScope({ ...base, role: "CAPTAIN", isAdmin: false })).toEqual({ kind: "fallback" });
    // Never: mentors, teachers, members.
    for (const role of ["MENTOR", "TEACHER", "MEMBER"] as const) {
      expect(resourceEmailScope({ ...base, role, subteam: role === "MEMBER" ? "BUILD" : null, isAdmin: false }), role).toBeNull();
    }
  });

  it("refuses accounts that aren't active", async () => {
    const disabled = await makeUser(t.db, { status: "DISABLED" });
    await expect(updateNotificationPrefs(contextFor(t.db, disabled), {})).rejects.toBeInstanceOf(UnauthorizedError);
    expect((await prefsOf(t.db, disabled.id)).emailOnReply).toBe(true);
  });
});

// ── Devices ───────────────────────────────────────────────────────────────────

describe("signOutOtherDevices / getSettings", () => {
  it("counts and ends only this user's other live sessions", async () => {
    const member = await makeUser(t.db);
    const bystander = await makeUser(t.db);
    const current = await makeSession(t.db, member.id);
    await makeSession(t.db, member.id);
    await makeSession(t.db, member.id);
    await makeSession(t.db, member.id);
    await makeSession(t.db, member.id, { expired: true });
    const bystanderSession = await makeSession(t.db, bystander.id);

    const before = await getSettings(t.db, member, { currentSessionTokenHash: current, now: TEST_NOW });
    expect(before?.otherSessionCount).toBe(3);
    expect(before?.prefs).toMatchObject({ emailOnReply: true, emailOnAssigned: false });

    const ctx = contextFor(t.db, member);
    expect(await signOutOtherDevices(ctx, { keepSessionTokenHash: current })).toEqual({ count: 3 });
    expect(await sessionHashes(t.db, member.id)).toEqual([current]);
    expect(await sessionHashes(t.db, bystander.id)).toEqual([bystanderSession]);
    expect(ctx.notifier.events).toEqual([]);

    expect(await signOutOtherDevices(ctx, { keepSessionTokenHash: current })).toEqual({ count: 0 });
    const after = await getSettings(t.db, member, { currentSessionTokenHash: current, now: TEST_NOW });
    expect(after?.otherSessionCount).toBe(0);
  });

  it("refuses accounts that aren't active", async () => {
    const disabled = await makeUser(t.db, { status: "DISABLED" });
    const s = await makeSession(t.db, disabled.id);
    await expect(signOutOtherDevices(contextFor(t.db, disabled), { keepSessionTokenHash: null })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(await sessionHashes(t.db, disabled.id)).toEqual([s]);
  });

  it("getSettings returns null for a user that doesn't exist", async () => {
    expect(await getSettings(t.db, { id: "missing-user" }, { currentSessionTokenHash: null, now: TEST_NOW })).toBeNull();
  });
});

// ── Demo seed ─────────────────────────────────────────────────────────────────

describe("seed safety checks", () => {
  const local = "postgresql://postgres:postgres@localhost:54329/portal";
  const remote = "postgresql://user:pw@ep-cool-name.us-east-2.aws.neon.tech/neondb?sslmode=require";

  it("recognises local databases", () => {
    expect(isLocalDatabaseUrl(local)).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@127.0.0.1:5432/x")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@[::1]:5432/x")).toBe(true);
    expect(isLocalDatabaseUrl(remote)).toBe(false);
    expect(isLocalDatabaseUrl("postgres://u:p@localhost.evil.com/x")).toBe(false);
    expect(isLocalDatabaseUrl("not a url")).toBe(false);
  });

  it("refuses production, remote without --force-remote, and remote --reset", () => {
    expect(checkSeedSafety({ nodeEnv: "production", databaseUrl: local, reset: false, forceRemote: false })).toMatch(/production/);
    expect(checkSeedSafety({ nodeEnv: "production", databaseUrl: local, reset: false, forceRemote: true })).toMatch(/production/);
    expect(checkSeedSafety({ nodeEnv: "development", databaseUrl: remote, reset: false, forceRemote: false })).toMatch(/--force-remote/);
    expect(checkSeedSafety({ nodeEnv: "development", databaseUrl: remote, reset: true, forceRemote: true })).toMatch(/--reset/);
    expect(checkSeedSafety({ nodeEnv: "development", databaseUrl: remote, reset: false, forceRemote: true })).toBeNull();
    expect(checkSeedSafety({ nodeEnv: undefined, databaseUrl: local, reset: true, forceRemote: false })).toBeNull();
  });
});

describe("demo seed", () => {
  let s: TestDb;
  beforeAll(async () => {
    s = await createTestDb();
  });
  afterAll(async () => {
    await s?.drop();
  });

  it("loads a consistent demo team into an empty database", async () => {
    const result = await seed(s.db, { now: TEST_NOW, timezone: TEST_TZ });
    const db = s.db;
    expect(result.today).toBe(TEST_TODAY);

    // People
    const byStatus = Object.fromEntries(
      (await db.user.groupBy({ by: ["status"], _count: { _all: true } })).map((g) => [g.status, g._count._all]),
    );
    expect(byStatus).toEqual({ ACTIVE: 24, PENDING: 2, DISABLED: 1 });
    expect(result.counts.users).toBe(27);
    expect(result.credentials).toHaveLength(27);
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@example.com" } });
    expect(admin).toMatchObject({ name: "Jordan Lee", role: "CAPTAIN", isAdmin: true, status: "ACTIVE" });
    expect(await verifyPassword(DEMO_PASSWORD, admin.passwordHash)).toBe(true);
    const roles = await db.user.groupBy({ by: ["role"], where: { status: "ACTIVE" }, _count: { _all: true } });
    const roleCount = Object.fromEntries(roles.map((r) => [r.role, r._count._all]));
    expect(roleCount).toEqual({ CAPTAIN: 1, SOFTWARE_LEADER: 1, BUILD_LEADER: 3, BUSINESS_LEADER: 1, MENTOR: 1, TEACHER: 1, MEMBER: 16 });
    const pending = await db.user.findMany({ where: { status: "PENDING" }, select: { role: true } });
    expect(pending.map((p) => p.role).sort()).toEqual(["BUILD_LEADER", "MENTOR"]);
    const users = await db.user.findMany();
    const byId = new Map(users.map((u) => [u.id, u]));
    for (const u of users) {
      expect(u.email).toMatch(/@example\.com$/);
      if (u.role === "MEMBER" || u.role.endsWith("_LEADER")) expect(u.subteam).not.toBeNull();
      else expect(u.subteam).toBeNull();
    }
    const membersBySubteam = await db.user.groupBy({ by: ["subteam"], where: { role: "MEMBER", status: "ACTIVE" }, _count: { _all: true } });
    expect(membersBySubteam).toHaveLength(3);

    // Tasks
    const tasks = await db.task.findMany({ include: { assignments: true } });
    expect(tasks).toHaveLength(result.counts.tasks);
    expect(tasks.length).toBeGreaterThanOrEqual(18);
    const minDue = dateOnlyToDb(addDays(TEST_TODAY, -6)).getTime();
    const maxDue = dateOnlyToDb(addDays(TEST_TODAY, 6)).getTime();
    for (const task of tasks) {
      expect(task.dueDate.getTime()).toBeGreaterThanOrEqual(minDue);
      expect(task.dueDate.getTime()).toBeLessThanOrEqual(maxDue);
      const creator = byId.get(task.createdById)!;
      expect(creator.status).toBe("ACTIVE");
      expect(canCreateTask(creator, task.subteam), task.title).toBe(true);
      for (const a of task.assignments) {
        const assignee = byId.get(a.userId)!;
        expect(canAssignTo(creator, assignee), `${task.title} -> ${assignee.name}`).toBe(true);
      }
    }
    expect(tasks.some((x) => x.subteam === null)).toBe(true);
    expect(new Set(tasks.map((x) => x.subteam)).size).toBe(4);

    // Task dashboard: categories per subteam, tasks sorted into their own subteam's categories, sign-up tasks.
    const categories = await db.taskCategory.findMany({ orderBy: [{ subteam: "asc" }, { position: "asc" }] });
    expect(categories).toHaveLength(result.counts.categories);
    expect(categories.filter((c) => c.subteam === "BUILD").map((c) => c.name)).toEqual([
      "Intake",
      "Outtake",
      "Drivetrain",
      "Lift",
      "CAD & Design",
    ]);
    expect(new Set(categories.map((c) => c.subteam))).toEqual(new Set(["SOFTWARE", "BUILD", "BUSINESS", null]));
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    for (const task of tasks) {
      if (task.categoryId) expect(categoryById.get(task.categoryId)?.subteam, task.title).toBe(task.subteam);
    }
    expect(tasks.some((x) => !x.categoryId)).toBe(true);
    const signupTasks = tasks.filter((x) => x.signupOpen);
    expect(signupTasks.length).toBeGreaterThanOrEqual(3);
    expect(signupTasks.some((x) => x.subteam === null)).toBe(true);
    expect(signupTasks.some((x) => x.signupLimit === null)).toBe(true);
    expect(signupTasks.some((x) => x.signupLimit !== null && x.assignments.length >= x.signupLimit)).toBe(true); // full
    expect(signupTasks.some((x) => x.signupLimit !== null && x.assignments.length < x.signupLimit && x.assignments.some((a) => a.selfAssigned))).toBe(true);
    for (const task of signupTasks) {
      if (task.signupLimit !== null) expect(task.assignments.length, task.title).toBeLessThanOrEqual(task.signupLimit);
    }
    // Self sign-ups only on sign-up tasks, only by people allowed to sign up, and never checked off yet.
    for (const task of tasks) {
      for (const a of task.assignments.filter((x) => x.selfAssigned)) {
        expect(task.signupOpen, task.title).toBe(true);
        expect(canSignUpForTask(byId.get(a.userId)!, task), task.title).toBe(true);
        expect(a.status).toBe("TODO");
      }
    }

    // Checklist items
    const assignments = await db.taskAssignment.findMany({ include: { task: true } });
    expect(assignments).toHaveLength(result.counts.assignments);
    expect(assignments.length).toBeGreaterThanOrEqual(80);
    const statusCount = (st: string) => assignments.filter((a) => a.status === st).length;
    for (const st of ["TODO", "SUBMITTED", "APPROVED", "REJECTED"]) expect(statusCount(st), st).toBeGreaterThan(0);
    const today = dateOnlyToDb(TEST_TODAY).getTime();
    const overdueTodo = assignments.filter((a) => a.status === "TODO" && a.task.dueDate.getTime() < today);
    expect(overdueTodo.length).toBeGreaterThan(0);
    const todays = assignments.filter((a) => a.task.dueDate.getTime() === today);
    expect(new Set(todays.map((a) => a.status))).toEqual(new Set(["TODO", "SUBMITTED", "APPROVED"]));
    expect(assignments.filter((a) => a.task.dueDate.getTime() > today).every((a) => a.status === "TODO")).toBe(true);
    for (const a of assignments) {
      if (a.status === "TODO") expect(a.submittedAt).toBeNull();
      else expect(a.submittedAt!.getTime()).toBeLessThanOrEqual(TEST_NOW.getTime());
      if (a.status === "APPROVED" || a.status === "REJECTED") {
        const reviewer = byId.get(a.reviewedById!)!;
        expect(canReviewAssignment(reviewer, a.task, a)).toBe(true);
        expect(a.reviewedAt!.getTime()).toBeLessThanOrEqual(TEST_NOW.getTime());
        expect(a.reviewedAt!.getTime()).toBeGreaterThanOrEqual(a.submittedAt!.getTime());
      } else {
        expect(a.reviewedById).toBeNull();
      }
      if (a.status === "REJECTED") expect(a.reviewNote).toBeTruthy();
    }
    expect(assignments.some((a) => a.submissionNote)).toBe(true);
    expect(assignments.some((a) => a.status === "APPROVED" && a.reviewNote)).toBe(true);
    // The captain and a build leader have their own checklist items.
    for (const role of ["CAPTAIN", "BUILD_LEADER"]) {
      const ids = users.filter((u) => u.role === role).map((u) => u.id);
      expect(assignments.some((a) => ids.includes(a.userId)), role).toBe(true);
    }

    // Questions
    const questions = await db.question.findMany({ include: { replies: true } });
    expect(questions).toHaveLength(result.counts.questions);
    expect(questions.length).toBeGreaterThanOrEqual(8);
    expect(new Set(questions.map((q) => q.status))).toEqual(new Set(["OPEN", "ANSWERED", "RESOLVED"]));
    expect(questions.some((q) => q.recipientId)).toBe(true);
    expect(questions.some((q) => !q.recipientId && q.subteam)).toBe(true);
    expect(questions.filter((q) => !q.recipientId && !q.subteam)).toHaveLength(1);
    expect(await db.questionReply.count()).toBe(result.counts.replies);
    for (const q of questions) {
      const asker = byId.get(q.askerId)!;
      expect(asker.status).toBe("ACTIVE");
      if (q.recipientId) expect(canBeQuestionRecipient(byId.get(q.recipientId)!)).toBe(true);
      if (q.status !== "OPEN" || q.replies.length > 0) expect(q.replies.length).toBeGreaterThan(0);
      for (const r of q.replies) {
        const author = byId.get(r.authorId)!;
        expect(r.authorId === q.askerId || canViewQuestion(author, q), `${q.title} reply by ${author.name}`).toBe(true);
        expect(r.createdAt.getTime()).toBeGreaterThanOrEqual(q.createdAt.getTime());
      }
      const latest = Math.max(q.createdAt.getTime(), ...q.replies.map((r) => r.createdAt.getTime()));
      expect(q.lastActivityAt.getTime()).toBe(latest);
    }

    // Resources: members' shares in every state, including an uploaded file.
    const resources = await db.resource.findMany({ include: { file: true } });
    expect(new Set(resources.map((r) => r.status))).toEqual(new Set(["PENDING", "APPROVED", "REJECTED"]));
    for (const r of resources) {
      expect(byId.get(r.createdById!)?.status).toBe("ACTIVE");
      if (r.status === "PENDING") expect(r.reviewedById).toBeNull();
      else if (r.reviewedById) expect(byId.get(r.reviewedById)?.role).not.toBe("MEMBER");
      if (r.status === "REJECTED") expect(r.reviewNote).toBeTruthy();
      if (r.file) expect(r.url).toBe("");
      else expect(r.url).toMatch(/^https:\/\//);
    }
    const code = resources.find((r) => r.file);
    expect(code).toMatchObject({ status: "APPROVED", type: "CODE", file: { filename: "TeleOpMain.java" } });
    expect(new TextDecoder().decode(code!.file!.data)).toContain("public class TeleOpMain");
    expect(code!.file!.size).toBe(code!.file!.data.byteLength);
  });

  it("refuses to run on a database that already has users", async () => {
    const before = await s.db.task.count();
    await expect(seed(s.db, { now: TEST_NOW, timezone: TEST_TZ })).rejects.toBeInstanceOf(SeedRefusedError);
    expect(await s.db.task.count()).toBe(before);
    expect(await s.db.user.count()).toBe(27);
  });

  it("--reset wipes every app row and reseeds cleanly", async () => {
    const someone = await s.db.user.findFirstOrThrow({ where: { email: "admin@example.com" } });
    await s.db.session.create({ data: { tokenHash: "stale-session", userId: someone.id, expiresAt: TEST_NOW } });
    await s.db.emailLog.create({ data: { to: "x@example.com", subject: "old", kind: "test", status: "SKIPPED" } });
    await s.db.rateLimit.create({ data: { key: "old", count: 1, windowStart: TEST_NOW } });
    await s.db.user.create({ data: { name: "Extra", email: "extra@example.com", passwordHash: await hashPassword("whatever-123"), role: "MEMBER", subteam: "BUILD" } });
    const resourcesBefore = await s.db.resource.count();
    const filesBefore = await s.db.resourceFile.count();

    const result = await seed(s.db, { now: TEST_NOW, timezone: TEST_TZ, reset: true });
    expect(await s.db.user.count()).toBe(27);
    expect(await s.db.task.count()).toBe(result.counts.tasks);
    expect(await s.db.taskAssignment.count()).toBe(result.counts.assignments);
    expect(await s.db.question.count()).toBe(result.counts.questions);
    expect(await s.db.taskCategory.count()).toBe(result.counts.categories);
    expect(await s.db.session.count()).toBe(0);
    expect(await s.db.emailLog.count()).toBe(0);
    expect(await s.db.rateLimit.count()).toBe(0);
    expect(await s.db.user.findUnique({ where: { email: "extra@example.com" } })).toBeNull();
    // Resources (and their uploaded files, which cascade) are replaced, not duplicated.
    expect(await s.db.resource.count()).toBe(resourcesBefore);
    expect(await s.db.resourceFile.count()).toBe(filesBefore);
    expect(filesBefore).toBeGreaterThan(0);
  });
});
