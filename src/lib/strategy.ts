// Strategy page (client-safe): the checks the add/edit form runs on a picked file right away. The server runs
// them again (src/server/services/strategy.ts), plus the ones that need the database (storage, file counts).
import { LIMITS } from "./constants";
import { formatFileSize, RESOURCE_FILE_MAX_MB } from "./files";

/** Lower-case extension without the dot ("Red Auto.PP" → "pp"), or "" when there is none. */
function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : "";
}

/** A Pedro Pathing path file (what the planner's Save downloads and its Load opens). */
export function isPedroPathFile(filename: string): boolean {
  return extensionOf(filename) === "pp";
}

/** e.g. "“field.png” is 5.2 MB. Files can be up to 4 MB each — …" */
export function strategyFileTooBigMessage(name: string, size: number): string {
  return `“${name}” is ${formatFileSize(size)}. Files can be up to ${RESOURCE_FILE_MAX_MB} MB each — save a smaller copy, or add a link to it instead.`;
}

/** More new files than one strategy can have. */
export function tooManyStrategyFilesMessage(keeping: number): string {
  const max = LIMITS.strategyFilesMax;
  return keeping > 0
    ? `A strategy can have up to ${max} files, and this one keeps ${keeping}. Take some off, or remove files it has.`
    : `A strategy can have up to ${max} files. Take some off.`;
}

/** New files in one save can add up to this much (one request; the host refuses bigger ones). */
export const STRATEGY_SAVE_MAX_BYTES = LIMITS.resourceFileMaxBytes;

/** Picked files that add up to more than one save can carry. */
export function strategySaveTooBigMessage(total: number): string {
  return `These files add up to ${formatFileSize(total)}, and one save can carry up to ${RESOURCE_FILE_MAX_MB} MB. Save with some of them, then edit the strategy to add the rest.`;
}

const isFiniteNumber = (v: unknown) =>
  typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));

const hasXY = (p: unknown): boolean =>
  !!p && typeof p === "object" && isFiniteNumber((p as { x?: unknown }).x) && isFiniteNumber((p as { y?: unknown }).y);

/**
 * Whether parsed JSON is a path the planner can open: the planner's own check (isValidProject in the
 * PedroPathingBiobuzz app) — a start point and at least one path, each with an end point.
 */
export function isPedroPathProject(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const project = data as { startPoint?: unknown; lines?: unknown };
  if (!hasXY(project.startPoint)) return false;
  if (!Array.isArray(project.lines) || project.lines.length === 0) return false;
  return project.lines.every((line: unknown) => !!line && typeof line === "object" && hasXY((line as { endPoint?: unknown }).endPoint));
}

/**
 * What's wrong with a .pp file's bytes, or null when the planner can open it: it must be UTF-8 JSON (a BOM is
 * fine) holding a path project. The message names the file.
 */
export function pedroPathProblem(bytes: Uint8Array, name: string): string | null {
  let data: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    data = JSON.parse(text);
  } catch {
    return `“${name}” isn't a path file the planner can open (it isn't valid JSON). Save it again from the planner and try again.`;
  }
  if (!isPedroPathProject(data)) {
    return `“${name}” isn't a path the planner can open: it needs a start point and at least one path. Save it again from the planner and try again.`;
  }
  return null;
}

/**
 * The problem with a picked file that the browser can see without reading it (empty, too big), or null.
 * .pp files are also read and checked with pedroPathProblem.
 */
export function strategyFileProblem(file: { name: string; size: number }): string | null {
  if (file.size === 0) return `“${file.name}” is empty. Choose another file.`;
  if (file.size > LIMITS.resourceFileMaxBytes) return strategyFileTooBigMessage(file.name, file.size);
  return null;
}

/** The Remove button's question: "Remove “Red auto” and its 2 files?" */
export function strategyRemoveQuestion(title: string, fileCount: number): string {
  if (fileCount === 0) return `Remove “${title}”?`;
  return `Remove “${title}” and its ${fileCount === 1 ? "file" : `${fileCount} files`}?`;
}

/** Remove team's question: "Remove 9040 · STEAMpunks Alpha from Other teams? The 3 strategies about them and their 2 files will be removed too." */
export function leagueTeamRemoveQuestion(label: string, strategies: number, files: number): string {
  if (strategies === 0) return `Remove ${label} from Other teams?`;
  const what = strategies === 1 ? "The strategy about them" : `The ${strategies} strategies about them`;
  const their = strategies === 1 ? "its" : "their";
  const withFiles = files === 0 ? "" : ` and ${their} ${files === 1 ? "file" : `${files} files`}`;
  return `Remove ${label} from Other teams? ${what}${withFiles} will be removed too.`;
}

/** After removing a team: "Removed 9040 · STEAMpunks Alpha, and the 3 strategies about them." */
export function leagueTeamRemovedNotice(label: string, strategies: number): string {
  if (!(strategies > 0)) return `Removed ${label}.`;
  return `Removed ${label}, and ${strategies === 1 ? "the strategy" : `the ${strategies} strategies`} about them.`;
}
