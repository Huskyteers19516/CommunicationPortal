import "server-only";
// Strategy → Other teams: the other teams in our league, for every ACTIVE person (writing about them is for everyone
// too; adding, renaming, and removing teams is canManageLeagueTeams). Strategies about a team come from
// listStrategies(…, { teamId }) in ./strategy.ts.
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canManageLeagueTeams } from "../permissions";

/** More than any league has; the list isn't paged. */
const TEAMS_MAX = 500;

export interface LeagueTeamRow {
  id: string;
  number: number;
  name: string;
  city: string;
  /** Strategies written about them. */
  strategyCount: number;
  hasSummary: boolean;
  /** When "Their strategy at a glance" was last saved, or null (never). */
  summaryUpdatedAt: Date | null;
}

export interface LeagueTeamList {
  teams: LeagueTeamRow[];
  /** Teams on the list before the search. */
  total: number;
  canManage: boolean;
}

/** "9040", "#90", "steam", "irvine": a number (or its start), or part of the name or city. */
function matches(team: { number: number; name: string; city: string }, q: string): boolean {
  const query = q.trim().toLowerCase();
  if (!query) return true;
  const digits = query.replace(/^#/, "");
  if (/^\d+$/.test(digits)) return String(team.number).startsWith(digits);
  return team.name.toLowerCase().includes(query) || team.city.toLowerCase().includes(query);
}

/** The other teams, by number, filtered by `q` (see matches). Null for accounts that aren't active. */
export async function listLeagueTeams(actor: Actor, opts: { q?: string } = {}, db: Db = prisma): Promise<LeagueTeamList | null> {
  if (actor.status !== "ACTIVE") return null;
  const [rows, written] = await Promise.all([
    db.leagueTeam.findMany({
      orderBy: { number: "asc" },
      take: TEAMS_MAX,
      select: { id: true, number: true, name: true, city: true, summaryUpdatedAt: true, _count: { select: { strategies: true } } },
    }),
    // Which ones have a summary, without loading the text (saves trim it, so a cleared one is "").
    db.leagueTeam.findMany({ where: { summary: { not: "" } }, select: { id: true } }),
  ]);
  const withSummary = new Set(written.map((t) => t.id));
  const total = rows.length < TEAMS_MAX ? rows.length : await db.leagueTeam.count();
  const q = (opts.q ?? "").slice(0, 100);
  return {
    teams: rows
      .filter((t) => matches(t, q))
      .map((t) => ({
        id: t.id,
        number: t.number,
        name: t.name,
        city: t.city,
        strategyCount: t._count.strategies,
        hasSummary: withSummary.has(t.id),
        summaryUpdatedAt: t.summaryUpdatedAt,
      })),
    total,
    canManage: canManageLeagueTeams(actor),
  };
}

/** The Strategy tabs' counts: our own strategies, and the other teams. Null for accounts that aren't active. */
export async function getStrategyTabCounts(actor: Actor, db: Db = prisma): Promise<{ ours: number; teams: number } | null> {
  if (actor.status !== "ACTIVE") return null;
  const [ours, teams] = await Promise.all([db.strategy.count({ where: { teamId: null } }), db.leagueTeam.count()]);
  return { ours, teams };
}

export interface LeagueTeamDetail {
  id: string;
  number: number;
  name: string;
  city: string;
  summary: string;
  summaryUpdatedAt: Date | null;
  summaryUpdatedByName: string | null;
  /** What the summary form sends back (summaryUpdatedAt as ISO, "" = never written): a newer save is a conflict. */
  summaryVersion: string;
  strategyCount: number;
  /** Files on the strategies about them (they go when the team is removed). */
  fileCount: number;
  canManage: boolean;
}

/** Parses a team number from the URL ("9040"); null for anything else. */
export function parseTeamNumber(value: string | undefined): number | null {
  if (!value || !/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}

/** One team for its page, by number, or null (missing, or an account that isn't active). */
export async function getLeagueTeam(actor: Actor, number: number | null, db: Db = prisma): Promise<LeagueTeamDetail | null> {
  if (actor.status !== "ACTIVE" || number === null || !Number.isSafeInteger(number)) return null;
  const t = await db.leagueTeam.findUnique({
    where: { number },
    select: {
      id: true,
      number: true,
      name: true,
      city: true,
      summary: true,
      summaryUpdatedAt: true,
      summaryUpdatedBy: { select: { name: true } },
      _count: { select: { strategies: true } },
    },
  });
  if (!t) return null;
  const fileCount = await db.strategyFile.count({ where: { strategy: { teamId: t.id } } });
  return {
    id: t.id,
    number: t.number,
    name: t.name,
    city: t.city,
    summary: t.summary,
    summaryUpdatedAt: t.summaryUpdatedAt,
    summaryUpdatedByName: t.summaryUpdatedAt ? (t.summaryUpdatedBy?.name ?? "a former member") : null,
    summaryVersion: t.summaryUpdatedAt ? t.summaryUpdatedAt.toISOString() : "",
    strategyCount: t._count.strategies,
    fileCount,
    canManage: canManageLeagueTeams(actor),
  };
}

/** A team for its edit form: people who can manage the list only. */
export async function getLeagueTeamForEdit(actor: Actor, number: number | null, db: Db = prisma): Promise<LeagueTeamDetail | null> {
  const t = await getLeagueTeam(actor, number, db);
  return t?.canManage ? t : null;
}
