import "server-only";
// Strategy → Paths: the team library of paths saved from the planner (PlannerPath). Every ACTIVE person sees and
// opens every saved path. Lists carry metadata only; the .pp data is only read for one path (getPlannerPath: the
// planner's Open, and the download route). Writes: src/server/services/planner-paths.ts.
import type { Prisma } from "@/generated/prisma/client";
import { isPlannerPathId, type PlannerPathTeamFilter } from "@/lib/planner-paths";
import { cleanSearchText, escapeLike } from "@/lib/search";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canAdminister, canEditPlannerPath } from "../permissions";

/** The most paths one list shows (newest first); search or pick a team to find older ones. */
export const PLANNER_PATHS_LIST_MAX = 200;
/** Longest search text used. */
export const PLANNER_PATH_SEARCH_MAX = 100;

export interface PlannerPathTeam {
  number: number;
  name: string;
}

export interface PlannerPathRow {
  id: string;
  name: string;
  notes: string;
  /** The other team it traces, or null (one of ours). */
  team: PlannerPathTeam | null;
  /** Bytes of .pp data. */
  size: number;
  createdAt: Date;
  updatedAt: Date;
  /** Who saved it first / last (null: nobody recorded, or their account was deleted). */
  createdByName: string | null;
  updatedByName: string | null;
  /** The viewer saved it first. */
  mine: boolean;
  /** The viewer may change, rename, or remove it (canEditPlannerPath). */
  canEdit: boolean;
  /** What a change sends back (updatedAt, ISO). */
  version: string;
}

export interface PlannerPathList {
  paths: PlannerPathRow[];
  /** Paths matching the filters (can be more than PLANNER_PATHS_LIST_MAX). */
  total: number;
}

const ROW_SELECT = {
  id: true,
  name: true,
  notes: true,
  size: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  team: { select: { number: true, name: true } },
  createdBy: { select: { name: true } },
  updatedBy: { select: { name: true } },
} as const satisfies Prisma.PlannerPathSelect;

type RowData = Prisma.PlannerPathGetPayload<{ select: typeof ROW_SELECT }>;

function toRow(actor: Actor, p: RowData): PlannerPathRow {
  return {
    id: p.id,
    name: p.name,
    notes: p.notes,
    team: p.team ? { number: p.team.number, name: p.team.name } : null,
    size: p.size,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    createdByName: p.createdBy?.name ?? null,
    updatedByName: p.updatedBy?.name ?? null,
    mine: p.createdById !== null && p.createdById === actor.id,
    canEdit: canEditPlannerPath(actor, p),
    version: p.updatedAt.toISOString(),
  };
}

/**
 * Saved paths, newest change first (at most `take`, default PLANNER_PATHS_LIST_MAX): all of them, ours, or one
 * other team's (`team`: its number; a number that isn't on the list has none), matching `q` in the name or notes
 * (case-insensitive; `%` and `_` are literal). Null for accounts that aren't active.
 */
export async function listPlannerPaths(
  actor: Actor,
  opts: { team?: PlannerPathTeamFilter; q?: string; take?: number } = {},
  db: Db = prisma,
): Promise<PlannerPathList | null> {
  if (actor.status !== "ACTIVE") return null;
  const where: Prisma.PlannerPathWhereInput = {};
  const team = opts.team ?? "all";
  if (team === "ours") where.teamId = null;
  else if (team !== "all") where.team = { number: team };
  const q = cleanSearchText(opts.q, PLANNER_PATH_SEARCH_MAX);
  if (q) {
    const text = escapeLike(q);
    where.OR = [{ name: { contains: text, mode: "insensitive" } }, { notes: { contains: text, mode: "insensitive" } }];
  }
  const take = Math.min(Math.max(1, opts.take ?? PLANNER_PATHS_LIST_MAX), PLANNER_PATHS_LIST_MAX);
  const [rows, total] = await Promise.all([
    db.plannerPath.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take, select: ROW_SELECT }),
    db.plannerPath.count({ where }),
  ]);
  return { paths: rows.map((p) => toRow(actor, p)), total };
}

export interface PlannerPathDetail extends PlannerPathRow {
  /** The .pp file (JSON text). */
  data: string;
}

/**
 * One saved path with its .pp data (the planner's Open, the download), or null (missing, not an id a path can have
 * — no query then — or not active).
 */
export async function getPlannerPath(actor: Actor, id: string, db: Db = prisma): Promise<PlannerPathDetail | null> {
  if (actor.status !== "ACTIVE" || !isPlannerPathId(id)) return null;
  const p = await db.plannerPath.findUnique({ where: { id }, select: { ...ROW_SELECT, data: true } });
  return p ? { ...toRow(actor, p), data: p.data } : null;
}

/** One saved path for its edit form (no data): only for people who may change it, else null. */
export async function getPlannerPathForEdit(actor: Actor, id: string, db: Db = prisma): Promise<PlannerPathRow | null> {
  if (actor.status !== "ACTIVE" || !isPlannerPathId(id)) return null;
  const p = await db.plannerPath.findUnique({ where: { id }, select: ROW_SELECT });
  if (!p) return null;
  const row = toRow(actor, p);
  return row.canEdit ? row : null;
}

/** The other teams in the league, by number (whose path it is: the planner's and the edit form's team menus). */
export async function listPlannerPathTeams(actor: Actor, db: Db = prisma): Promise<PlannerPathTeam[] | null> {
  if (actor.status !== "ACTIVE") return null;
  return db.leagueTeam.findMany({ orderBy: { number: "asc" }, take: 500, select: { number: true, name: true } });
}

/** The planner's session: who's signed in, whether they can change everyone's paths, and the teams. */
export async function getPlannerSession(
  actor: Actor,
  db: Db = prisma,
): Promise<{ user: { name: string; canManageAll: boolean }; teams: PlannerPathTeam[] } | null> {
  const teams = await listPlannerPathTeams(actor, db);
  if (!teams) return null;
  return { user: { name: actor.name, canManageAll: canAdminister(actor) }, teams };
}
