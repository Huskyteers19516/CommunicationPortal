// Strategy → Other teams: the other teams in our league (LeagueTeam), what we know about how they play ("Their
// strategy at a glance", a summary anyone ACTIVE can write), and strategies written about them (Strategy.teamId,
// e.g. their auto traced in the Pedro Pathing planner as a .pp file — added with ./strategy.ts).
// - Adding, renaming, and removing teams: everyone with admin access (canManageLeagueTeams). Our own number
//   (OUR_TEAM_NUMBER) is never one of them, and numbers are unique.
// - The summary is saved with the version it was loaded at (summaryUpdatedAt), so two people writing at once can't
//   overwrite each other without seeing it: the second save is a ConflictError, and saving again replaces it.
// - Removing a team removes the strategies about it and their files (the database cascades). No emails.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { LIMITS, OUR_TEAM_NUMBER } from "@/lib/constants";
import { idSchema, optionalText, text } from "@/lib/validation";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { canManageLeagueTeams } from "../permissions";

export const LEAGUE_TEAM_NOT_FOUND = "That team is no longer on the Other teams list.";
export const LEAGUE_TEAM_INACTIVE = "Your account isn't active, so you can't change the Other teams list.";
export const LEAGUE_TEAM_CANT_MANAGE = "Only leaders, the captain, mentors, and teachers can add, change, or remove teams.";
export const OUR_NUMBER_MESSAGE = `${OUR_TEAM_NUMBER} is us, the Huskyteers. Add the other teams in the league here.`;
export const SUMMARY_CONFLICT =
  "Someone else saved this summary while you were writing. The newer version is shown below — your text is still here, and saving again replaces it.";
/** The biggest team number accepted (FTC numbers are 5 digits today). */
export const LEAGUE_TEAM_NUMBER_MAX = 999_999;

const numberMessage = "Enter the team's number, like 9040.";

/** The team's FTC number: digits only ("#9040" and "9,040" are fine too), not ours. */
const numberField = z.preprocess(
  (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.replace(/[#,\s]/g, "") : v),
  z
    .string({ error: numberMessage })
    .regex(/^\d{1,6}$/, numberMessage)
    .transform(Number)
    .refine((n) => n >= 1 && n <= LEAGUE_TEAM_NUMBER_MAX, numberMessage)
    .refine((n) => n !== OUR_TEAM_NUMBER, OUR_NUMBER_MESSAGE),
);

const teamFields = z.object({
  number: numberField,
  name: text("Team name", LIMITS.leagueTeamNameMax),
  city: optionalText("City", LIMITS.leagueTeamCityMax),
});

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(LEAGUE_TEAM_INACTIVE);
}

function requireManager(ctx: ServiceContext) {
  requireActive(ctx);
  if (!canManageLeagueTeams(ctx.actor)) throw new ForbiddenError(LEAGUE_TEAM_CANT_MANAGE);
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

function numberTaken(number: number): ValidationError {
  const message = `Team ${number} is already on the list.`;
  return new ValidationError(message, { number: message });
}

/** Add a team to the Other teams list (people with admin access). */
export async function createLeagueTeam(ctx: ServiceContext, raw: unknown): Promise<{ id: string; number: number }> {
  requireManager(ctx);
  const data = parseInput(teamFields, asRecord(raw));
  if (await ctx.db.leagueTeam.findUnique({ where: { number: data.number }, select: { id: true } })) throw numberTaken(data.number);
  try {
    return await ctx.db.leagueTeam.create({
      data: { number: data.number, name: data.name, city: data.city ?? "", createdById: ctx.actor.id, createdAt: ctx.now },
      select: { id: true, number: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw numberTaken(data.number);
    throw e;
  }
}

const teamIdInput = z.object({ teamId: idSchema });

/** Change a team's number, name, or city (people with admin access). */
export async function updateLeagueTeam(ctx: ServiceContext, raw: unknown): Promise<{ id: string; number: number }> {
  requireManager(ctx);
  const rec = asRecord(raw);
  const { teamId } = parseInput(teamIdInput, rec);
  const data = parseInput(teamFields, rec);
  const taken = await ctx.db.leagueTeam.findUnique({ where: { number: data.number }, select: { id: true } });
  if (taken && taken.id !== teamId) throw numberTaken(data.number);
  try {
    const { count } = await ctx.db.leagueTeam.updateMany({
      where: { id: teamId },
      data: { number: data.number, name: data.name, city: data.city ?? "" },
    });
    if (count === 0) throw new NotFoundError(LEAGUE_TEAM_NOT_FOUND);
  } catch (e) {
    if (isUniqueViolation(e)) throw numberTaken(data.number);
    throw e;
  }
  return { id: teamId, number: data.number };
}

/**
 * Remove a team (people with admin access), with the strategies about it and their files. Returns what went,
 * for the message.
 */
export async function deleteLeagueTeam(
  ctx: ServiceContext,
  raw: unknown,
): Promise<{ number: number; name: string; strategies: number; files: number }> {
  requireManager(ctx);
  const { teamId } = parseInput(teamIdInput, asRecord(raw));
  return ctx.db.$transaction(async (tx) => {
    const team = await tx.leagueTeam.findUnique({ where: { id: teamId }, select: { number: true, name: true } });
    if (!team) throw new NotFoundError(LEAGUE_TEAM_NOT_FOUND);
    const strategies = await tx.strategy.count({ where: { teamId } });
    const files = await tx.strategyFile.count({ where: { strategy: { teamId } } });
    const { count } = await tx.leagueTeam.deleteMany({ where: { id: teamId } }); // strategies and files cascade
    if (count === 0) throw new NotFoundError(LEAGUE_TEAM_NOT_FOUND);
    return { ...team, strategies, files };
  });
}

const summaryInput = z.object({
  teamId: idSchema,
  summary: z.preprocess(
    // Browsers send a textarea's line breaks as CRLF; its maxlength counts each as one character, so we do too.
    (v) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n") : ""),
    z.string().trim().max(LIMITS.leagueTeamSummaryMax, `The summary must be at most ${LIMITS.leagueTeamSummaryMax} characters.`),
  ),
  /** The summary's summaryUpdatedAt when the form loaded it (ISO), or "" when it had never been written. */
  version: z.preprocess((v) => (typeof v === "string" ? v.trim() : ""), z.string().max(64)),
});

/**
 * Write "Their strategy at a glance" for a team (anyone ACTIVE; empty clears it). Refused with a ConflictError
 * when someone else saved it after `version` (the form then shows their text; saving again replaces it).
 */
export async function saveLeagueTeamSummary(ctx: ServiceContext, raw: unknown): Promise<{ number: number }> {
  requireActive(ctx);
  const { teamId, summary, version } = parseInput(summaryInput, asRecord(raw));
  const loaded = version ? new Date(version) : null;
  if (loaded && Number.isNaN(loaded.getTime())) throw new ValidationError("Reload the page and try again.");

  const { count } = await ctx.db.leagueTeam.updateMany({
    where: { id: teamId, summaryUpdatedAt: loaded },
    data: { summary, summaryUpdatedAt: ctx.now, summaryUpdatedById: ctx.actor.id },
  });
  const team = await ctx.db.leagueTeam.findUnique({ where: { id: teamId }, select: { number: true } });
  if (!team) throw new NotFoundError(LEAGUE_TEAM_NOT_FOUND);
  if (count === 0) throw new ConflictError(SUMMARY_CONFLICT);
  return { number: team.number };
}
