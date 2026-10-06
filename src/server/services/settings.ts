// Settings: the signed-in user's own profile, password, email preferences, team website listing, and devices.
// Everything here acts on `ctx.actor` only — no ids come from the client.
import { z } from "zod";
import type { Subteam } from "@/generated/prisma/enums";
import { LIMITS } from "@/lib/constants";
import { checkbox, nameSchema, passwordSchema } from "@/lib/validation";
import { parseInput } from "../action";
import type { Actor } from "../actor";
import { hashPassword, verifyPassword } from "../auth/password";
import type { ServiceContext } from "../context";
import type { Db } from "../db";
import { ConflictError, UnauthorizedError, ValidationError } from "../errors";
import { canAdminister, isStaff, ledSubteam } from "../permissions";
import { enforceRateLimit } from "../rate-limit";
import { holdWebsitePhotoAfterRename } from "./user-photos";

const PASSWORD_CHANGE_LIMIT = 10;
const PASSWORD_CHANGE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Session to keep signed in (the device making the request). */
export interface KeepSessionMeta {
  keepSessionTokenHash: string | null;
}

export interface NotificationPrefs {
  emailOnQuestion: boolean;
  emailOnSubmission: boolean;
  emailOnReply: boolean;
  emailOnReview: boolean;
  emailOnAssigned: boolean;
  emailOnSignup: boolean;
  emailOnResource: boolean;
}

const prefsSelect = {
  emailOnQuestion: true,
  emailOnSubmission: true,
  emailOnReply: true,
  emailOnReview: true,
  emailOnAssigned: true,
  emailOnSignup: true,
  emailOnResource: true,
} as const;

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function assertActive(actor: Actor) {
  if (actor.status !== "ACTIVE") throw new UnauthorizedError();
}

// ── Reads ─────────────────────────────────────────────────────────────────────

export interface SettingsData {
  prefs: NotificationPrefs;
  /** Signed-in sessions (not expired) other than the current device. */
  otherSessionCount: number;
  /** "Show me on the team website's progress page" (the opposite of User.hideFromPublicProgress). */
  showOnPublicProgress: boolean;
}

/** Loader for the Settings page: the actor's own preferences and how many other devices are signed in. */
export async function getSettings(
  db: Db,
  actor: Pick<Actor, "id">,
  options: { currentSessionTokenHash: string | null; now: Date },
): Promise<SettingsData | null> {
  const [row, otherSessionCount] = await Promise.all([
    db.user.findUnique({ where: { id: actor.id }, select: { ...prefsSelect, hideFromPublicProgress: true } }),
    db.session.count({ where: { ...otherSessionsWhere(actor.id, options.currentSessionTokenHash), expiresAt: { gt: options.now } } }),
  ]);
  if (!row) return null;
  const { hideFromPublicProgress, ...prefs } = row;
  return { prefs, otherSessionCount, showOnPublicProgress: !hideFromPublicProgress };
}

function otherSessionsWhere(userId: string, keepTokenHash: string | null) {
  return keepTokenHash ? { userId, tokenHash: { not: keepTokenHash } } : { userId };
}

// ── Profile ───────────────────────────────────────────────────────────────────

const profileInput = z.object({ name: nameSchema });

/**
 * Change your display name. Email and position are managed by the admin. The team website finds members' photos by
 * name, so a new name holds your photo off the website until someone who manages your account checks it
 * (holdWebsitePhotoAfterRename in ./user-photos.ts). `photoHeld`: you have a photo and it's held for a new name.
 */
export async function updateProfile(ctx: ServiceContext, raw: unknown): Promise<{ photoHeld: boolean }> {
  const { name } = parseInput(profileInput, asRecord(raw));
  assertActive(ctx.actor);
  const before = await ctx.db.user.findUnique({ where: { id: ctx.actor.id }, select: { name: true, photo: { select: { id: true } } } });
  const { count } = await ctx.db.user.updateMany({ where: { id: ctx.actor.id }, data: { name } });
  if (count === 0 || !before) throw new UnauthorizedError();
  const held = await holdWebsitePhotoAfterRename(ctx, before.name, name);
  return { photoHeld: held && before.photo !== null };
}

// ── Password ──────────────────────────────────────────────────────────────────

const passwordInput = z.object({
  currentPassword: z
    .string({ error: "Enter your current password." })
    .min(1, "Enter your current password.")
    .max(LIMITS.passwordMax, "That's not your current password."),
  newPassword: passwordSchema,
  confirmPassword: z.string({ error: "Type your new password again." }).min(1, "Type your new password again."),
});

/**
 * Change your password (you must know the current one). Signs out every other device and
 * invalidates unused password-reset links. The session `keepSessionTokenHash` stays signed in.
 */
export async function changePassword(ctx: ServiceContext, raw: unknown, meta: KeepSessionMeta): Promise<void> {
  const data = parseInput(passwordInput, asRecord(raw));
  assertActive(ctx.actor);
  if (data.newPassword !== data.confirmPassword) {
    throw new ValidationError("The new passwords don't match.", { confirmPassword: "The new passwords don't match." });
  }

  await enforceRateLimit(ctx.db, `pwchange:${ctx.actor.id}`, PASSWORD_CHANGE_LIMIT, PASSWORD_CHANGE_WINDOW_MS, ctx.now);

  const user = await ctx.db.user.findUnique({ where: { id: ctx.actor.id }, select: { passwordHash: true } });
  if (!user) throw new UnauthorizedError();
  if (!(await verifyPassword(data.currentPassword, user.passwordHash))) {
    throw new ValidationError("That's not your current password.", { currentPassword: "That's not your current password." });
  }
  if (data.newPassword.normalize("NFKC") === data.currentPassword.normalize("NFKC")) {
    const msg = "Choose a new password that's different from your current one.";
    throw new ValidationError(msg, { newPassword: msg });
  }

  const newHash = await hashPassword(data.newPassword);
  await ctx.db.$transaction(async (tx) => {
    // Conditional write: if the password changed since we verified it, don't overwrite.
    const { count } = await tx.user.updateMany({
      where: { id: ctx.actor.id, passwordHash: user.passwordHash },
      data: { passwordHash: newHash },
    });
    if (count === 0) throw new ConflictError("Your password was just changed somewhere else. Reload the page and try again.");
    await tx.session.deleteMany({ where: otherSessionsWhere(ctx.actor.id, meta.keepSessionTokenHash) });
    await tx.passwordResetToken.updateMany({ where: { userId: ctx.actor.id, usedAt: null }, data: { usedAt: ctx.now } });
  });
  ctx.notifier.notify({ type: "password.changed", userId: ctx.actor.id });
}

// ── Email notifications ───────────────────────────────────────────────────────

const prefsInput = z.object({
  emailOnReply: checkbox,
  emailOnReview: checkbox,
  emailOnAssigned: checkbox,
  emailOnQuestion: checkbox,
  emailOnSubmission: checkbox,
  emailOnSignup: checkbox,
  emailOnResource: checkbox,
});

/**
 * Whose shared resources email this person (resource.submitted, see resourceSubmittedRecipients):
 * every member's (owners), their own subteam's members' (subteam leaders), or — the captain — only
 * members with no subteam or whose subteam has no active leader. Null: never (mentors, teachers, members).
 */
export type ResourceEmailScope = { kind: "all" } | { kind: "subteam"; subteam: Subteam } | { kind: "fallback" };

export function resourceEmailScope(actor: Pick<Actor, "id" | "role" | "subteam" | "isAdmin">): ResourceEmailScope | null {
  if (actor.isAdmin) return { kind: "all" };
  const led = ledSubteam(actor);
  if (led) return { kind: "subteam", subteam: led };
  if (actor.role === "CAPTAIN") return { kind: "fallback" };
  return null;
}

/** Which preferences this person may change (others are ignored even if submitted). */
export function editablePrefKeys(actor: Pick<Actor, "id" | "role" | "subteam" | "isAdmin">): (keyof NotificationPrefs)[] {
  const keys: (keyof NotificationPrefs)[] = ["emailOnReply", "emailOnReview", "emailOnAssigned"];
  if (isStaff(actor)) keys.push("emailOnQuestion", "emailOnSubmission");
  if (canAdminister(actor)) keys.push("emailOnSignup");
  if (resourceEmailScope(actor)) keys.push("emailOnResource");
  return keys;
}

/**
 * Save email preferences from the settings form (unchecked boxes arrive missing = off).
 * Staff-only (question/submission) and admin-only (sign-up / resource approval) switches are only applied for staff/admins.
 */
export async function updateNotificationPrefs(ctx: ServiceContext, raw: unknown): Promise<void> {
  const parsed = parseInput(prefsInput, asRecord(raw));
  assertActive(ctx.actor);
  const data: Partial<NotificationPrefs> = {};
  for (const key of editablePrefKeys(ctx.actor)) data[key] = parsed[key];
  const { count } = await ctx.db.user.updateMany({ where: { id: ctx.actor.id }, data });
  if (count === 0) throw new UnauthorizedError();
}

// ── Team website ──────────────────────────────────────────────────────────────

const publicProgressInput = z.object({ show: checkbox });

/**
 * "Show me on the team website's progress page": off leaves you out of its list of people and unnamed in its
 * recent feed (your items still count toward the team's and your subteam's totals). Your own account only.
 */
export async function updatePublicProgressVisibility(ctx: ServiceContext, raw: unknown): Promise<{ show: boolean }> {
  const { show } = parseInput(publicProgressInput, asRecord(raw));
  assertActive(ctx.actor);
  const { count } = await ctx.db.user.updateMany({
    where: { id: ctx.actor.id, status: "ACTIVE" },
    data: { hideFromPublicProgress: !show },
  });
  if (count === 0) throw new UnauthorizedError();
  return { show };
}

// ── Devices ───────────────────────────────────────────────────────────────────

/** Sign out everywhere except the current device. `count` = active sessions that were ended. */
export async function signOutOtherDevices(ctx: ServiceContext, meta: KeepSessionMeta): Promise<{ count: number }> {
  assertActive(ctx.actor);
  const others = otherSessionsWhere(ctx.actor.id, meta.keepSessionTokenHash);
  const [, live] = await ctx.db.$transaction([
    // Clean up expired sessions without counting them as "devices".
    ctx.db.session.deleteMany({ where: { ...others, expiresAt: { lte: ctx.now } } }),
    ctx.db.session.deleteMany({ where: others }),
  ]);
  return { count: live.count };
}
