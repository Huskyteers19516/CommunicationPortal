// Admin area mutations: approve/reject sign-ups and manage people.
// Every function first checks canAdminister(ctx.actor) — UI hiding is not security.

import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { AccountStatus, Role, Subteam } from "@/generated/prisma/enums";
import { APP_NAME, ROLE_LABELS, SEAT_LIMITS, TEAM_NAME, TEAM_NUMBER, subteamForRole } from "@/lib/constants";
import { formatDateTime } from "@/lib/dates";
import { checkbox, emailSchema, idSchema, nameSchema } from "@/lib/validation";
import { parseInput } from "../action";
import { issuePasswordReset } from "../auth/password-reset";
import type { ServiceContext } from "../context";
import type { Db } from "../db";
import { type EmailTransport, sendEmail } from "../email/transport";
import { type DiscordOptions, type DiscordStatus, postToDiscord, testPayload } from "../notifications/discord";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { canAdminister, canGrantRole, canManageAccount, isOwner, ROLE_RANK } from "../permissions";
import { enforceRateLimit } from "../rate-limit";

// ── Shared helpers ─────────────────────────────────────────────────────────

const roleField = z.enum(Role, { error: "Pick a position." });
const statusField = z.enum(AccountStatus, { error: "Pick a status." });
const blankToUndefined = (v: unknown) => (v === "" || v === null ? undefined : v);
const optionalRole = z.preprocess(blankToUndefined, roleField.optional());
const optionalSubteam = z.preprocess(blankToUndefined, z.enum(Subteam, { error: "Pick a subteam." }).optional());

const userIdInput = z.object({ userId: idSchema });

function assertAdmin(ctx: ServiceContext) {
  if (!canAdminister(ctx.actor)) throw new ForbiddenError();
}

const OWNER_ONLY = "Only an owner can change an owner's account.";
const ABOVE_YOU =
  "You can't change this account. Leaders manage members' accounts; the captain, mentors, and teachers also manage leaders'. Ask an owner.";

type AccountRef = { id: string; role: Role; status: AccountStatus; isAdmin: boolean };

/**
 * Leaders, the captain, mentors, and teachers have admin access too, but only over accounts ranked
 * below them (and sign-ups up to their own rank). Owners' accounts are off-limits to them.
 */
function assertCanManageAccount(ctx: ServiceContext, target: AccountRef) {
  if (!canManageAccount(ctx.actor, target)) throw new ForbiddenError(target.isAdmin ? OWNER_ONLY : ABOVE_YOU);
}

/** The position being given must be one this admin may give (see canGrantRole). */
function assertCanGrant(ctx: ServiceContext, role: Role, approving: boolean) {
  if (canGrantRole(ctx.actor, role, { approving })) return;
  const who = ROLE_RANK[role] >= ROLE_RANK.CAPTAIN ? "an owner" : "the captain, a mentor, a teacher, or an owner";
  const message = `You can't make someone ${ROLE_LABELS[role]}. Ask ${who}.`;
  throw new ValidationError(message, { role: message });
}

/** Non-owners' conditional writes never touch an owner, even if someone became one a moment ago. */
function notOwnerUnlessOwner(ctx: ServiceContext): Prisma.UserWhereInput {
  return isOwner(ctx.actor) ? {} : { isAdmin: false };
}

/**
 * Subteam a person ends up with for `role`: leaders get their role's subteam,
 * captain/mentor/teacher get none, members must have one.
 */
function resolveSubteam(role: Role, requested: Subteam | null | undefined): Subteam | null {
  const implied = subteamForRole(role);
  if (implied !== undefined) return implied;
  if (!requested) throw new ValidationError("Pick a subteam for a Member.", { subteam: "Pick a subteam for a Member." });
  return requested;
}

/** Throws if every seat for a limited leadership role is already taken by ACTIVE people (other than `userId`). */
async function assertSeatAvailable(db: Db, role: Role, userId: string, override: boolean) {
  const limit = SEAT_LIMITS[role];
  if (limit === undefined || override) return;
  const filled = await db.user.count({ where: { role, status: "ACTIVE", id: { not: userId } } });
  if (filled >= limit) {
    throw new ConflictError(
      `${ROLE_LABELS[role]} already has ${filled} of ${limit} seat${limit === 1 ? "" : "s"} filled. ` +
        "Tick “Approve anyway” to go over the limit.",
    );
  }
}

const loadSelect = { id: true, name: true, role: true, subteam: true, status: true, isAdmin: true } as const;

async function loadUser(db: Db, userId: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: loadSelect });
  if (!user) throw new NotFoundError("That account no longer exists.");
  return user;
}

// ── Approvals ─────────────────────────────────────────────────────────────

const approveInput = z.object({
  userId: idSchema,
  role: optionalRole,
  subteam: optionalSubteam,
  overrideSeatLimit: checkbox,
});

/** Approve a PENDING (or previously REJECTED) sign-up, optionally as a different position. */
export async function approveUser(ctx: ServiceContext, raw: unknown): Promise<void> {
  assertAdmin(ctx);
  const data = parseInput(approveInput, raw as Record<string, unknown>);
  const target = await loadUser(ctx.db, data.userId);
  assertCanManageAccount(ctx, target);
  if (target.status !== "PENDING" && target.status !== "REJECTED") {
    throw new ConflictError(`${target.name}'s account is already ${target.status === "ACTIVE" ? "active" : "disabled"}.`);
  }

  const role = data.role ?? target.role;
  assertCanGrant(ctx, role, true);
  const subteam = resolveSubteam(role, data.subteam ?? target.subteam);
  await assertSeatAvailable(ctx.db, role, target.id, data.overrideSeatLimit);

  const { count } = await ctx.db.user.updateMany({
    // Same role as when we checked it (so a non-owner can't approve something they couldn't see as such).
    where: { id: target.id, status: { in: ["PENDING", "REJECTED"] }, role: target.role, ...notOwnerUnlessOwner(ctx) },
    data: { role, subteam, status: "ACTIVE", approvedById: ctx.actor.id, approvedAt: ctx.now },
  });
  if (count === 0) throw new ConflictError("Someone already decided on this account. Refresh to see the latest.");

  ctx.notifier.notify({ type: "account.approved", userId: target.id });
}

/** Turn down a PENDING sign-up. */
export async function rejectUser(ctx: ServiceContext, raw: unknown): Promise<void> {
  assertAdmin(ctx);
  const { userId } = parseInput(userIdInput, raw as Record<string, unknown>);
  const target = await loadUser(ctx.db, userId);
  if (target.status !== "PENDING") throw new ConflictError(`${target.name}'s account isn't waiting for approval anymore.`);
  assertCanManageAccount(ctx, target);
  const { count } = await ctx.db.user.updateMany({
    where: { id: userId, status: "PENDING", role: target.role, ...notOwnerUnlessOwner(ctx) },
    data: { status: "REJECTED" },
  });
  if (count === 0) throw new ConflictError(`${target.name}'s account changed in the meantime. Refresh and try again.`);
}

// ── People ────────────────────────────────────────────────────────────────

const updateInput = z.object({
  userId: idSchema,
  name: nameSchema,
  email: emailSchema,
  role: roleField,
  subteam: optionalSubteam,
  status: statusField,
  isAdmin: checkbox,
  overrideSeatLimit: checkbox,
});

const EMAIL_TAKEN = "Another account already uses this email.";

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/**
 * Serializes every change that can remove an active admin, so two admins demoting each other
 * at the same moment can't both pass the "at least one admin" check. Held until the transaction ends.
 */
async function lockAdminSet(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hk-admin-set'))`;
}

/** Edit someone's name, email, position, subteam, account status, and admin access. */
export async function updateUser(ctx: ServiceContext, raw: unknown): Promise<void> {
  assertAdmin(ctx);
  const data = parseInput(updateInput, raw as Record<string, unknown>);
  const target = await ctx.db.user.findUnique({ where: { id: data.userId }, select: { ...loadSelect, email: true } });
  if (!target) throw new NotFoundError("That account no longer exists.");
  assertCanManageAccount(ctx, target);
  // Only owners can make someone an owner (or take it away). For everyone else the box is ignored.
  const owner = isOwner(ctx.actor) ? data.isAdmin : target.isAdmin;
  const waiting = target.status === "PENDING" || target.status === "REJECTED";
  if (data.role !== target.role) assertCanGrant(ctx, data.role, waiting);

  if (target.id === ctx.actor.id) {
    if (target.isAdmin && !owner) {
      throw new ValidationError("You can't remove yourself as an owner. Ask another owner to do it.", {
        isAdmin: "You can't remove yourself as an owner.",
      });
    }
    if (data.status !== "ACTIVE") {
      throw new ValidationError("You can't disable or deactivate your own account.", {
        status: "Your own account must stay active.",
      });
    }
    // A leader/mentor/teacher who changed their own position could lock themselves out of Admin.
    if (!isOwner(ctx.actor) && data.role !== target.role) {
      throw new ValidationError("You can't change your own position. Ask another admin.", {
        role: "You can't change your own position.",
      });
    }
  }

  const emailChanged = data.email !== target.email;
  // A changed email + "forgot password" would hand someone's account to whoever typed the new address.
  if (emailChanged && !isOwner(ctx.actor) && target.id !== ctx.actor.id) {
    const message = "Only an owner can change someone else's email.";
    throw new ValidationError(message, { email: message });
  }
  if (emailChanged) {
    const taken = await ctx.db.user.findUnique({ where: { email: data.email }, select: { id: true } });
    if (taken && taken.id !== target.id) throw new ValidationError(EMAIL_TAKEN, { email: EMAIL_TAKEN });
  }

  const subteam = resolveSubteam(data.role, data.subteam ?? target.subteam);
  const becomesActive = data.status === "ACTIVE" && target.status !== "ACTIVE";
  if (data.status === "ACTIVE" && (data.role !== target.role || becomesActive)) {
    await assertSeatAvailable(ctx.db, data.role, target.id, data.overrideSeatLimit);
  }
  const isApproval = becomesActive && (target.status === "PENDING" || target.status === "REJECTED");
  const losesAccess = data.status === "DISABLED" || data.status === "REJECTED";
  const staysActiveAdmin = owner && data.status === "ACTIVE";

  try {
    await ctx.db.$transaction(async (tx) => {
      await lockAdminSet(tx);
      // Re-read under the lock: another admin may have promoted or demoted this person meanwhile.
      const current = await tx.user.findUnique({
        where: { id: target.id },
        select: { id: true, role: true, isAdmin: true, status: true },
      });
      if (!current) throw new NotFoundError("That account no longer exists.");
      // Check again on the fresh row: an owner may have promoted this person since we first looked.
      assertCanManageAccount(ctx, current);
      const wasActiveAdmin = current.isAdmin && current.status === "ACTIVE";

      await tx.user.update({
        where: { id: target.id },
        data: {
          name: data.name,
          email: data.email,
          role: data.role,
          subteam,
          status: data.status,
          // Non-owners never write the owner flag (so a stale form can't undo a promotion).
          ...(isOwner(ctx.actor) ? { isAdmin: owner } : {}),
          ...(isApproval ? { approvedById: ctx.actor.id, approvedAt: ctx.now } : {}),
        },
      });
      if (wasActiveAdmin && !staysActiveAdmin) {
        // Checked after the write, inside the transaction, so a failure rolls it back.
        const admins = await tx.user.count({ where: { isAdmin: true, status: "ACTIVE" } });
        if (admins === 0) {
          throw new ConflictError("There must always be at least one active owner. Make someone else an owner first.");
        }
      }
      // Reset links already sent went to the old address: they must not work anymore.
      if (emailChanged) {
        await tx.passwordResetToken.updateMany({ where: { userId: target.id, usedAt: null }, data: { usedAt: ctx.now } });
      }
      if (losesAccess) {
        await tx.session.deleteMany({ where: { userId: target.id } });
        // Parts they were making go back up for grabs (they can't finish them now).
        await tx.part.updateMany({
          where: { claimedById: target.id, status: "CLAIMED" },
          data: { status: "NEEDED", claimedById: null, claimedAt: null },
        });
      }
    });
  } catch (e) {
    // Someone else took the address between the check above and the write.
    if (isUniqueViolation(e)) throw new ValidationError(EMAIL_TAKEN, { email: EMAIL_TAKEN });
    throw e;
  }

  if (isApproval) ctx.notifier.notify({ type: "account.approved", userId: target.id });
}

/**
 * Create a one-time password reset link for someone and email it to them (when email is set up).
 * Owners also get the link back, to pass on privately if the email doesn't arrive; other admins don't.
 */
export async function sendPasswordResetLink(ctx: ServiceContext, raw: unknown): Promise<{ resetUrl: string | null }> {
  assertAdmin(ctx);
  const { userId } = parseInput(userIdInput, raw as Record<string, unknown>);
  const target = await loadUser(ctx.db, userId);
  assertCanManageAccount(ctx, target);
  if (target.status === "DISABLED") {
    throw new ConflictError("This account is disabled. Re-activate it before sending a reset link.");
  }
  const { resetUrl } = await issuePasswordReset(ctx, target.id);
  // Only owners see the link itself. Anyone else holding it could sign in as that person.
  return { resetUrl: isOwner(ctx.actor) ? resetUrl : null };
}

/** Sign someone out on every device. Returns how many sessions were ended. */
export async function revokeSessions(ctx: ServiceContext, raw: unknown): Promise<{ count: number }> {
  assertAdmin(ctx);
  const { userId } = parseInput(userIdInput, raw as Record<string, unknown>);
  const target = await loadUser(ctx.db, userId);
  if (target.id !== ctx.actor.id) assertCanManageAccount(ctx, target);
  const { count } = await ctx.db.session.deleteMany({ where: { userId: target.id } });
  return { count };
}

/**
 * Anything that would be lost (or would cascade away, e.g. leaders' answers in their threads) if the
 * account were deleted. Accounts with any of it must be disabled instead. Mirrored by getUserDetail.canDelete.
 */
export const NO_ACTIVITY = {
  tasksCreated: { none: {} },
  assignments: { none: {} },
  reviews: { none: {} },
  questionsAsked: { none: {} },
  questionReplies: { none: {} },
  partsRequested: { none: {} },
  partsClaimed: { none: {} },
  sponsorshipsCreated: { none: {} },
} satisfies Prisma.UserWhereInput;

export const HAS_ACTIVITY_MESSAGE = "This person has activity in the portal — disable the account instead.";

/** Permanently remove a sign-up that never did anything (PENDING or REJECTED, no tasks, checklist items, reviews, questions, or replies). */
export async function deleteUser(ctx: ServiceContext, raw: unknown): Promise<void> {
  assertAdmin(ctx);
  const { userId } = parseInput(userIdInput, raw as Record<string, unknown>);
  if (userId === ctx.actor.id) throw new ConflictError("You can't delete your own account.");
  const target = await ctx.db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      status: true,
      isAdmin: true,
      _count: {
        select: {
          tasksCreated: true,
          assignments: true,
          reviews: true,
          questionsAsked: true,
          questionReplies: true,
          partsRequested: true,
          partsClaimed: true,
          sponsorshipsCreated: true,
        },
      },
    },
  });
  if (!target) throw new NotFoundError("That account no longer exists.");
  assertCanManageAccount(ctx, target);
  if (target.status !== "PENDING" && target.status !== "REJECTED") {
    throw new ConflictError("Only pending or rejected sign-ups can be deleted. Disable the account instead.");
  }
  if (Object.values(target._count).some((n) => n > 0)) throw new ConflictError(HAS_ACTIVITY_MESSAGE);
  // Conditional delete guards against the account being approved (or doing something) meanwhile.
  const { count } = await ctx.db.user.deleteMany({
    where: { id: target.id, status: { in: ["PENDING", "REJECTED"] }, role: target.role, ...notOwnerUnlessOwner(ctx), ...NO_ACTIVITY },
  });
  if (count === 0) throw new ConflictError("This account changed in the meantime. Refresh and try again.");
}

// ── Email ─────────────────────────────────────────────────────────────────

export type TestEmailStatus = "SENT" | "FAILED" | "SKIPPED";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Send a branded test email to the signed-in admin and report what happened.
 * `options.transport` lets tests inject a fake; by default the configured transport is used.
 */
export async function sendTestEmail(
  ctx: ServiceContext,
  options: { transport?: EmailTransport | null } = {},
): Promise<TestEmailStatus> {
  assertAdmin(ctx);
  await enforceRateLimit(ctx.db, `admin-test-email:${ctx.actor.id}`, 5, 10 * 60 * 1000, ctx.now);

  const when = formatDateTime(ctx.now, ctx.config.teamTimezone);
  const subject = `Test email from ${APP_NAME}`;
  const text = [
    `Hi ${ctx.actor.name},`,
    "",
    `This is a test email from the ${APP_NAME} (FTC ${TEAM_NUMBER} ${TEAM_NAME}), sent ${when}.`,
    "If you can read this, email notifications are working.",
    "",
    `Open the portal: ${ctx.config.appUrl}`,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;background:#f5f8f4;font-family:Inter,Segoe UI,Arial,sans-serif;color:#18191c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8f4;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #dfe3df;border-radius:12px;overflow:hidden">
<tr><td style="background:#3A8543;padding:16px 24px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(APP_NAME)}</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6">
<p style="margin:0 0 12px">Hi ${escapeHtml(ctx.actor.name)},</p>
<p style="margin:0 0 12px">This is a test email from the ${escapeHtml(APP_NAME)}, sent ${escapeHtml(when)}.</p>
<p style="margin:0 0 20px"><strong>If you can read this, email notifications are working.</strong></p>
<a href="${escapeHtml(ctx.config.appUrl)}" style="display:inline-block;background:#3A8543;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:8px">Open the portal</a>
</td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eef0ee;color:#6d6e73;font-size:12px">FTC ${TEAM_NUMBER} ${escapeHtml(TEAM_NAME)} · You got this because you pressed “Send me a test email”.</td></tr>
</table></td></tr></table></body></html>`;

  return sendEmail(ctx.db, { to: ctx.actor.email, subject, text, html, kind: "test" }, options.transport);
}

/** Posts a test message to the leaders' Discord channel (Admin → Email log). */
export async function sendDiscordTest(ctx: ServiceContext, options: DiscordOptions = {}): Promise<DiscordStatus> {
  assertAdmin(ctx);
  await enforceRateLimit(ctx.db, `admin-test-discord:${ctx.actor.id}`, 5, 10 * 60 * 1000, ctx.now);
  return (await postToDiscord(ctx.db, testPayload(ctx.actor.name, ctx.config.appUrl), "test", options)).status;
}
