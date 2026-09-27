import "server-only";
// The Task dashboard (/tasks, /tasks/[id]): every task of every subteam, who's on it, and how far along
// they are. Every ACTIVE person can see it, so this is the PUBLIC view of a task: a simplified status per
// person (done / checked off / to do — "sent back" reads as "to do"), and never submission or review notes.

import type { Prisma } from "@/generated/prisma/client";
import type { AssignmentStatus, Priority, Role, Subteam } from "@/generated/prisma/enums";
import { SUBTEAM_LABELS, SUBTEAMS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import { isFull } from "@/lib/signup";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canManageCategories, canManageTask, canSignUpForTask } from "../permissions";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

export type BoardView = "active" | "past";
/** A dashboard section: a subteam, or "TEAM" for whole-team tasks. */
export type BoardSectionKey = Subteam | "TEAM";
/** What everyone may see about one person's progress. */
export type PublicStatus = "done" | "checked" | "todo";

export const BOARD_SECTION_KEYS: BoardSectionKey[] = [...SUBTEAMS, "TEAM"];
/** Tasks due more than this many days ago count as past, finished or not. */
export const BOARD_ACTIVE_DAYS_BACK = 30;
export const BOARD_ACTIVE_LIMIT = 300;
export const BOARD_PAST_LIMIT = 100;

const PUBLIC_STATUS: Record<AssignmentStatus, PublicStatus> = {
  APPROVED: "done",
  SUBMITTED: "checked",
  TODO: "todo",
  // Being sent back is between the member and their leader.
  REJECTED: "todo",
};

export function sectionKeyOf(subteam: Subteam | null): BoardSectionKey {
  return subteam ?? "TEAM";
}

export function subteamOfSection(key: BoardSectionKey): Subteam | null {
  return key === "TEAM" ? null : key;
}

export function sectionLabel(key: BoardSectionKey): string {
  return key === "TEAM" ? "Whole team" : SUBTEAM_LABELS[key];
}

export function parseBoardSection(value: string | string[] | undefined): BoardSectionKey | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return BOARD_SECTION_KEYS.find((k) => k === v);
}

// ---------- shapes ----------

export interface BoardPerson {
  id: string;
  name: string;
  /** Done / checked off (waiting for review) / to do. "Sent back" shows as to do. */
  publicStatus: PublicStatus;
  /** Signed themselves up (vs. assigned by a leader). */
  selfAssigned: boolean;
  isMe: boolean;
}

export interface BoardTask {
  id: string;
  title: string;
  dueDate: DateOnly;
  priority: Priority;
  subteam: Subteam | null;
  category: { id: string; name: string } | null;
  /** Set up as "Let people sign up" (stays true while sign-ups are closed). */
  signupMode: boolean;
  signupOpen: boolean;
  signupLimit: number | null;
  /** People on the task (assigned or signed up). */
  spotsTaken: number;
  full: boolean;
  /** Everyone on the task, by name. */
  people: BoardPerson[];
  counts: { total: number; done: number; checked: number; todo: number };
  /** The viewer is on this task. */
  isMine: boolean;
  /** The viewer may sign up right now (open, their subteam, a spot left, not past due, not on it yet). */
  canSignUp: boolean;
  /** The viewer signed up and hasn't checked it off yet. */
  canLeave: boolean;
  /** The viewer manages this task (can open it under Manage). */
  canManage: boolean;
}

export interface BoardCategory {
  id: string;
  name: string;
  tasks: BoardTask[];
}

export interface BoardSection {
  key: BoardSectionKey;
  subteam: Subteam | null;
  label: string;
  /** The viewer can add categories and tasks here. */
  canManage: boolean;
  taskCount: number;
  /** In display order. Managers also get empty ones (so they can add tasks into them). */
  categories: BoardCategory[];
  uncategorized: BoardTask[];
}

export interface TaskBoard {
  view: BoardView;
  sections: BoardSection[];
  /** Tasks shown across all sections. */
  total: number;
  /** More tasks matched than the limit; the oldest (past) / latest (active) ones aren't shown. */
  truncated: boolean;
  limit: number;
}

export interface BoardFilters {
  view: BoardView;
  subteam?: BoardSectionKey;
  /** Only tasks the viewer is on. */
  mine?: boolean;
  /** Only tasks with sign-ups open and a spot left, not past due (and your own sign-ups you can still leave). */
  open?: boolean;
  today: DateOnly;
}

// ---------- loading ----------

const boardTaskSelect = {
  id: true,
  title: true,
  dueDate: true,
  priority: true,
  subteam: true,
  createdById: true,
  signupMode: true,
  signupOpen: true,
  signupLimit: true,
  category: { select: { id: true, name: true } },
  // Public fields only: no submission or review notes.
  assignments: { select: { userId: true, status: true, selfAssigned: true, user: { select: { name: true } } } },
} satisfies Prisma.TaskSelect;

type BoardTaskRow = Prisma.TaskGetPayload<{ select: typeof boardTaskSelect }>;

/** Still being worked on: due within the last 30 days, and not yet due or someone isn't approved yet. */
function activeWhere(today: DateOnly): Prisma.TaskWhereInput {
  return {
    dueDate: { gte: dateOnlyToDb(addDays(today, -BOARD_ACTIVE_DAYS_BACK)) },
    OR: [{ dueDate: { gte: dateOnlyToDb(today) } }, { assignments: { some: { status: { not: "APPROVED" } } } }],
  };
}

function toBoardTask(actor: ActorLike, t: BoardTaskRow, today: DateOnly): BoardTask {
  const people = t.assignments
    .map((a) => ({
      id: a.userId,
      name: a.user.name,
      publicStatus: PUBLIC_STATUS[a.status],
      selfAssigned: a.selfAssigned,
      isMe: a.userId === actor.id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = { total: people.length, done: 0, checked: 0, todo: 0 };
  for (const p of people) counts[p.publicStatus] += 1;

  const mine = t.assignments.find((a) => a.userId === actor.id);
  const spotsTaken = t.assignments.length;
  const full = isFull({ signupLimit: t.signupLimit, spotsTaken });
  const dueDate = dbToDateOnly(t.dueDate);
  return {
    id: t.id,
    title: t.title,
    dueDate,
    priority: t.priority,
    subteam: t.subteam,
    category: t.category,
    signupMode: t.signupMode,
    signupOpen: t.signupOpen,
    signupLimit: t.signupLimit,
    spotsTaken,
    full,
    people,
    counts,
    isMine: !!mine,
    canSignUp: canSignUpForTask(actor, t) && !mine && !full && dueDate >= today,
    canLeave: !!mine && mine.selfAssigned && mine.status === "TODO",
    canManage: canManageTask(actor, t),
  };
}

/**
 * Every subteam's tasks for the dashboard, grouped into sections (Software, Build, Business, Whole team)
 * and categories. Two queries in total. Active: soonest due first. Past: most recent first.
 */
export async function getTaskBoard(actor: ActorLike, filters: BoardFilters, db: Db = prisma): Promise<TaskBoard> {
  const { view, today } = filters;
  const sectionKeys = filters.subteam ? [filters.subteam] : BOARD_SECTION_KEYS;
  const active = activeWhere(today);
  const where: Prisma.TaskWhereInput = {
    AND: [
      view === "active" ? active : { NOT: active },
      filters.subteam ? { subteam: subteamOfSection(filters.subteam) } : {},
      filters.mine ? { assignments: { some: { userId: actor.id } } } : {},
      filters.open ? { signupOpen: true, dueDate: { gte: dateOnlyToDb(today) } } : {},
    ],
  };
  const limit = view === "active" ? BOARD_ACTIVE_LIMIT : BOARD_PAST_LIMIT;
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    view === "active"
      ? [{ dueDate: "asc" }, { priority: "desc" }, { title: "asc" }, { id: "asc" }]
      : [{ dueDate: "desc" }, { priority: "desc" }, { title: "asc" }, { id: "asc" }];

  const [rows, categories] = await Promise.all([
    db.task.findMany({ where, orderBy, take: limit + 1, select: boardTaskSelect }),
    db.taskCategory.findMany({
      where: filters.subteam ? { subteam: subteamOfSection(filters.subteam) } : {},
      orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true, subteam: true },
    }),
  ]);
  const truncated = rows.length > limit;
  let tasks = rows.slice(0, limit).map((t) => toBoardTask(actor, t, today));
  // "Open for sign-up": tasks you could sign up for right now (not full, your subteam or whole team,
  // not already on it) — plus, for leaders, the open ones they run, so they can keep an eye on them —
  // plus the ones you signed up for and can still leave, so a card doesn't vanish right after "Sign up".
  if (filters.open) tasks = tasks.filter((t) => (!t.full && (t.canSignUp || t.canManage)) || t.canLeave);

  // Empty categories are only useful to managers on the plain active view (a place to add tasks).
  const showEmpty = view === "active" && !filters.mine && !filters.open;

  const sections = sectionKeys.map((key): BoardSection => {
    const subteam = subteamOfSection(key);
    const canManage = canManageCategories(actor, subteam);
    const own = tasks.filter((t) => t.subteam === subteam);
    const groups = categories
      .filter((c) => c.subteam === subteam)
      .map((c): BoardCategory => ({ id: c.id, name: c.name, tasks: own.filter((t) => t.category?.id === c.id) }));
    const grouped = new Set(groups.map((g) => g.id));
    return {
      key,
      subteam,
      label: sectionLabel(key),
      canManage,
      taskCount: own.length,
      categories: groups.filter((g) => g.tasks.length > 0 || (canManage && showEmpty)),
      uncategorized: own.filter((t) => !t.category || !grouped.has(t.category.id)),
    };
  });

  return { view, sections, total: tasks.length, truncated, limit };
}

// ---------- one task ----------

export interface BoardTaskDetail extends BoardTask {
  description: string;
  createdBy: { id: string; name: string; role: Role; subteam: Subteam | null };
  createdAt: Date;
  /** Why the viewer can't sign up (shown next to the button), or null when it doesn't apply. */
  signupNote: string | null;
}

/** One task as everyone sees it (/tasks/[id]). Null if it doesn't exist. */
export async function getBoardTask(
  actor: ActorLike,
  id: string,
  opts: { today: DateOnly },
  db: Db = prisma,
): Promise<BoardTaskDetail | null> {
  if (!id || id.length > 64) return null;
  const row = await db.task.findUnique({
    where: { id },
    select: {
      ...boardTaskSelect,
      description: true,
      createdAt: true,
      createdBy: { select: { id: true, name: true, role: true, subteam: true } },
    },
  });
  if (!row) return null;
  const task = toBoardTask(actor, row, opts.today);

  let signupNote: string | null = null;
  const signupTask = task.signupMode;
  if (!task.isMine && signupTask && !task.canSignUp) {
    if (!task.signupOpen) signupNote = "Sign-ups for this task are closed.";
    else if (!canSignUpForTask(actor, task)) signupNote = `Only ${task.subteam ? SUBTEAM_LABELS[task.subteam] : "team"} members can sign up.`;
    else if (task.dueDate < opts.today) signupNote = "The due date has passed.";
    else if (task.full) signupNote = "All spots are taken.";
  }

  return { ...task, description: row.description, createdBy: row.createdBy, createdAt: row.createdAt, signupNote };
}
