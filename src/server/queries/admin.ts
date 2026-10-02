import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { AccountStatus, type AssignmentStatus, type EmailStatus, Role, Subteam } from "@/generated/prisma/enums";
import { ROLE_LABELS, SEAT_LIMITS } from "@/lib/constants";
import { cleanSearchText } from "@/lib/search";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { env } from "../env";
import { ForbiddenError } from "../errors";
import { canAdminister, canManageAccount, canViewEmailLog } from "../permissions";
import { NO_ACTIVITY } from "../services/admin";

// Read-only loaders for the Admin area. Pages call requireAdminUser() first; these re-check anyway.
// `db` defaults to the app singleton (tests pass their own).

export const ADMIN_PAGE_SIZE = 50;

function assertAdmin(actor: Actor) {
  if (!canAdminister(actor)) throw new ForbiddenError();
}

function pageInfo(total: number, requested: number) {
  const pageCount = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  const page = Math.min(Math.max(1, requested), pageCount);
  return { page, pageCount, skip: (page - 1) * ADMIN_PAGE_SIZE };
}

// ── Approvals page ──────────────────────────────────────────────────────────

export interface PendingUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  subteam: Subteam | null;
  isAdmin: boolean;
  createdAt: Date;
}

/** Sign-ups waiting for approval, oldest first (capped at 50; `total` is the full count). */
export async function getPendingUsers(actor: Actor, db: Db = prisma): Promise<{ users: PendingUser[]; total: number }> {
  assertAdmin(actor);
  const where: Prisma.UserWhereInput = { status: "PENDING" };
  const [users, total] = await Promise.all([
    db.user.findMany({
      where,
      select: { id: true, name: true, email: true, role: true, subteam: true, isAdmin: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: ADMIN_PAGE_SIZE,
    }),
    db.user.count({ where }),
  ]);
  return { users, total };
}

export interface SeatUsage {
  role: Role;
  label: string;
  limit: number;
  filled: number;
  holders: { id: string; name: string }[];
}

/** For each limited leadership role: the limit, how many ACTIVE people hold it, and who. */
export async function getSeatUsage(actor: Actor, db: Db = prisma): Promise<SeatUsage[]> {
  assertAdmin(actor);
  const roles = (Object.keys(SEAT_LIMITS) as Role[]).filter((r) => SEAT_LIMITS[r] !== undefined);
  const holders = await db.user.findMany({
    where: { status: "ACTIVE", role: { in: roles } },
    select: { id: true, name: true, role: true },
    orderBy: { name: "asc" },
  });
  return roles.map((role) => {
    const people = holders.filter((h) => h.role === role).map(({ id, name }) => ({ id, name }));
    return { role, label: ROLE_LABELS[role], limit: SEAT_LIMITS[role] ?? 0, filled: people.length, holders: people };
  });
}

export interface RecentDecision {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
  status: AccountStatus;
  decision: "APPROVED" | "REJECTED";
  decidedAt: Date;
  decidedBy: string | null;
}

/**
 * The latest approvals (approvedAt) and rejections (updatedAt), newest first.
 * Rejections have no decision timestamp of their own; updatedAt is close enough because sign-ins
 * (lastSeenAt) don't bump it, only later edits to the account do.
 */
export async function getRecentDecisions(actor: Actor, limit = 10, db: Db = prisma): Promise<RecentDecision[]> {
  assertAdmin(actor);
  const take = Math.min(Math.max(1, limit), 50);
  const select = {
    id: true,
    name: true,
    role: true,
    subteam: true,
    status: true,
    approvedAt: true,
    updatedAt: true,
    approvedBy: { select: { name: true } },
  } as const;
  const [approved, rejected] = await Promise.all([
    db.user.findMany({ where: { approvedAt: { not: null } }, select, orderBy: { approvedAt: "desc" }, take }),
    db.user.findMany({ where: { status: "REJECTED" }, select, orderBy: { updatedAt: "desc" }, take }),
  ]);
  const rows: RecentDecision[] = [
    ...approved
      // A person approved earlier and rejected later shows up once, as rejected.
      .filter((u) => u.status !== "REJECTED")
      .map((u) => ({ ...base(u), decision: "APPROVED" as const, decidedAt: u.approvedAt!, decidedBy: u.approvedBy?.name ?? null })),
    ...rejected.map((u) => ({ ...base(u), decision: "REJECTED" as const, decidedAt: u.updatedAt, decidedBy: null })),
  ];
  return rows.sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime()).slice(0, take);

  function base(u: { id: string; name: string; role: Role; subteam: Subteam | null; status: AccountStatus }) {
    return { id: u.id, name: u.name, role: u.role, subteam: u.subteam, status: u.status };
  }
}

// ── People ─────────────────────────────────────────────────────────────────

export interface UserFilters {
  q?: string;
  status?: AccountStatus;
  role?: Role;
  subteam?: Subteam;
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function pickEnum<T extends string>(values: Record<string, T>, v: string | undefined): T | undefined {
  return v && (Object.values(values) as string[]).includes(v) ? (v as T) : undefined;
}

function parsePageParam(v: string | undefined): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 10_000) : 1;
}

/** Read People filters from the URL, ignoring anything unexpected. */
export function parseUserFilters(sp: SearchParams): UserFilters {
  return {
    q: cleanSearchText(first(sp.q), 100),
    status: pickEnum(AccountStatus, first(sp.status)),
    role: pickEnum(Role, first(sp.role)),
    subteam: pickEnum(Subteam, first(sp.subteam)),
    page: parsePageParam(first(sp.page)),
  };
}

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  role: Role;
  subteam: Subteam | null;
  status: AccountStatus;
  isAdmin: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
}

export interface UserListResult {
  users: UserListItem[];
  total: number;
  page: number;
  pageCount: number;
}

/** Everyone matching the filters: PENDING sign-ups first, then by name. 50 per page. */
export async function listUsers(actor: Actor, filters: UserFilters, db: Db = prisma): Promise<UserListResult> {
  assertAdmin(actor);
  const and: Prisma.UserWhereInput[] = [];
  const q = filters.q?.trim();
  if (q) {
    and.push({
      OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }],
    });
  }
  if (filters.status) and.push({ status: filters.status });
  if (filters.role) and.push({ role: filters.role });
  if (filters.subteam) and.push({ subteam: filters.subteam });
  const where: Prisma.UserWhereInput = { AND: and };
  const pendingWhere: Prisma.UserWhereInput = { AND: [...and, { status: "PENDING" }] };
  const restWhere: Prisma.UserWhereInput = { AND: [...and, { status: { not: "PENDING" } }] };

  const [total, pendingTotal] = await Promise.all([db.user.count({ where }), db.user.count({ where: pendingWhere })]);
  const { page, pageCount, skip } = pageInfo(total, filters.page);

  const select = {
    id: true,
    name: true,
    email: true,
    role: true,
    subteam: true,
    status: true,
    isAdmin: true,
    lastSeenAt: true,
    createdAt: true,
  } as const;
  const orderBy: Prisma.UserOrderByWithRelationInput[] = [{ name: "asc" }, { id: "asc" }];

  // Page through "pending" then "everyone else" as if they were one list.
  const pending =
    skip < pendingTotal
      ? await db.user.findMany({ where: pendingWhere, select, orderBy, skip, take: ADMIN_PAGE_SIZE })
      : [];
  const remaining = ADMIN_PAGE_SIZE - pending.length;
  const rest =
    remaining > 0
      ? await db.user.findMany({
          where: restWhere,
          select,
          orderBy,
          skip: Math.max(0, skip - pendingTotal),
          take: remaining,
        })
      : [];

  return { users: [...pending, ...rest], total, page, pageCount };
}

export interface UserDetail {
  id: string;
  name: string;
  email: string;
  role: Role;
  subteam: Subteam | null;
  status: AccountStatus;
  isAdmin: boolean;
  lastSeenAt: Date | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedBy: string | null;
  /** Checklist items by status. To do / waiting / needs changes only count tasks that aren't marked finished. */
  assignments: Record<AssignmentStatus, number>;
  /** Items not approved when a leader marked their task finished (closed, no credit). */
  closedAssignments: number;
  tasksCreated: number;
  questionsAsked: number;
  activeSessions: number;
  /** Created tasks, has checklist items, reviewed, asked, or replied: deleting would lose that, so disable instead. */
  hasActivity: boolean;
  /** Delete is only for PENDING/REJECTED accounts with no activity at all (and never yourself). Mirrors deleteUser. */
  canDelete: boolean;
  /** The actor may change this account (owners' accounts: owners only). Mirrors canManageAccount. */
  canManage: boolean;
  isSelf: boolean;
  /** The email is listed in ADMIN_EMAILS (only matters before the first admin exists). */
  inAdminEmails: boolean;
}

/** One person with activity counts, or null if the id doesn't exist. */
export async function getUserDetail(actor: Actor, id: string, db: Db = prisma, now: Date = new Date()): Promise<UserDetail | null> {
  assertAdmin(actor);
  if (!id || id.length > 64) return null;
  const [user, byStatus, closedAssignments, activeSessions, noActivity] = await Promise.all([
    db.user.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        subteam: true,
        status: true,
        isAdmin: true,
        lastSeenAt: true,
        createdAt: true,
        approvedAt: true,
        approvedBy: { select: { name: true } },
        _count: { select: { tasksCreated: true, questionsAsked: true } },
      },
    }),
    // Approved items count wherever they are; the rest only on tasks still open.
    db.taskAssignment.groupBy({
      by: ["status"],
      where: { userId: id, OR: [{ status: "APPROVED" }, { task: { completedAt: null } }] },
      _count: { _all: true },
    }),
    db.taskAssignment.count({ where: { userId: id, status: { not: "APPROVED" }, task: { completedAt: { not: null } } } }),
    db.session.count({ where: { userId: id, expiresAt: { gt: now } } }),
    // Same condition deleteUser's conditional delete uses.
    db.user.count({ where: { id, ...NO_ACTIVITY } }),
  ]);
  if (!user) return null;

  const assignments: Record<AssignmentStatus, number> = { TODO: 0, SUBMITTED: 0, APPROVED: 0, REJECTED: 0 };
  for (const row of byStatus) assignments[row.status] = row._count._all;
  const isSelf = user.id === actor.id;
  const tasksCreated = user._count.tasksCreated;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    subteam: user.subteam,
    status: user.status,
    isAdmin: user.isAdmin,
    lastSeenAt: user.lastSeenAt,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt,
    approvedBy: user.approvedBy?.name ?? null,
    assignments,
    closedAssignments,
    tasksCreated,
    questionsAsked: user._count.questionsAsked,
    activeSessions,
    hasActivity: noActivity === 0,
    canDelete:
      !isSelf && canManageAccount(actor, user) && (user.status === "PENDING" || user.status === "REJECTED") && noActivity === 1,
    canManage: isSelf || canManageAccount(actor, user),
    isSelf,
    inAdminEmails: env.adminEmails.includes(user.email.toLowerCase()),
  };
}

// ── Email ──────────────────────────────────────────────────────────────────

export interface EmailLogFilters {
  status?: EmailStatus;
  page: number;
}

export function parseEmailLogFilters(sp: SearchParams): EmailLogFilters {
  return {
    status: pickEnum({ SENT: "SENT", FAILED: "FAILED", SKIPPED: "SKIPPED" } as Record<string, EmailStatus>, first(sp.status)),
    page: parsePageParam(first(sp.page)),
  };
}

export interface EmailLogItem {
  id: string;
  to: string;
  subject: string;
  kind: string;
  status: EmailStatus;
  error: string | null;
  createdAt: Date;
}

/** Outgoing email attempts, newest first, 50 per page. */
export async function listEmailLogs(
  actor: Actor,
  filters: EmailLogFilters,
  db: Db = prisma,
): Promise<{ logs: EmailLogItem[]; total: number; page: number; pageCount: number }> {
  if (!canViewEmailLog(actor)) throw new ForbiddenError();
  const where: Prisma.EmailLogWhereInput = filters.status ? { status: filters.status } : {};
  const total = await db.emailLog.count({ where });
  const { page, pageCount, skip } = pageInfo(total, filters.page);
  const logs = await db.emailLog.findMany({
    where,
    select: { id: true, to: true, subject: true, kind: true, status: true, error: true, createdAt: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip,
    take: ADMIN_PAGE_SIZE,
  });
  return { logs, total, page, pageCount };
}

export interface EmailConfigStatus {
  mode: "smtp" | "resend" | "none";
  /** Human description — never contains passwords or API keys. */
  detail: string;
  from: string;
  appUrl: string;
  adminEmails: string[];
}

/** Which email provider is configured (from env). Secrets are never included. */
export function getEmailConfigStatus(actor: Actor): EmailConfigStatus {
  assertAdmin(actor);
  const smtp = env.smtp;
  const common = { from: env.emailFrom, appUrl: env.appUrl, adminEmails: env.adminEmails };
  if (smtp) {
    return {
      mode: "smtp",
      detail: `SMTP server ${smtp.host}:${smtp.port}${smtp.user ? " (with login)" : " (no login)"}`,
      ...common,
    };
  }
  if (env.resendApiKey) return { mode: "resend", detail: "Resend API key is set.", ...common };
  return { mode: "none", detail: "No email provider is set up, so emails are only written to the log.", ...common };
}
