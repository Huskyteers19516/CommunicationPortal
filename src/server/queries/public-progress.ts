import "server-only";
// The team website's live progress (GET /api/public/progress, no sign-in). Only aggregate, non-sensitive numbers:
// never emails, notes, review notes, due dates / overdue, questions, account ids, or anything about accounts that
// aren't ACTIVE. See "Public progress (team website)" in docs/CONVENTIONS.md for the exact counting rules.
//
// Who counts: ACTIVE students — members, subteam leaders, and the captain (owners too, whatever their position) —
// never mentors or teachers. People who turned off "Show me on the team website" (User.hideFromPublicProgress) are
// left out of `people` and unnamed in `recent`, but their items still count in every total.
// What counts: the checklist items (TaskAssignment) of tasks due on or after `since`. Approved = done (also the
// ones counted when a leader marked the whole task finished); to do / checked off / sent back = open, unless the
// task is marked finished (then they're closed and count as neither).
//
// Polled by every visitor (every 30 s, cached 15 s by Vercel), so it's a fixed handful of aggregate queries.
import { createHmac, randomBytes } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { ATTENDANCE_SETTINGS_KEY, parseAttendanceSettings, weekStartOf } from "@/lib/attendance";
import { SUBTEAM_LABELS, SUBTEAMS, TEAM_NAME, TEAM_NUMBER } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, todayInTimezone } from "@/lib/dates";
import {
  type PublicCounts,
  type PublicPerson,
  type PublicProgressAnswer,
  type PublicProgressSettings,
  PUBLIC_PROGRESS_DEFAULT_SINCE,
  PUBLIC_PROGRESS_ID_SALT_KEY,
  PUBLIC_PROGRESS_KEY,
  PUBLIC_RECENT_MAX,
  PUBLIC_WEEKS,
  parsePublicProgressSettings,
  publicCompletion,
  publicName,
  publicRoleLabel,
} from "@/lib/public-progress";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canManagePublicProgress } from "../permissions";

/** Mentors and teachers are never on the page (it's the students' progress). */
export const PUBLIC_PROGRESS_EXCLUDED_ROLES: Role[] = ["MENTOR", "TEACHER"];

/** The people whose items count: ACTIVE, not a mentor or teacher. */
export const publicStudentsWhere = {
  status: "ACTIVE",
  role: { notIn: PUBLIC_PROGRESS_EXCLUDED_ROLES },
} satisfies Prisma.UserWhereInput;

/** Hard cap on people loaded (the team is ~40). */
const PEOPLE_CAP = 1000;

/** A salt shorter than this is treated as missing (made again). */
const SALT_MIN_LENGTH = 32;

// ── Settings ─────────────────────────────────────────────────────────────────

export interface PublicProgressConfig {
  settings: PublicProgressSettings;
  /** The attendance reports' start (`reportStart`): where counting starts while `settings.since` is empty. */
  defaultSince: DateOnly;
  /** The day counting starts: `settings.since`, else `defaultSince`. */
  since: DateOnly;
}

type NoteBodies = Map<string, string>;

async function readNotes(db: Db, keys: string[]): Promise<NoteBodies> {
  const rows = await db.teamNote.findMany({ where: { key: { in: keys } }, select: { key: true, body: true } });
  return new Map(rows.map((r) => [r.key, r.body]));
}

function configFrom(notes: NoteBodies): PublicProgressConfig {
  const settings = parsePublicProgressSettings(notes.get(PUBLIC_PROGRESS_KEY));
  const attendance = notes.get(ATTENDANCE_SETTINGS_KEY);
  const defaultSince = attendance ? parseAttendanceSettings(attendance).reportStart : PUBLIC_PROGRESS_DEFAULT_SINCE;
  return { settings, defaultSince, since: settings.since ?? defaultSince };
}

/** The saved settings (with defaults) and the day counting starts. */
export async function getPublicProgressConfig(db: Db = prisma): Promise<PublicProgressConfig> {
  return configFrom(await readNotes(db, [PUBLIC_PROGRESS_KEY, ATTENDANCE_SETTINGS_KEY]));
}

export interface PublicProgressAdminView extends PublicProgressConfig {
  /** ACTIVE students who turned off "Show me on the team website" (a count only). */
  hiddenPeople: number;
}

/** Admin → Approvals → Team website. Null for everyone without admin access. */
export async function getPublicProgressAdminView(actor: Actor, db: Db = prisma): Promise<PublicProgressAdminView | null> {
  if (actor.status !== "ACTIVE" || !canManagePublicProgress(actor)) return null;
  const [config, hiddenPeople] = await Promise.all([
    getPublicProgressConfig(db),
    db.user.count({ where: { ...publicStudentsWhere, hideFromPublicProgress: true } }),
  ]);
  return { ...config, hiddenPeople };
}

// ── Opaque ids ───────────────────────────────────────────────────────────────

/** A person's id on the public page: an HMAC of the account id with the salt (never the account id itself). */
export function publicPersonId(salt: string, userId: string): string {
  return createHmac("sha256", salt).update(`person:${userId}`).digest("base64url").slice(0, 16);
}

/**
 * The salt for publicPersonId, made (random, once) on the first request that needs it. Two first requests at once
 * agree: only one insert wins and both read it back.
 */
async function idSalt(db: Db, saved: string | undefined): Promise<string> {
  if (saved && saved.length >= SALT_MIN_LENGTH) return saved;
  const fresh = randomBytes(32).toString("base64url");
  if (saved === undefined) {
    await db.teamNote.createMany({ data: [{ key: PUBLIC_PROGRESS_ID_SALT_KEY, body: fresh }], skipDuplicates: true });
  } else {
    await db.teamNote.updateMany({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY, body: saved }, data: { body: fresh } });
  }
  const row = await db.teamNote.findUnique({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY }, select: { body: true } });
  return row && row.body.length >= SALT_MIN_LENGTH ? row.body : fresh;
}

// ── The page's data ──────────────────────────────────────────────────────────

interface PersonRow {
  userId: string;
  done: number;
  open: number;
  done7: number;
  lastDoneAt: Date | null;
}

interface TaskRow {
  subteam: Subteam | null;
  /** 1 = the row for everyone (all subteams together). */
  everyone: number;
  tasks: number;
  active: number;
}

const rankOf = (s: Subteam | null) => (s ? SUBTEAMS.indexOf(s) : SUBTEAMS.length);
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function counts(done: number, open: number, done7: number): PublicCounts {
  return { itemsDone: done, itemsOpen: open, completion: publicCompletion(done, open), doneLast7Days: done7 };
}

/**
 * Everything the public page shows, or {enabled: false} while the page is turned off. `now` and `teamTimezone`
 * decide "the last 7 days" and the weeks (Monday to Sunday, team timezone).
 */
export async function getPublicProgress(db: Db, options: { now: Date; teamTimezone: string }): Promise<PublicProgressAnswer> {
  const notes = await readNotes(db, [PUBLIC_PROGRESS_KEY, ATTENDANCE_SETTINGS_KEY, PUBLIC_PROGRESS_ID_SALT_KEY]);
  const { settings, since } = configFrom(notes);
  if (!settings.enabled) return { enabled: false };

  const tz = options.teamTimezone;
  const today = todayInTimezone(tz, options.now);
  const last7From = addDays(today, -6);
  const thisWeek = weekStartOf(today);
  const firstWeek = addDays(thisWeek, -7 * (PUBLIC_WEEKS - 1));

  // The counted items: tasks due on/after `since`, people who count. Enum values are SQL literals on purpose.
  const counted = Prisma.sql`
    FROM "TaskAssignment" a
    JOIN "Task" t ON t."id" = a."taskId"
    JOIN "User" u ON u."id" = a."userId"
    WHERE t."dueDate" >= ${since}::date
      AND u."status" = 'ACTIVE'
      AND u."role" NOT IN ('MENTOR', 'TEACHER')`;
  // The calendar day (team timezone) an item was approved: reviewedAt is a UTC timestamp without a zone.
  const approvedLocal = Prisma.sql`((a."reviewedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)`;
  const isOpen = Prisma.sql`(a."status" <> 'APPROVED' AND t."completedAt" IS NULL)`;

  const [salt, users, personRows, taskRows, weekRows, recentRows] = await Promise.all([
    idSalt(db, notes.get(PUBLIC_PROGRESS_ID_SALT_KEY)),
    db.user.findMany({
      where: publicStudentsWhere,
      select: { id: true, name: true, role: true, subteam: true, hideFromPublicProgress: true },
      orderBy: { id: "asc" },
      take: PEOPLE_CAP,
    }),
    db.$queryRaw<PersonRow[]>`
      SELECT a."userId" AS "userId",
        (count(*) FILTER (WHERE a."status" = 'APPROVED'))::int AS "done",
        (count(*) FILTER (WHERE ${isOpen}))::int AS "open",
        (count(*) FILTER (WHERE a."status" = 'APPROVED' AND (${approvedLocal})::date >= ${last7From}::date))::int AS "done7",
        max(a."reviewedAt") FILTER (WHERE a."status" = 'APPROVED') AS "lastDoneAt"
      ${counted}
      GROUP BY a."userId"`,
    db.$queryRaw<TaskRow[]>`
      SELECT u."subteam"::text AS "subteam", GROUPING(u."subteam")::int AS "everyone",
        (count(DISTINCT a."taskId"))::int AS "tasks",
        (count(DISTINCT a."taskId") FILTER (WHERE ${isOpen}))::int AS "active"
      ${counted}
      GROUP BY GROUPING SETS ((u."subteam"), ())`,
    db.$queryRaw<{ weekStart: DateOnly; n: number }[]>`
      SELECT to_char(date_trunc('week', ${approvedLocal}), 'YYYY-MM-DD') AS "weekStart", count(*)::int AS "n"
      ${counted}
        AND a."status" = 'APPROVED'
        AND (${approvedLocal})::date >= ${firstWeek}::date
      GROUP BY 1`,
    // Approved one by one: items counted by marking a whole task finished are left out (one task could fill it).
    db.taskAssignment.findMany({
      where: {
        status: "APPROVED",
        finishedWithTask: false,
        reviewedAt: { not: null },
        user: publicStudentsWhere,
        task: { dueDate: { gte: dateOnlyToDb(since) } },
      },
      select: { userId: true, reviewedAt: true, task: { select: { title: true } } },
      orderBy: [{ reviewedAt: "desc" }, { id: "asc" }],
      take: PUBLIC_RECENT_MAX,
    }),
  ]);

  const byUser = new Map(personRows.map((r) => [r.userId, r]));
  const statsOf = (userId: string) => byUser.get(userId) ?? { done: 0, open: 0, done7: 0, lastDoneAt: null };
  const sum = (list: typeof users) => {
    let done = 0;
    let open = 0;
    let done7 = 0;
    for (const u of list) {
      const s = statsOf(u.id);
      done += s.done;
      open += s.open;
      done7 += s.done7;
    }
    return counts(done, open, done7);
  };
  const everyoneTasks = taskRows.find((r) => r.everyone === 1);
  const tasksWithItems = everyoneTasks?.tasks ?? 0;
  const tasksActive = everyoneTasks?.active ?? 0;

  const subteams = SUBTEAMS.map((key) => {
    const members = users.filter((u) => u.subteam === key);
    const row = taskRows.find((r) => r.everyone === 0 && r.subteam === key);
    return { key, name: SUBTEAM_LABELS[key], ...sum(members), tasksActive: row?.active ?? 0, people: members.length };
  });

  const style = settings.nameStyle;
  const people: PublicPerson[] =
    style === "hidden"
      ? []
      : users
          .filter((u) => !u.hideFromPublicProgress)
          .map((u) => {
            const s = statsOf(u.id);
            return {
              id: publicPersonId(salt, u.id),
              name: publicName(u.name, style) ?? "Team member",
              subteam: u.subteam,
              role: publicRoleLabel(u.role, u.subteam),
              ...counts(s.done, s.open, s.done7),
              lastDoneAt: s.lastDoneAt ? new Date(s.lastDoneAt).toISOString() : null,
            };
          })
          .sort((a, b) => rankOf(a.subteam) - rankOf(b.subteam) || collator.compare(a.name, b.name) || a.id.localeCompare(b.id));

  const usersById = new Map(users.map((u) => [u.id, u]));
  const recent = recentRows.flatMap((r) => {
    if (!r.reviewedAt) return [];
    const user = usersById.get(r.userId);
    return [
      {
        title: settings.showTaskTitles ? r.task.title : null,
        subteam: user?.subteam ?? null,
        who: user && !user.hideFromPublicProgress ? publicName(user.name, style) : null,
        at: r.reviewedAt.toISOString(),
      },
    ];
  });

  const perWeek = new Map(weekRows.map((r) => [r.weekStart, r.n]));
  const weekly = Array.from({ length: PUBLIC_WEEKS }, (_, i) => {
    const weekStart = addDays(firstWeek, 7 * i);
    return { weekStart, itemsDone: perWeek.get(weekStart) ?? 0 };
  });

  return {
    enabled: true,
    team: { name: TEAM_NAME, number: Number(TEAM_NUMBER) },
    since,
    updatedAt: options.now.toISOString(),
    totals: {
      ...sum(users),
      tasksFinished: Math.max(0, tasksWithItems - tasksActive),
      tasksActive,
      people: users.length,
    },
    subteams,
    people,
    recent,
    weekly,
  };
}
