// Registration, sign-in, and password reset. These run before anyone is signed in,
// so every function takes a PublicContext (no actor) plus request metadata for rate limiting.

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { type AccountStatus, Role, Subteam } from "@/generated/prisma/enums";
import { LIMITS, subteamForRole } from "@/lib/constants";
import { emailSchema, nameSchema, passwordSchema } from "@/lib/validation";
import { formDataToObject } from "../action";
import { getDummyHash, hashPassword, verifyPassword } from "../auth/password";
import { issuePasswordReset } from "../auth/password-reset";
import { hashToken } from "../auth/tokens";
import type { PublicContext } from "../context";
import type { Db } from "../db";
import { ValidationError } from "../errors";
import { adminAccessWhere } from "../notifications/recipients";
import { consumeRateLimit, enforceRateLimit, resetRateLimit } from "../rate-limit";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Abuse limits. Per-IP limits are generous on purpose: at a team meeting everyone shares the
 * school's one public IP, and 30+ people may sign up or sign in within minutes.
 */
export const AUTH_RATE_LIMITS = {
  registerPerIp: { limit: 60, windowMs: HOUR },
  loginPerIpAndEmail: { limit: 10, windowMs: 15 * MINUTE },
  loginPerIp: { limit: 300, windowMs: 15 * MINUTE },
  /** Failed sign-ins for one account from anywhere, so rotating IPs can't give unlimited guesses. */
  loginPerAccount: { limit: 30, windowMs: HOUR },
  forgotPerIp: { limit: 20, windowMs: HOUR },
  forgotPerEmail: { limit: 3, windowMs: HOUR },
} as const;

export const AUTH_MESSAGES = {
  duplicateEmail: "An account with this email already exists.",
  wrongJoinCode: "That team code isn't right. Ask a leader for the current code.",
  missingJoinCode: "Enter the team code. Ask a leader if you don't have it.",
  badLogin: "Incorrect email or password.",
  badResetLink: "This reset link is invalid or has expired. Request a new one.",
  resetEmailSent: "If an account exists for that email, we've sent a reset link. It expires in 1 hour.",
} as const;

/** Where the request came from (used only for rate limiting). */
export interface RequestMeta {
  ip: string;
}

/** Which proxy headers can be believed. Anything a client can set itself must not be trusted. */
export interface ProxyTrust {
  /** Running on Vercel, whose edge overwrites X-Real-IP / X-Forwarded-For with the real client IP. */
  vercel: boolean;
  /** TRUST_PROXY_HEADERS=true: a reverse proxy we control replaces X-Forwarded-For. */
  trustProxyHeaders: boolean;
}

/**
 * Client IP for rate limiting. Forwarding headers are only believed where the platform sets them;
 * otherwise every client shares the "unknown" bucket (the per-IP limits are generous enough for that),
 * because a spoofed header would give each attempt a fresh bucket.
 */
export function clientIpFromHeaders(headers: { get(name: string): string | null }, trust: ProxyTrust): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0];
  const realIp = headers.get("x-real-ip");
  const candidates = trust.vercel ? [realIp, forwarded] : trust.trustProxyHeaders ? [forwarded, realIp] : [];
  for (const raw of candidates) {
    const ip = raw?.trim();
    // Only IPv4/IPv6 characters: an odd header can't smuggle arbitrary text into rate-limit keys.
    if (ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip)) return ip;
  }
  return "unknown";
}

export interface SignInResult {
  userId: string;
  status: AccountStatus;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw instanceof FormData) return formDataToObject(raw);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Rate-limit keys must stay short and predictable even if a proxy header is odd. */
function ipKey(meta: RequestMeta): string {
  const ip = (meta.ip ?? "").trim().slice(0, 64);
  return ip || "unknown";
}

function isAdminEmail(ctx: PublicContext, email: string): boolean {
  return ctx.config.adminEmails.some((e) => e.trim().toLowerCase() === email);
}

/**
 * ADMIN_EMAILS only bootstraps the first admin: it counts while the team has no ACTIVE admin.
 * After that, admins are added and removed in Admin → People, and those changes stick.
 */
async function hasActiveAdmin(db: Db): Promise<boolean> {
  return (await db.user.count({ where: { isAdmin: true, status: "ACTIVE" } })) > 0;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function confirmPasswordError(input: Record<string, unknown>): string | undefined {
  const confirm = input.confirmPassword;
  if (typeof confirm !== "string" || confirm === "") return "Type your password again to confirm it.";
  if (confirm !== input.password) return "Passwords don't match.";
  return undefined;
}

/**
 * Parse with zod and merge in cross-field errors, so the form shows every problem at once
 * (zod skips object refinements when a field has a type error). Same error shape as parseInput().
 */
function validate<T>(schema: z.ZodType<T>, input: Record<string, unknown>, extra: Record<string, string | undefined> = {}): T {
  const result = schema.safeParse(input);
  const fieldErrors: Record<string, string> = {};
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path.join(".") || "_form";
      fieldErrors[key] ??= issue.message;
    }
  }
  for (const [key, message] of Object.entries(extra)) {
    if (message) fieldErrors[key] ??= message;
  }
  const messages = Object.values(fieldErrors);
  if (result.success && messages.length === 0) return result.data;
  throw new ValidationError(messages.length === 1 ? messages[0] : "Please fix the highlighted fields.", fieldErrors);
}

/**
 * `next` is only followed if it is a same-site path. Rejects "//host", "/\host", absolute URLs,
 * and control characters/backslashes (browsers normalise those into protocol-relative URLs).
 */
export function safeRedirectPath(next: unknown): string | null {
  if (typeof next !== "string" || next.length === 0 || next.length > 1000) return null;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  for (const ch of next) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === "\\") return null;
  }
  return next;
}

// ── registration ─────────────────────────────────────────────────────────────

const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
  role: z.enum(Role, { error: "Choose your position on the team." }),
  subteam: z.preprocess((v) => (isBlank(v) ? undefined : v), z.enum(Subteam, { error: "Choose your subteam." }).optional()),
});

/**
 * Create an account.
 * - Members pick a subteam and are ACTIVE right away.
 * - Leaders get the subteam their role implies; captain/mentor/teacher get none. Both wait for admin approval (PENDING).
 * - An ADMIN_EMAILS address becomes an ACTIVE admin immediately, but only while the team has no ACTIVE
 *   admin yet (bootstraps the site owner). Later sign-ups with such an address are treated like anyone else's.
 */
export async function registerUser(ctx: PublicContext, raw: unknown, meta: RequestMeta): Promise<SignInResult> {
  const input = asRecord(raw);
  const data = validate(registerSchema, input, {
    confirmPassword: confirmPasswordError(input),
    subteam: input.role === "MEMBER" && isBlank(input.subteam) ? "Choose your subteam." : undefined,
  });

  // Counted after basic form checks (typos don't burn attempts) but before the join code, so codes can't be brute-forced.
  await enforceRateLimit(ctx.db, `register:ip:${ipKey(meta)}`, AUTH_RATE_LIMITS.registerPerIp.limit, AUTH_RATE_LIMITS.registerPerIp.windowMs, ctx.now);

  const requiredCode = ctx.config.teamJoinCode?.trim();
  if (requiredCode) {
    const given = typeof input.joinCode === "string" ? input.joinCode.trim() : "";
    if (!given) throw new ValidationError(AUTH_MESSAGES.missingJoinCode, { joinCode: AUTH_MESSAGES.missingJoinCode });
    if (!sameSecret(given.toLowerCase(), requiredCode.toLowerCase())) {
      throw new ValidationError(AUTH_MESSAGES.wrongJoinCode, { joinCode: AUTH_MESSAGES.wrongJoinCode });
    }
  }

  const duplicate = () => new ValidationError(AUTH_MESSAGES.duplicateEmail, { email: AUTH_MESSAGES.duplicateEmail });
  const existing = await ctx.db.user.findUnique({ where: { email: data.email }, select: { id: true } });
  if (existing) throw duplicate();

  const implied = subteamForRole(data.role);
  const subteam = implied === undefined ? (data.subteam ?? null) : implied;
  if (data.role === "MEMBER" && !subteam) {
    throw new ValidationError("Choose your subteam.", { subteam: "Choose your subteam." });
  }

  const isAdmin = isAdminEmail(ctx, data.email) && !(await hasActiveAdmin(ctx.db));
  const status: AccountStatus = isAdmin || data.role === "MEMBER" ? "ACTIVE" : "PENDING";

  let user: { id: string; status: AccountStatus };
  try {
    user = await ctx.db.user.create({
      data: {
        name: data.name,
        email: data.email,
        passwordHash: await hashPassword(data.password),
        role: data.role,
        subteam,
        status,
        isAdmin,
        approvedAt: isAdmin ? ctx.now : null,
      },
      select: { id: true, status: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicate(); // two sign-ups with the same email at once
    throw e;
  }

  if (user.status === "PENDING") ctx.notifier.notify({ type: "account.pending", userId: user.id });
  return { userId: user.id, status: user.status };
}

export interface PendingNotice {
  /** An admin really gets an email about new sign-ups (account.pending). */
  adminEmailed: boolean;
  /** The person will get an email when approved. */
  approvalEmailed: boolean;
}

/**
 * For /pending: what we can honestly promise someone waiting for approval. account.pending only reaches
 * ACTIVE admins with emailOnSignup, and nothing is sent at all when email isn't configured.
 */
export async function getPendingNotice(db: Db, emailConfigured: boolean): Promise<PendingNotice> {
  if (!emailConfigured) return { adminEmailed: false, approvalEmailed: false };
  const admins = await db.user.count({ where: { AND: [adminAccessWhere, { emailOnSignup: true }] } });
  return { adminEmailed: admins > 0, approvalEmailed: true };
}

// ── sign in ──────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: emailSchema,
  password: z
    .string({ error: "Enter your password." })
    .min(1, "Enter your password.")
    .max(LIMITS.passwordMax, AUTH_MESSAGES.badLogin),
});

/**
 * Check an email + password. Accounts of any status may sign in: PENDING / REJECTED / DISABLED
 * users land on /pending, which explains their state. Callers start the session.
 */
export async function authenticate(ctx: PublicContext, raw: unknown, meta: RequestMeta): Promise<SignInResult> {
  const { email, password } = validate(loginSchema, asRecord(raw));
  const ip = ipKey(meta);
  const ipAndEmailKey = `login:${ip}:${email}`;
  const accountKey = `login:acct:${email}`;
  await enforceRateLimit(ctx.db, ipAndEmailKey, AUTH_RATE_LIMITS.loginPerIpAndEmail.limit, AUTH_RATE_LIMITS.loginPerIpAndEmail.windowMs, ctx.now);
  await enforceRateLimit(ctx.db, `login:ip:${ip}`, AUTH_RATE_LIMITS.loginPerIp.limit, AUTH_RATE_LIMITS.loginPerIp.windowMs, ctx.now);
  await enforceRateLimit(ctx.db, accountKey, AUTH_RATE_LIMITS.loginPerAccount.limit, AUTH_RATE_LIMITS.loginPerAccount.windowMs, ctx.now);

  const user = await ctx.db.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, status: true, isAdmin: true, approvedAt: true },
  });
  if (!user) {
    await verifyPassword(password, await getDummyHash()); // keep timing close to a real check
    throw new ValidationError(AUTH_MESSAGES.badLogin);
  }
  if (!(await verifyPassword(password, user.passwordHash))) throw new ValidationError(AUTH_MESSAGES.badLogin);
  // Right password: only failed attempts should count toward this account's lockouts.
  await resetRateLimit(ctx.db, ipAndEmailKey);
  await resetRateLimit(ctx.db, accountKey);

  // Bootstrap: with no ACTIVE admin at all, an ADMIN_EMAILS account (even one that predates the setting)
  // becomes the admin. Once an admin exists, their decisions stick, and a DISABLED account is never revived.
  if (user.status !== "DISABLED" && isAdminEmail(ctx, email) && !(await hasActiveAdmin(ctx.db))) {
    await ctx.db.user.update({
      where: { id: user.id },
      data: { isAdmin: true, status: "ACTIVE", approvedAt: user.approvedAt ?? ctx.now },
    });
    return { userId: user.id, status: "ACTIVE" };
  }
  return { userId: user.id, status: user.status };
}

// ── password reset ───────────────────────────────────────────────────────────

const forgotSchema = z.object({ email: emailSchema });

/**
 * "Forgot password": emails a one-time link if the account exists and isn't disabled.
 * Always resolves the same way so nobody can probe which emails have accounts.
 */
export async function requestPasswordReset(ctx: PublicContext, raw: unknown, meta: RequestMeta): Promise<void> {
  const { email } = validate(forgotSchema, asRecord(raw));
  await enforceRateLimit(ctx.db, `forgot:ip:${ipKey(meta)}`, AUTH_RATE_LIMITS.forgotPerIp.limit, AUTH_RATE_LIMITS.forgotPerIp.windowMs, ctx.now);
  // Per-email cap: stay silent (an error here would reveal that we're tracking that address).
  if (!(await consumeRateLimit(ctx.db, `forgot:email:${email}`, AUTH_RATE_LIMITS.forgotPerEmail.limit, AUTH_RATE_LIMITS.forgotPerEmail.windowMs, ctx.now))) return;

  const user = await ctx.db.user.findUnique({ where: { email }, select: { id: true, status: true } });
  if (!user || user.status === "DISABLED") return;
  await issuePasswordReset(ctx, user.id);
}

export type ResetTokenStatus = "valid" | "invalid" | "expired";

/** For the reset page: is this link still usable? Used or unknown tokens are "invalid". */
export async function getResetTokenStatus(db: Db, token: string | null | undefined, now: Date): Promise<ResetTokenStatus> {
  const value = typeof token === "string" ? token.trim() : "";
  if (!value || value.length > 200) return "invalid";
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(value) },
    select: { usedAt: true, expiresAt: true },
  });
  if (!row || row.usedAt) return "invalid";
  return row.expiresAt.getTime() <= now.getTime() ? "expired" : "valid";
}

const resetSchema = z.object({ password: passwordSchema });

/**
 * Set a new password from a reset link. The token is single-use; all of the user's other links
 * are invalidated and every session is signed out (the caller signs this device back in).
 */
export async function resetPassword(ctx: PublicContext, raw: unknown): Promise<SignInResult> {
  const input = asRecord(raw);
  const token = typeof input.token === "string" ? input.token.trim() : "";
  // Check the link first: no point making someone fix their password for a dead link.
  if ((await getResetTokenStatus(ctx.db, token, ctx.now)) !== "valid") throw new ValidationError(AUTH_MESSAGES.badResetLink);

  const { password } = validate(resetSchema, input, { confirmPassword: confirmPasswordError(input) });
  const passwordHash = await hashPassword(password);
  const tokenHash = hashToken(token);

  const result = await ctx.db.$transaction(async (tx) => {
    // Conditional claim: two tabs submitting the same link can't both succeed.
    const row = await tx.passwordResetToken.findUnique({ where: { tokenHash }, select: { id: true, userId: true } });
    const claimed = row
      ? await tx.passwordResetToken.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { gt: ctx.now } },
          data: { usedAt: ctx.now },
        })
      : { count: 0 };
    if (!row || claimed.count === 0) throw new ValidationError(AUTH_MESSAGES.badResetLink);

    const user = await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash },
      select: { id: true, status: true, email: true },
    });
    await tx.passwordResetToken.updateMany({ where: { userId: row.userId, usedAt: null }, data: { usedAt: ctx.now } });
    await tx.session.deleteMany({ where: { userId: row.userId } });
    // Proving control of the mailbox also lifts the account-level sign-in lockout.
    await tx.rateLimit.deleteMany({ where: { key: `login:acct:${user.email}` } });
    return { userId: user.id, status: user.status };
  });
  ctx.notifier.notify({ type: "password.changed", userId: result.userId });
  return result;
}
