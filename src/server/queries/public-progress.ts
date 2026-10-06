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
//
// One listed person's page (GET /api/public/progress/people/<id>, getPublicPersonProgress) uses the very same SQL
// pieces for that person, so their numbers are exactly their `people` entry; it's null — a 404 — for anyone the
// progress JSON doesn't list, and for everyone while the profiles (`showPersonPages`, off by default) are off.
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
  type PublicPersonProgress,
  type PublicProgressAnswer,
  type PublicProgressSettings,
  type PublicWeek,
  PUBLIC_HIDDEN_MIN_GROUP,
  PUBLIC_PERSON_DONE_MAX,
  PUBLIC_PERSON_ID_RE,
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

const NO_ITEMS: Omit<PersonRow, "userId"> = { done: 0, open: 0, submitted: 0, done7: 0, lastDoneAt: null };

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

// ── The counting rules, as SQL (the progress JSON and one person's page share them) ──────────────────────────

/**
 * The counted items: tasks due on/after `since`, people who count (ACTIVE, not mentors or teachers, not in
 * `uncounted`). Ends inside its WHERE, so `AND …` can follow. Enum values are SQL literals on purpose.
 */
function countedItemsSql(since: DateOnly, uncounted: Iterable<string>): Prisma.Sql {
  return Prisma.sql`
    FROM "TaskAssignment" a
    JOIN "Task" t ON t."id" = a."taskId"
    JOIN "User" u ON u."id" = a."userId"
    WHERE t."dueDate" >= ${since}::date
      AND u."status" = 'ACTIVE'
      AND u."role" NOT IN ('MENTOR', 'TEACHER')
      AND u."id" <> ALL(${[...uncounted]}::text[])`;
}

/** The calendar day (team timezone) an item was approved: reviewedAt is a UTC timestamp without a zone. */
function approvedLocalSql(tz: string): Prisma.Sql {
  return Prisma.sql`((a."reviewedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}::text)`;
}

/** An open item: not approved, on a task that isn't marked finished. */
const IS_OPEN = Prisma.sql`(a."status" <> 'APPROVED' AND t."completedAt" IS NULL)`;

/** Per person: done, open, waiting for review, done in the last 7 days, newest approval (PersonRow). */
function personCountsSql(counted: Prisma.Sql, tz: string, last7From: DateOnly): Prisma.Sql {
  return Prisma.sql`
    SELECT a."userId" AS "userId",
      (count(*) FILTER (WHERE a."status" = 'APPROVED'))::int AS "done",
      (count(*) FILTER (WHERE ${IS_OPEN}))::int AS "open",
      (count(*) FILTER (WHERE a."status" = 'SUBMITTED' AND t."completedAt" IS NULL))::int AS "submitted",
      (count(*) FILTER (WHERE a."status" = 'APPROVED' AND (${approvedLocalSql(tz)})::date >= ${last7From}::date))::int AS "done7",
      max(a."reviewedAt") FILTER (WHERE a."status" = 'APPROVED') AS "lastDoneAt"
    ${counted}
    GROUP BY a."userId"`;
}

/** Approvals per Monday–Sunday week (team timezone) from `firstWeek`; weeks without any are missing (weeklyFrom fills them). */
function weeklySql(counted: Prisma.Sql, tz: string, firstWeek: DateOnly): Prisma.Sql {
  const approvedLocal = approvedLocalSql(tz);
  return Prisma.sql`
    SELECT to_char(date_trunc('week', ${approvedLocal}), 'YYYY-MM-DD') AS "weekStart", count(*)::int AS "n"
    ${counted}
      AND a."status" = 'APPROVED'
      AND (${approvedLocal})::date >= ${firstWeek}::date
    GROUP BY 1`;
}

/** Every week from `firstWeek` through `thisWeek`, zero-filled. */
function weeklyFrom(rows: { weekStart: DateOnly; n: number }[], firstWeek: DateOnly, thisWeek: DateOnly): PublicWeek[] {
  const perWeek = new Map(rows.map((r) => [r.weekStart, r.n]));
  const weekly: PublicWeek[] = [];
  for (let weekStart = firstWeek; weekStart <= thisWeek; weekStart = addDays(weekStart, 7)) {
    weekly.push({ weekStart, itemsDone: perWeek.get(weekStart) ?? 0 });
  }
  return weekly;
}

/** The days "the last 7 days" and the weeks are counted from (team timezone). */
function publicCalendar(since: DateOnly, now: Date, tz: string) {
  const today = todayInTimezone(tz, now);
  const thisWeek = weekStartOf(today);
  return { last7From: addDays(today, -6), thisWeek, firstWeek: firstPublicWeek(since, thisWeek) };
}

/** A person's entry in `people` (also `person` on their own page): the same fields, in the same order. */
function publicPersonEntry(
  user: { id: string; name: string; role: Role; subteam: Subteam | null },
  stats: Omit<PersonRow, "userId">,
  salt: string,
  style: NameStyle,
): PublicPerson {
  return {
    id: publicPersonId(salt, user.id, style),
    name: publicName(user.name, style) ?? "Team member",
    subteam: user.subteam,
    role: publicRoleLabel(user.role, user.subteam),
    ...counts(stats.done, stats.open, stats.submitted, stats.done7),
    lastDoneAt: stats.lastDoneAt ? publicTime(stats.lastDoneAt) : null,
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
  const { last7From, thisWeek, firstWeek } = publicCalendar(since, options.now, tz);

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

  // The counted items: tasks due on/after `since`, people who count.
  const counted = countedItemsSql(since, uncounted);

  const personRows = await db.$queryRaw<PersonRow[]>(personCountsSql(counted, tz, last7From));
  const taskRows = await db.$queryRaw<TaskRow[]>`
    SELECT u."subteam"::text AS "subteam", GROUPING(u."subteam")::int AS "everyone",
      (count(DISTINCT a."taskId"))::int AS "tasks",
      (count(DISTINCT a."taskId") FILTER (WHERE ${IS_OPEN}))::int AS "active"
    ${counted}
    GROUP BY GROUPING SETS ((u."subteam"), ())`;
  const weekRows = await db.$queryRaw<{ weekStart: DateOnly; n: number }[]>(weeklySql(counted, tz, firstWeek));
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
  const statsOf = (userId: string) => byUser.get(userId) ?? NO_ITEMS;
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
          .map((u) => publicPersonEntry(u, statsOf(u.id), salt, style))
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

  const weekly = weeklyFrom(weekRows, firstWeek, thisWeek);

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

// ── One person (GET /api/public/progress/people/<id>) ─────────────────────────

/** Someone the progress JSON lists, as the person page needs them. */
export interface PublicListedPerson {
  id: string;
  name: string;
  role: Role;
  subteam: Subteam | null;
}

/**
 * Who the person page can answer for right now: the settings it needs and the listed people by their public id. Null
 * while there's nobody to answer for: the page or the profiles (`showPersonPages`) off, names hidden, or no salt yet.
 * The person route keeps one per server instance for PUBLIC_ANSWER_TTL_MS (public-api.ts), so an id that isn't in it —
 * made up, or someone who left themselves off the list — is answered from memory: no database read, no cache entry.
 */
export interface PublicPeopleDirectory {
  since: DateOnly;
  style: NameStyle;
  salt: string;
  showTaskTitles: boolean;
  /** `people[].id` → that person (only the listed people: ACTIVE students who didn't hide themselves). */
  byId: Map<string, PublicListedPerson>;
}

/**
 * The directory (PublicPeopleDirectory): two reads one after another (settings, then the listed people — an HMAC each
 * for their ids), never a write. Read-only: an id can only come from the progress JSON, which makes the salt, so a
 * missing (or too short) salt means no id is valid yet.
 */
export async function getPublicPeopleDirectory(db: Db): Promise<PublicPeopleDirectory | null> {
  const notes = await readNotes(db, [PUBLIC_PROGRESS_KEY, ATTENDANCE_SETTINGS_KEY, PUBLIC_PROGRESS_ID_SALT_KEY]);
  const { settings, since } = configFrom(notes);
  const style = settings.nameStyle;
  const salt = notes.get(PUBLIC_PROGRESS_ID_SALT_KEY) ?? null;
  if (!settings.enabled || !settings.showPersonPages || style === "hidden" || salt === null || salt.length < SALT_MIN_LENGTH) {
    return null;
  }
  // Only the people the progress JSON lists: whoever left themselves off it can't be found by any id.
  const listed = await db.user.findMany({
    where: { ...publicStudentsWhere, hideFromPublicProgress: false },
    select: { id: true, name: true, role: true, subteam: true },
    orderBy: { id: "asc" },
    take: PEOPLE_CAP,
  });
  const byId = new Map<string, PublicListedPerson>();
  for (const u of listed) byId.set(publicPersonId(salt, u.id, style), u);
  return { since, style, salt, showTaskTitles: settings.showTaskTitles, byId };
}

/**
 * One listed person's page: exactly their `people` entry, their approvals per week (the same weeks as `weekly`), and
 * their newest PUBLIC_PERSON_DONE_MAX approvals (tasks due on or after `since`, whole-task credit included and marked
 * `withTask`; titles only while task titles are shown; the task's subteam). Null — the endpoint's one 404, whatever
 * the reason — while the page or the profiles are off or names are hidden, or when `id` isn't a listed person's id:
 * unknown, someone who left themselves off the list, a mentor or teacher, an account that isn't ACTIVE. Those last
 * cases are one code path (the id is looked for among the listed people only), so nothing tells them apart.
 *
 * Never emails, notes, review notes, due dates, overdue/late info, or account or task ids. At most five reads, one
 * after another, never a write: the directory (getPublicPeopleDirectory: settings, the listed people), then that
 * person's counts, weeks, and approvals (getPublicPersonProgressFor). An id that can't be a person's id reads nothing.
 */
export async function getPublicPersonProgress(
  db: Db,
  options: { now: Date; teamTimezone: string; id: string },
): Promise<PublicPersonProgress | null> {
  if (!PUBLIC_PERSON_ID_RE.test(options.id)) return null;
  const directory = await getPublicPeopleDirectory(db);
  return directory ? getPublicPersonProgressFor(db, directory, options) : null;
}

/**
 * getPublicPersonProgress with the directory already read (the route reuses one for PUBLIC_ANSWER_TTL_MS): null without
 * a read when `id` isn't in it, else three reads one after another (their counts, weeks, and approvals).
 */
export async function getPublicPersonProgressFor(
  db: Db,
  directory: PublicPeopleDirectory,
  options: { now: Date; teamTimezone: string; id: string },
): Promise<PublicPersonProgress | null> {
  const user = directory.byId.get(options.id);
  if (!user) return null;
  const { since, salt, style } = directory;

  const tz = options.teamTimezone;
  const { last7From, thisWeek, firstWeek } = publicCalendar(since, options.now, tz);
  // Their counted items. Someone listed is never left out of the numbers (only hidden people can be), so no one else
  // needs to be loaded to count theirs exactly as the progress JSON does.
  const theirs = Prisma.sql`${countedItemsSql(since, [])}
      AND a."userId" = ${user.id}`;
  const [stats] = await db.$queryRaw<PersonRow[]>(personCountsSql(theirs, tz, last7From));
  const weekRows = await db.$queryRaw<{ weekStart: DateOnly; n: number }[]>(weeklySql(theirs, tz, firstWeek));
  const doneRows = await db.taskAssignment.findMany({
    where: {
      userId: user.id,
      status: "APPROVED",
      reviewedAt: { not: null },
      user: publicStudentsWhere,
      task: { dueDate: { gte: dateOnlyToDb(since) } },
    },
    select: { reviewedAt: true, finishedWithTask: true, task: { select: { title: true, subteam: true } } },
    orderBy: [{ reviewedAt: "desc" }, { id: "asc" }],
    take: PUBLIC_PERSON_DONE_MAX,
  });

  return {
    enabled: true,
    updatedAt: options.now.toISOString(),
    since,
    person: publicPersonEntry(user, stats ?? NO_ITEMS, salt, style),
    weekly: weeklyFrom(weekRows, firstWeek, thisWeek),
    done: doneRows.flatMap((r) =>
      r.reviewedAt
        ? [{ title: directory.showTaskTitles ? r.task.title : null, subteam: r.task.subteam, at: publicTime(r.reviewedAt), withTask: r.finishedWithTask }]
        : [],
    ),
  };
}
