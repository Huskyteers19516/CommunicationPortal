import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { QuestionStatus, Role, Subteam } from "@/generated/prisma/enums";
import { ROLE_LABELS, SUBTEAM_LEADER_ROLE, STAFF_ROLES, isSubteamLeaderRole } from "@/lib/constants";
import { addDays, dateOnlyToDb, type DateOnly, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { env } from "../env";
import {
  canBeQuestionRecipient,
  canChangeQuestionStatus,
  canManageTask,
  canReplyToQuestion,
  canViewQuestion,
  hasAllScope,
  isStaff,
} from "../permissions";
import { questionInboxWhere } from "../scopes";

// Every loader takes an optional `db` (defaults to the app singleton) so tests can point it at a throwaway database.

export const QUESTIONS_PAGE_SIZE = 50;
const MAX_THREAD_REPLIES = 200;

export type InboxFilter = QuestionStatus | "all";
export type StatusCounts = Record<QuestionStatus, number> & { all: number };

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageCount: number;
}

interface PersonSummary {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
}

const personSelect = { id: true, name: true, role: true, subteam: true } as const;

function pageArgs(page: number) {
  const p = Number.isInteger(page) && page > 0 ? page : 1;
  return { page: p, skip: (p - 1) * QUESTIONS_PAGE_SIZE, take: QUESTIONS_PAGE_SIZE };
}

function pageCount(total: number) {
  return Math.max(1, Math.ceil(total / QUESTIONS_PAGE_SIZE));
}

async function countByStatus(db: Db, where: Prisma.QuestionWhereInput): Promise<StatusCounts> {
  const rows = await db.question.groupBy({ by: ["status"], where, _count: { _all: true } });
  const counts: StatusCounts = { OPEN: 0, ANSWERED: 0, RESOLVED: 0, all: 0 };
  for (const r of rows) {
    counts[r.status] = r._count._all;
    counts.all += r._count._all;
  }
  return counts;
}

// ── My questions ───────────────────────────────────────────────────────────────

export interface MyQuestionRow {
  id: string;
  title: string;
  status: QuestionStatus;
  subteam: Subteam | null;
  recipientName: string | null;
  replyCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  lastReply: { authorName: string; byMe: boolean; at: Date } | null;
}

/** Questions the actor asked, most recent activity first. */
export async function listMyQuestions(
  actor: Pick<Actor, "id">,
  opts: { status?: QuestionStatus; page?: number } = {},
  db: Db = prisma,
): Promise<Paged<MyQuestionRow> & { counts: StatusCounts }> {
  const { page, skip, take } = pageArgs(opts.page ?? 1);
  const mine: Prisma.QuestionWhereInput = { askerId: actor.id };
  const where: Prisma.QuestionWhereInput = opts.status ? { askerId: actor.id, status: opts.status } : mine;

  const [rows, counts] = await Promise.all([
    db.question.findMany({
      where,
      orderBy: [{ lastActivityAt: "desc" }, { id: "desc" }],
      skip,
      take,
      select: {
        id: true,
        title: true,
        status: true,
        subteam: true,
        lastActivityAt: true,
        createdAt: true,
        recipient: { select: { name: true } },
        _count: { select: { replies: true } },
        replies: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { createdAt: true, author: { select: { id: true, name: true } } },
        },
      },
    }),
    countByStatus(db, mine),
  ]);

  const total = opts.status ? counts[opts.status] : counts.all;
  return {
    items: rows.map((q) => {
      const last = q.replies[0];
      return {
        id: q.id,
        title: q.title,
        status: q.status,
        subteam: q.subteam,
        recipientName: q.recipient?.name ?? null,
        replyCount: q._count.replies,
        lastActivityAt: q.lastActivityAt,
        createdAt: q.createdAt,
        lastReply: last ? { authorName: last.author.name, byMe: last.author.id === actor.id, at: last.createdAt } : null,
      };
    }),
    total,
    page,
    pageCount: pageCount(total),
    counts,
  };
}

// ── Staff inbox ────────────────────────────────────────────────────────────────

export interface InboxRow {
  id: string;
  title: string;
  status: QuestionStatus;
  subteam: Subteam | null;
  asker: PersonSummary;
  recipientName: string | null;
  /** Addressed to the viewer personally. */
  toMe: boolean;
  replyCount: number;
  lastActivityAt: Date;
  createdAt: Date;
}

/**
 * Questions in the actor's scope that someone else asked. OPEN is oldest-first (nothing waits too long);
 * the other filters are newest-first. Non-staff get an empty inbox.
 */
export async function listInbox(
  actor: Pick<Actor, "id" | "role" | "subteam" | "isAdmin">,
  opts: { status?: InboxFilter; page?: number } = {},
  db: Db = prisma,
): Promise<Paged<InboxRow> & { counts: StatusCounts; status: InboxFilter }> {
  const status = opts.status ?? "OPEN";
  const { page, skip, take } = pageArgs(opts.page ?? 1);
  const scope = questionInboxWhere(actor);
  const where: Prisma.QuestionWhereInput = status === "all" ? scope : { AND: [scope, { status }] };
  const dir = status === "OPEN" ? "asc" : "desc";

  const [rows, counts] = await Promise.all([
    db.question.findMany({
      where,
      orderBy: [{ lastActivityAt: dir }, { id: dir }],
      skip,
      take,
      select: {
        id: true,
        title: true,
        status: true,
        subteam: true,
        recipientId: true,
        lastActivityAt: true,
        createdAt: true,
        asker: { select: personSelect },
        recipient: { select: { name: true } },
        _count: { select: { replies: true } },
      },
    }),
    countByStatus(db, scope),
  ]);

  const total = counts[status];
  return {
    items: rows.map((q) => ({
      id: q.id,
      title: q.title,
      status: q.status,
      subteam: q.subteam,
      asker: q.asker,
      recipientName: q.recipient?.name ?? null,
      toMe: q.recipientId === actor.id,
      replyCount: q._count.replies,
      lastActivityAt: q.lastActivityAt,
      createdAt: q.createdAt,
    })),
    total,
    page,
    pageCount: pageCount(total),
    counts,
    status,
  };
}

// ── Thread ─────────────────────────────────────────────────────────────────────

export interface ThreadReply {
  id: string;
  body: string;
  createdAt: Date;
  author: PersonSummary & { isAdmin: boolean };
  /** A staff answer (author is staff and not the asker) — shown in a brand-tinted bubble. */
  isStaff: boolean;
  isAsker: boolean;
  isMine: boolean;
}

export interface QuestionThread {
  id: string;
  title: string;
  body: string;
  status: QuestionStatus;
  subteam: Subteam | null;
  createdAt: Date;
  lastActivityAt: Date;
  asker: PersonSummary;
  recipient: PersonSummary | null;
  task: { id: string; title: string; canManage: boolean } | null;
  replies: ThreadReply[];
  /** Total replies (may exceed `replies.length` for very long threads — only the latest are loaded). */
  replyCount: number;
  viewer: { isAsker: boolean; isStaff: boolean };
  permissions: { canReply: boolean; canResolve: boolean; canReopen: boolean; canDelete: boolean };
}

/** A full thread, or null if it doesn't exist or the actor can't see it. */
export async function getQuestionThread(
  actor: Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">,
  id: string,
  db: Db = prisma,
): Promise<QuestionThread | null> {
  if (!id || id.length > 64) return null;
  const q = await db.question.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      body: true,
      status: true,
      subteam: true,
      askerId: true,
      recipientId: true,
      createdAt: true,
      lastActivityAt: true,
      asker: { select: personSelect },
      recipient: { select: personSelect },
      task: { select: { id: true, title: true, createdById: true, subteam: true } },
      _count: { select: { replies: true } },
      replies: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MAX_THREAD_REPLIES,
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { ...personSelect, isAdmin: true } },
        },
      },
    },
  });
  if (!q || !canViewQuestion(actor, q)) return null;

  const active = actor.status === "ACTIVE";
  const canChange = active && canChangeQuestionStatus(actor, q);
  const replyCount = q._count.replies;

  return {
    id: q.id,
    title: q.title,
    body: q.body,
    status: q.status,
    subteam: q.subteam,
    createdAt: q.createdAt,
    lastActivityAt: q.lastActivityAt,
    asker: q.asker,
    recipient: q.recipient,
    task: q.task ? { id: q.task.id, title: q.task.title, canManage: canManageTask(actor, q.task) } : null,
    replies: q.replies.reverse().map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.createdAt,
      author: r.author,
      isStaff: r.author.id !== q.askerId && isStaff(r.author),
      isAsker: r.author.id === q.askerId,
      isMine: r.author.id === actor.id,
    })),
    replyCount,
    viewer: { isAsker: q.askerId === actor.id, isStaff: isStaff(actor) },
    permissions: {
      canReply: active && canReplyToQuestion(actor, q),
      canResolve: canChange && q.status !== "RESOLVED",
      canReopen: canChange && q.status === "RESOLVED",
      canDelete: active && (actor.isAdmin || (q.askerId === actor.id && replyCount === 0)),
    },
  };
}

// ── Ask form options ───────────────────────────────────────────────────────────

export type RecipientGroupKey = "subteam" | "captain" | "mentors" | "leaders" | "admins";

export interface RecipientOption {
  id: string;
  name: string;
  /** "Build Leader", "Mentor", … */
  roleLabel: string;
}

export interface RecipientGroup {
  key: RecipientGroupKey;
  label: string;
  options: RecipientOption[];
}

const GROUP_ORDER: { key: RecipientGroupKey; label: string }[] = [
  { key: "subteam", label: "Your subteam leaders" },
  { key: "captain", label: "Captain" },
  { key: "mentors", label: "Mentors & Teachers" },
  { key: "leaders", label: "Other leaders" },
  { key: "admins", label: "Site admins" },
];

/**
 * People a question can be addressed to: ACTIVE staff except the actor, grouped with the actor's
 * own subteam leaders first. Empty groups are left out.
 */
export async function getRecipientOptions(
  actor: Pick<Actor, "id" | "subteam">,
  db: Db = prisma,
): Promise<RecipientGroup[]> {
  const users = await db.user.findMany({
    where: {
      status: "ACTIVE",
      id: { not: actor.id },
      OR: [{ role: { in: [...STAFF_ROLES] } }, { isAdmin: true }],
    },
    select: { id: true, name: true, role: true, status: true, isAdmin: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 200,
  });

  const ownLeaderRole = actor.subteam ? SUBTEAM_LEADER_ROLE[actor.subteam] : null;
  const buckets = new Map<RecipientGroupKey, RecipientOption[]>();
  for (const u of users) {
    if (!canBeQuestionRecipient(u)) continue;
    const key: RecipientGroupKey =
      u.role === ownLeaderRole
        ? "subteam"
        : u.role === "CAPTAIN"
          ? "captain"
          : u.role === "MENTOR" || u.role === "TEACHER"
            ? "mentors"
            : isSubteamLeaderRole(u.role)
              ? "leaders"
              : "admins";
    const roleLabel = key === "admins" ? "Site admin" : ROLE_LABELS[u.role];
    const list = buckets.get(key) ?? [];
    list.push({ id: u.id, name: u.name, roleLabel });
    buckets.set(key, list);
  }

  return GROUP_ORDER.flatMap(({ key, label }) => {
    const options = buckets.get(key);
    return options?.length ? [{ key, label, options }] : [];
  });
}

export interface AskTaskOption {
  taskId: string;
  title: string;
  dueDate: DateOnly;
  upcoming: boolean;
}

/**
 * The actor's recent checklist items for the "related task" picker: upcoming ones (soonest first),
 * then the last 30 days (most recent first). At most 50.
 *
 * `includeTaskId` ("Ask a question about this" from the Task dashboard) adds that task first in its
 * group when it isn't one of the actor's own — every task is visible to everyone on the dashboard.
 */
export async function getAskTaskOptions(
  actor: Pick<Actor, "id">,
  opts: { today?: DateOnly; includeTaskId?: string } = {},
  db: Db = prisma,
): Promise<AskTaskOption[]> {
  const today = opts.today ?? todayInTimezone(env.teamTimezone);
  const todayDb = dateOnlyToDb(today);
  const since = dateOnlyToDb(addDays(today, -30));
  const select = { task: { select: { id: true, title: true, dueDate: true } } } as const;
  const includeId = opts.includeTaskId && opts.includeTaskId.length <= 64 ? opts.includeTaskId : null;

  const [upcoming, recent, extra] = await Promise.all([
    db.taskAssignment.findMany({
      where: { userId: actor.id, task: { dueDate: { gte: todayDb } } },
      orderBy: [{ task: { dueDate: "asc" } }, { id: "asc" }],
      take: 50,
      select,
    }),
    db.taskAssignment.findMany({
      where: { userId: actor.id, task: { dueDate: { gte: since, lt: todayDb } } },
      orderBy: [{ task: { dueDate: "desc" } }, { id: "asc" }],
      take: 50,
      select,
    }),
    includeId ? db.task.findUnique({ where: { id: includeId }, select: { id: true, title: true, dueDate: true } }) : null,
  ]);

  // Keep a few recent ones even when the upcoming list is long.
  const recentQuota = Math.min(recent.length, Math.max(15, 50 - upcoming.length));
  const upcomingQuota = Math.min(upcoming.length, 50 - recentQuota);
  const toOption = (isUpcoming: boolean) => (a: (typeof upcoming)[number]): AskTaskOption => ({
    taskId: a.task.id,
    title: a.task.title,
    dueDate: dbToDateOnly(a.task.dueDate),
    upcoming: isUpcoming,
  });
  const options = [...upcoming.slice(0, upcomingQuota).map(toOption(true)), ...recent.slice(0, recentQuota).map(toOption(false))];
  if (!extra || options.some((o) => o.taskId === extra.id)) return options;
  const extraOption = toOption(extra.dueDate >= todayDb)({ task: extra });
  // First in its group, so it is easy to spot (and selected by default on the ask page).
  const at = extraOption.upcoming ? 0 : options.findIndex((o) => !o.upcoming);
  return at === -1 ? [...options, extraOption] : [...options.slice(0, at), extraOption, ...options.slice(at)];
}

/** The task a question is being asked about ("Ask a question about this" on /tasks/[id]). */
export interface AskAboutTask {
  id: string;
  title: string;
  /** Null = whole-team task (the captain handles those, unless `poster` runs it). */
  subteam: Subteam | null;
  createdByName: string;
  /** Someone besides the asker leads the task's subteam and can answer (always false for whole-team tasks). */
  subteamHasLeaders: boolean;
  /**
   * A whole-team task posted by a subteam leader (the Business leader's fundraising and outreach): they run it, so
   * the form offers them first. Null otherwise — and when they can't take questions or are the asker.
   */
  poster: { id: string; name: string } | null;
}

/**
 * The task behind `?taskId=` on the ask page, so the form can say what the question is about and offer
 * that task's subteam leaders. Every task is on the Task dashboard, so any existing task will do.
 */
export async function getAskAboutTask(
  actor: Pick<Actor, "id">,
  taskId: string | undefined,
  db: Db = prisma,
): Promise<AskAboutTask | null> {
  if (!taskId || taskId.length > 64) return null;
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      subteam: true,
      createdBy: { select: { id: true, name: true, role: true, subteam: true, status: true, isAdmin: true } },
    },
  });
  if (!task) return null;
  const leaders = task.subteam
    ? await db.user.count({ where: { status: "ACTIVE", role: SUBTEAM_LEADER_ROLE[task.subteam], id: { not: actor.id } } })
    : 0;
  const creator = task.createdBy;
  // All-scope staff see every whole-team question anyway (the "Captain" choice); a subteam leader only sees it
  // when it's addressed to them.
  const poster =
    task.subteam === null && creator.id !== actor.id && !hasAllScope(creator) && canBeQuestionRecipient(creator)
      ? { id: creator.id, name: creator.name }
      : null;
  return {
    id: task.id,
    title: task.title,
    subteam: task.subteam,
    createdByName: creator.name,
    subteamHasLeaders: leaders > 0,
    poster,
  };
}
