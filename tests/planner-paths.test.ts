// Strategy → Paths: the team library of paths saved from the Pedro Pathing planner (PlannerPath). Services:
// src/server/services/planner-paths.ts; queries: src/server/queries/planner-paths.ts; the planner's JSON API:
// src/app/api/planner/** (+ src/server/planner-api.ts); the Paths tab's actions and the .pp download; the proxy's
// JSON 401 for the API. Every route runs against this file's database.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Queries read through the app-wide `prisma`: point it at this file's database. Routes and actions ask
// getCurrentUser who's signed in (holder.user). revalidatePath is counted (there's no Next.js request here).
const holder = vi.hoisted(() => ({
  db: null as unknown as Record<string | symbol, unknown>,
  user: null as unknown,
  refreshed: 0,
}));
vi.mock("@/server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/db")>();
  const prisma = new Proxy(
    {},
    {
      get(_target, key) {
        const value = holder.db[key];
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(holder.db) : value;
      },
    },
  );
  return { ...actual, prisma };
});
vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  return { ...actual, getCurrentUser: async () => holder.user };
});
vi.mock("next/cache", () => ({
  revalidatePath: () => {
    holder.refreshed++;
  },
}));

import { NextRequest } from "next/server";
import { deletePlannerPathAction, updatePlannerPathAction } from "@/app/(app)/strategy/paths/actions";
import * as downloadRoute from "@/app/(app)/strategy/paths/[id]/download/route";
import * as pathRoute from "@/app/api/planner/paths/[id]/route";
import * as pathsRoute from "@/app/api/planner/paths/route";
import * as sessionRoute from "@/app/api/planner/session/route";
import { initialActionState } from "@/lib/action-state";
import { LIMITS, OUR_TEAM_NUMBER } from "@/lib/constants";
import {
  isPlannerPathId,
  parsePlannerPathTeamFilter,
  PLANNER_URL,
  type PlannerPathTeamFilter,
  plannerOpenHref,
  plannerPathDownloadHref,
  plannerPathTeamParam,
  plannerPathWhose,
  plannerTeamHref,
} from "@/lib/planner-paths";
import { leagueTeamRemoveQuestion } from "@/lib/strategy";
import { proxy } from "@/proxy";
import type { Actor } from "@/server/actor";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { canAdminister, canEditPlannerPath } from "@/server/permissions";
import {
  PLANNER_API_BODY_MAX_BYTES,
  PLANNER_API_CROSS_SITE,
  PLANNER_API_RATE_LIMITED,
  PLANNER_API_REQUEST_LIMIT,
  plannerApiRateKey,
  plannerCsrfProblem,
} from "@/server/planner-api";
import { getLeagueTeam, getStrategyTabCounts } from "@/server/queries/league-teams";
import {
  getPlannerPath,
  getPlannerPathForEdit,
  getPlannerSession,
  listPlannerPaths,
  listPlannerPathTeams,
  PLANNER_PATHS_LIST_MAX,
} from "@/server/queries/planner-paths";
import { createLeagueTeam, deleteLeagueTeam } from "@/server/services/league-teams";
import {
  checkPlannerPathData,
  createPlannerPath,
  deletePlannerPath,
  PLANNER_PATH_CANT_EDIT,
  PLANNER_PATH_CREATE_LIMIT,
  PLANNER_PATH_INACTIVE,
  PLANNER_PATH_OUR_NUMBER,
  PLANNER_PATH_RATE_LIMITED,
  PLANNER_PATH_TOO_BIG,
  PLANNER_PATH_WRITE_LIMIT,
  PlannerPathConflictError,
  plannerPathConflictMessage,
  plannerPathRateKey,
  plannerPathTeamNotFound,
  PlannerPathTooBigError,
  updatePlannerPath,
} from "@/server/services/planner-paths";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW } from "./helpers/factories";

/** A path the planner can open (the shape its Save writes). */
const PP = JSON.stringify(
  {
    startPoint: { x: 61.75, y: 8, heading: "linear", startDeg: 90, endDeg: 90 },
    lines: [{ id: "line-1", name: "Path 1", endPoint: { x: 61.75, y: 30, heading: "linear", startDeg: 90, endDeg: 90 }, controlPoints: [], color: "#ffc516" }],
    shapes: [],
    version: "1.2.1",
  },
  null,
  2,
);
const PP_TWO_LINES = JSON.stringify({
  startPoint: { x: 10, y: 10 },
  lines: [{ endPoint: { x: 20, y: 20 } }, { endPoint: { x: 30, y: 40 }, controlPoints: [{ x: 25, y: 35 }] }],
});

const MIN = 60 * 1000;
const at = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * MIN);

let t: TestDb;
let maya: Actor; // Software member
let ethan: Actor; // Build member
let priya: Actor; // Software leader
let marcus: Actor; // Build leader
let amara: Actor; // Business leader
let jordan: Actor; // Captain
let elena: Actor; // Mentor
let david: Actor; // Teacher
let olivia: Actor; // Owner (a Build member with the Owner flag)
let pending: Actor;
let disabled: Actor;

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db as unknown as Record<string | symbol, unknown>;
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  marcus = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  pending = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUILD", status: "PENDING" });
  disabled = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
});
afterAll(async () => {
  await t.drop();
});

/** Saves a path as `who` (straight through the service), with a few defaults. */
async function save(who: Actor, input: Record<string, unknown> = {}, now = TEST_NOW) {
  return createPlannerPath({ ...contextFor(t.db, who), now }, { name: "Test path", data: PP, ...input });
}

/** The ValidationError a call throws. */
async function validationError(p: Promise<unknown>): Promise<ValidationError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ValidationError);
  return e as ValidationError;
}

// ── Client-safe helpers ─────────────────────────────────────────────────────────────────────────────────────────

describe("helpers", () => {
  it("parse the team filter: all, ours, or another team's number (never ours, never garbage)", () => {
    expect(parsePlannerPathTeamFilter(undefined)).toBe("all");
    expect(parsePlannerPathTeamFilter("")).toBe("all");
    expect(parsePlannerPathTeamFilter("ALL")).toBe("all");
    expect(parsePlannerPathTeamFilter("ours")).toBe("ours");
    expect(parsePlannerPathTeamFilter("9040")).toBe(9040);
    expect(parsePlannerPathTeamFilter("#9040")).toBe(9040);
    expect(parsePlannerPathTeamFilter(String(OUR_TEAM_NUMBER))).toBeNull();
    expect(parsePlannerPathTeamFilter("0")).toBeNull();
    expect(parsePlannerPathTeamFilter("9040x")).toBeNull();
    expect(parsePlannerPathTeamFilter("1234567")).toBeNull();
    expect(plannerPathTeamParam("all")).toBeNull();
    expect(plannerPathTeamParam(9040)).toBe("9040");
    expect(plannerPathWhose(null)).toBe("Ours");
    expect(plannerPathWhose({ number: 9040, name: "STEAMpunks Alpha" })).toBe("9040 · STEAMpunks Alpha");
  });

  it("link to the planner on this site (index.html itself: its files are relative) and to the download", () => {
    expect(PLANNER_URL).toBe("/planner/index.html");
    expect(plannerOpenHref("abc 1")).toBe("/planner/index.html?path=abc%201");
    expect(plannerPathDownloadHref("abc")).toBe("/strategy/paths/abc/download");
    // A team's page: the planner's Save to team library starts with that team.
    expect(plannerTeamHref(9040)).toBe("/planner/index.html?team=9040");
  });

  it("know what a saved path's id can look like (cuids, the seed's readable ids; never a NUL byte)", () => {
    for (const id of ["cmg1a2b3c0000xyz", "demo-path-red-audience", "a_B-9", "x".repeat(64)]) expect(isPlannerPathId(id), id).toBe(true);
    for (const id of ["", "\u0000", "a\u0000b", "a b", "../x", "x".repeat(65), "é", 5, null]) expect(isPlannerPathId(id), String(id)).toBe(false);
  });

  it("check .pp data: text, a path the planner can open, at most 256 KB as UTF-8 (a BOM is dropped)", () => {
    expect(checkPlannerPathData(PP, "x")).toEqual({ text: PP, size: Buffer.byteLength(PP) });
    expect(checkPlannerPathData(`\uFEFF${PP}`, "x").text).toBe(PP);
    const accented = PP.replace("Path 1", "Trajectoire é");
    expect(checkPlannerPathData(accented, "x").size).toBe(Buffer.byteLength(accented, "utf8"));
    expect(() => checkPlannerPathData({ startPoint: {} }, "x")).toThrow(ValidationError);
    expect(() => checkPlannerPathData("{ nope", "Red")).toThrow(/“Red” isn't a path file the planner can open/);
    expect(() => checkPlannerPathData(JSON.stringify({ startPoint: { x: 1, y: 2 }, lines: [] }), "Red")).toThrow(/needs a start point and at least one path/);
    const big = JSON.stringify({ ...JSON.parse(PP), pad: "x".repeat(LIMITS.plannerPathDataMaxBytes) });
    expect(() => checkPlannerPathData(big, "x")).toThrow(PlannerPathTooBigError);
    // Exactly at the limit is fine.
    const base = JSON.stringify({ ...JSON.parse(PP), pad: "" });
    const exact = JSON.stringify({ ...JSON.parse(PP), pad: "x".repeat(LIMITS.plannerPathDataMaxBytes - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(exact)).toBe(LIMITS.plannerPathDataMaxBytes);
    expect(checkPlannerPathData(exact, "x").size).toBe(LIMITS.plannerPathDataMaxBytes);
  });
});

// ── Services ────────────────────────────────────────────────────────────────────────────────────────────────────

describe("saving a path (createPlannerPath)", () => {
  it("anyone ACTIVE saves one of ours: name, notes, the .pp text, its size, and who saved it", async () => {
    const { id, version } = await save(maya, { name: "  Red auto  ", notes: "Line one\r\nLine two", data: PP });
    expect(version).toBe(TEST_NOW.toISOString());
    const row = await t.db.plannerPath.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      name: "Red auto",
      notes: "Line one\nLine two",
      data: PP,
      size: Buffer.byteLength(PP),
      teamId: null,
      createdById: maya.id,
      updatedById: maya.id,
    });
    expect(row.createdAt).toEqual(TEST_NOW);
    expect(row.updatedAt).toEqual(TEST_NOW);
  });

  it("saves another team's path by number (9040, \"9040\", \"#9040\"); null / \"\" / \"ours\" are ours", async () => {
    for (const teamNumber of [9040, "9040", "#9040"]) {
      const { id } = await save(ethan, { teamNumber });
      expect((await t.db.plannerPath.findUniqueOrThrow({ where: { id }, include: { team: true } })).team?.number).toBe(9040);
    }
    for (const teamNumber of [null, "", "ours", undefined]) {
      const { id } = await save(ethan, { teamNumber });
      expect((await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).teamId).toBeNull();
    }
  });

  it("refuses bad input with messages on the right fields", async () => {
    expect((await validationError(save(maya, { name: "   " }))).fieldErrors.name).toBe("Name is required.");
    expect((await validationError(save(maya, { name: "x".repeat(LIMITS.plannerPathNameMax + 1) }))).fieldErrors.name).toMatch(/at most 80/);
    expect((await validationError(save(maya, { notes: "x".repeat(LIMITS.plannerPathNotesMax + 1) }))).fieldErrors.notes).toMatch(/at most 2000/);
    expect((await validationError(save(maya, { teamNumber: OUR_TEAM_NUMBER }))).fieldErrors.teamNumber).toBe(PLANNER_PATH_OUR_NUMBER);
    expect((await validationError(save(maya, { teamNumber: String(OUR_TEAM_NUMBER) }))).fieldErrors.teamNumber).toBe(PLANNER_PATH_OUR_NUMBER);
    expect((await validationError(save(maya, { teamNumber: 12345 }))).fieldErrors.teamNumber).toBe(plannerPathTeamNotFound(12345));
    for (const bad of ["abc", 9040.5, -3, 0, true, { number: 9040 }]) {
      expect((await validationError(save(maya, { teamNumber: bad }))).fieldErrors.teamNumber, String(bad)).toBeTruthy();
    }
    expect((await validationError(save(maya, { data: undefined }))).fieldErrors.data).toBeTruthy();
    expect((await validationError(save(maya, { data: JSON.parse(PP) }))).fieldErrors.data).toBeTruthy();
    expect((await validationError(save(maya, { data: "" }))).fieldErrors.data).toMatch(/isn't valid JSON/);
    expect((await validationError(save(maya, { data: "[1,2]" }))).fieldErrors.data).toMatch(/needs a start point/);
    // Several problems at once: all of them.
    const both = await validationError(save(maya, { name: "", data: "nope" }));
    expect(Object.keys(both.fieldErrors).sort()).toEqual(["data", "name"]);
    expect(both.userMessage).toBe("Please fix the highlighted fields.");
    // Too big is its own error (the API answers 413).
    const big = JSON.stringify({ ...JSON.parse(PP), pad: "x".repeat(LIMITS.plannerPathDataMaxBytes) });
    await expect(save(maya, { data: big })).rejects.toBeInstanceOf(PlannerPathTooBigError);
    await expect(save(maya, { data: big })).rejects.toThrow(PLANNER_PATH_TOO_BIG);
  });

  it("keeps names on one line and drops control characters Postgres would refuse", async () => {
    const { id } = await save(maya, { name: "Red\nauto\u0000 v2", notes: "a\u0000b\tc\nd\u0007" });
    const row = await t.db.plannerPath.findUniqueOrThrow({ where: { id } });
    expect(row.name).toBe("Red auto  v2");
    expect(row.notes).toBe("ab\tc\nd");
  });

  it("is only for ACTIVE accounts", async () => {
    for (const who of [pending, disabled]) {
      await expect(save(who)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(save(who)).rejects.toThrow(PLANNER_PATH_INACTIVE);
    }
  });
});

describe("changing a path (updatePlannerPath)", () => {
  it("changes only what's sent, moves the version forward, and records who changed it", async () => {
    const { id, version } = await save(maya, { name: "Blue auto", notes: "Old notes", teamNumber: 9040 });
    const ctx = { ...contextFor(t.db, maya), now: at(10) };
    const renamed = await updatePlannerPath(ctx, { pathId: id, version, name: "Blue auto v2" });
    // The path as it is now: the name sent, the notes and team it had.
    expect(renamed).toEqual({
      id,
      version: at(10).toISOString(),
      name: "Blue auto v2",
      notes: "Old notes",
      team: { number: 9040, name: "STEAMpunks Alpha" },
      teamNumber: 9040,
    });
    let row = await t.db.plannerPath.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ name: "Blue auto v2", notes: "Old notes", data: PP, updatedById: maya.id });

    const moved = await updatePlannerPath({ ...ctx, now: at(20) }, { pathId: id, version: renamed.version, data: PP_TWO_LINES, notes: "", teamNumber: null });
    expect(moved).toMatchObject({ name: "Blue auto v2", notes: "", team: null, teamNumber: null });
    row = await t.db.plannerPath.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ name: "Blue auto v2", notes: "", data: PP_TWO_LINES, size: Buffer.byteLength(PP_TWO_LINES), teamId: null });
    expect(row.updatedAt.toISOString()).toBe(moved.version);
    expect(row.createdAt).toEqual(TEST_NOW);
  });

  it("refuses a save based on an older version (with who saved it meanwhile); versions never repeat", async () => {
    const { id, version } = await save(maya, { name: "Shared auto" });
    // Priya (a leader) saves first — at the very same instant as the path was created.
    const theirs = await updatePlannerPath(contextFor(t.db, priya), { pathId: id, version, notes: "Priya's notes" });
    expect(theirs.version).not.toBe(version);
    expect(new Date(theirs.version).getTime()).toBe(TEST_NOW.getTime() + 1);
    // Maya's save based on the version she opened is refused, and says who and what's current.
    const e = await updatePlannerPath(contextFor(t.db, maya), { pathId: id, version, name: "Mine" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(PlannerPathConflictError);
    expect((e as PlannerPathConflictError).current).toEqual({ version: theirs.version, updatedByName: "Priya Raman" });
    expect((e as PlannerPathConflictError).userMessage).toBe(plannerPathConflictMessage("Priya Raman"));
    expect((await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).name).toBe("Shared auto");
    // Saving again with the current version replaces it.
    await updatePlannerPath(contextFor(t.db, maya), { pathId: id, version: theirs.version, name: "Mine" });
    expect((await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).name).toBe("Mine");
  });

  it("needs a version it can read, and refuses bad fields", async () => {
    const { id, version } = await save(maya);
    const ctx = contextFor(t.db, maya);
    expect((await validationError(updatePlannerPath(ctx, { pathId: id, name: "x" }))).fieldErrors.version).toBeTruthy();
    expect((await validationError(updatePlannerPath(ctx, { pathId: id, version: "yesterday", name: "x" }))).fieldErrors.version).toBeTruthy();
    expect((await validationError(updatePlannerPath(ctx, { pathId: id, version, name: "" }))).fieldErrors.name).toBeTruthy();
    expect((await validationError(updatePlannerPath(ctx, { pathId: id, version, data: "{}" }))).fieldErrors.data).toBeTruthy();
    expect((await validationError(updatePlannerPath(ctx, { pathId: id, version, teamNumber: OUR_TEAM_NUMBER }))).fieldErrors.teamNumber).toBe(
      PLANNER_PATH_OUR_NUMBER,
    );
    const big = JSON.stringify({ ...JSON.parse(PP), pad: "x".repeat(LIMITS.plannerPathDataMaxBytes) });
    await expect(updatePlannerPath(ctx, { pathId: id, version, data: big })).rejects.toBeInstanceOf(PlannerPathTooBigError);
    await expect(updatePlannerPath(ctx, { pathId: "nope", version, name: "x" })).rejects.toBeInstanceOf(NotFoundError);
    // Nothing changed.
    expect((await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString()).toBe(version);
  });

  it("whoever saved it and everyone with admin access change or remove it; other members can't", async () => {
    const editors = [maya, priya, marcus, amara, jordan, elena, david, olivia];
    for (const who of editors) {
      expect(canEditPlannerPath(who, { createdById: maya.id }), who.name).toBe(true);
      const { id, version } = await save(maya, { name: `For ${who.name}` });
      await updatePlannerPath(contextFor(t.db, who), { pathId: id, version, name: `Renamed by ${who.name}` });
      expect(await deletePlannerPath(contextFor(t.db, who), { pathId: id })).toEqual({ name: `Renamed by ${who.name}`, teamNumber: null });
      expect(await t.db.plannerPath.count({ where: { id } })).toBe(0);
    }
    const { id, version } = await save(maya, { name: "Maya's", teamNumber: 9040 });
    expect(canEditPlannerPath(ethan, { createdById: maya.id })).toBe(false);
    expect(canEditPlannerPath(ethan, { createdById: null })).toBe(false);
    await expect(updatePlannerPath(contextFor(t.db, ethan), { pathId: id, version, name: "Ethan's now" })).rejects.toThrow(PLANNER_PATH_CANT_EDIT);
    await expect(deletePlannerPath(contextFor(t.db, ethan), { pathId: id })).rejects.toBeInstanceOf(ForbiddenError);
    for (const who of [pending, disabled]) {
      await expect(updatePlannerPath(contextFor(t.db, who), { pathId: id, version, name: "x" })).rejects.toThrow(PLANNER_PATH_INACTIVE);
      await expect(deletePlannerPath(contextFor(t.db, who), { pathId: id })).rejects.toThrow(PLANNER_PATH_INACTIVE);
    }
    expect(await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Maya's" });
    // Removing it again: it's gone.
    expect(await deletePlannerPath(contextFor(t.db, maya), { pathId: id })).toEqual({ name: "Maya's", teamNumber: 9040 });
    await expect(deletePlannerPath(contextFor(t.db, maya), { pathId: id })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ids no saved path can have (a NUL byte, spaces, too long)", () => {
  it("are not found, before the database is asked (Postgres refuses a NUL byte: that was a 500)", async () => {
    const { id } = await save(maya, { name: "Real one" });
    for (const bad of ["\u0000", "a\u0000b", `${id}\u0000`, "a b", "x".repeat(65)]) {
      expect(await getPlannerPath(maya, bad), JSON.stringify(bad)).toBeNull();
      expect(await getPlannerPathForEdit(maya, bad), JSON.stringify(bad)).toBeNull();
      await expect(updatePlannerPath(contextFor(t.db, maya), { pathId: bad, version: TEST_NOW.toISOString(), name: "x" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(deletePlannerPath(contextFor(t.db, maya), { pathId: bad })).rejects.toBeInstanceOf(NotFoundError);
    }
    expect((await getPlannerPath(maya, id))?.name).toBe("Real one");
  });
});

describe("rate limits", () => {
  it(`${PLANNER_PATH_CREATE_LIMIT.limit} new paths an hour per person, then a friendly RateLimitError`, async () => {
    const saver = await makeUser(t.db, { name: "Busy Saver" });
    for (let i = 0; i < PLANNER_PATH_CREATE_LIMIT.limit; i++) await save(saver, { name: `Auto ${i}` });
    await expect(save(saver, { name: "One too many" })).rejects.toBeInstanceOf(RateLimitError);
    await expect(save(saver, { name: "One too many" })).rejects.toThrow(PLANNER_PATH_RATE_LIMITED);
    // Someone else isn't held up, and an hour later it's fine again.
    await save(maya, { name: "Not held up" });
    await save(saver, { name: "An hour later" }, at(61));
  });

  it(`${PLANNER_PATH_WRITE_LIMIT.limit} changes and removals an hour per person`, async () => {
    const editor = await makeUser(t.db, { name: "Busy Editor" });
    const { id, version } = await save(editor);
    await t.db.rateLimit.create({ data: { key: plannerPathRateKey("write", editor.id), count: PLANNER_PATH_WRITE_LIMIT.limit, windowStart: TEST_NOW } });
    await expect(updatePlannerPath(contextFor(t.db, editor), { pathId: id, version, name: "x" })).rejects.toBeInstanceOf(RateLimitError);
    await expect(deletePlannerPath(contextFor(t.db, editor), { pathId: id })).rejects.toBeInstanceOf(RateLimitError);
    // Saving new paths is counted apart.
    await save(editor, { name: "Still saves new ones" });
    await updatePlannerPath({ ...contextFor(t.db, editor), now: at(61) }, { pathId: id, version, name: "Later" });
  });
});

describe("removing a team", () => {
  it("removes its saved paths too (and says so first); ours stay", async () => {
    const { id: teamId, number } = await createLeagueTeam(contextFor(t.db, jordan), { number: "33333", name: "Short Lived" });
    await save(maya, { name: "Their auto", teamNumber: number });
    await save(ethan, { name: "Their other auto", teamNumber: number });
    const ours = await save(maya, { name: "Ours stays" });
    const detail = (await getLeagueTeam(jordan, number, t.db))!;
    expect(detail.pathCount).toBe(2);
    expect(leagueTeamRemoveQuestion("33333 · Short Lived", detail.strategyCount, detail.fileCount, detail.pathCount)).toBe(
      "Remove 33333 · Short Lived from Other teams? The 2 saved paths for them will be removed too.",
    );
    await deleteLeagueTeam(contextFor(t.db, jordan), { teamId });
    expect(await t.db.plannerPath.count({ where: { name: { in: ["Their auto", "Their other auto"] } } })).toBe(0);
    expect(await t.db.plannerPath.count({ where: { id: ours.id } })).toBe(1);
  });

  it("the Remove team question counts strategies, files, and paths", () => {
    const label = "9040 · STEAMpunks Alpha";
    expect(leagueTeamRemoveQuestion(label, 0, 0, 0)).toBe(`Remove ${label} from Other teams?`);
    expect(leagueTeamRemoveQuestion(label, 0, 0, 1)).toBe(`Remove ${label} from Other teams? The saved path for them will be removed too.`);
    expect(leagueTeamRemoveQuestion(label, 1, 1)).toBe(`Remove ${label} from Other teams? The strategy about them and its file will be removed too.`);
    expect(leagueTeamRemoveQuestion(label, 2, 3, 1)).toBe(
      `Remove ${label} from Other teams? The 2 strategies about them and their 3 files, and the saved path for them, will be removed too.`,
    );
  });
});

// ── Queries ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("lists (listPlannerPaths)", () => {
  let searchIds: Record<string, string>;
  beforeAll(async () => {
    searchIds = {};
    const add = async (who: Actor, name: string, extra: Record<string, unknown>, minutes: number) =>
      (searchIds[name] = (await save(who, { name, ...extra }, at(1000 + minutes))).id);
    await add(maya, "Zeta 100% auto", {}, 1);
    await add(ethan, "Zeta 100 auto", { teamNumber: 9040 }, 2);
    await add(maya, "Zeta a_b", { notes: "Watch the ZETA-NOTES here" }, 3);
    await add(ethan, "Zeta axb", { teamNumber: 13171 }, 4);
    await add(maya, "Zeta back\\slash", {}, 5);
  });

  it("newest change first, with whose it is, who saved it, and what the viewer may do", async () => {
    const list = (await listPlannerPaths(ethan, { q: "zeta" }, t.db))!;
    expect(list.paths.map((p) => p.name)).toEqual(["Zeta back\\slash", "Zeta axb", "Zeta a_b", "Zeta 100 auto", "Zeta 100% auto"]);
    expect(list.total).toBe(5);
    const axb = list.paths[1];
    expect(axb).toMatchObject({
      team: { number: 13171, name: "Polyisoprene Mallards" },
      createdByName: "Ethan Chen",
      updatedByName: "Ethan Chen",
      mine: true,
      canEdit: true,
      size: Buffer.byteLength(PP),
      version: at(1004).toISOString(),
    });
    expect(list.paths[0]).toMatchObject({ team: null, mine: false, canEdit: false });
    expect((await listPlannerPaths(priya, { q: "zeta" }, t.db))!.paths.every((p) => p.canEdit)).toBe(true);
    // Metadata only.
    expect(Object.keys(axb)).not.toContain("data");
  });

  it("filters: ours, one team's (by number), a number with none", async () => {
    const names = async (team: PlannerPathTeamFilter) =>
      (await listPlannerPaths(maya, { team, q: "zeta" }, t.db))!.paths.map((p) => p.name).sort();
    expect(await names("ours")).toEqual(["Zeta 100% auto", "Zeta a_b", "Zeta back\\slash"]);
    expect(await names(9040)).toEqual(["Zeta 100 auto"]);
    expect(await names(13171)).toEqual(["Zeta axb"]);
    expect(await names(424242)).toEqual([]);
    expect((await names("all")).length).toBe(5);
  });

  it("search matches the name or notes, ignores case, and takes % _ \\ literally", async () => {
    const names = async (q: string) => (await listPlannerPaths(maya, { q }, t.db))!.paths.map((p) => p.name).sort();
    expect(await names("100%")).toEqual(["Zeta 100% auto"]);
    expect(await names("a_b")).toEqual(["Zeta a_b"]);
    expect(await names("zeta-notes")).toEqual(["Zeta a_b"]);
    expect(await names("back\\sl")).toEqual(["Zeta back\\slash"]);
    expect(await names("%")).toEqual(["Zeta 100% auto"]);
    // Control characters are dropped (a NUL byte would make Postgres fail).
    expect(await names("zeta a\u0000_b")).toEqual(["Zeta a_b"]);
    expect(await names("   ")).not.toHaveLength(0);
  });

  it("stops at the limit and counts them all; nothing for accounts that aren't active", async () => {
    const list = (await listPlannerPaths(maya, { q: "zeta", take: 2 }, t.db))!;
    expect(list.paths).toHaveLength(2);
    expect(list.total).toBe(5);
    expect((await listPlannerPaths(maya, { take: 10_000 }, t.db))!.paths.length).toBeLessThanOrEqual(PLANNER_PATHS_LIST_MAX);
    for (const who of [pending, disabled]) {
      expect(await listPlannerPaths(who, {}, t.db)).toBeNull();
      expect(await getPlannerPath(who, searchIds["Zeta a_b"], t.db)).toBeNull();
      expect(await listPlannerPathTeams(who, t.db)).toBeNull();
      expect(await getPlannerSession(who, t.db)).toBeNull();
      expect(await getStrategyTabCounts(who, t.db)).toBeNull();
    }
  });

  it("one path with its data; its edit form only for people who may change it; tab counts", async () => {
    const detail = (await getPlannerPath(ethan, searchIds["Zeta a_b"], t.db))!;
    expect(detail).toMatchObject({ name: "Zeta a_b", notes: "Watch the ZETA-NOTES here", data: PP, canEdit: false });
    expect(await getPlannerPath(ethan, "missing", t.db)).toBeNull();
    expect(await getPlannerPathForEdit(ethan, searchIds["Zeta a_b"], t.db)).toBeNull();
    expect((await getPlannerPathForEdit(maya, searchIds["Zeta a_b"], t.db))?.name).toBe("Zeta a_b");
    expect((await getPlannerPathForEdit(marcus, searchIds["Zeta a_b"], t.db))?.name).toBe("Zeta a_b");
    const counts = (await getStrategyTabCounts(maya, t.db))!;
    expect(counts.paths).toBe(await t.db.plannerPath.count());
  });

  it("the planner's session: who, whether they change everyone's paths, and the other teams by number", async () => {
    const mine = (await getPlannerSession(maya, t.db))!;
    expect(mine.user).toEqual({ name: "Maya Patel", canManageAll: false });
    expect(mine.teams.length).toBeGreaterThanOrEqual(17);
    expect(mine.teams[0]).toEqual({ number: 9040, name: "STEAMpunks Alpha" });
    expect(mine.teams.map((x) => x.number)).toEqual([...mine.teams.map((x) => x.number)].sort((a, b) => a - b));
    expect(mine.teams.some((x) => x.number === OUR_TEAM_NUMBER)).toBe(false);
    for (const who of [priya, jordan, olivia]) expect((await getPlannerSession(who, t.db))!.user.canManageAll, who.name).toBe(canAdminister(who));
    expect((await getPlannerSession(priya, t.db))!.user.canManageAll).toBe(true);
  });
});

// ── The planner's JSON API ──────────────────────────────────────────────────────────────────────────────────────

const ORIGIN = "http://localhost:3000";
/** What the planner on this site sends with every change. */
const PLANNER_HEADERS = { "content-type": "application/json", "x-planner": "1", origin: ORIGIN, "sec-fetch-site": "same-origin" };

function request(method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const body = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  return new NextRequest(`${ORIGIN}${path}`, { method, headers: opts.headers ?? {}, body });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) }) as never;

async function json(res: Response): Promise<Record<string, unknown>> {
  expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  return (await res.json()) as Record<string, unknown>;
}

function expectApiHeaders(res: Response) {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
}

const as = (who: Actor | null) => {
  holder.user = who;
};

describe("GET /api/planner/session", () => {
  it("401 JSON for signed-out and inactive people (never a redirect); who and the teams for ACTIVE ones", async () => {
    for (const who of [null, pending, disabled]) {
      as(who);
      const res = await sessionRoute.GET();
      expect(res.status).toBe(401);
      expectApiHeaders(res);
      expect(typeof (await json(res)).error).toBe("string");
    }
    as(maya);
    const res = await sessionRoute.GET();
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    const body = await json(res);
    expect(Object.keys(body).sort()).toEqual(["teams", "user"]);
    expect(body.user).toEqual({ name: "Maya Patel", canManageAll: false });
    expect((body.teams as { number: number; name: string }[])[0]).toEqual({ number: 9040, name: "STEAMpunks Alpha" });
    as(marcus);
    expect(((await json(await sessionRoute.GET())).user as { canManageAll: boolean }).canManageAll).toBe(true);
    as(null);
  });
});

describe("/api/planner/paths", () => {
  it("saves (201 {id, version}) and lists, in the contract's shape", async () => {
    as(maya);
    const res = await pathsRoute.POST(
      request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, body: { name: "API auto", notes: "From the planner", teamNumber: 9040, data: PP } }),
    );
    expect(res.status).toBe(201);
    expectApiHeaders(res);
    const created = await json(res);
    expect(Object.keys(created).sort()).toEqual(["id", "version"]);
    expect(new Date(created.version as string).toISOString()).toBe(created.version);

    const list = await pathsRoute.GET(request("GET", "/api/planner/paths?team=9040&q=api%20auto"));
    expect(list.status).toBe(200);
    expectApiHeaders(list);
    const { paths } = (await json(list)) as { paths: Record<string, unknown>[] };
    expect(paths).toHaveLength(1);
    expect(Object.keys(paths[0]).sort()).toEqual(
      ["canEdit", "createdByName", "id", "name", "notes", "size", "team", "updatedAt", "updatedByName"].sort(),
    );
    expect(paths[0]).toEqual({
      id: created.id,
      name: "API auto",
      notes: "From the planner",
      team: { number: 9040, name: "STEAMpunks Alpha" },
      size: Buffer.byteLength(PP),
      updatedAt: created.version,
      updatedByName: "Maya Patel",
      createdByName: "Maya Patel",
      canEdit: true,
    });
    // "ours" leaves it out; a bad team filter is a 400.
    const ours = (await json(await pathsRoute.GET(request("GET", "/api/planner/paths?team=ours&q=api%20auto")))) as { paths: unknown[] };
    expect(ours.paths).toHaveLength(0);
    const bad = await pathsRoute.GET(request("GET", "/api/planner/paths?team=theirs"));
    expect(bad.status).toBe(400);
    expect((await json(bad)).fieldErrors).toEqual({ team: expect.any(String) });
    as(null);
  });

  it("401 for signed-out and inactive people, even with the planner's headers", async () => {
    for (const who of [null, pending]) {
      as(who);
      expect((await pathsRoute.GET(request("GET", "/api/planner/paths"))).status).toBe(401);
      const res = await pathsRoute.POST(request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, body: { name: "x", data: PP } }));
      expect(res.status).toBe(401);
      expectApiHeaders(res);
    }
    expect(await t.db.plannerPath.count({ where: { name: "x" } })).toBe(0);
    as(null);
  });

  it("refuses changes that don't come from the planner on this site (403), before anything is saved", async () => {
    as(maya);
    const body = { name: "Forged", data: PP };
    const cases: Record<string, string>[] = [
      { ...PLANNER_HEADERS, "x-planner": "" },
      { "content-type": "application/json", origin: ORIGIN },
      { ...PLANNER_HEADERS, "content-type": "text/plain" },
      { ...PLANNER_HEADERS, "content-type": "application/x-www-form-urlencoded" },
      { ...PLANNER_HEADERS, origin: "https://evil.example" },
      { ...PLANNER_HEADERS, origin: "null" },
      { ...PLANNER_HEADERS, origin: "http://localhost:3001" },
      { ...PLANNER_HEADERS, "sec-fetch-site": "cross-site" },
      { ...PLANNER_HEADERS, "sec-fetch-site": "same-site" },
    ];
    for (const headers of cases) {
      const res = await pathsRoute.POST(request("POST", "/api/planner/paths", { headers, body }));
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expectApiHeaders(res);
    }
    expect(await t.db.plannerPath.count({ where: { name: "Forged" } })).toBe(0);
    // Without Origin / Sec-Fetch-Site (older browsers, tools) the two headers are enough; charset is fine.
    const ok = await pathsRoute.POST(
      request("POST", "/api/planner/paths", { headers: { "content-type": "application/json; charset=utf-8", "x-planner": "1" }, body: { name: "Plain", data: PP } }),
    );
    expect(ok.status).toBe(201);
    // Behind a proxy: the forwarded host counts as this site.
    expect(
      plannerCsrfProblem(
        request("POST", "/api/planner/paths", {
          headers: { ...PLANNER_HEADERS, origin: "https://portal.example.org", "x-forwarded-host": "portal.example.org", "x-forwarded-proto": "https" },
        }),
      ),
    ).toBeNull();
    expect(plannerCsrfProblem(request("POST", "/api/planner/paths", { headers: { ...PLANNER_HEADERS, origin: "https://evil.example" } }))).toBe(
      PLANNER_API_CROSS_SITE,
    );
    as(null);
  });

  it("400 for bad JSON and bad fields, 413 for too big (before reading it all), 429 when saving too often", async () => {
    as(ethan);
    const post = (opts: { body?: unknown; raw?: string; headers?: Record<string, string> }) =>
      pathsRoute.POST(request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, ...opts }));
    for (const raw of ["{ nope", "[1,2]", "\"text\"", "null", ""]) {
      const res = await post({ raw });
      expect(res.status, raw).toBe(400);
      expect(typeof (await json(res)).error).toBe("string");
    }
    const invalidPath = await post({ body: { name: "Broken", data: "{}" } });
    expect(invalidPath.status).toBe(400);
    expect(Object.keys((await json(invalidPath)).fieldErrors as object)).toEqual(["data"]);
    const us = await post({ body: { name: "Ours?", teamNumber: OUR_TEAM_NUMBER, data: PP } });
    expect(us.status).toBe(400);
    expect(await json(us)).toEqual({ error: PLANNER_PATH_OUR_NUMBER, fieldErrors: { teamNumber: PLANNER_PATH_OUR_NUMBER } });
    const missingTeam = await post({ body: { name: "Unknown team", teamNumber: 55555, data: PP } });
    expect(missingTeam.status).toBe(400);

    // Data over 256 KB (the body itself is still under the cap): 413 from the check.
    const big = JSON.stringify({ ...JSON.parse(PP), pad: "x".repeat(LIMITS.plannerPathDataMaxBytes) });
    const tooBig = await post({ body: { name: "Big", data: big } });
    expect(tooBig.status).toBe(413);
    expect((await json(tooBig)).error).toBe(PLANNER_PATH_TOO_BIG);
    // A body over the cap: 413 without parsing it (declared, or not).
    const huge = JSON.stringify({ name: "Huge", data: "x".repeat(PLANNER_API_BODY_MAX_BYTES) });
    expect((await post({ raw: huge })).status).toBe(413);
    expect((await post({ raw: huge, headers: { ...PLANNER_HEADERS, "content-length": String(Buffer.byteLength(huge)) } })).status).toBe(413);
    expect(await t.db.plannerPath.count({ where: { name: { in: ["Broken", "Ours?", "Unknown team", "Big", "Huge"] } } })).toBe(0);

    await t.db.rateLimit.upsert({
      where: { key: plannerPathRateKey("create", ethan.id) },
      create: { key: plannerPathRateKey("create", ethan.id), count: PLANNER_PATH_CREATE_LIMIT.limit, windowStart: new Date() },
      update: { count: PLANNER_PATH_CREATE_LIMIT.limit, windowStart: new Date() },
    });
    const limited = await post({ body: { name: "Too often", data: PP } });
    expect(limited.status).toBe(429);
    expect((await json(limited)).error).toBe(PLANNER_PATH_RATE_LIMITED);
    await t.db.rateLimit.deleteMany({ where: { key: plannerPathRateKey("create", ethan.id) } });
    as(null);
  });
});

describe("/api/planner/paths/:id", () => {
  it("opens one (with its .pp data and version), saves changes (409 when stale), and removes it (204)", async () => {
    as(maya);
    const created = await json(
      await pathsRoute.POST(request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, body: { name: "Round trip", data: PP } })),
    );
    const id = created.id as string;

    as(ethan); // anyone ACTIVE opens it
    const opened = await pathRoute.GET(request("GET", `/api/planner/paths/${id}`), params(id));
    expect(opened.status).toBe(200);
    expectApiHeaders(opened);
    expect(await json(opened)).toEqual({ id, name: "Round trip", notes: "", team: null, data: PP, version: created.version, canEdit: false });
    const missing = await pathRoute.GET(request("GET", "/api/planner/paths/nope"), params("nope"));
    expect(missing.status).toBe(404);
    expect(typeof (await json(missing)).error).toBe("string");

    // Ethan can't change or remove Maya's path.
    const put = (who: Actor, body: Record<string, unknown>, headers: Record<string, string> = PLANNER_HEADERS) => {
      as(who);
      return pathRoute.PUT(request("PUT", `/api/planner/paths/${id}`, { headers, body }), params(id));
    };
    const forbidden = await put(ethan, { name: "Ethan's", version: created.version });
    expect(forbidden.status).toBe(403);
    expect((await json(forbidden)).error).toBe(PLANNER_PATH_CANT_EDIT);

    // Maya saves the path (data only): 200 {version}.
    const saved = await put(maya, { data: PP_TWO_LINES, version: created.version });
    expect(saved.status).toBe(200);
    expectApiHeaders(saved);
    const { version } = (await json(saved)) as { version: string };
    expect(version).not.toBe(created.version);
    expect(await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Round trip", data: PP_TWO_LINES });

    // A leader saves from an older copy: 409 with who and what's current.
    const stale = await put(priya, { name: "Priya's copy", version: created.version });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ error: plannerPathConflictMessage("Maya Patel"), current: { version, updatedByName: "Maya Patel" } });
    // Without the planner's headers: 403; bad version: 400.
    expect((await put(maya, { name: "x", version }, { "content-type": "application/json" })).status).toBe(403);
    expect((await put(maya, { name: "x", version: "soon" })).status).toBe(400);
    expect((await put(maya, { name: "x" })).status).toBe(400);
    as(null);
    expect((await put(null as unknown as Actor, { name: "x", version })).status).toBe(401);

    // Remove: others 403; CSRF 403; the saver 204 with no body; again 404.
    const del = (who: Actor | null, headers: Record<string, string> = PLANNER_HEADERS) => {
      as(who);
      return pathRoute.DELETE(request("DELETE", `/api/planner/paths/${id}`, { headers }), params(id));
    };
    expect((await del(ethan)).status).toBe(403);
    expect((await del(maya, { "x-planner": "1" })).status).toBe(403);
    expect((await del(maya, { ...PLANNER_HEADERS, origin: "https://evil.example" })).status).toBe(403);
    expect((await del(null)).status).toBe(401);
    const removed = await del(maya);
    expect(removed.status).toBe(204);
    expectApiHeaders(removed);
    expect(await removed.text()).toBe("");
    expect((await del(maya)).status).toBe(404);
    as(null);
  });
});

describe("/api/planner/paths/:id — more", () => {
  it("answers a save with the path's name, notes, and team as they are now (an overwrite keeps someone's rename)", async () => {
    as(maya);
    const created = await json(
      await pathsRoute.POST(
        request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, body: { name: "Maya original name", notes: "Mine", data: PP } }),
      ),
    );
    const id = created.id as string;
    const put = (who: Actor, body: Record<string, unknown>) => {
      as(who);
      return pathRoute.PUT(request("PUT", `/api/planner/paths/${id}`, { headers: PLANNER_HEADERS, body }), params(id));
    };
    // Marcus renames it, changes its notes, and files it under 9040 (the edit form, here straight through the API).
    const renamed = await put(marcus, { name: "Marcus better name", notes: "Checked", teamNumber: 9040, version: created.version });
    expect(renamed.status).toBe(200);
    const after = (await json(renamed)) as { version: string };
    expect(after).toEqual({
      version: expect.any(String),
      name: "Marcus better name",
      notes: "Checked",
      team: { number: 9040, name: "STEAMpunks Alpha" },
    });
    // Maya's planner saves from its old copy: 409; then she overwrites with the data only.
    expect((await put(maya, { data: PP_TWO_LINES, version: created.version })).status).toBe(409);
    const overwritten = await put(maya, { data: PP_TWO_LINES, version: after.version });
    expect(overwritten.status).toBe(200);
    expect(await json(overwritten)).toEqual({
      version: expect.any(String),
      name: "Marcus better name",
      notes: "Checked",
      team: { number: 9040, name: "STEAMpunks Alpha" },
    });
    expect(await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Marcus better name", data: PP_TWO_LINES });
    // Made one of ours again: team null.
    const current = (await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
    expect(await json(await put(marcus, { teamNumber: null, version: current }))).toMatchObject({ team: null });
    as(null);
  });

  it("404 (not a 500) for ids no path can have, like a NUL byte", async () => {
    as(maya);
    for (const bad of ["\u0000", "a\u0000b", "x".repeat(65)]) {
      const get = await pathRoute.GET(request("GET", "/api/planner/paths/x"), params(bad));
      const put = await pathRoute.PUT(
        request("PUT", "/api/planner/paths/x", { headers: PLANNER_HEADERS, body: { name: "x", version: TEST_NOW.toISOString() } }),
        params(bad),
      );
      const del = await pathRoute.DELETE(request("DELETE", "/api/planner/paths/x", { headers: PLANNER_HEADERS }), params(bad));
      expect([get.status, put.status, del.status], JSON.stringify(bad)).toEqual([404, 404, 404]);
      expect(typeof (await json(get)).error).toBe("string");
      expect((await downloadRoute.GET(request("GET", "/strategy/paths/x/download"), params(bad))).status).toBe(404);
    }
    as(null);
  });

  it(`every request counts toward ${PLANNER_API_REQUEST_LIMIT.limit} an hour per person, refused ones too (429 before the body is read)`, async () => {
    const busy = await makeUser(t.db, { name: "Busy Planner" });
    as(busy);
    // Refused requests (bad JSON, bad fields) count, not only saves.
    for (let i = 0; i < 3; i++) {
      expect((await pathsRoute.POST(request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, raw: "{ nope" }))).status).toBe(400);
    }
    expect((await t.db.rateLimit.findUniqueOrThrow({ where: { key: plannerApiRateKey(busy.id) } })).count).toBe(3);
    // A forged request (no planner header) is refused before it counts.
    await pathsRoute.POST(request("POST", "/api/planner/paths", { headers: { "content-type": "application/json" }, raw: "{}" }));
    expect((await t.db.rateLimit.findUniqueOrThrow({ where: { key: plannerApiRateKey(busy.id) } })).count).toBe(3);

    await t.db.rateLimit.update({ where: { key: plannerApiRateKey(busy.id) }, data: { count: PLANNER_API_REQUEST_LIMIT.limit } });
    const limited = [
      await sessionRoute.GET(),
      await pathsRoute.GET(request("GET", "/api/planner/paths")),
      await pathRoute.GET(request("GET", "/api/planner/paths/x"), params("x")),
      await pathsRoute.POST(request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, raw: "{ nope" })),
      await pathsRoute.POST(request("POST", "/api/planner/paths", { headers: PLANNER_HEADERS, body: { name: "Over", data: PP } })),
    ];
    for (const res of limited) {
      expect(res.status).toBe(429);
      expectApiHeaders(res);
      expect((await json(res)).error).toBe(PLANNER_API_RATE_LIMITED);
    }
    expect(await t.db.plannerPath.count({ where: { name: "Over" } })).toBe(0);
    // Someone else isn't held up.
    as(maya);
    expect((await sessionRoute.GET()).status).toBe(200);
    as(null);
  });
});

// ── Download, actions, proxy ────────────────────────────────────────────────────────────────────────────────────

describe("Download .pp (/strategy/paths/:id/download)", () => {
  it("always a download named after the path, byte for byte; sign in first; 404 when gone", async () => {
    const { id } = await save(maya, { name: "Red / auto: v2.pp", data: PP });
    as(ethan);
    const res = await downloadRoute.GET(request("GET", `/strategy/paths/${id}/download`), params(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Red auto v2\.pp"; filename\*=UTF-8''Red%20auto%20v2\.pp$/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe(PP);
    expect((await downloadRoute.GET(request("GET", "/strategy/paths/nope/download"), params("nope"))).status).toBe(404);
    as(pending);
    expect((await downloadRoute.GET(request("GET", `/strategy/paths/${id}/download`), params(id))).status).toBe(403);
    as(null);
    const out = await downloadRoute.GET(request("GET", `/strategy/paths/${id}/download`), params(id));
    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toMatch(/\/login\?next=%2Fstrategy%2Fpaths%2F/);
  });
});

/** Where a Server Action redirected to (it throws Next.js's redirect error), or null. */
async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    const m = /^NEXT_REDIRECT;[^;]*;([^;]*);/.exec(digest);
    if (!m) throw e;
    return m[1];
  }
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("the Paths tab's actions", () => {
  it("Remove goes back to the list it was on (keeping only real filters), or the team's page", async () => {
    as(maya);
    const a = await save(maya, { name: "Remove me" });
    expect(
      await redirectOf(deletePlannerPathAction(initialActionState, form({ pathId: a.id, from: "paths", team: "9040", q: "auto" }))),
    ).toBe("/strategy/paths?team=9040&q=auto&removed=1");
    const b = await save(maya, { name: "Remove me too" });
    expect(
      await redirectOf(deletePlannerPathAction(initialActionState, form({ pathId: b.id, from: "paths", team: "https://evil", q: "\u0000" }))),
    ).toBe("/strategy/paths?removed=1");
    const c = await save(maya, { name: "Theirs", teamNumber: 9040 });
    expect(await redirectOf(deletePlannerPathAction(initialActionState, form({ pathId: c.id, from: "team" })))).toBe(
      "/strategy/teams/9040?pathRemoved=1",
    );
    // Not allowed: the message, no redirect.
    const d = await save(maya, { name: "Not Ethan's" });
    as(ethan);
    const state = await deletePlannerPathAction(initialActionState, form({ pathId: d.id, from: "paths" }));
    expect(state).toMatchObject({ ok: false, message: PLANNER_PATH_CANT_EDIT });
    as(null);
  });

  it("Edit saves and goes back; after a conflict the page is refreshed so saving again replaces theirs", async () => {
    const { id, version } = await save(maya, { name: "Edit me", teamNumber: 9040 });
    as(maya);
    const edit = (fields: Record<string, string>) => updatePlannerPathAction(initialActionState, form({ pathId: id, ...fields }));
    expect(await redirectOf(edit({ version, name: "Edited", notes: "New notes", teamNumber: "9040", from: "team" }))).toBe(
      "/strategy/teams/9040?pathSaved=1",
    );
    const row = await t.db.plannerPath.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ name: "Edited", notes: "New notes" });

    // A stale form: refused with who changed it, and the page refreshed.
    const before = holder.refreshed;
    const state = await edit({ version, name: "Stale", notes: "", teamNumber: "", from: "team" });
    expect(state).toMatchObject({ ok: false, message: plannerPathConflictMessage("Maya Patel") });
    expect(holder.refreshed).toBe(before + 1);
    // With the current version: saved, now one of ours, so back to the Paths tab.
    expect(await redirectOf(edit({ version: row.updatedAt.toISOString(), name: "Ours now", notes: "", teamNumber: "", from: "team" }))).toBe(
      "/strategy/paths?saved=1",
    );
    expect((await t.db.plannerPath.findUniqueOrThrow({ where: { id } })).teamId).toBeNull();
    as(null);
  });
});

describe("the proxy", () => {
  const visit = (path: string, cookie = false) =>
    proxy(new NextRequest(`${ORIGIN}${path}`, { headers: cookie ? { cookie: "hk_session=abc" } : {} }));

  it("answers the API with a JSON 401 when signed out (never the sign-in page), and lets it through otherwise", async () => {
    const res = visit("/api/planner/session");
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
    expect(visit("/api/planner/paths/abc", true).headers.get("x-middleware-next")).toBe("1");
  });

  it("serves the planner's files to everyone, but its page only after signing in (and back)", () => {
    for (const file of ["/planner/assets/index.js", "/planner/manifest.webmanifest", "/planner/sw.js", "/planner/LICENSE"]) {
      expect(visit(file).headers.get("x-middleware-next"), file).toBe("1");
    }
    const page = visit("/planner/index.html?path=abc");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(`${ORIGIN}/login?next=%2Fplanner%2Findex.html%3Fpath%3Dabc`);
    expect(visit("/planner/index.html", true).headers.get("x-middleware-next")).toBe("1");
    expect(visit("/strategy/paths").status).toBe(307);
  });

  it("knows the planner's page however it's spelled (the sign-in bounce is a convenience, not access control)", () => {
    for (const page of ["/planner/INDEX.html", "/planner/index.html/", "/planner/%69ndex.html", "/planner//index.html", "/planner/Index.HTML?team=9040"]) {
      expect(visit(page).status, page).toBe(307);
    }
    // A malformed escape isn't the page (and doesn't throw).
    expect(visit("/planner/%E0%A4%A.html").headers.get("x-middleware-next")).toBe("1");
  });
});
