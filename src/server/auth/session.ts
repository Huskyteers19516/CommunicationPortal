import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type Actor, actorSelect } from "../actor";
import { type Db, prisma } from "../db";
import { canAccessManage, canAdminister, canViewEmailLog } from "../permissions";
import { generateToken, hashToken } from "./tokens";

export const SESSION_COOKIE = "hk_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

/** Create a DB session and set the cookie. Call only from Server Actions / Route Handlers. */
export async function startSession(db: Db, userId: string): Promise<void> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const userAgent = (await headers()).get("user-agent")?.slice(0, 300) ?? null;
  await db.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt, userAgent } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Delete the current session + cookie. Call only from Server Actions / Route Handlers. */
export async function endSession(db: Db = prisma): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  jar.delete(SESSION_COOKIE);
}

/** sha256 of the current session cookie (to keep "this device" signed in when revoking others). */
export async function getCurrentSessionTokenHash(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? hashToken(token) : null;
}

/** The signed-in user (any account status), or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, expiresAt: true, lastUsedAt: true, user: { select: actorSelect } },
  });
  if (!session) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (now - session.lastUsedAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    const at = new Date(now);
    // Best effort, throttled so page views don't turn into writes.
    await Promise.all([
      prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: at } }),
      // Raw SQL so @updatedAt isn't bumped by mere visits.
      prisma.$executeRaw`UPDATE "User" SET "lastSeenAt" = ${at} WHERE id = ${session.user.id}`,
    ]).catch(() => {});
  }
  return session.user;
});

/** Set by src/proxy.ts on signed-in requests: the path (and query) being opened. */
const PATH_HEADER = "x-hk-path";

/** /login, with ?next= back to this page when the proxy said where we are (a stale cookie got past it). */
async function loginRedirectPath(): Promise<string> {
  const path = (await headers()).get(PATH_HEADER);
  if (!path || path === "/" || !path.startsWith("/") || path.startsWith("//") || path.length > 1000) return "/login";
  return `/login?next=${encodeURIComponent(path)}`;
}

/** For pages: an ACTIVE user, else redirect to /login (and back here afterwards) or /pending. */
export async function requireActiveUser(): Promise<Actor> {
  const user = await getCurrentUser();
  if (!user) redirect(await loginRedirectPath());
  if (user.status !== "ACTIVE") redirect("/pending");
  return user;
}

/** For Manage pages: an ACTIVE staff user (leader/captain/mentor/teacher/admin), else redirect to /today. */
export async function requireStaffUser(): Promise<Actor> {
  const user = await requireActiveUser();
  if (!canAccessManage(user)) redirect("/today");
  return user;
}

/** For Admin pages: an ACTIVE admin, else redirect to /today. */
export async function requireAdminUser(): Promise<Actor> {
  const user = await requireActiveUser();
  if (!canAdminister(user)) redirect("/today");
  return user;
}

/** For owner-only Admin pages (the email log): an ACTIVE owner, else redirect to /admin or /today. */
export async function requireOwnerUser(): Promise<Actor> {
  const user = await requireAdminUser();
  if (!canViewEmailLog(user)) redirect("/admin");
  return user;
}
