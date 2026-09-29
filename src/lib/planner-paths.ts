// Strategy → Paths (client-safe): the team library of paths saved from the Pedro Pathing planner. The planner is
// served by this site (public/planner/, a static build of the PedroPathingBiobuzz app) and saves to the library
// through /api/planner/* (src/app/api/planner/). Server code: src/server/services/planner-paths.ts (writes) and
// src/server/queries/planner-paths.ts (reads).
import { OUR_TEAM_NUMBER, PEDRO_VISUALIZER_URL } from "./constants";

/**
 * The planner on this site. Its build uses relative links (`./assets/…`), so it must be opened at a URL ending in
 * "/planner/…": `index.html` itself, not "/planner" (Next.js sends "/planner/" there; next.config.ts sends that on
 * to this page).
 */
export const PLANNER_URL = "/planner/index.html";

/** The same planner on GitHub Pages (no team library there: its paths stay in that browser). */
export const PLANNER_GITHUB_PAGES_URL = PEDRO_VISUALIZER_URL;

/** The planner, opening a saved path from the team library. */
export function plannerOpenHref(pathId: string): string {
  return `${PLANNER_URL}?path=${encodeURIComponent(pathId)}`;
}

/**
 * The planner on another team's page ("Trace their path"): its Save to team library then starts with that team as
 * whose path it is (the planner reads `?team=`, and only uses it when the team is on its list).
 */
export function plannerTeamHref(teamNumber: number): string {
  return `${PLANNER_URL}?team=${encodeURIComponent(String(teamNumber))}`;
}

/**
 * What a saved path's id can look like: the database's cuids and the seed's readable ids (the planner checks
 * `?path=` the same way). Anything else is never a saved path — answered "not found" before the database is asked
 * (a NUL byte would make Postgres refuse the query).
 */
export const PLANNER_PATH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `id` could be a saved path's id (PLANNER_PATH_ID). */
export function isPlannerPathId(id: unknown): id is string {
  return typeof id === "string" && PLANNER_PATH_ID.test(id);
}

/** Downloads a saved path as a .pp file (the planner's Load opens it). */
export function plannerPathDownloadHref(pathId: string): string {
  return `/strategy/paths/${encodeURIComponent(pathId)}/download`;
}

/** Which paths a list shows: all of them, ours, or one other team's (by number). */
export type PlannerPathTeamFilter = "all" | "ours" | number;

/**
 * `?team=` from a URL or the planner's API: "all" (or nothing), "ours", or another team's number ("9040", "#9040").
 * Null for anything else, and for our own number (ours are "ours").
 */
export function parsePlannerPathTeamFilter(value: string | null | undefined): PlannerPathTeamFilter | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "all") return "all";
  if (v === "ours") return "ours";
  const digits = v.replace(/^#/, "");
  if (!/^\d{1,6}$/.test(digits)) return null;
  const number = Number(digits);
  return number >= 1 && number !== OUR_TEAM_NUMBER ? number : null;
}

/** The filter as it goes in a URL ("all" is left out). */
export function plannerPathTeamParam(filter: PlannerPathTeamFilter): string | null {
  return filter === "all" ? null : String(filter);
}

/** Whose path it is: "Ours", or "9040 · STEAMpunks Alpha". */
export function plannerPathWhose(team: { number: number; name: string } | null): string {
  return team ? `${team.number} · ${team.name}` : "Ours";
}

/** The Remove button's question. */
export function plannerPathRemoveQuestion(name: string): string {
  return `Remove “${name}” from the team's saved paths? This can't be undone (download it first to keep a copy).`;
}
