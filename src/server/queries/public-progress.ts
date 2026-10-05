import "server-only";
// The team website's live progress (GET /api/public/progress, no sign-in). Only aggregate, non-sensitive numbers:
// never emails, notes, review notes, due dates / overdue, questions, account ids, or anything about accounts that
// aren't ACTIVE. See "Public progress (team website)" in docs/CONVENTIONS.md for the exact counting rules.
//
// Who counts: ACTIVE students — members, subteam leaders, and the captain (owners too, whatever their position) —
// never mentors or teachers. People who turned off "Show me on the team website" (User.hideFromPublicProgress) are
// left out of `people` and `recent`; they count in the totals only when at least PUBLIC_HIDDEN_MIN_GROUP people in
// their group (subteam, or no subteam) did, so nobody's numbers are a group total minus the listed people.
// What counts: the checklist items (TaskAssignment) of tasks due on or after `since`. Approved = done (also the
// ones counted when a leader marked the whole task finished); to do / checked off / sent back = open, unless the
// task is marked finished (then they're closed and count as neither).
//
// Polled by every visitor (every 30 s, cached 15 s by Vercel, built at most every 10 s per server instance — see
// public-api.ts), so it's a fixed handful of aggregate queries, run one after another (one database connection).
import { createHmac, randomBytes } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { Role, Subteam } from "@/generated/prisma/enums";
import { ATTENDANCE_SETTINGS_KEY, parseAttendanceSettings, weekStartOf } from "@/lib/attendance";
import { SUBTEAM_LABELS, SUBTEAMS, TEAM_NAME, TEAM_NUMBER } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, todayInTimezone } from "@/lib/dates";
import {
  type NameStyle,
  type PublicCounts,
  type PublicPerson,
  type PublicProgressAnswer,
  type PublicProgressSettings,
  PUBLIC_HIDDEN_MIN_GROUP,
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
  /** Of them: left out of every number, because too few in their group are hidden (PUBLIC_HIDDEN_MIN_GROUP). */
  hiddenUncounted: number;
}

/** Admin → Approvals → Team website. Null for everyone without admin access. */
export async function getPublicProgressAdminView(actor: Actor, db: Db = prisma): Promise<PublicProgressAdminView | null> {
  if (actor.status !== "ACTIVE" || !canManagePublicProgress(actor)) return null;
  const [config, hidden] = await Promise.all([
    getPublicProgressConfig(db),
    db.user.findMany({
      where: { ...publicStudentsWhere, hideFromPublicProgress: true },
      select: { id: true, subteam: true, hideFromPublicProgress: true },
      take: PEOPLE_CAP,
    }),
  ]);
  return { ...config, hiddenPeople: hidden.length, hiddenUncounted: uncountedHiddenIds(hidden).size };
}

/**
 * The people left out of every number: those who hid themselves in a group (subteam, or no subteam) where fewer than
 * PUBLIC_HIDDEN_MIN_GROUP did. Their group's total minus its listed people would otherwise be exactly their numbers.
 */
export function uncountedHiddenIds(users: { id: string; subteam: Subteam | null; hideFromPublicProgress: boolean }[]): Set<string> {
  const hiddenByGroup = new Map<Subteam | null, string[]>();
  for (const u of users) {
    if (!u.hideFromPublicProgress) continue;
    const ids = hiddenByGroup.get(u.subteam) ?? [];
    ids.push(u.id);
    hiddenByGroup.set(u.subteam, ids);
  }
  const out = new Set<string>();
  for (const ids of hiddenByGroup.values()) if (ids.length < PUBLIC_HIDDEN_MIN_GROUP) for (const id of ids) out.add(id);
  return out;
}

// ── Opaque ids ───────────────────────────────────────────────────────────────

/**
 * A person's id on the public page: an HMAC of the account id with the salt (never the account id itself). The name
 * style is part of it, so switching to shorter names gives everyone new ids: a copy saved earlier can't be matched up
 * by id to put the full names back on.
 */
export function publicPersonId(salt: string, userId: string, style: NameStyle): string {
  return createHmac("sha256", salt).update(`person:${style}:${userId}`).digest("base64url").slice(0, 16);
}

/**
 * The salt for publicPersonId. Saving the page's settings makes it (services/public-progress.ts), so the public
 * request normally only reads it; if it's still missing (or too short), the first request that needs it makes it.
 * Two first requests at once agree: only one insert wins and both read it back.
 */
export async function publicProgressIdSalt(db: Db, saved?: string | null): Promise<string> {
  // undefined: not read yet; null: there's no salt yet.
  if (saved === undefined) {
    const row = await db.teamNote.findUnique({ where: { key: PUBLIC_PROGRESS_ID_SALT_KEY }, select: { body: true } });
    saved = row?.body ?? null;
  }
  if (saved !== null && saved.length >= SALT_MIN_LENGTH) return saved;
  const fresh = randomBytes(32).toString("base64url");
  if (saved === null) {
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
  submitted: number;
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

/** A time on the public page: to the minute (seconds and milliseconds dropped). */
export function publicTime(at: Date | string): string {
  const t = new Date(at).getTime();
  return new Date(t - (((t % 60_000) + 60_000) % 60_000)).toISOString();
}

function counts(done: number, open: number, submitted: number, done7: number): PublicCounts {
  return {
    itemsDone: done,
    itemsOpen: open,
    itemsSubmitted: submitted,
    completion: publicCompletion(done, open),
    doneLast7Days: done7,
  };
}

/** The first week in `weekly`: 8 weeks back, or the week `since` falls in when that's later (never after this week). */
export function firstPublicWeek(since: DateOnly, thisWeek: DateOnly): DateOnly {
  const eightBack = addDays(thisWeek, -7 * (PUBLIC_WEEKS - 1));
  const sinceWeek = weekStartOf(since);
  if (sinceWeek > thisWeek) return thisWeek;
  return sinceWeek > eightBack ? sinceWeek : eightBack;
}

/**
 * Everything the public page shows, or {enabled: false} while the page is turned off. `now` and `teamTimezone`
 * decide "the last 7 days" and the weeks (Monday to Sunday, team timezone).
 */
export async function getPublicProgress(db: Db, options: { now: Date; teamTimezone: string }): Promise<PublicProgressAnswer> {
  const notes = await readNotes(db, [PUBLIC_PROGRESS_KEY, ATTENDANCE_SETTINGS_KEY, PUBLIC_PROGRESS_ID_SALT_KEY]);
  const { settings, since } = configFrom(notes);
  if (!settings.enabled) return { enabled: false };

  const style = settings.nameStyle;
  const tz = options.teamTimezone;
  const today = todayInTimezone(tz, options.now);
  const last7From = addDays(today, -6);
  const thisWeek = weekStartOf(today);
  const firstWeek = firstPublicWeek(since, thisWeek);

  // One query at a time: each holds one of the pool's few connections, and this runs for anonymous visitors.
  const salt = style === "hidden" ? null : await publicProgressIdSalt(db, notes.get(PUBLIC_PROGRESS_ID_SALT_KEY) ?? null);
  const users = await db.user.findMany({
    where: publicStudentsWhere,
    select: { id: true, name: true, role: true, subteam: true, hideFromPublicProgress: true },
    orderBy: { id: "asc" },
    take: PEOPLE_CAP,
  });
  const uncounted = uncountedHiddenIds(users);
  const countedUsers = users.filter((u) => !uncounted.has(u.id));

  // The counted items: tasks due on/after `since`, people who count. Enum values are SQL literals on purpose.
  const counted = Prisma.sql`
    FROM "TaskAssignment" a
    JOIN "Task" t ON t."id" = a."taskId"
    JOIN "User" u ON u."id" = a."userId"
    WHERE t."dueDate" >= ${since}::date
      AND u."status" = 'ACTIVE'
      AND u."role" NOT IN ('MENTOR', 'TEACHER')
      AND u."id" <> ALL(${[...uncounted]}::text[])`;
  // The calendar day (team timezone) an item was approved: reviewedAt is a UTC timestamp without a zone.
  const approvedLocal = Prisma.sql`((a."reviewedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)`;
  const isOpen = Prisma.sql`(a."status" <> 'APPROVED' AND t."completedAt" IS NULL)`;

  const personRows = await db.$queryRaw<PersonRow[]>`
    SELECT a."userId" AS "userId",
      (count(*) FILTER (WHERE a."status" = 'APPROVED'))::int AS "done",
      (count(*) FILTER (WHERE ${isOpen}))::int AS "open",
      (count(*) FILTER (WHERE a."status" = 'SUBMITTED' AND t."completedAt" IS NULL))::int AS "submitted",
      (count(*) FILTER (WHERE a."status" = 'APPROVED' AND (${approvedLocal})::date >= ${last7From}::date))::int AS "done7",
      max(a."reviewedAt") FILTER (WHERE a."status" = 'APPROVED') AS "lastDoneAt"
    ${counted}
    GROUP BY a."userId"`;
  const taskRows = await db.$queryRaw<TaskRow[]>`
    SELECT u."subteam"::text AS "subteam", GROUPING(u."subteam")::int AS "everyone",
      (count(DISTINCT a."taskId"))::int AS "tasks",
      (count(DISTINCT a."taskId") FILTER (WHERE ${isOpen}))::int AS "active"
    ${counted}
    GROUP BY GROUPING SETS ((u."subteam"), ())`;
  const weekRows = await db.$queryRaw<{ weekStart: DateOnly; n: number }[]>`
    SELECT to_char(date_trunc('week', ${approvedLocal}), 'YYYY-MM-DD') AS "weekStart", count(*)::int AS "n"
    ${counted}
      AND a."status" = 'APPROVED'
      AND (${approvedLocal})::date >= ${firstWeek}::date
    GROUP BY 1`;
  // Approved one by one: items counted by marking a whole task finished are left out (one task could fill it), and so
  // is everyone who left themselves off the list (a title and a time could still point at them).
  const recentRows = await db.taskAssignment.findMany({
    where: {
      status: "APPROVED",
      finishedWithTask: false,
      reviewedAt: { not: null },
      user: { ...publicStudentsWhere, hideFromPublicProgress: false },
      task: { dueDate: { gte: dateOnlyToDb(since) } },
    },
    select: { userId: true, reviewedAt: true, task: { select: { title: true } } },
    orderBy: [{ reviewedAt: "desc" }, { id: "asc" }],
    take: PUBLIC_RECENT_MAX,
  });

  const byUser = new Map(personRows.map((r) => [r.userId, r]));
  const statsOf = (userId: string) => byUser.get(userId) ?? { done: 0, open: 0, submitted: 0, done7: 0, lastDoneAt: null };
  const sum = (list: typeof users) => {
    let done = 0;
    let open = 0;
    let submitted = 0;
    let done7 = 0;
    for (const u of list) {
      const s = statsOf(u.id);
      done += s.done;
      open += s.open;
      submitted += s.submitted;
      done7 += s.done7;
    }
    return counts(done, open, submitted, done7);
  };
  const everyoneTasks = taskRows.find((r) => r.everyone === 1);
  const tasksWithItems = everyoneTasks?.tasks ?? 0;
  const tasksActive = everyoneTasks?.active ?? 0;

  const subteams = SUBTEAMS.map((key) => {
    const members = countedUsers.filter((u) => u.subteam === key);
    const row = taskRows.find((r) => r.everyone === 0 && r.subteam === key);
    return { key, name: SUBTEAM_LABELS[key], ...sum(members), tasksActive: row?.active ?? 0, people: members.length };
  });

  const people: PublicPerson[] =
    salt === null
      ? []
      : users
          .filter((u) => !u.hideFromPublicProgress)
          .map((u) => {
            const s = statsOf(u.id);
            return {
              id: publicPersonId(salt, u.id, style),
              name: publicName(u.name, style) ?? "Team member",
              subteam: u.subteam,
              role: publicRoleLabel(u.role, u.subteam),
              ...counts(s.done, s.open, s.submitted, s.done7),
              lastDoneAt: s.lastDoneAt ? publicTime(s.lastDoneAt) : null,
            };
          })
          .sort((a, b) => rankOf(a.subteam) - rankOf(b.subteam) || collator.compare(a.name, b.name) || a.id.localeCompare(b.id));

  const usersById = new Map(users.map((u) => [u.id, u]));
  const recent = recentRows.flatMap((r) => {
    const user = usersById.get(r.userId);
    if (!r.reviewedAt || !user || user.hideFromPublicProgress) return [];
    return [
      {
        title: settings.showTaskTitles ? r.task.title : null,
        subteam: user.subteam,
        who: publicName(user.name, style),
        at: publicTime(r.reviewedAt),
      },
    ];
  });

  const perWeek = new Map(weekRows.map((r) => [r.weekStart, r.n]));
  const weekly: { weekStart: DateOnly; itemsDone: number }[] = [];
  for (let weekStart = firstWeek; weekStart <= thisWeek; weekStart = addDays(weekStart, 7)) {
    weekly.push({ weekStart, itemsDone: perWeek.get(weekStart) ?? 0 });
  }

  return {
    enabled: true,
    team: { name: TEAM_NAME, number: Number(TEAM_NUMBER) },
    since,
    updatedAt: options.now.toISOString(),
    totals: {
      ...sum(countedUsers),
      tasksFinished: Math.max(0, tasksWithItems - tasksActive),
      tasksActive,
      people: countedUsers.length,
    },
    subteams,
    people,
    recent,
    weekly,
  };
}
