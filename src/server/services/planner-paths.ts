// Strategy → Paths: the team library of paths saved from the Pedro Pathing planner (PlannerPath). The planner runs
// on this site (/planner/, a static build in public/planner/) and saves through the JSON API in
// src/app/api/planner/ ("Save to team library"); the Paths tab and each Other-team page rename and remove them
// (src/app/(app)/strategy/paths/actions.ts). Both call these services.
// - Everyone ACTIVE sees and opens every saved path, and saves new ones. Changing, renaming, or removing one is for
//   whoever saved it first and everyone with admin access (canEditPlannerPath).
// - A path is one of ours (teamId null) or traces another team in the league (by number: never OUR_TEAM_NUMBER, and
//   the team must be on the Other teams list). Removing a team removes its paths (the database cascades).
// - `data` is the planner's .pp file (JSON text): at most LIMITS.plannerPathDataMaxBytes (UTF-8), and a path the
//   planner can open (pedroPathProblem in src/lib/strategy.ts, the same check as a .pp attached to a strategy).
// - Saves send `version` (the updatedAt they loaded, ISO): a save based on an older version is a
//   PlannerPathConflictError (who saved it meanwhile, and the current version), so two people can't silently
//   overwrite each other. Every save moves updatedAt forward (at least 1 ms), so versions never repeat.
// - Rate limits per person: PLANNER_PATH_CREATE_LIMIT new paths an hour, PLANNER_PATH_WRITE_LIMIT changes and
//   removals an hour. No emails.
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { LIMITS, OUR_TEAM_NUMBER } from "@/lib/constants";
import { formatFileSize } from "@/lib/files";
import { isPlannerPathId } from "@/lib/planner-paths";
import { pedroPathProblem } from "@/lib/strategy";
import { optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canEditPlannerPath } from "../permissions";
import { consumeRateLimit } from "../rate-limit";

type Tx = Prisma.TransactionClient;

export const PLANNER_PATH_NOT_FOUND = "That path is no longer in the team's saved paths.";
export const PLANNER_PATH_INACTIVE = "Your account isn't active, so you can't save or change paths.";
export const PLANNER_PATH_CANT_EDIT =
  "Only the person who saved this path, or a leader, the captain, a mentor, or a teacher, can change or remove it.";
export const PLANNER_PATH_OUR_NUMBER = `${OUR_TEAM_NUMBER} is us: save it as one of ours instead.`;
export const PLANNER_PATH_TEAM_MESSAGE = "Pick whose path this is: ours, or a team on the Other teams list.";
export const PLANNER_PATH_DATA_MESSAGE = "Send the path's .pp file (its JSON text).";
export const PLANNER_PATH_VERSION_MESSAGE = "Reload the path and try again.";
export const PLANNER_PATH_TOO_BIG = `This path is too big to save: paths can be up to ${formatFileSize(LIMITS.plannerPathDataMaxBytes)}.`;
export const PLANNER_PATH_RATE_LIMITED = "You've saved a lot of paths in the last hour. Wait a few minutes and try again.";

/** Team `n` isn't on the Other teams list (never added, or removed). */
export function plannerPathTeamNotFound(n: number): string {
  return `Team ${n} isn't on the Other teams list. Pick another team, or save it as one of ours.`;
}

/** Someone saved the path after the version this save was based on. */
export function plannerPathConflictMessage(updatedByName: string | null): string {
  return `${updatedByName ?? "Someone else"} changed this path after you opened it. Save again to replace their version, or reload to see it.`;
}

const HOUR = 60 * 60 * 1000;
/** New paths per person per hour. */
export const PLANNER_PATH_CREATE_LIMIT = { limit: 60, windowMs: HOUR } as const;
/** Changes (saves, renames) and removals per person per hour. */
export const PLANNER_PATH_WRITE_LIMIT = { limit: 300, windowMs: HOUR } as const;

/** The RateLimit counter's key for a person's new paths ("create") or changes and removals ("write"). */
export function plannerPathRateKey(kind: "create" | "write", userId: string): string {
  return `planner-path-${kind}:${userId}`;
}

/** The .pp data is over LIMITS.plannerPathDataMaxBytes (the API answers 413). */
export class PlannerPathTooBigError extends ValidationError {}

/** A save based on an older version (the API answers 409 with `current`). */
export class PlannerPathConflictError extends ConflictError {
  readonly current: { version: string; updatedByName: string | null };
  constructor(current: { version: string; updatedByName: string | null }) {
    super(plannerPathConflictMessage(current.updatedByName));
    this.current = current;
  }
}

// ---------- input ----------

/** Control characters (a NUL byte makes Postgres refuse the row); line breaks and tabs are kept where asked. */
const CONTROL = /[\p{Cc}\u2028\u2029]+/gu;
const CONTROL_BUT_LINE_BREAKS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]+/g;

/** One line: control characters and line breaks become spaces. */
const nameField = z.preprocess(
  (v) => (typeof v === "string" ? v.replace(CONTROL, " ") : v),
  text("Name", LIMITS.plannerPathNameMax),
);

/** Notes: "" / missing = none. Line breaks are kept (as "\n"). */
const notesField = z.preprocess(
  (v) => (typeof v === "string" ? v.replace(CONTROL_BUT_LINE_BREAKS, "") : v),
  optionalText("Notes", LIMITS.plannerPathNotesMax),
);

/** The biggest team number accepted (the same as Other teams). */
const TEAM_NUMBER_MAX = 999_999;

/**
 * Whose path it is: null (or "", "ours") = ours; otherwise another team's number (9040, "9040", "#9040").
 * Whether that team is on the list is checked when saving.
 */
const teamNumberField = z.preprocess(
  (v) => {
    if (v === null || v === "" || v === "ours") return null;
    if (typeof v === "string") {
      const digits = v.trim().replace(/^#/, "");
      return /^\d{1,7}$/.test(digits) ? Number(digits) : v;
    }
    return v;
  },
  z
    .number({ error: PLANNER_PATH_TEAM_MESSAGE })
    .int(PLANNER_PATH_TEAM_MESSAGE)
    .min(1, PLANNER_PATH_TEAM_MESSAGE)
    .max(TEAM_NUMBER_MAX, PLANNER_PATH_TEAM_MESSAGE)
    .refine((n) => n !== OUR_TEAM_NUMBER, PLANNER_PATH_OUR_NUMBER)
    .nullable(),
);

const createInput = z.object({
  name: nameField,
  notes: notesField,
  teamNumber: teamNumberField.optional(),
});

const updateInput = z.object({
  name: nameField.optional(),
  notes: notesField,
  teamNumber: teamNumberField.optional(),
});

/** Which path (any text: one no saved path can have is "not found", see parsePathId). */
const pathIdInput = z.object({ pathId: z.string().trim().min(1) });

/**
 * The path a change or removal is for: missing is a ValidationError; an id no saved path can have (isPlannerPathId:
 * a NUL byte, too long…) is NotFound, before the database is asked.
 */
function parsePathId(rec: Record<string, unknown>): string {
  const { pathId } = parseInput(pathIdInput, rec);
  if (!isPlannerPathId(pathId)) throw new NotFoundError(PLANNER_PATH_NOT_FOUND);
  return pathId;
}

const versionInput = z.object({
  version: z.string({ error: PLANNER_PATH_VERSION_MESSAGE }).trim().min(1, PLANNER_PATH_VERSION_MESSAGE).max(64, PLANNER_PATH_VERSION_MESSAGE),
});

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** Sent (and not undefined): a field a change sets; a missing one stays as it is. */
function sent(rec: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(rec, key) && rec[key] !== undefined;
}

/** The name as the data's error message quotes it (one line, at most the longest name). */
function nameForMessage(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replace(CONTROL, " ").trim().slice(0, LIMITS.plannerPathNameMax) || fallback;
}

/**
 * The .pp data: text, at most LIMITS.plannerPathDataMaxBytes as UTF-8 (a leading byte-order mark is dropped), and a
 * path the planner can open. Returns the text as stored and its size in bytes.
 */
export function checkPlannerPathData(value: unknown, name: string): { text: string; size: number } {
  if (typeof value !== "string") throw new ValidationError(PLANNER_PATH_DATA_MESSAGE, { data: PLANNER_PATH_DATA_MESSAGE });
  const bytes = new TextEncoder().encode(value.replace(/^\uFEFF/, ""));
  if (bytes.byteLength > LIMITS.plannerPathDataMaxBytes) throw new PlannerPathTooBigError(PLANNER_PATH_TOO_BIG, { data: PLANNER_PATH_TOO_BIG });
  const problem = pedroPathProblem(bytes, name || "This path");
  if (problem) throw new ValidationError(problem, { data: problem });
  // What was measured is what's stored (a lone surrogate becomes U+FFFD, as Postgres would store it).
  return { text: new TextDecoder().decode(bytes), size: bytes.byteLength };
}

/**
 * Checks everything at once (the fields and the data), so every problem comes back in one go. Too big is answered
 * on its own (the API sends 413).
 */
function parseAll<T>(parseFields: () => T, parseData: (() => { text: string; size: number }) | null) {
  const errors: Record<string, string> = {};
  const failures: ValidationError[] = [];
  let fields: T | undefined;
  let data: { text: string; size: number } | undefined;
  try {
    fields = parseFields();
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e;
    failures.push(e);
    Object.assign(errors, e.fieldErrors);
  }
  if (parseData) {
    try {
      data = parseData();
    } catch (e) {
      if (e instanceof PlannerPathTooBigError || !(e instanceof ValidationError)) throw e;
      failures.push(e);
      for (const [key, message] of Object.entries(e.fieldErrors)) errors[key] ??= message;
    }
  }
  if (failures.length > 0 || fields === undefined) {
    const only = failures.length === 1 && Object.keys(errors).length <= 1 ? failures[0].userMessage : "Please fix the highlighted fields.";
    throw new ValidationError(only, errors);
  }
  return { fields, data };
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(PLANNER_PATH_INACTIVE);
}

async function enforcePlannerRateLimit(ctx: ServiceContext, kind: "create" | "write"): Promise<void> {
  const { limit, windowMs } = kind === "create" ? PLANNER_PATH_CREATE_LIMIT : PLANNER_PATH_WRITE_LIMIT;
  if (!(await consumeRateLimit(ctx.db, plannerPathRateKey(kind, ctx.actor.id), limit, windowMs, ctx.now))) {
    throw new RateLimitError(PLANNER_PATH_RATE_LIMITED);
  }
}

/**
 * The other team's id, by number, held until the transaction ends (so it can't be removed between this check and
 * the write). A ValidationError on `teamNumber` when it isn't on the list.
 */
async function lockTeam(tx: Tx, number: number): Promise<string> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "LeagueTeam" WHERE number = ${number} FOR KEY SHARE`;
  if (rows.length === 0) {
    const message = plannerPathTeamNotFound(number);
    throw new ValidationError(message, { teamNumber: message });
  }
  return rows[0].id;
}

/** Loads a path for a change and checks the actor may make it (missing → NotFound, not theirs → Forbidden). */
async function loadEditablePath(ctx: ServiceContext, pathId: string) {
  const path = await ctx.db.plannerPath.findUnique({
    where: { id: pathId },
    select: { id: true, name: true, createdById: true, team: { select: { number: true } } },
  });
  if (!path) throw new NotFoundError(PLANNER_PATH_NOT_FOUND);
  if (!canEditPlannerPath(ctx.actor, path)) throw new ForbiddenError(PLANNER_PATH_CANT_EDIT);
  return path;
}

// ---------- mutations ----------

/**
 * Save a new path to the team library (anyone ACTIVE): `name`, optional `notes`, `teamNumber` (null / missing =
 * ours), and `data` (the .pp JSON text). Returns its id and version (updatedAt, ISO).
 */
export async function createPlannerPath(ctx: ServiceContext, raw: unknown): Promise<{ id: string; version: string }> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const { fields, data } = parseAll(
    () => parseInput(createInput, rec),
    () => checkPlannerPathData(rec.data, nameForMessage(rec.name, "")),
  );
  await enforcePlannerRateLimit(ctx, "create");
  const teamNumber = fields.teamNumber ?? null;
  return ctx.db.$transaction(async (tx) => {
    const teamId = teamNumber === null ? null : await lockTeam(tx, teamNumber);
    const row = await tx.plannerPath.create({
      data: {
        name: fields.name,
        notes: fields.notes ?? "",
        data: data!.text,
        size: data!.size,
        teamId,
        createdById: ctx.actor.id,
        updatedById: ctx.actor.id,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      },
      select: { id: true, updatedAt: true },
    });
    return { id: row.id, version: row.updatedAt.toISOString() };
  });
}

/** A saved path after a change: its new version, and its name, notes, and whose it is as they are now. */
export interface PlannerPathSaved {
  id: string;
  version: string;
  name: string;
  notes: string;
  team: { number: number; name: string } | null;
  /** team?.number ?? null. */
  teamNumber: number | null;
}

/**
 * Change a saved path (whoever saved it, and everyone with admin access): any of `name`, `notes`, `teamNumber`,
 * `data` (the ones sent; the rest stay), based on `version` (the updatedAt it loaded, ISO). A newer save meanwhile
 * is a PlannerPathConflictError. Returns the new version and the path's name, notes, and team as they are now (a
 * save that only sends the data keeps someone else's rename: the planner shows what's saved, not what it had).
 */
export async function updatePlannerPath(ctx: ServiceContext, raw: unknown): Promise<PlannerPathSaved> {
  requireActive(ctx);
  const rec = asRecord(raw);
  const pathId = parsePathId(rec);
  const path = await loadEditablePath(ctx, pathId);
  const { version } = parseInput(versionInput, rec);
  const loaded = new Date(version);
  if (Number.isNaN(loaded.getTime())) throw new ValidationError(PLANNER_PATH_VERSION_MESSAGE, { version: PLANNER_PATH_VERSION_MESSAGE });

  const { fields, data } = parseAll(
    () => parseInput(updateInput, rec),
    sent(rec, "data") ? () => checkPlannerPathData(rec.data, nameForMessage(rec.name, path.name)) : null,
  );
  await enforcePlannerRateLimit(ctx, "write");

  const changes: Prisma.PlannerPathUncheckedUpdateManyInput = {};
  if (fields.name !== undefined) changes.name = fields.name;
  if (sent(rec, "notes")) changes.notes = fields.notes ?? "";
  if (data) {
    changes.data = data.text;
    changes.size = data.size;
  }
  const teamNumber = sent(rec, "teamNumber") ? (fields.teamNumber ?? null) : undefined;
  // Always later than the version it replaces, so the next save based on that one is refused.
  const next = new Date(Math.max(ctx.now.getTime(), loaded.getTime() + 1));

  return ctx.db.$transaction(async (tx) => {
    if (teamNumber !== undefined) changes.teamId = teamNumber === null ? null : await lockTeam(tx, teamNumber);
    const { count } = await tx.plannerPath.updateMany({
      where: { id: pathId, updatedAt: loaded },
      data: { ...changes, updatedById: ctx.actor.id, updatedAt: next },
    });
    if (count === 0) {
      const current = await tx.plannerPath.findUnique({
        where: { id: pathId },
        select: { updatedAt: true, updatedBy: { select: { name: true } } },
      });
      if (!current) throw new NotFoundError(PLANNER_PATH_NOT_FOUND);
      throw new PlannerPathConflictError({ version: current.updatedAt.toISOString(), updatedByName: current.updatedBy?.name ?? null });
    }
    const saved = await tx.plannerPath.findUniqueOrThrow({
      where: { id: pathId },
      select: { name: true, notes: true, team: { select: { number: true, name: true } } },
    });
    const team = saved.team ? { number: saved.team.number, name: saved.team.name } : null;
    return { id: pathId, version: next.toISOString(), name: saved.name, notes: saved.notes, team, teamNumber: team?.number ?? null };
  });
}

/**
 * Remove a saved path (whoever saved it, and everyone with admin access). Returns its name and whose it was (so
 * the page goes back to that list).
 */
export async function deletePlannerPath(ctx: ServiceContext, raw: unknown): Promise<{ name: string; teamNumber: number | null }> {
  requireActive(ctx);
  const pathId = parsePathId(asRecord(raw));
  const path = await loadEditablePath(ctx, pathId);
  await enforcePlannerRateLimit(ctx, "write");
  const { count } = await ctx.db.plannerPath.deleteMany({ where: { id: pathId } });
  if (count === 0) throw new NotFoundError(PLANNER_PATH_NOT_FOUND);
  return { name: path.name, teamNumber: path.team?.number ?? null };
}
