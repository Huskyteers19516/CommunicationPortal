// Strategy → Other teams: the other teams in our league (LeagueTeam), their "strategy at a glance" summary, and
// strategies written about them (Strategy.teamId). Services: src/server/services/league-teams.ts (+ teamId in
// ./strategy.ts); queries: src/server/queries/league-teams.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIMITS, OUR_TEAM_NUMBER } from "@/lib/constants";
import { leagueTeamRemovedNotice, leagueTeamRemoveQuestion } from "@/lib/strategy";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/server/errors";
import { canManageLeagueTeams } from "@/server/permissions";
import { getLeagueTeam, getLeagueTeamForEdit, getStrategyTabCounts, listLeagueTeams, parseTeamNumber } from "@/server/queries/league-teams";
import { getStrategyDetail, listStrategies } from "@/server/queries/strategy";
import {
  createLeagueTeam,
  deleteLeagueTeam,
  LEAGUE_TEAM_CANT_MANAGE,
  LEAGUE_TEAM_INACTIVE,
  OUR_NUMBER_MESSAGE,
  saveLeagueTeamSummary,
  SUMMARY_CONFLICT,
  updateLeagueTeam,
} from "@/server/services/league-teams";
import { createStrategy, deleteStrategy, STRATEGY_TEAM_NOT_FOUND, updateStrategy } from "@/server/services/strategy";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW } from "./helpers/factories";

let t: TestDb;
let maya: Actor; // Software member
let ethan: Actor; // Build member
let ava: Actor; // Business member
let priya: Actor; // Software leader
let marcus: Actor; // Build leader
let amara: Actor; // Business leader
let jordan: Actor; // Captain
let elena: Actor; // Mentor
let david: Actor; // Teacher
let olivia: Actor; // Owner (a Build member with the Owner flag)
let pending: Actor;
let disabled: Actor;
let rejected: Actor;
let pendingLeader: Actor;

beforeAll(async () => {
  t = await createTestDb();
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  ava = await makeUser(t.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  marcus = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  pending = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUILD", status: "PENDING" });
  disabled = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUILD", status: "DISABLED" });
  rejected = await makeUser(t.db, { name: "Rex Rejected", role: "MEMBER", subteam: "SOFTWARE", status: "REJECTED" });
  pendingLeader = await makeUser(t.db, { name: "Quinn Waiting", role: "BUILD_LEADER", status: "PENDING" });
});
afterAll(async () => {
  await t.drop();
});
// Strategies are added with one fixed "now"; the hourly limit is tested in strategy.test.ts.
beforeEach(async () => {
  await t.db.rateLimit.deleteMany();
});

const ctx = (actor: Actor, now: Date = TEST_NOW) => ({ ...contextFor(t.db, actor), now });
const minutesLater = (m: number) => new Date(TEST_NOW.getTime() + m * 60 * 1000);

const enc = (s: string) => new TextEncoder().encode(s);
/** A real 1×1 PNG. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
/** A tiny path the planner can open (the shape its Save writes). */
const PP = enc(
  JSON.stringify({
    startPoint: { x: 61.75, y: 8, heading: "linear", startDeg: 90, endDeg: 90 },
    lines: [{ id: "line-a", name: "Path 1", endPoint: { x: 61.75, y: 30, heading: "linear", startDeg: 90, endDeg: 90 }, controlPoints: [], color: "#ffc516" }],
    version: "1.2.1",
  }),
);

function file(name = "their-auto.pp", bytes: Uint8Array | string = PP, type = "") {
  return { name, type, bytes: typeof bytes === "string" ? enc(bytes) : bytes };
}

function form(over: Record<string, unknown> = {}) {
  return { title: "Their auto (traced)", kind: "AUTO", description: "", link: "", ...over };
}

async function create(actor: Actor, over: Record<string, unknown> = {}, files: unknown[] = []) {
  return createStrategy(ctx(actor), { ...form(over), files });
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

async function validationOf(p: Promise<unknown>): Promise<ValidationError> {
  const err = await errorOf(p);
  expect(err).toBeInstanceOf(ValidationError);
  return err as ValidationError;
}

describe("other teams in the league", () => {
  it("the league's teams are there from the start, by number, without us", async () => {
    const list = (await listLeagueTeams(maya, {}, t.db))!;
    expect(list.total).toBeGreaterThanOrEqual(17);
    const numbers = list.teams.map((x) => x.number);
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(numbers).toContain(9040);
    expect(numbers).not.toContain(OUR_TEAM_NUMBER);
    expect(list.teams.find((x) => x.number === 9040)).toMatchObject({ id: "leagueteam9040", name: "STEAMpunks Alpha", city: "Irvine" });
    expect(list.canManage).toBe(false);
    expect((await listLeagueTeams(priya, {}, t.db))!.canManage).toBe(true);
    for (const a of [pending, disabled, rejected]) {
      expect(await listLeagueTeams(a, {}, t.db), a.name).toBeNull();
      expect(await getLeagueTeam(a, 9040, t.db), a.name).toBeNull();
    }
  });

  it("search finds a number (or its start), a name, or a city", async () => {
    const search = async (q: string) => (await listLeagueTeams(maya, { q }, t.db))!.teams.map((x) => x.number);
    expect(await search("9040")).toEqual([9040]);
    expect(await search("#1330")).toEqual([13303]);
    expect(await search("steampunks")).toEqual([9040, 13277]);
    expect(await search("laguna")).toEqual([21990, 24216]);
    expect(await search("nothing like this")).toEqual([]);
    expect(parseTeamNumber("9040")).toBe(9040);
    for (const bad of [undefined, "", "abc", "90 40", "1234567", "-1"]) expect(parseTeamNumber(bad), String(bad)).toBeNull();
  });

  it("only people with admin access add, change, and remove teams", async () => {
    for (const a of [maya, ethan, ava]) {
      expect(canManageLeagueTeams(a), a.name).toBe(false);
      const err = await errorOf(createLeagueTeam(ctx(a), { number: "11111", name: "Nope" }));
      expect(err, a.name).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).userMessage).toBe(LEAGUE_TEAM_CANT_MANAGE);
      await expect(updateLeagueTeam(ctx(a), { teamId: "leagueteam9040", number: "9040", name: "Renamed" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteLeagueTeam(ctx(a), { teamId: "leagueteam9040" })).rejects.toBeInstanceOf(ForbiddenError);
      expect(await getLeagueTeamForEdit(a, 9040, t.db), a.name).toBeNull();
    }
    for (const a of [pending, pendingLeader]) {
      const err = await errorOf(createLeagueTeam(ctx(a), { number: "11111", name: "Nope" }));
      expect((err as ForbiddenError).userMessage, a.name).toBe(LEAGUE_TEAM_INACTIVE);
    }
    for (const a of [priya, marcus, amara, jordan, elena, david, olivia]) expect(canManageLeagueTeams(a), a.name).toBe(true);

    const { id, number } = await createLeagueTeam(ctx(elena), { number: " #12,345 ", name: "  New Bots ", city: "Orange" });
    expect(number).toBe(12345);
    expect(await t.db.leagueTeam.findUniqueOrThrow({ where: { id } })).toMatchObject({ number: 12345, name: "New Bots", city: "Orange", createdById: elena.id, summary: "" });
    await updateLeagueTeam(ctx(marcus), { teamId: id, number: "12346", name: "New Bots Renamed", city: "" });
    expect(await getLeagueTeam(maya, 12346, t.db)).toMatchObject({ name: "New Bots Renamed", city: "", canManage: false });
    expect(await getLeagueTeam(maya, 12345, t.db)).toBeNull();
    expect((await getLeagueTeamForEdit(marcus, 12346, t.db))?.id).toBe(id);
    await deleteLeagueTeam(ctx(marcus), { teamId: id });
    await expect(deleteLeagueTeam(ctx(marcus), { teamId: id })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateLeagueTeam(ctx(marcus), { teamId: id, number: "12346", name: "Gone" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("numbers are unique, never ours, and look like team numbers; names are required", async () => {
    const taken = await validationOf(createLeagueTeam(ctx(jordan), { number: "9040", name: "Copy" }));
    expect(taken.fieldErrors.number).toBe("Team 9040 is already on the list.");
    const ours = await validationOf(createLeagueTeam(ctx(jordan), { number: String(OUR_TEAM_NUMBER), name: "Huskyteers" }));
    expect(ours.fieldErrors.number).toBe(OUR_NUMBER_MESSAGE);
    for (const bad of ["", "abc", "0", "1234567", "12.5"]) {
      expect((await validationOf(createLeagueTeam(ctx(jordan), { number: bad, name: "Bad" }))).fieldErrors.number, bad).toBe(
        "Enter the team's number, like 9040.",
      );
    }
    const e = await validationOf(createLeagueTeam(ctx(jordan), { number: "22222", name: " ", city: "x".repeat(LIMITS.leagueTeamCityMax + 1) }));
    expect(e.fieldErrors).toMatchObject({ name: "Team name is required.", city: expect.stringMatching(/at most 80/) });
    // Renaming to a number another team has, or to ours, is refused too; keeping its own number is fine.
    expect((await validationOf(updateLeagueTeam(ctx(jordan), { teamId: "leagueteam9040", number: "13171", name: "X" }))).fieldErrors.number).toBe(
      "Team 13171 is already on the list.",
    );
    expect((await validationOf(updateLeagueTeam(ctx(jordan), { teamId: "leagueteam9040", number: "19516", name: "X" }))).fieldErrors.number).toBe(
      OUR_NUMBER_MESSAGE,
    );
    await updateLeagueTeam(ctx(jordan), { teamId: "leagueteam9040", number: "9040", name: "STEAMpunks Alpha", city: "Irvine" });
  });

  it("anyone active writes the summary; a save based on an older version is refused, and saving again replaces it", async () => {
    const team = (await getLeagueTeam(maya, 13171, t.db))!;
    expect(team).toMatchObject({ summary: "", summaryVersion: "", summaryUpdatedAt: null, summaryUpdatedByName: null });
    // Maya and Ethan both open it (never written: version "").
    await saveLeagueTeamSummary(ctx(maya, minutesLater(1)), { teamId: team.id, summary: "  Fast 2-sample auto.  ", version: "" });
    const afterMaya = (await getLeagueTeam(ethan, 13171, t.db))!;
    expect(afterMaya).toMatchObject({ summary: "Fast 2-sample auto.", summaryUpdatedByName: "Maya Patel", summaryVersion: minutesLater(1).toISOString() });

    const conflict = await errorOf(saveLeagueTeamSummary(ctx(ethan, minutesLater(2)), { teamId: team.id, summary: "Parks early.", version: "" }));
    expect(conflict).toBeInstanceOf(ConflictError);
    expect((conflict as ConflictError).userMessage).toBe(SUMMARY_CONFLICT);
    expect((await getLeagueTeam(ethan, 13171, t.db))!.summary).toBe("Fast 2-sample auto.");

    // Having seen Maya's version, Ethan saves again (with it) and replaces it.
    await saveLeagueTeamSummary(ctx(ethan, minutesLater(3)), { teamId: team.id, summary: "Fast 2-sample auto. Parks early.", version: afterMaya.summaryVersion });
    expect(await getLeagueTeam(maya, 13171, t.db)).toMatchObject({ summary: "Fast 2-sample auto. Parks early.", summaryUpdatedByName: "Ethan Chen" });
    // Maya's old version is stale now.
    await expect(
      saveLeagueTeamSummary(ctx(maya, minutesLater(4)), { teamId: team.id, summary: "Mine", version: afterMaya.summaryVersion }),
    ).rejects.toBeInstanceOf(ConflictError);
    // Clearing it is a save too; the list shows it has no summary.
    const latest = (await getLeagueTeam(maya, 13171, t.db))!.summaryVersion;
    await saveLeagueTeamSummary(ctx(maya, minutesLater(5)), { teamId: team.id, summary: "   ", version: latest });
    expect((await listLeagueTeams(maya, { q: "13171" }, t.db))!.teams[0]).toMatchObject({ hasSummary: false, summaryUpdatedAt: minutesLater(5) });

    const tooLong = await validationOf(saveLeagueTeamSummary(ctx(maya), { teamId: team.id, summary: "x".repeat(LIMITS.leagueTeamSummaryMax + 1), version: "" }));
    expect(tooLong.fieldErrors.summary).toMatch(/at most 5000/);
    await expect(saveLeagueTeamSummary(ctx(maya), { teamId: "missing", summary: "x", version: "" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(saveLeagueTeamSummary(ctx(maya), { teamId: team.id, summary: "x", version: "not a date" })).rejects.toBeInstanceOf(ValidationError);
    for (const a of [pending, disabled]) {
      await expect(saveLeagueTeamSummary(ctx(a), { teamId: team.id, summary: "x", version: "" }), a.name).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("a summary typed up to the box's limit fits, although browsers send its line breaks as CRLF", async () => {
    const team = (await getLeagueTeam(maya, 13303, t.db))!;
    // The textarea's maxlength counts a line break as one character; the form sends each as "\r\n".
    const lines = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(249, "x"));
    const typed = lines.join("\n");
    expect(typed).toHaveLength(LIMITS.leagueTeamSummaryMax - 1);
    await saveLeagueTeamSummary(ctx(maya, minutesLater(10)), { teamId: team.id, summary: `${lines.join("\r\n")}x`, version: team.summaryVersion });
    // Stored with plain line breaks.
    const saved = (await getLeagueTeam(maya, 13303, t.db))!;
    expect(saved.summary).toBe(`${typed}x`);
    expect((await listLeagueTeams(maya, { q: "13303" }, t.db))!.teams[0]).toMatchObject({ hasSummary: true, summaryUpdatedAt: minutesLater(10) });
    // One character more is still too long.
    const tooLong = await validationOf(
      saveLeagueTeamSummary(ctx(maya, minutesLater(11)), { teamId: team.id, summary: `${lines.join("\r\n")}xy`, version: saved.summaryVersion }),
    );
    expect(tooLong.fieldErrors.summary).toMatch(/at most 5000/);
  });

  it("the tabs count our strategies (never the ones about other teams) and the other teams", async () => {
    const before = (await getStrategyTabCounts(maya, t.db))!;
    expect(before.teams).toBe(await t.db.leagueTeam.count());
    expect(before.teams).toBe((await listLeagueTeams(maya, {}, t.db))!.total);
    const theirs = await create(maya, { title: "About 9040", teamId: "leagueteam9040" });
    const ours = await create(maya, { title: "Ours", teamId: "" });
    expect(await getStrategyTabCounts(ethan, t.db)).toEqual({ ours: before.ours + 1, teams: before.teams, paths: before.paths });
    await deleteStrategy(ctx(maya), { strategyId: theirs.id });
    await deleteStrategy(ctx(maya), { strategyId: ours.id });
    for (const a of [pending, disabled, rejected]) expect(await getStrategyTabCounts(a, t.db), a.name).toBeNull();
  });

  it("strategies about a team stay on its page, out of ours; anyone adds them; the author or admins edit them", async () => {
    const { id } = await create(ethan, { title: "9040's auto (traced)", kind: "AUTO", teamId: "leagueteam9040" }, [file("9040-auto.pp")]);
    expect(await t.db.strategy.findUniqueOrThrow({ where: { id } })).toMatchObject({ teamId: "leagueteam9040", createdById: ethan.id });
    const ours = (await listStrategies(maya, { mine: false }, t.db))!;
    expect(ours.items.some((s) => s.id === id)).toBe(false);
    const theirs = (await listStrategies(maya, { mine: false, teamId: "leagueteam9040" }, t.db))!;
    expect(theirs.items.map((s) => s.id)).toEqual([id]);
    expect(await getStrategyDetail(maya, id, t.db)).toMatchObject({ team: { number: 9040, name: "STEAMpunks Alpha" }, canEdit: false });
    expect((await listLeagueTeams(maya, { q: "9040" }, t.db))!.teams[0].strategyCount).toBe(1);
    expect(await getLeagueTeam(maya, 9040, t.db)).toMatchObject({ strategyCount: 1, fileCount: 1 });

    await expect(updateStrategy(ctx(maya), { strategyId: id, ...form() })).rejects.toBeInstanceOf(ForbiddenError);
    // Editing never moves it to another team (or to ours).
    await updateStrategy(ctx(ethan), { strategyId: id, ...form({ title: "9040's auto", teamId: "" }) });
    expect((await t.db.strategy.findUniqueOrThrow({ where: { id } })).teamId).toBe("leagueteam9040");
    expect(await deleteStrategy(ctx(priya), { strategyId: id })).toEqual({ title: "9040's auto", teamNumber: 9040 });

    const missing = await errorOf(create(maya, { teamId: "leagueteam1" }));
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as NotFoundError).userMessage).toBe(STRATEGY_TEAM_NOT_FOUND);
    const { id: oursId } = await create(maya, { teamId: "" });
    expect(await deleteStrategy(ctx(maya), { strategyId: oursId })).toMatchObject({ teamNumber: null });
  });

  it("removing a team removes the strategies about it and their files, and nothing else", async () => {
    const { id: teamId } = await createLeagueTeam(ctx(jordan), { number: "33333", name: "Short Lived", city: "Irvine" });
    const a = await create(maya, { title: "Their auto", teamId }, [file("their.pp"), file("field.png", PNG)]);
    const b = await create(ethan, { title: "Scouting them", kind: "SCOUTING", teamId });
    const ours = await create(maya, { title: "Ours stays" }, [file("ours.pp")]);
    const detail = (await getLeagueTeam(jordan, 33333, t.db))!;
    expect(detail).toMatchObject({ strategyCount: 2, fileCount: 2 });
    expect(leagueTeamRemoveQuestion("33333 · Short Lived", detail.strategyCount, detail.fileCount)).toBe(
      "Remove 33333 · Short Lived from Other teams? The 2 strategies about them and their 2 files will be removed too.",
    );

    expect(await deleteLeagueTeam(ctx(jordan), { teamId })).toEqual({ number: 33333, name: "Short Lived", strategies: 2, files: 2 });
    expect(await t.db.strategy.count({ where: { id: { in: [a.id, b.id] } } })).toBe(0);
    expect(await t.db.strategyFile.count({ where: { strategyId: a.id } })).toBe(0);
    expect(await t.db.strategy.findUnique({ where: { id: ours.id } })).not.toBeNull();
  });
});

describe("the remove question and notice", () => {
  it("says what went after a team is removed", () => {
    expect(leagueTeamRemovedNotice("9040 · STEAMpunks Alpha", 0)).toBe("Removed 9040 · STEAMpunks Alpha.");
    expect(leagueTeamRemovedNotice("9040 · STEAMpunks Alpha", Number.NaN)).toBe("Removed 9040 · STEAMpunks Alpha.");
    expect(leagueTeamRemovedNotice("9040 · STEAMpunks Alpha", 1)).toBe("Removed 9040 · STEAMpunks Alpha, and the strategy about them.");
    expect(leagueTeamRemovedNotice("9040 · STEAMpunks Alpha", 3)).toBe("Removed 9040 · STEAMpunks Alpha, and the 3 strategies about them.");
  });

  it("says how many strategies and files go with the team", () => {
    expect(leagueTeamRemoveQuestion("9040 · STEAMpunks Alpha", 0, 0)).toBe("Remove 9040 · STEAMpunks Alpha from Other teams?");
    expect(leagueTeamRemoveQuestion("9040 · STEAMpunks Alpha", 1, 1)).toBe(
      "Remove 9040 · STEAMpunks Alpha from Other teams? The strategy about them and its file will be removed too.",
    );
    expect(leagueTeamRemoveQuestion("9040 · STEAMpunks Alpha", 2, 0)).toBe(
      "Remove 9040 · STEAMpunks Alpha from Other teams? The 2 strategies about them will be removed too.",
    );
  });
});
