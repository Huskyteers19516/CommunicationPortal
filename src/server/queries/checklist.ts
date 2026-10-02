import "server-only";
// Read side of the member checklist (/today and /my-tasks). Everything here is scoped to the
// actor's own assignments — nobody else's checklist can ever show up.
//
// Tasks a leader marked finished (Task.completedAt): their approved items count as done like any other; items
// that were never approved are *closed* — off Today and the Open tab, never overdue, listed under Done as closed.

import type { Prisma } from "@/generated/prisma/client";
import type { AssignmentStatus, Priority, Subteam } from "@/generated/prisma/enums";
import { addDays, type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";

/** One checklist item as the UI sees it (plain, serializable data; timestamps are ISO strings). */
export interface ChecklistItemData {
  assignmentId: string;
  status: AssignmentStatus;
  submittedAt: string | null;
  submissionNote: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewerName: string | null;
  /** Approved because a leader marked the whole task finished and counted it for everyone. */
  finishedWithTask: boolean;
  task: {
    id: string;
    title: string;
    description: string;
    subteam: Subteam | null;
    dueDate: DateOnly;
    priority: Priority;
    creatorName: string;
    /** Task dashboard category (e.g. "Intake"), if any. */
    categoryName: string | null;
    /** When a leader marked the whole task finished (ISO), else null. Not approved by then = closed, no credit. */
    finishedAt: string | null;
    finishedByName: string | null;
  };
}

type ActorRef = Pick<Actor, "id">;

const itemSelect = {
  id: true,
  status: true,
  submittedAt: true,
  submissionNote: true,
  reviewNote: true,
  reviewedAt: true,
  reviewedBy: { select: { name: true } },
  finishedWithTask: true,
  task: {
    select: {
      id: true,
      title: true,
      description: true,
      subteam: true,
      dueDate: true,
      priority: true,
      createdBy: { select: { name: true } },
      category: { select: { name: true } },
      completedAt: true,
      completedBy: { select: { name: true } },
    },
  },
} satisfies Prisma.TaskAssignmentSelect;

type ItemRow = Prisma.TaskAssignmentGetPayload<{ select: typeof itemSelect }>;

function toItem(row: ItemRow): ChecklistItemData {
  return {
    assignmentId: row.id,
    status: row.status,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    submissionNote: row.submissionNote,
    reviewNote: row.reviewNote,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewerName: row.reviewedBy?.name ?? null,
    finishedWithTask: row.finishedWithTask,
    task: {
      id: row.task.id,
      title: row.task.title,
      description: row.task.description,
      subteam: row.task.subteam,
      dueDate: dbToDateOnly(row.task.dueDate),
      priority: row.task.priority,
      creatorName: row.task.createdBy.name,
      categoryName: row.task.category?.name ?? null,
      finishedAt: row.task.completedAt?.toISOString() ?? null,
      finishedByName: row.task.completedBy?.name ?? null,
    },
  };
}

/** The item's task isn't marked finished (closed items never show as open, overdue, or waiting). */
const OPEN_TASK = { completedAt: null } satisfies Prisma.TaskWhereInput;

const PRIORITY_RANK: Record<Priority, number> = { HIGH: 0, NORMAL: 1, LOW: 2 };
const TODAY_STATUS_RANK: Record<AssignmentStatus, number> = { TODO: 0, REJECTED: 0, SUBMITTED: 1, APPROVED: 2 };

/** Earliest due date first, then high priority first, then title. */
function byDueAsc(a: ChecklistItemData, b: ChecklistItemData): number {
  if (a.task.dueDate !== b.task.dueDate) return a.task.dueDate < b.task.dueDate ? -1 : 1;
  const p = PRIORITY_RANK[a.task.priority] - PRIORITY_RANK[b.task.priority];
  return p !== 0 ? p : a.task.title.localeCompare(b.task.title);
}

/** Open items first, then waiting for review, then approved. */
function byTodayOrder(a: ChecklistItemData, b: ChecklistItemData): number {
  const s = TODAY_STATUS_RANK[a.status] - TODAY_STATUS_RANK[b.status];
  return s !== 0 ? s : byDueAsc(a, b);
}

// ---------------------------------------------------------------------------------------------
// Today

/** How many days ahead "Coming up" looks. */
export const UPCOMING_DAYS = 7;
/** Safety cap on how many items the Today page loads (newest due dates win if someone has hundreds). */
export const TODAY_VIEW_LIMIT = 200;

export interface TodayView {
  /** Sent back by a leader (any due date), oldest due first. */
  needsChanges: ChecklistItemData[];
  /** Due before today and still to do. */
  overdue: ChecklistItemData[];
  /** Due today — open first, then waiting for review, then approved. Items that need changes are listed there instead. */
  today: ChecklistItemData[];
  /** Checked off but not reviewed yet, due before today (so they don't silently disappear). */
  waiting: ChecklistItemData[];
  /** Due in the next 7 days and not approved yet. Items that need changes are listed there instead. */
  upcoming: ChecklistItemData[];
  summary: {
    /** Everything due today, whatever its status. */
    todayTotal: number;
    todayApproved: number;
    todaySubmitted: number;
    overdueCount: number;
  };
  /** Overdue items that exist but weren't loaded because of TODAY_VIEW_LIMIT (normally 0). */
  hiddenOverdue: number;
}

/**
 * Everything the actor needs to look at on the Today page, grouped into sections. Each item appears once.
 * Items of tasks marked finished only show when approved (as done); closed ones aren't on Today at all.
 */
export async function getTodayView(actor: ActorRef, today: DateOnly, db: Db = prisma): Promise<TodayView> {
  const todayDb = dateOnlyToDb(today);
  const horizon = addDays(today, UPCOMING_DAYS);

  const rows = await db.taskAssignment.findMany({
    where: {
      userId: actor.id,
      OR: [
        { status: "REJECTED", task: OPEN_TASK },
        { status: { in: ["TODO", "SUBMITTED"] }, task: { dueDate: { lte: dateOnlyToDb(horizon) }, ...OPEN_TASK } },
        { status: "APPROVED", task: { dueDate: todayDb } },
      ],
    },
    select: itemSelect,
    orderBy: [{ task: { dueDate: "desc" } }, { createdAt: "desc" }],
    take: TODAY_VIEW_LIMIT,
  });

  const view: TodayView = {
    needsChanges: [],
    overdue: [],
    today: [],
    waiting: [],
    upcoming: [],
    summary: { todayTotal: 0, todayApproved: 0, todaySubmitted: 0, overdueCount: 0 },
    hiddenOverdue: 0,
  };

  for (const row of rows) {
    const item = toItem(row);
    const due = item.task.dueDate;
    if (due === today) {
      view.summary.todayTotal++;
      if (item.status === "APPROVED") view.summary.todayApproved++;
      if (item.status === "SUBMITTED") view.summary.todaySubmitted++;
    }

    if (item.status === "REJECTED") view.needsChanges.push(item);
    else if (due === today) view.today.push(item);
    else if (due < today) {
      if (item.status === "TODO") view.overdue.push(item);
      else if (item.status === "SUBMITTED") view.waiting.push(item);
    } else if (due <= horizon && item.status !== "APPROVED") view.upcoming.push(item);
  }

  view.needsChanges.sort(byDueAsc);
  view.overdue.sort(byDueAsc);
  view.today.sort(byTodayOrder);
  view.waiting.sort(byDueAsc);
  view.upcoming.sort(byDueAsc);

  view.summary.overdueCount = view.overdue.length;
  if (rows.length === TODAY_VIEW_LIMIT) {
    // Very rare: the cap cut off the oldest items. Keep the headline number honest.
    view.summary.overdueCount = await db.taskAssignment.count({
      where: { userId: actor.id, status: "TODO", task: { dueDate: { lt: todayDb }, ...OPEN_TASK } },
    });
    view.hiddenOverdue = Math.max(0, view.summary.overdueCount - view.overdue.length);
  }

  return view;
}

// ---------------------------------------------------------------------------------------------
// My tasks

export const MY_TASKS_TABS = ["open", "done", "all"] as const;
export type MyTasksTab = (typeof MY_TASKS_TABS)[number];
export const MY_TASKS_PAGE_SIZE = 50;

const OPEN_STATUSES: AssignmentStatus[] = ["TODO", "REJECTED", "SUBMITTED"];

/** Open = still to do, sent back, or waiting, on a task nobody marked finished. Done = approved, or closed with its task. */
const TAB_WHERE: Record<MyTasksTab, Prisma.TaskAssignmentWhereInput> = {
  open: { status: { in: OPEN_STATUSES }, task: OPEN_TASK },
  done: { OR: [{ status: "APPROVED" }, { task: { completedAt: { not: null } } }] },
  all: {},
};

/** Done is ordered by when each item was done (see loadDonePage), which Prisma's orderBy can't express. */
const TAB_ORDER: Record<Exclude<MyTasksTab, "done">, Prisma.TaskAssignmentOrderByWithRelationInput[]> = {
  open: [{ task: { dueDate: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
  all: [{ task: { dueDate: "desc" } }, { createdAt: "desc" }, { id: "asc" }],
};

/**
 * One page of the Done tab, most recently done first: an approved item by when it was approved, a closed one by
 * when its task was marked finished (so a closed to-do doesn't sink below every approval ever, and a closed
 * send-back isn't dated by the send-back). Same rows as TAB_WHERE.done.
 */
async function loadDonePage(actor: ActorRef, page: number, db: Db): Promise<ItemRow[]> {
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT a.id
    FROM "TaskAssignment" a JOIN "Task" t ON t.id = a."taskId"
    WHERE a."userId" = ${actor.id} AND (a.status = 'APPROVED' OR t."completedAt" IS NOT NULL)
    ORDER BY (CASE WHEN a.status = 'APPROVED' THEN a."reviewedAt" ELSE t."completedAt" END) DESC NULLS LAST, a.id ASC
    LIMIT ${MY_TASKS_PAGE_SIZE} OFFSET ${(page - 1) * MY_TASKS_PAGE_SIZE}`;
  if (ids.length === 0) return [];
  const rows = await db.taskAssignment.findMany({ where: { id: { in: ids.map((r) => r.id) }, userId: actor.id }, select: itemSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((r) => byId.get(r.id) ?? []);
}

export function parseMyTasksTab(value: string | string[] | undefined): MyTasksTab {
  const v = Array.isArray(value) ? value[0] : value;
  return (MY_TASKS_TABS as readonly string[]).includes(v ?? "") ? (v as MyTasksTab) : "open";
}

export interface MyTasksPage {
  tab: MyTasksTab;
  items: ChecklistItemData[];
  counts: Record<MyTasksTab, number>;
  page: number;
  pageCount: number;
}

/** The actor's own assignments for one tab of /my-tasks, 50 per page, plus per-tab counts. */
export async function getMyTasks(
  actor: ActorRef,
  opts: { tab: MyTasksTab; page: number },
  db: Db = prisma,
): Promise<MyTasksPage> {
  const tab = opts.tab;
  const requested = Number.isInteger(opts.page) && opts.page > 0 ? opts.page : 1;
  const where: Prisma.TaskAssignmentWhereInput = { userId: actor.id, ...TAB_WHERE[tab] };
  const load = (page: number) =>
    tab === "done"
      ? loadDonePage(actor, page, db)
      : db.taskAssignment.findMany({
          where,
          select: itemSelect,
          orderBy: TAB_ORDER[tab],
          skip: (page - 1) * MY_TASKS_PAGE_SIZE,
          take: MY_TASKS_PAGE_SIZE,
        });

  const countTab = (t: MyTasksTab) => db.taskAssignment.count({ where: { userId: actor.id, ...TAB_WHERE[t] } });
  const [open, done, all, firstTry] = await Promise.all([countTab("open"), countTab("done"), countTab("all"), load(requested)]);
  const counts: Record<MyTasksTab, number> = { open, done, all };

  const pageCount = Math.max(1, Math.ceil(counts[tab] / MY_TASKS_PAGE_SIZE));
  // Past the last page (e.g. an old link): show the last page instead of an empty list.
  const page = Math.min(requested, pageCount);
  const rows = page === requested ? firstTry : await load(page);

  return { tab, items: rows.map(toItem), counts, page, pageCount };
}
