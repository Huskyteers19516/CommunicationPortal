// Read-only dashboards for staff: the Manage overview and team/member progress.
// Every query applies the scope helpers, so a subteam leader only ever sees their own people/tasks.
// Counting is done with count/groupBy in a fixed number of queries (never one query per person).
// Tasks a leader marked finished: approved items count as approved; the rest are "closed" — still part of the
// total (so completion rates stay honest), but neither done, waiting, nor overdue.
import "server-only";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { AssignmentStatus, type Priority, type Role, Subteam } from "@/generated/prisma/enums";
import { SUBTEAMS } from "@/lib/constants";
import { addDays, dateOnlyToDb, type DateOnly, dbToDateOnly } from "@/lib/dates";
import { idSchema } from "@/lib/validation";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { isClosedItem } from "../domain/assignment";
import { canAccessManage, canManageTask, canViewMemberProgress, hasAllScope, ledSubteam } from "../permissions";
import { manageableMembersWhere, manageableTasksWhere, questionInboxWhere, reviewQueueWhere } from "../scopes";

// ---------------------------------------------------------------------------
// Ranges & shared helpers
// ---------------------------------------------------------------------------

export const PROGRESS_RANGES = ["today", "week", "month"] as const;
export type ProgressRange = (typeof PROGRESS_RANGES)[number];
export const DEFAULT_PROGRESS_RANGE: ProgressRange = "week";

/** Items still on the person's plate. Overdue = one of these with a due date before today, on an open task. */
const OPEN_STATUSES: AssignmentStatus[] = [AssignmentStatus.TODO, AssignmentStatus.REJECTED];

/** Not marked finished. */
const OPEN_TASK = { completedAt: null } satisfies Prisma.TaskWhereInput;
const FINISHED_TASK = { completedAt: { not: null } } satisfies Prisma.TaskWhereInput;

const rangeSchema = z.enum(PROGRESS_RANGES);
const subteamSchema = z.enum(Subteam);

const first = (value: unknown) => (Array.isArray(value) ? value[0] : value);

/** `?range=` -> a valid range (falls back to the default for anything unexpected). */
export function parseProgressRange(value: unknown): ProgressRange {
  const parsed = rangeSchema.safeParse(first(value));
  return parsed.success ? parsed.data : DEFAULT_PROGRESS_RANGE;
}

/** `?subteam=` -> a Subteam, or undefined for "all" / anything unexpected. */
export function parseSubteamFilter(value: unknown): Subteam | undefined {
  const parsed = subteamSchema.safeParse(first(value));
  return parsed.success ? parsed.data : undefined;
}

/**
 * Inclusive calendar-day bounds for a range, ending today.
 * today = [today]; week = today-6..today (7 days); month = today-29..today (30 days).
 */
export function progressRangeBounds(range: ProgressRange, today: DateOnly): { from: DateOnly; to: DateOnly } {
  const back = range === "today" ? 0 : range === "week" ? 6 : 29;
  return { from: addDays(today, -back), to: today };
}

/** Approved share of all items as a whole percentage, or null when there is nothing to count. */
export function completionRate(approved: number, total: number): number | null {
  return total > 0 ? Math.round((approved / total) * 100) : null;
}

export interface StatusCounts {
  total: number;
  approved: number;
  /** Submitted / rejected / todo only count items of tasks that aren't marked finished. */
  submitted: number;
  rejected: number;
  todo: number;
  /** Not approved when the task was marked finished: closed, no credit. */
  closed: number;
}

function emptyCounts(): StatusCounts {
  return { total: 0, approved: 0, submitted: 0, rejected: 0, todo: 0, closed: 0 };
}

/** `finished` = the item's task is marked finished. */
function addStatus(counts: StatusCounts, status: AssignmentStatus, n: number, finished = false) {
  counts.total += n;
  if (status === "APPROVED") counts.approved += n;
  else if (finished) counts.closed += n;
  else if (status === "SUBMITTED") counts.submitted += n;
  else if (status === "REJECTED") counts.rejected += n;
  else counts.todo += n;
}

function addCounts(into: StatusCounts, from: StatusCounts) {
  into.total += from.total;
  into.approved += from.approved;
  into.submitted += from.submitted;
  into.rejected += from.rejected;
  into.todo += from.todo;
  into.closed += from.closed;
}

export interface PersonRef {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
}

const personSelect = { id: true, name: true, role: true, subteam: true } as const;

/** Sort people by subteam (Software, Build, Business, then no subteam), then by name. */
function comparePeople(a: PersonRef, b: PersonRef): number {
  const rank = (s: Subteam | null) => (s ? SUBTEAMS.indexOf(s) : SUBTEAMS.length);
  return (
    rank(a.subteam) - rank(b.subteam) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    a.id.localeCompare(b.id)
  );
}

// ---------------------------------------------------------------------------
// Overview (/manage)
// ---------------------------------------------------------------------------

export interface TodaysTask {
  id: string;
  title: string;
  subteam: Subteam | null;
  priority: Priority;
  /** A leader marked the whole task finished. */
  finished: boolean;
  counts: StatusCounts;
}

export interface AttentionPerson extends PersonRef {
  overdueCount: number;
}

export interface ActivityItem {
  /** Assignment id. */
  id: string;
  status: AssignmentStatus;
  /** submittedAt for submissions, reviewedAt for approvals / send-backs. */
  at: Date;
  person: PersonRef;
  reviewerName: string | null;
  task: { id: string; title: string };
  /** The actor can open /manage/tasks/{task.id}. */
  canManageTask: boolean;
  /** The actor can open /manage/progress/{person.id}. */
  canViewPerson: boolean;
}

export interface Overview {
  /**
   * Submissions waiting for this actor's review — the same reviewQueueWhere as /manage/review and the nav
   * badge (for subteam leaders this includes their own members' items on whole-team tasks).
   */
  reviewQueueCount: number;
  openQuestionCount: number;
  dueToday: { total: number; approved: number; submitted: number };
  overdueOpenCount: number;
  /** Up to 20 manageable tasks due today, high priority first. */
  todaysTasks: TodaysTask[];
  /** How many manageable tasks are due today in total (may exceed todaysTasks.length). */
  todaysTaskTotal: number;
  /** Top 5 in-scope people by overdue open items. */
  attention: AttentionPerson[];
  /**
   * Latest 10 submissions / reviews in scope, newest first. Items approved by "Mark task finished" aren't reviews
   * one by one, so they're left out (one task could otherwise fill the list).
   */
  recentActivity: ActivityItem[];
}

const TODAYS_TASKS_MAX = 20;
const ATTENTION_MAX = 5;
const ACTIVITY_MAX = 10;

const activitySelect = {
  id: true,
  status: true,
  submittedAt: true,
  reviewedAt: true,
  user: { select: personSelect },
  reviewedBy: { select: { name: true } },
  task: { select: { id: true, title: true, subteam: true, createdById: true } },
} satisfies Prisma.TaskAssignmentSelect;

export async function getOverview(actor: Actor, today: DateOnly, db: Db = prisma): Promise<Overview> {
  const todayDb = dateOnlyToDb(today);
  const people = manageableMembersWhere(actor);
  const todaysTasksWhere: Prisma.TaskWhereInput = { AND: [manageableTasksWhere(actor), { dueDate: todayDb }] };
  const overdueWhere: Prisma.TaskAssignmentWhereInput = {
    user: people,
    status: { in: OPEN_STATUSES },
    task: { dueDate: { lt: todayDb }, ...OPEN_TASK },
  };
  // Activity on tasks the actor manages, plus activity of the people they look after.
  const activityScope: Prisma.TaskAssignmentWhereInput = { OR: [{ task: manageableTasksWhere(actor) }, { user: people }] };

  const [
    reviewQueueCount,
    openQuestionCount,
    dueTodayGroups,
    dueTodayFinishedGroups,
    overdueOpenCount,
    taskRows,
    todaysTaskTotal,
    taskStatusGroups,
    attentionGroups,
    recentSubmitted,
    recentReviewed,
  ] = await Promise.all([
    db.taskAssignment.count({ where: reviewQueueWhere(actor) }),
    db.question.count({ where: { AND: [questionInboxWhere(actor), { status: "OPEN" }] } }),
    db.taskAssignment.groupBy({
      by: ["status"],
      where: { user: people, task: { dueDate: todayDb, ...OPEN_TASK } },
      _count: { _all: true },
    }),
    db.taskAssignment.groupBy({
      by: ["status"],
      where: { user: people, task: { dueDate: todayDb, ...FINISHED_TASK } },
      _count: { _all: true },
    }),
    db.taskAssignment.count({ where: overdueWhere }),
    db.task.findMany({
      where: todaysTasksWhere,
      select: { id: true, title: true, subteam: true, priority: true, completedAt: true },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }, { id: "asc" }],
      take: TODAYS_TASKS_MAX,
    }),
    db.task.count({ where: todaysTasksWhere }),
    db.taskAssignment.groupBy({
      by: ["taskId", "status"],
      where: { task: todaysTasksWhere },
      _count: { _all: true },
    }),
    db.taskAssignment.groupBy({
      by: ["userId"],
      where: overdueWhere,
      _count: { userId: true },
      orderBy: [{ _count: { userId: "desc" } }, { userId: "asc" }],
      take: ATTENTION_MAX,
    }),
    db.taskAssignment.findMany({
      where: { AND: [activityScope, { status: "SUBMITTED", submittedAt: { not: null } }] },
      select: activitySelect,
      orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
      take: ACTIVITY_MAX,
    }),
    db.taskAssignment.findMany({
      where: {
        AND: [activityScope, { status: { in: ["APPROVED", "REJECTED"] }, reviewedAt: { not: null }, finishedWithTask: false }],
      },
      select: activitySelect,
      orderBy: [{ reviewedAt: "desc" }, { id: "asc" }],
      take: ACTIVITY_MAX,
    }),
  ]);

  const dueToday = emptyCounts();
  for (const g of dueTodayGroups) addStatus(dueToday, g.status, g._count._all);
  for (const g of dueTodayFinishedGroups) addStatus(dueToday, g.status, g._count._all, true);

  const finishedTasks = new Set(taskRows.filter((t) => t.completedAt !== null).map((t) => t.id));
  const perTask = new Map<string, StatusCounts>();
  for (const g of taskStatusGroups) {
    let counts = perTask.get(g.taskId);
    if (!counts) perTask.set(g.taskId, (counts = emptyCounts()));
    addStatus(counts, g.status, g._count._all, finishedTasks.has(g.taskId));
  }
  const todaysTasks: TodaysTask[] = taskRows.map(({ completedAt, ...t }) => ({
    ...t,
    finished: completedAt !== null,
    counts: perTask.get(t.id) ?? emptyCounts(),
  }));

  const attentionIds = attentionGroups.map((g) => g.userId);
  const attentionUsers = attentionIds.length
    ? await db.user.findMany({ where: { id: { in: attentionIds } }, select: personSelect })
    : [];
  const byId = new Map(attentionUsers.map((u) => [u.id, u]));
  const attention: AttentionPerson[] = [];
  for (const g of attentionGroups) {
    const user = byId.get(g.userId);
    if (user) attention.push({ ...user, overdueCount: g._count.userId });
  }

  type ActivityRow = (typeof recentSubmitted)[number];
  const toActivity = (row: ActivityRow, at: Date): ActivityItem => ({
    id: row.id,
    status: row.status,
    at,
    person: row.user,
    reviewerName: row.reviewedBy?.name ?? null,
    task: { id: row.task.id, title: row.task.title },
    canManageTask: canManageTask(actor, row.task),
    canViewPerson: canViewMemberProgress(actor, row.user),
  });
  const recentActivity = [
    ...recentSubmitted.flatMap((r) => (r.submittedAt ? [toActivity(r, r.submittedAt)] : [])),
    ...recentReviewed.flatMap((r) => (r.reviewedAt ? [toActivity(r, r.reviewedAt)] : [])),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id))
    .slice(0, ACTIVITY_MAX);

  return {
    reviewQueueCount,
    openQuestionCount,
    dueToday: { total: dueToday.total, approved: dueToday.approved, submitted: dueToday.submitted },
    overdueOpenCount,
    todaysTasks,
    todaysTaskTotal,
    attention,
    recentActivity,
  };
}

// ---------------------------------------------------------------------------
// Team progress (/manage/progress)
// ---------------------------------------------------------------------------

export interface ProgressSummary extends StatusCounts {
  /** Open items (to do / sent back) due before today on tasks not marked finished — regardless of the range. */
  overdue: number;
  /** Approved share in percent, null when there are no items in the range. */
  completionRate: number | null;
}

export interface TeamProgressRow extends ProgressSummary {
  user: PersonRef & { lastSeenAt: Date | null };
}

export interface SubteamProgress extends ProgressSummary {
  /** null = people without a subteam (captain, mentors, teachers). */
  subteam: Subteam | null;
  people: number;
}

export interface TeamProgress {
  range: ProgressRange;
  from: DateOnly;
  to: DateOnly;
  /** The subteam filter actually applied (always the led subteam for subteam leaders). */
  subteam: Subteam | null;
  /** Only all-scope staff may switch subteams. */
  canFilterSubteam: boolean;
  /** One page of people (50 per page), sorted by subteam then name. */
  rows: TeamProgressRow[];
  page: number;
  pageCount: number;
  /** People matching the current filter (across all pages). */
  peopleCount: number;
  /** Totals for everyone matching the current filter. */
  totals: ProgressSummary;
  /** Per-subteam totals for the summary strip (not affected by the subteam filter). */
  subteams: SubteamProgress[];
}

export const TEAM_PROGRESS_PAGE_SIZE = 50;
/** Hard cap on people loaded — the team is ~40, this only guards against runaway data. */
const PEOPLE_CAP = 1000;

function summarize(counts: StatusCounts, overdue: number): ProgressSummary {
  return { ...counts, overdue, completionRate: completionRate(counts.approved, counts.total) };
}

export async function getTeamProgress(
  actor: Actor,
  options: { range?: unknown; subteam?: unknown; page?: number },
  today: DateOnly,
  db: Db = prisma,
): Promise<TeamProgress> {
  const range = parseProgressRange(options.range);
  const { from, to } = progressRangeBounds(range, today);
  const allScope = hasAllScope(actor);
  // Subteam leaders are locked to their own subteam no matter what the URL says.
  const subteam = allScope ? (parseSubteamFilter(options.subteam) ?? null) : ledSubteam(actor);

  const people = manageableMembersWhere(actor);
  const due = { gte: dateOnlyToDb(from), lte: dateOnlyToDb(to) };
  const [users, rangeGroups, rangeFinishedGroups, overdueGroups] = await Promise.all([
    db.user.findMany({
      where: people,
      select: { ...personSelect, lastSeenAt: true },
      orderBy: { name: "asc" },
      take: PEOPLE_CAP,
    }),
    db.taskAssignment.groupBy({
      by: ["userId", "status"],
      where: { user: people, task: { dueDate: due, ...OPEN_TASK } },
      _count: { _all: true },
    }),
    db.taskAssignment.groupBy({
      by: ["userId", "status"],
      where: { user: people, task: { dueDate: due, ...FINISHED_TASK } },
      _count: { _all: true },
    }),
    db.taskAssignment.groupBy({
      by: ["userId"],
      where: { user: people, status: { in: OPEN_STATUSES }, task: { dueDate: { lt: dateOnlyToDb(today) }, ...OPEN_TASK } },
      _count: { _all: true },
    }),
  ]);

  const countsByUser = new Map<string, StatusCounts>();
  const addGroups = (groups: typeof rangeGroups, finished: boolean) => {
    for (const g of groups) {
      let counts = countsByUser.get(g.userId);
      if (!counts) countsByUser.set(g.userId, (counts = emptyCounts()));
      addStatus(counts, g.status, g._count._all, finished);
    }
  };
  addGroups(rangeGroups, false);
  addGroups(rangeFinishedGroups, true);
  const overdueByUser = new Map(overdueGroups.map((g) => [g.userId, g._count._all]));

  const allRows: TeamProgressRow[] = [...users].sort(comparePeople).map((user) => ({
    user,
    ...summarize(countsByUser.get(user.id) ?? emptyCounts(), overdueByUser.get(user.id) ?? 0),
  }));

  // Summary strip: every subteam in scope (all three for all-scope staff), plus "no subteam"
  // (captain/mentors/teachers) only when those people actually have items.
  const groups: (Subteam | null)[] = allScope ? [...SUBTEAMS, null] : subteam ? [subteam] : [];
  const subteams: SubteamProgress[] = [];
  for (const group of groups) {
    const rows = allRows.filter((r) => r.user.subteam === group);
    const counts = emptyCounts();
    let overdue = 0;
    for (const r of rows) {
      addCounts(counts, r);
      overdue += r.overdue;
    }
    if (group === null && counts.total === 0 && overdue === 0) continue;
    subteams.push({ subteam: group, people: rows.length, ...summarize(counts, overdue) });
  }

  const filtered = subteam ? allRows.filter((r) => r.user.subteam === subteam) : allRows;
  const totalCounts = emptyCounts();
  let totalOverdue = 0;
  for (const r of filtered) {
    addCounts(totalCounts, r);
    totalOverdue += r.overdue;
  }

  const pageCount = Math.max(1, Math.ceil(filtered.length / TEAM_PROGRESS_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(options.page ?? 1) || 1), pageCount);
  const rows = filtered.slice((page - 1) * TEAM_PROGRESS_PAGE_SIZE, page * TEAM_PROGRESS_PAGE_SIZE);

  return {
    range,
    from,
    to,
    subteam,
    canFilterSubteam: allScope,
    rows,
    page,
    pageCount,
    peopleCount: filtered.length,
    totals: summarize(totalCounts, totalOverdue),
    subteams,
  };
}

// ---------------------------------------------------------------------------
// One person's progress (/manage/progress/[userId])
// ---------------------------------------------------------------------------

export interface MemberAssignment {
  id: string;
  status: AssignmentStatus;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  reviewerName: string | null;
  /** Open and due before today (never on a task marked finished). */
  overdue: boolean;
  /** Not approved and the task is marked finished: closed, no credit. */
  closed: boolean;
  /** Approved because the whole task was marked finished and counted for everyone. */
  finishedWithTask: boolean;
  /** Due inside the selected range (false = shown only because it is overdue). */
  inRange: boolean;
  task: { id: string; title: string; subteam: Subteam | null; priority: Priority; dueDate: DateOnly };
  /** The actor can open /manage/tasks/{task.id}. */
  canManageTask: boolean;
}

export interface MemberProgress {
  user: PersonRef & { lastSeenAt: Date | null };
  range: ProgressRange;
  from: DateOnly;
  to: DateOnly;
  summary: ProgressSummary;
  /** Items due in the range plus every currently overdue item, newest due first (max 200). */
  assignments: MemberAssignment[];
  /** More than 200 items matched; only the newest 200 are listed. */
  truncated: boolean;
}

export const MEMBER_ASSIGNMENTS_MAX = 200;

/** Null when the person doesn't exist, isn't active, or is outside the actor's scope (callers use notFound()). */
export async function getMemberProgress(
  actor: Actor,
  userId: unknown,
  options: { range?: unknown },
  today: DateOnly,
  db: Db = prisma,
): Promise<MemberProgress | null> {
  if (!canAccessManage(actor)) return null;
  const id = idSchema.safeParse(userId);
  if (!id.success) return null;

  const user = await db.user.findUnique({
    where: { id: id.data },
    select: { ...personSelect, status: true, lastSeenAt: true },
  });
  // Mirrors manageableMembersWhere: ACTIVE people in the actor's scope.
  if (!user || user.status !== "ACTIVE" || !canViewMemberProgress(actor, user)) return null;

  const range = parseProgressRange(options.range);
  const { from, to } = progressRangeBounds(range, today);
  const fromDb = dateOnlyToDb(from);
  const toDb = dateOnlyToDb(to);
  const todayDb = dateOnlyToDb(today);
  const overdueWhere: Prisma.TaskAssignmentWhereInput = {
    userId: user.id,
    status: { in: OPEN_STATUSES },
    task: { dueDate: { lt: todayDb }, ...OPEN_TASK },
  };

  const [groups, finishedGroups, overdue, rows] = await Promise.all([
    db.taskAssignment.groupBy({
      by: ["status"],
      where: { userId: user.id, task: { dueDate: { gte: fromDb, lte: toDb }, ...OPEN_TASK } },
      _count: { _all: true },
    }),
    db.taskAssignment.groupBy({
      by: ["status"],
      where: { userId: user.id, task: { dueDate: { gte: fromDb, lte: toDb }, ...FINISHED_TASK } },
      _count: { _all: true },
    }),
    db.taskAssignment.count({ where: overdueWhere }),
    db.taskAssignment.findMany({
      where: { OR: [{ userId: user.id, task: { dueDate: { gte: fromDb, lte: toDb } } }, overdueWhere] },
      select: {
        id: true,
        status: true,
        submittedAt: true,
        reviewedAt: true,
        reviewNote: true,
        reviewedBy: { select: { name: true } },
        finishedWithTask: true,
        task: {
          select: { id: true, title: true, subteam: true, priority: true, dueDate: true, createdById: true, completedAt: true },
        },
      },
      orderBy: [{ task: { dueDate: "desc" } }, { createdAt: "desc" }, { id: "asc" }],
      take: MEMBER_ASSIGNMENTS_MAX + 1,
    }),
  ]);

  const counts = emptyCounts();
  for (const g of groups) addStatus(counts, g.status, g._count._all);
  for (const g of finishedGroups) addStatus(counts, g.status, g._count._all, true);

  const assignments: MemberAssignment[] = rows.slice(0, MEMBER_ASSIGNMENTS_MAX).map((row) => {
    const dueDate = dbToDateOnly(row.task.dueDate);
    return {
      id: row.id,
      status: row.status,
      submittedAt: row.submittedAt,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      reviewerName: row.reviewedBy?.name ?? null,
      overdue: OPEN_STATUSES.includes(row.status) && dueDate < today && row.task.completedAt === null,
      closed: isClosedItem(row.status, row.task.completedAt),
      finishedWithTask: row.finishedWithTask && row.status === "APPROVED",
      inRange: dueDate >= from && dueDate <= to,
      task: { id: row.task.id, title: row.task.title, subteam: row.task.subteam, priority: row.task.priority, dueDate },
      canManageTask: canManageTask(actor, row.task),
    };
  });

  return {
    user: { id: user.id, name: user.name, role: user.role, subteam: user.subteam, lastSeenAt: user.lastSeenAt },
    range,
    from,
    to,
    summary: summarize(counts, overdue),
    assignments,
    truncated: rows.length > MEMBER_ASSIGNMENTS_MAX,
  };
}
