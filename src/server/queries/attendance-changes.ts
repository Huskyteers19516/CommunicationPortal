import "server-only";
// The attendance change log (AttendanceChange): what admins did to people's attendance (and people scanning in over
// a hand entry). Admins only
// (canViewAttendanceChanges): /attendance/changes (filters, pages, CSV), a session's History, and the two-week
// report's "Changes by admins".
import type { Prisma } from "@/generated/prisma/client";
import type { AttendanceChangeAction, AttendanceCreditKind, AttendanceKind } from "@/generated/prisma/enums";
import { dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import type { Actor } from "../actor";
import { type AttendanceChangeFilters, type AttendanceChangeKind, type AttendanceChangeRow, CHANGES_PAGE_SIZE } from "../attendance/changes";
import { prisma } from "../db";
import { canViewAttendanceChanges } from "../permissions";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;

export const changeRowSelect = {
  id: true,
  createdAt: true,
  action: true,
  sessionId: true,
  sessionDate: true,
  sessionKind: true,
  userId: true,
  userName: true,
  user: { select: { name: true } },
  changedById: true,
  changedBy: { select: { name: true } },
  fromCredit: true,
  fromKind: true,
  toCredit: true,
  toKind: true,
} as const satisfies Prisma.AttendanceChangeSelect;

type ChangeRowData = {
  id: string;
  createdAt: Date;
  action: AttendanceChangeAction;
  sessionId: string | null;
  sessionDate: Date;
  sessionKind: AttendanceKind;
  userId: string | null;
  userName: string;
  user: { name: string } | null;
  changedById: string | null;
  changedBy: { name: string } | null;
  fromCredit: number | null;
  fromKind: AttendanceCreditKind | null;
  toCredit: number | null;
  toKind: AttendanceCreditKind | null;
};

/** Rows as pages show them: the person's name as it is now (or as it was, once their account is gone). */
export function attendanceChangeRows(rows: ChangeRowData[]): AttendanceChangeRow[] {
  return rows.map(({ user, changedBy, sessionDate, ...r }) => ({
    ...r,
    sessionDate: dbToDateOnly(sessionDate),
    userName: user?.name ?? r.userName,
    changedByName: changedBy?.name ?? null,
  }));
}

/**
 * The "Kind of change" filter: "Marked not here" is ADDED as No credit (so "Added by hand" leaves those out), and
 * "Scanned in" is CREDIT_CHANGED by the person themselves (so "Credit changed" leaves those out).
 */
function kindWhere(kind: AttendanceChangeKind): Prisma.AttendanceChangeWhereInput {
  const self = { changedById: { equals: prisma.attendanceChange.fields.userId } };
  switch (kind) {
    case "ADDED":
      return { action: "ADDED", toCredit: { not: 0 } };
    case "NOT_HERE":
      return { action: "ADDED", toCredit: 0 };
    case "SCANNED_IN":
      return { action: "CREDIT_CHANGED", ...self };
    case "CREDIT_CHANGED":
      return { action: "CREDIT_CHANGED", OR: [{ changedById: null }, { userId: null }, { NOT: self }] };
    default:
      return { action: kind };
  }
}

function whereFor(f: AttendanceChangeFilters): Prisma.AttendanceChangeWhereInput {
  const where: Prisma.AttendanceChangeWhereInput = {};
  if (f.person) where.userId = f.person;
  if (f.by) where.changedById = f.by;
  if (f.action) where.AND = [kindWhere(f.action)];
  if (f.from || f.to) {
    where.sessionDate = {
      ...(f.from ? { gte: dateOnlyToDb(f.from) } : {}),
      ...(f.to ? { lte: dateOnlyToDb(f.to) } : {}),
    };
  }
  return where;
}

const newestFirst = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.AttendanceChangeOrderByWithRelationInput[];

export interface AttendanceChangePage {
  rows: AttendanceChangeRow[];
  total: number;
  page: number;
  pageCount: number;
}

/** One page of the change log (newest first) matching the filters. Null for everyone but admins. */
export async function listAttendanceChanges(actor: ActorLike, filters: AttendanceChangeFilters): Promise<AttendanceChangePage | null> {
  if (actor.status !== "ACTIVE" || !canViewAttendanceChanges(actor)) return null;
  const where = whereFor(filters);
  const total = await prisma.attendanceChange.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / CHANGES_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await prisma.attendanceChange.findMany({
    where,
    orderBy: newestFirst,
    skip: (page - 1) * CHANGES_PAGE_SIZE,
    take: CHANGES_PAGE_SIZE,
    select: changeRowSelect,
  });
  return { rows: attendanceChangeRows(rows), total, page, pageCount };
}

/** Most rows one CSV download holds (newest first). */
export const CHANGES_CSV_MAX = 10_000;

/** Every change matching the filters (newest first, up to CHANGES_CSV_MAX), for the CSV. Null for everyone but admins. */
export async function listAttendanceChangesForCsv(actor: ActorLike, filters: AttendanceChangeFilters): Promise<AttendanceChangeRow[] | null> {
  if (actor.status !== "ACTIVE" || !canViewAttendanceChanges(actor)) return null;
  const rows = await prisma.attendanceChange.findMany({ where: whereFor(filters), orderBy: newestFirst, take: CHANGES_CSV_MAX, select: changeRowSelect });
  return attendanceChangeRows(rows);
}

export interface ChangeFilterChoices {
  /** Everyone whose attendance was changed (accounts that still exist), by name. */
  people: { id: string; name: string }[];
  /** Everyone who made a change (accounts that still exist), by name. */
  admins: { id: string; name: string }[];
}

/** What the Person and "Changed by" menus offer: only people who are in the log. Null for everyone but admins. */
export async function getChangeFilterChoices(actor: ActorLike): Promise<ChangeFilterChoices | null> {
  if (actor.status !== "ACTIVE" || !canViewAttendanceChanges(actor)) return null;
  const [people, admins] = await Promise.all([
    prisma.user.findMany({ where: { attendanceChangesAbout: { some: {} } }, select: { id: true, name: true }, take: 1000 }),
    prisma.user.findMany({ where: { attendanceChangesMade: { some: {} } }, select: { id: true, name: true }, take: 1000 }),
  ]);
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  return { people: people.sort(byName), admins: admins.sort(byName) };
}
