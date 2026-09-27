import "server-only";
// Fundraising (/fundraising): every ACTIVE person sees every fundraiser, the team's progress, and who's
// helping; the Business subteam and staff (canManageFundraisers) also get the edit tools.
// While a fundraiser is open, only helpers whose account is still ACTIVE are listed and counted (the same
// rule the sign-up uses for the spots); once it's over the list shows everyone who helped.

import type { Prisma } from "@/generated/prisma/client";
import type { FundraiserKind, FundraiserStatus, Role, Subteam } from "@/generated/prisma/enums";
import { type DateOnly, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import { fundraiserClosedReason, fundraiserLastDay, parseSeasonGoal, parseSeasonStart } from "@/lib/fundraising";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canManageFundraisers } from "../permissions";
import { FUNDRAISING_SEASON_GOAL_KEY, FUNDRAISING_SEASON_START_KEY } from "../services/fundraising";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin">;

/** Fundraisers still being planned or run (the page shows them all; a team has a handful). */
export const FUNDRAISERS_OPEN_LIMIT = 200;
/** The Done and Cancelled lists show the most recent ones. */
export const FUNDRAISERS_DONE_LIMIT = 30;
export const FUNDRAISERS_CANCELLED_LIMIT = 20;

export interface FundraiserPerson {
  id: string;
  name: string;
  isMe: boolean;
}

export interface FundraiserItem {
  id: string;
  name: string;
  kind: FundraiserKind;
  status: FundraiserStatus;
  description: string;
  location: string;
  /** A safe http(s) link (donation page, sign-up sheet…), or "". */
  link: string;
  startsOn: DateOnly | null;
  endsOn: DateOnly | null;
  goalAmount: number | null;
  raisedAmount: number;
  lead: { id: string; name: string } | null;
  isLead: boolean;
  /** Everyone helping, in the order they signed up. */
  volunteers: FundraiserPerson[];
  volunteerCount: number;
  volunteerLimit: number | null;
  /** Null = no limit. */
  spotsLeft: number | null;
  isVolunteer: boolean;
  /** Why the helper list is closed (done, cancelled, or its last day has passed), or null while it's open. */
  closedReason: string | null;
  /** Still Planning / Upcoming / Happening now, but its last day has passed (nobody marked it done yet). */
  datesPassed: boolean;
  /** "I'll help". */
  canVolunteer: boolean;
  /** "Leave". */
  canLeave: boolean;
  /** Edit / remove / update the amount / take people off the list. */
  canManage: boolean;
}

export interface FundraisingSummary {
  /** Money raised by every fundraiser this season (all-time without a season start) that wasn't cancelled. */
  raised: number;
  /** Their goals added up (fundraisers without a goal count as nothing). */
  goalSum: number;
  /** Set by the Business team; null when not set. */
  seasonGoal: number | null;
  /**
   * The day the season started (set with the goal): only fundraisers whose last day is on or after it
   * count (no dates: added on or after it). Null = every fundraiser counts.
   */
  seasonStart: DateOnly | null;
  /** What the big bar measures against: the season goal, else the sum of goals, else null. */
  target: number | null;
  targetKind: "season" | "goals" | null;
  /** Happening now or upcoming, and not over yet (the "Happening now & upcoming" list). */
  upcomingCount: number;
  /** Open fundraisers the viewer is helping with. */
  helpingCount: number;
}

export interface FundraisingPage {
  canManage: boolean;
  summary: FundraisingSummary;
  /** Happening now first, then upcoming, soonest first (only ones whose dates haven't passed). */
  current: FundraiserItem[];
  planning: FundraiserItem[];
  /** Not marked done or cancelled, but their dates have passed: most recent first. */
  datesPassed: FundraiserItem[];
  /** Most recently finished first. */
  done: FundraiserItem[];
  doneTotal: number;
  cancelled: FundraiserItem[];
  cancelledTotal: number;
}

const itemSelect = {
  id: true,
  name: true,
  kind: true,
  status: true,
  description: true,
  location: true,
  link: true,
  startsOn: true,
  endsOn: true,
  goalAmount: true,
  raisedAmount: true,
  volunteerLimit: true,
  lead: { select: { id: true, name: true } },
  volunteers: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { user: { select: { id: true, name: true, status: true } } },
  },
} satisfies Prisma.FundraiserSelect;

type ItemRow = Prisma.FundraiserGetPayload<{ select: typeof itemSelect }>;

/** Everyone while it's closed (who helped); only ACTIVE people while it's open (who blocks a spot). */
function listedVolunteers<V extends { user: { status: string } }>(volunteers: V[], closedReason: string | null): V[] {
  return closedReason ? volunteers : volunteers.filter((v) => v.user.status === "ACTIVE");
}

function timing(row: Pick<ItemRow, "status" | "startsOn" | "endsOn">, today: DateOnly) {
  const startsOn = row.startsOn ? dbToDateOnly(row.startsOn) : null;
  const endsOn = row.endsOn ? dbToDateOnly(row.endsOn) : null;
  return { startsOn, endsOn, closedReason: fundraiserClosedReason({ status: row.status, startsOn, endsOn }, today) };
}

function toItem(actor: ActorLike, row: ItemRow, today: DateOnly): FundraiserItem {
  const { startsOn, endsOn, closedReason } = timing(row, today);
  const volunteers = listedVolunteers(row.volunteers, closedReason).map((v) => ({
    id: v.user.id,
    name: v.user.name,
    isMe: v.user.id === actor.id,
  }));
  const count = volunteers.length;
  const isVolunteer = volunteers.some((v) => v.isMe);
  const spotsLeft = row.volunteerLimit === null ? null : Math.max(0, row.volunteerLimit - count);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    description: row.description,
    location: row.location,
    link: row.link,
    startsOn,
    endsOn,
    goalAmount: row.goalAmount,
    raisedAmount: row.raisedAmount,
    lead: row.lead,
    isLead: row.lead?.id === actor.id,
    volunteers,
    volunteerCount: count,
    volunteerLimit: row.volunteerLimit,
    spotsLeft,
    isVolunteer,
    closedReason,
    datesPassed: !!closedReason && row.status !== "DONE" && row.status !== "CANCELLED",
    canVolunteer: !closedReason && !isVolunteer && spotsLeft !== 0,
    canLeave: !closedReason && isVolunteer,
    canManage: canManageFundraisers(actor),
  };
}

/** Soonest first; no date goes last; then by name. */
function bySoonest(a: FundraiserItem, b: FundraiserItem): number {
  const da = a.startsOn ?? a.endsOn;
  const db = b.startsOn ?? b.endsOn;
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da < db ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

/** Happening now before upcoming, each soonest first. */
function compareCurrent(a: FundraiserItem, b: FundraiserItem): number {
  const rank = (s: FundraiserStatus) => (s === "ACTIVE" ? 0 : 1);
  return rank(a.status) - rank(b.status) || bySoonest(a, b);
}

/** Most recent last day first; then by name. */
function byLastDayDesc(a: FundraiserItem, b: FundraiserItem): number {
  const da = fundraiserLastDay(a) ?? "";
  const db = fundraiserLastDay(b) ?? "";
  if (da !== db) return da > db ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/** Where a fundraiser's last day is today or later, or it has no dates yet. */
function notOverWhere(today: DateOnly): Prisma.FundraiserWhereInput {
  const day = dateOnlyToDb(today);
  return {
    OR: [{ endsOn: { gte: day } }, { endsOn: null, startsOn: { gte: day } }, { endsOn: null, startsOn: null }],
  };
}

/** Fundraisers that belong to the season starting on `start`: last day on or after it (no dates: added since). */
function seasonWhere(start: DateOnly | null): Prisma.FundraiserWhereInput {
  if (!start) return {};
  const day = dateOnlyToDb(start);
  return {
    OR: [
      { endsOn: { gte: day } },
      { endsOn: null, startsOn: { gte: day } },
      { endsOn: null, startsOn: null, createdAt: { gte: day } },
    ],
  };
}

async function loadSeason(db: Db): Promise<{ goal: number | null; start: DateOnly | null }> {
  const notes = await db.teamNote.findMany({
    where: { key: { in: [FUNDRAISING_SEASON_GOAL_KEY, FUNDRAISING_SEASON_START_KEY] } },
    select: { key: true, body: true },
  });
  const body = (key: string) => notes.find((n) => n.key === key)?.body;
  return { goal: parseSeasonGoal(body(FUNDRAISING_SEASON_GOAL_KEY)), start: parseSeasonStart(body(FUNDRAISING_SEASON_START_KEY)) };
}

/**
 * Team totals: money raised and goals this season (cancelled ones don't count), the season goal, and
 * what's coming up.
 */
export async function getFundraisingSummary(
  actor: ActorLike,
  options: { today: DateOnly },
  db: Db = prisma,
): Promise<FundraisingSummary> {
  const season = await loadSeason(db);
  const [sums, upcomingCount, helpingCount] = await Promise.all([
    db.fundraiser.aggregate({
      where: { AND: [{ status: { not: "CANCELLED" } }, seasonWhere(season.start)] },
      _sum: { raisedAmount: true, goalAmount: true },
    }),
    db.fundraiser.count({ where: { status: { in: ["UPCOMING", "ACTIVE"] }, ...notOverWhere(options.today) } }),
    db.fundraiserVolunteer.count({
      where: { userId: actor.id, fundraiser: { status: { in: ["PLANNING", "UPCOMING", "ACTIVE"] }, ...notOverWhere(options.today) } },
    }),
  ]);
  const raised = sums._sum.raisedAmount ?? 0;
  const goalSum = sums._sum.goalAmount ?? 0;
  const seasonGoal = season.goal;
  const target = seasonGoal ?? (goalSum > 0 ? goalSum : null);
  return {
    raised,
    goalSum,
    seasonGoal,
    seasonStart: season.start,
    target,
    targetKind: seasonGoal !== null ? "season" : goalSum > 0 ? "goals" : null,
    upcomingCount,
    helpingCount,
  };
}

/**
 * The most recently finished DONE fundraisers: by last day (the end date, or the start date for a one-day
 * one), newest first; undated ones after, most recently updated first.
 */
async function loadRecentDone(db: Db) {
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Fundraiser" WHERE status = 'DONE'
    ORDER BY COALESCE("endsOn", "startsOn") DESC NULLS LAST, "updatedAt" DESC, id ASC
    LIMIT ${FUNDRAISERS_DONE_LIMIT}`;
  if (ids.length === 0) return [];
  const rows = await db.fundraiser.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select: itemSelect });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap(({ id }) => byId.get(id) ?? []);
}

/**
 * Everything on /fundraising, grouped: happening now & upcoming, planning, dates passed (still open but
 * over), done (recent), cancelled.
 */
export async function getFundraisingPage(actor: ActorLike, options: { today: DateOnly }, db: Db = prisma): Promise<FundraisingPage> {
  const { today } = options;
  const [open, done, doneTotal, cancelled, cancelledTotal, summary] = await Promise.all([
    db.fundraiser.findMany({
      where: { status: { in: ["PLANNING", "UPCOMING", "ACTIVE"] } },
      select: itemSelect,
      orderBy: [{ startsOn: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      take: FUNDRAISERS_OPEN_LIMIT,
    }),
    loadRecentDone(db),
    db.fundraiser.count({ where: { status: "DONE" } }),
    db.fundraiser.findMany({
      where: { status: "CANCELLED" },
      select: itemSelect,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: FUNDRAISERS_CANCELLED_LIMIT,
    }),
    db.fundraiser.count({ where: { status: "CANCELLED" } }),
    getFundraisingSummary(actor, { today }, db),
  ]);

  const openItems = open.map((row) => toItem(actor, row, today));
  const live = openItems.filter((f) => !f.datesPassed);
  return {
    canManage: canManageFundraisers(actor),
    summary,
    // Same rule as summary.upcomingCount (Upcoming / Happening now whose last day hasn't passed).
    current: live.filter((f) => f.status !== "PLANNING").sort(compareCurrent),
    planning: live.filter((f) => f.status === "PLANNING").sort(bySoonest),
    datesPassed: openItems.filter((f) => f.datesPassed).sort(byLastDayDesc),
    done: done.map((row) => toItem(actor, row, today)),
    doneTotal,
    cancelled: cancelled.map((row) => toItem(actor, row, today)),
    cancelledTotal,
  };
}

export interface FundraiserHelper extends FundraiserPerson {
  role: Role;
  subteam: Subteam | null;
  /** When they signed up (ISO). */
  signedUpAt: string;
}

export interface FundraiserDetail extends FundraiserItem {
  helpers: FundraiserHelper[];
  createdBy: { id: string; name: string } | null;
  /** ISO. */
  createdAt: string;
}

/** One fundraiser (any ACTIVE person can open it), or null when it doesn't exist. */
export async function getFundraiser(
  actor: ActorLike,
  id: string,
  options: { today: DateOnly },
  db: Db = prisma,
): Promise<FundraiserDetail | null> {
  if (!id || id.length > 64) return null;
  const row = await db.fundraiser.findUnique({
    where: { id },
    select: {
      ...itemSelect,
      createdAt: true,
      createdBy: { select: { id: true, name: true } },
      volunteers: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { createdAt: true, user: { select: { id: true, name: true, role: true, subteam: true, status: true } } },
      },
    },
  });
  if (!row) return null;
  const { closedReason } = timing(row, options.today);
  return {
    ...toItem(actor, row, options.today),
    helpers: listedVolunteers(row.volunteers, closedReason).map((v) => ({
      id: v.user.id,
      name: v.user.name,
      isMe: v.user.id === actor.id,
      role: v.user.role,
      subteam: v.user.subteam,
      signedUpAt: v.createdAt.toISOString(),
    })),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface LeadOption {
  id: string;
  name: string;
}

export interface LeadOptionGroup {
  label: string;
  options: LeadOption[];
}

/** Everyone ACTIVE who can lead a fundraiser, grouped for the form's menu (Business first). */
export async function getFundraiserLeadOptions(db: Db = prisma): Promise<LeadOptionGroup[]> {
  const people = await db.user.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, name: true, subteam: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 500,
  });
  const groups: { label: string; match: (s: Subteam | null) => boolean }[] = [
    { label: "Business", match: (s) => s === "BUSINESS" },
    { label: "Software", match: (s) => s === "SOFTWARE" },
    { label: "Build", match: (s) => s === "BUILD" },
    { label: "Captain, mentors, and teachers", match: (s) => s === null },
  ];
  return groups
    .map((g) => ({ label: g.label, options: people.filter((p) => g.match(p.subteam)).map((p) => ({ id: p.id, name: p.name })) }))
    .filter((g) => g.options.length > 0);
}
