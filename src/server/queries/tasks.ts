import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { AccountStatus, AssignmentStatus, Priority, QuestionStatus, Role, Subteam } from "@/generated/prisma/enums";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { type DateOnly, dateOnlyToDb, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { env } from "../env";
import { isClosedItem } from "../domain/assignment";
import {
  canAssignTo,
  canCreateTask,
  canManageCategories,
  canManageTask,
  canReviewAssignment,
  hasAllScope,
  isStaff,
  ledSubteam,
} from "../permissions";
import { assignableUsersWhere, manageableTasksWhere, reviewQueueWhere, visibleQuestionsWhere } from "../scopes";

export const TASKS_PAGE_SIZE = 50;
export const REVIEW_QUEUE_LIMIT = 200;

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

/** Subteam filter value used in URLs: a subteam, or "TEAM" for whole-team tasks. */
export type SubteamFilter = Subteam | "TEAM";

export function parseSubteamFilter(value: string | string[] | undefined): SubteamFilter | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === "TEAM") return "TEAM";
  return SUBTEAMS.find((s) => s === v);
}

function subteamWhere(filter: SubteamFilter | undefined): Prisma.TaskWhereInput {
  if (!filter) return {};
  return { subteam: filter === "TEAM" ? null : filter };
}

// ---------- form options ----------

export interface SubteamOption {
  /** "" = whole team. */
  value: "" | Subteam;
  label: string;
}

export interface TaskFormOptions {
  subteams: SubteamOption[];
  defaultSubteam: "" | Subteam;
  /**
   * Subteam values whose category list the actor may add to with "New category…" (canManageCategories). The
   * Business leader picks from the whole-team categories but doesn't add to them.
   */
  newCategorySubteams: ("" | Subteam)[];
}

const subteamOption = (value: "" | Subteam): SubteamOption => ({ value, label: value ? SUBTEAM_LABELS[value] : "Whole team" });

/**
 * Subteams the actor may create tasks for: all-scope staff every subteam and the whole team (the default);
 * subteam leaders their own subteam (the default), plus the whole team for the Business leader.
 *
 * `editing` (the edit form): only subteams the actor would still manage the task in after saving (updateTask
 * refuses the rest) — so the Business leader is offered the whole team only for tasks they created.
 */
export function getTaskFormOptions(actor: ActorLike, editing?: { createdById: string }): TaskFormOptions {
  if (!isStaff(actor)) return { subteams: [], defaultSubteam: "", newCategorySubteams: [] };
  let values: ("" | Subteam)[] = hasAllScope(actor) ? ["", ...SUBTEAMS] : SUBTEAMS.filter((s) => canCreateTask(actor, s));
  if (!hasAllScope(actor) && canCreateTask(actor, null)) values.push("");
  if (editing) values = values.filter((v) => canManageTask(actor, { createdById: editing.createdById, subteam: v || null }));
  return {
    subteams: values.map(subteamOption),
    defaultSubteam: values[0] ?? "",
    newCategorySubteams: values.filter((v) => canManageCategories(actor, v || null)),
  };
}

// ---------- assignable people ----------

export interface AssignablePerson {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
  /** Set when the person is shown but can't be (re-)added, e.g. "Not active". */
  note?: string;
  /** Always stays assigned (e.g. a subteam leader can't remove themselves); rendered checked + disabled. */
  locked?: boolean;
  /** The actor may put them only on whole-team tasks (the Business leader and people outside Business). */
  wholeTeamOnly?: boolean;
  /** Can't be added right now (editing a task that's marked finished): rendered disabled while not picked. */
  frozen?: boolean;
}

export interface AssigneeGroup {
  /** Subteam, or "STAFF" for people without a subteam (captain, mentors, teachers). */
  key: Subteam | "STAFF";
  label: string;
  people: AssignablePerson[];
}

const GROUP_ORDER: AssigneeGroup["key"][] = [...SUBTEAMS, "STAFF"];

/** Group people by subteam (null subteam = "Staff"), in a fixed order, names sorted. */
export function groupPeople(people: AssignablePerson[]): AssigneeGroup[] {
  const groups = new Map<AssigneeGroup["key"], AssignablePerson[]>();
  for (const p of people) {
    const key = p.subteam ?? "STAFF";
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }
  return GROUP_ORDER.filter((k) => groups.has(k)).map((key) => ({
    key,
    label: key === "STAFF" ? "Staff" : SUBTEAM_LABELS[key],
    people: (groups.get(key) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

/**
 * ACTIVE people the actor may put on some task they can create, grouped by subteam. People they may put only on
 * whole-team tasks (for the Business leader: everyone outside Business) are marked `wholeTeamOnly`.
 */
export async function getAssignableUsers(actor: ActorLike, db: Db = prisma): Promise<AssigneeGroup[]> {
  const wholeTeam = canCreateTask(actor, null);
  const own = ledSubteam(actor);
  const users = await db.user.findMany({
    where: assignableUsersWhere(actor, wholeTeam ? null : own),
    select: { id: true, name: true, role: true, subteam: true, status: true },
    orderBy: { name: "asc" },
    take: 1000,
  });
  return groupPeople(
    users.map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role,
      subteam: u.subteam,
      ...(wholeTeam && own && !canAssignTo(actor, u, own) ? { wholeTeamOnly: true } : {}),
    })),
  );
}

// ---------- task list ----------

export type TaskListView = "upcoming" | "past" | "all";

export interface StatusCounts {
  total: number;
  /** To do / submitted / rejected only count items of tasks that aren't marked finished; approved counts everywhere. */
  todo: number;
  submitted: number;
  approved: number;
  rejected: number;
  /** Not approved when the task was marked finished: closed, no credit. */
  closed: number;
}

export interface ManagedTaskRow {
  id: string;
  title: string;
  subteam: Subteam | null;
  dueDate: DateOnly;
  priority: Priority;
  category: { id: string; name: string } | null;
  signupMode: boolean;
  signupOpen: boolean;
  signupLimit: number | null;
  createdByName: string;
  isMine: boolean;
  /** A leader marked the whole task finished. */
  finished: boolean;
  counts: StatusCounts;
}

export interface ManagedTaskList {
  tasks: ManagedTaskRow[];
  total: number;
  page: number;
  pageCount: number;
}

function emptyCounts(): StatusCounts {
  return { total: 0, todo: 0, submitted: 0, approved: 0, rejected: 0, closed: 0 };
}

const COUNT_KEY: Record<AssignmentStatus, keyof Omit<StatusCounts, "total" | "closed">> = {
  TODO: "todo",
  SUBMITTED: "submitted",
  APPROVED: "approved",
  REJECTED: "rejected",
};

function addToCounts(counts: StatusCounts, status: AssignmentStatus, completedAt: Date | null, n = 1) {
  counts[isClosedItem(status, completedAt) ? "closed" : COUNT_KEY[status]] += n;
  counts.total += n;
}

/** Not marked finished: the task is still being worked on. */
const OPEN_TASK = { completedAt: null } satisfies Prisma.TaskWhereInput;

/**
 * Tasks the actor manages, with per-status assignment counts (one groupBy, no N+1). Upcoming = due today or later
 * and not marked finished; Past = due before today, or marked finished.
 */
export async function listManagedTasks(
  actor: ActorLike,
  opts: { view: TaskListView; subteam?: SubteamFilter; mine?: boolean; page?: number; today?: DateOnly },
  db: Db = prisma,
): Promise<ManagedTaskList> {
  const today = dateOnlyToDb(opts.today ?? todayInTimezone(env.teamTimezone));
  const where: Prisma.TaskWhereInput = {
    AND: [
      manageableTasksWhere(actor),
      opts.view === "upcoming"
        ? { dueDate: { gte: today }, ...OPEN_TASK }
        : opts.view === "past"
          ? { OR: [{ dueDate: { lt: today } }, { completedAt: { not: null } }] }
          : {},
      subteamWhere(opts.subteam),
      opts.mine ? { createdById: actor.id } : {},
    ],
  };
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    opts.view === "upcoming"
      ? [{ dueDate: "asc" }, { createdAt: "asc" }]
      : [{ dueDate: "desc" }, { createdAt: "desc" }];

  const total = await db.task.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / TASKS_PAGE_SIZE));
  const page = Math.min(Math.max(1, opts.page ?? 1), pageCount);

  const tasks = await db.task.findMany({
    where,
    orderBy,
    skip: (page - 1) * TASKS_PAGE_SIZE,
    take: TASKS_PAGE_SIZE,
    select: {
      id: true,
      title: true,
      subteam: true,
      dueDate: true,
      priority: true,
      signupMode: true,
      signupOpen: true,
      signupLimit: true,
      category: { select: { id: true, name: true } },
      createdById: true,
      createdBy: { select: { name: true } },
      completedAt: true,
    },
  });

  const grouped = tasks.length
    ? await db.taskAssignment.groupBy({
        by: ["taskId", "status"],
        where: { taskId: { in: tasks.map((t) => t.id) } },
        _count: { _all: true },
      })
    : [];
  const completedAt = new Map(tasks.map((t) => [t.id, t.completedAt]));
  const countsByTask = new Map<string, StatusCounts>();
  for (const g of grouped) {
    const c = countsByTask.get(g.taskId) ?? emptyCounts();
    addToCounts(c, g.status, completedAt.get(g.taskId) ?? null, g._count._all);
    countsByTask.set(g.taskId, c);
  }

  return {
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      subteam: t.subteam,
      dueDate: dbToDateOnly(t.dueDate),
      priority: t.priority,
      category: t.category,
      signupMode: t.signupMode,
      signupOpen: t.signupOpen,
      signupLimit: t.signupLimit,
      createdByName: t.createdBy.name,
      isMine: t.createdById === actor.id,
      finished: t.completedAt !== null,
      counts: countsByTask.get(t.id) ?? emptyCounts(),
    })),
    total,
    page,
    pageCount,
  };
}

// ---------- task detail ----------

function assignModeOf(signupMode: boolean): "assign" | "signup" {
  return signupMode ? "signup" : "assign";
}

export interface ManagedAssignment {
  id: string;
  status: AssignmentStatus;
  submittedAt: Date | null;
  submissionNote: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  reviewerName: string | null;
  user: { id: string; name: string; role: Role; subteam: Subteam | null; status: AccountStatus };
  /** The person signed themselves up from the Task dashboard. */
  selfAssigned: boolean;
  /** Approved because the whole task was marked finished and counted for everyone. */
  finishedWithTask: boolean;
  /** Not approved and the task is marked finished: closed, no credit. */
  closed: boolean;
  /** The actor may approve / send back / reopen this item (false for your own item unless all-scope). */
  canReview: boolean;
  /** The actor may take this person off the task (false for your own item unless all-scope). */
  canRemove: boolean;
}

export interface ManagedTaskDetail {
  id: string;
  title: string;
  description: string;
  subteam: Subteam | null;
  dueDate: DateOnly;
  priority: Priority;
  category: { id: string; name: string } | null;
  signupOpen: boolean;
  signupLimit: number | null;
  /** "signup" for sign-up tasks (open now, or closed but with spots / self sign-ups), else "assign". */
  assignMode: "assign" | "signup";
  createdAt: Date;
  createdBy: { id: string; name: string; role: Role; subteam: Subteam | null };
  /** When a leader marked the whole task finished ("Mark task finished"), else null. */
  completedAt: Date | null;
  completedBy: { id: string; name: string } | null;
  assignments: ManagedAssignment[];
  counts: StatusCounts;
  questions: { id: string; title: string; status: QuestionStatus }[];
}

/** A task the actor manages, with everyone's checklist status. Null if missing or not manageable. */
export async function getManagedTaskDetail(actor: ActorLike, id: string, db: Db = prisma): Promise<ManagedTaskDetail | null> {
  if (!id || id.length > 64) return null;
  const task = await db.task.findFirst({
    where: { AND: [{ id }, manageableTasksWhere(actor)] },
    select: {
      id: true,
      title: true,
      description: true,
      subteam: true,
      dueDate: true,
      priority: true,
      signupMode: true,
      signupOpen: true,
      signupLimit: true,
      category: { select: { id: true, name: true } },
      createdAt: true,
      createdById: true,
      createdBy: { select: { id: true, name: true, role: true, subteam: true } },
      completedAt: true,
      completedBy: { select: { id: true, name: true } },
      assignments: {
        orderBy: { user: { name: "asc" } },
        select: {
          id: true,
          userId: true,
          status: true,
          selfAssigned: true,
          finishedWithTask: true,
          submittedAt: true,
          submissionNote: true,
          reviewedAt: true,
          reviewNote: true,
          reviewedBy: { select: { name: true } },
          user: { select: { id: true, name: true, role: true, subteam: true, status: true } },
        },
      },
      questions: {
        where: visibleQuestionsWhere(actor),
        orderBy: { lastActivityAt: "desc" },
        take: 50,
        select: { id: true, title: true, status: true },
      },
    },
  });
  if (!task) return null;

  const counts = emptyCounts();
  for (const a of task.assignments) addToCounts(counts, a.status, task.completedAt);

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    subteam: task.subteam,
    dueDate: dbToDateOnly(task.dueDate),
    priority: task.priority,
    category: task.category,
    signupOpen: task.signupOpen,
    signupLimit: task.signupLimit,
    assignMode: assignModeOf(task.signupMode),
    createdAt: task.createdAt,
    createdBy: task.createdBy,
    completedAt: task.completedAt,
    completedBy: task.completedBy,
    counts,
    questions: task.questions,
    assignments: task.assignments.map((a) => ({
      id: a.id,
      status: a.status,
      submittedAt: a.submittedAt,
      submissionNote: a.submissionNote,
      reviewedAt: a.reviewedAt,
      reviewNote: a.reviewNote,
      reviewerName: a.reviewedBy?.name ?? null,
      user: a.user,
      selfAssigned: a.selfAssigned,
      finishedWithTask: a.finishedWithTask && a.status === "APPROVED",
      closed: isClosedItem(a.status, task.completedAt),
      canReview: canReviewAssignment(actor, task, { userId: a.userId, assigneeSubteam: a.user.subteam }),
      canRemove: a.userId !== actor.id || hasAllScope(actor),
    })),
  };
}

// ---------- duplicate ----------

export interface TaskDuplicate {
  /** The task being copied. */
  sourceId: string;
  sourceTitle: string;
  title: string;
  description: string;
  /** "" = whole team. Falls back to the actor's default when they can't create tasks for the original subteam. */
  subteam: "" | Subteam;
  priority: Priority;
  /** Due today (team timezone) — the usual reason to copy is "same thing again today". */
  dueDate: DateOnly;
  /** The original category when the copy stays in the same subteam, else "" (none). */
  categoryId: string;
  assignMode: "assign" | "signup";
  signupLimit: number | null;
  /**
   * The original assignees the actor can still assign (ACTIVE and in scope). People who signed
   * themselves up aren't copied — a sign-up task starts fresh.
   */
  assigneeIds: string[];
}

/**
 * Prefill for "Duplicate task". Null when the task is missing or the actor can't manage it. A copy of a task that
 * was marked finished starts open (nothing about being finished is copied).
 */
export async function getTaskDuplicate(
  actor: ActorLike,
  id: string,
  opts: { today?: DateOnly } = {},
  db: Db = prisma,
): Promise<TaskDuplicate | null> {
  if (!isStaff(actor) || !id || id.length > 64) return null;
  const task = await db.task.findFirst({
    where: { AND: [{ id }, manageableTasksWhere(actor)] },
    select: {
      id: true,
      title: true,
      description: true,
      subteam: true,
      priority: true,
      categoryId: true,
      signupMode: true,
      signupOpen: true,
      signupLimit: true,
      createdById: true,
      assignments: {
        orderBy: { user: { name: "asc" } },
        select: { selfAssigned: true, user: { select: { id: true, subteam: true, status: true } } },
      },
    },
  });
  if (!task || !canManageTask(actor, task)) return null;
  const sameSubteam = canCreateTask(actor, task.subteam);
  const subteam = sameSubteam ? (task.subteam ?? "") : getTaskFormOptions(actor).defaultSubteam;

  return {
    sourceId: task.id,
    sourceTitle: task.title,
    title: task.title,
    description: task.description,
    subteam,
    priority: task.priority,
    dueDate: opts.today ?? todayInTimezone(env.teamTimezone),
    categoryId: sameSubteam ? (task.categoryId ?? "") : "",
    assignMode: assignModeOf(task.signupMode),
    signupLimit: task.signupLimit,
    assigneeIds: task.assignments
      .filter((a) => !a.selfAssigned && canAssignTo(actor, a.user, subteam || null))
      .map((a) => a.user.id),
  };
}

// ---------- review queue ----------

export interface ReviewItem {
  id: string;
  submittedAt: Date | null;
  submissionNote: string | null;
  /** Feedback from an earlier send-back, if any. */
  previousReviewNote: string | null;
  user: { id: string; name: string; role: Role; subteam: Subteam | null };
}

export interface ReviewGroup {
  task: {
    id: string;
    title: string;
    subteam: Subteam | null;
    dueDate: DateOnly;
    priority: Priority;
    /**
     * The actor manages this task (can open /manage/tasks/[id]). False for whole-team tasks that a
     * subteam leader only reviews for their own members.
     */
    canManage: boolean;
  };
  items: ReviewItem[];
}

export interface ReviewQueue {
  /** Everything waiting (may exceed the number shown). */
  total: number;
  /** Items shown (capped at REVIEW_QUEUE_LIMIT). */
  shown: number;
  /** Grouped by task, tasks ordered by their oldest submission. */
  groups: ReviewGroup[];
}

/**
 * Submissions waiting for this actor's review, oldest first. For subteam leaders this includes their
 * own members' items on whole-team tasks (see reviewQueueWhere).
 */
export async function getReviewQueue(actor: ActorLike, opts: { subteam?: SubteamFilter } = {}, db: Db = prisma): Promise<ReviewQueue> {
  const where: Prisma.TaskAssignmentWhereInput = {
    AND: [reviewQueueWhere(actor), opts.subteam ? { task: subteamWhere(opts.subteam) } : {}],
  };
  const [total, rows] = await Promise.all([
    db.taskAssignment.count({ where }),
    db.taskAssignment.findMany({
      where,
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: REVIEW_QUEUE_LIMIT,
      select: {
        id: true,
        submittedAt: true,
        submissionNote: true,
        reviewNote: true,
        user: { select: { id: true, name: true, role: true, subteam: true } },
        task: { select: { id: true, title: true, subteam: true, dueDate: true, priority: true, createdById: true } },
      },
    }),
  ]);

  const groups = new Map<string, ReviewGroup>();
  for (const r of rows) {
    let g = groups.get(r.task.id);
    if (!g) {
      const { createdById, ...task } = r.task;
      g = {
        task: { ...task, dueDate: dbToDateOnly(task.dueDate), canManage: canManageTask(actor, { createdById, subteam: task.subteam }) },
        items: [],
      };
      groups.set(r.task.id, g);
    }
    g.items.push({
      id: r.id,
      submittedAt: r.submittedAt,
      submissionNote: r.submissionNote,
      previousReviewNote: r.reviewNote,
      user: r.user,
    });
  }
  return { total, shown: rows.length, groups: [...groups.values()] };
}
