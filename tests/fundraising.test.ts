import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FundraiserStatus } from "@/generated/prisma/enums";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import {
  FUNDRAISER_DATE_TOO_EARLY,
  FUNDRAISER_DATE_TOO_LATE,
  fundraiserClosedReason,
  fundraiserDatesLabel,
  goalPercent,
  helperSpotsLabel,
  parseSeasonGoal,
  parseSeasonStart,
  suggestedSeasonStart,
} from "@/lib/fundraising";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import {
  FUNDRAISERS_DONE_LIMIT,
  getFundraiser,
  getFundraiserLeadOptions,
  getFundraisingPage,
  getFundraisingSummary,
} from "@/server/queries/fundraising";
import {
  createFundraiser,
  deleteFundraiser,
  FUNDRAISER_HELP_RATE_LIMIT,
  FUNDRAISING_SEASON_GOAL_KEY,
  FUNDRAISING_SEASON_START_KEY,
  fundraiserFullMessage,
  raisedChangedMessage,
  removeVolunteer,
  unvolunteer,
  updateFundraiser,
  updateRaisedAmount,
  updateSeasonGoal,
  volunteer,
} from "@/server/services/fundraising";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

type Who =
  | "owner"
  | "captain"
  | "mentor"
  | "teacher"
  | "bizLead"
  | "swLead"
  | "buildLead"
  | "bizMember"
  | "swMember"
  | "buildMember"
  | "pendingBiz"
  | "disabledBiz"
  | "disabledSw";

let t: TestDb;
let p: Record<Who, Actor>;
/** Plenty of members for the race. */
let crowd: Actor[];

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    owner: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true, name: "Olive Owner" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Mia Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Theo Teacher" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Amara Lead" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Lead" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Gwen Business" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ethan Build" }),
    pendingBiz: await makeUser(db, { role: "BUSINESS_LEADER", status: "PENDING", name: "Pat Pending" }),
    disabledBiz: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", status: "DISABLED", name: "Dana Disabled" }),
    disabledSw: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", status: "DISABLED", name: "Dex Disabled" }),
  };
  crowd = [];
  for (let i = 0; i < 8; i++) crowd.push(await makeUser(t.db, { role: "MEMBER", subteam: i % 2 ? "BUILD" : "SOFTWARE", name: `Helper ${i}` }));
});

afterAll(async () => {
  await t?.drop();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);

let n = 0;
/** A fundraiser straight in the DB (bypassing the service). Dates are days from TEST_TODAY. */
async function makeFundraiser(
  opts: {
    status?: FundraiserStatus;
    starts?: number | null;
    ends?: number | null;
    limit?: number | null;
    goal?: number | null;
    raised?: number;
    helpers?: Actor[];
    leadId?: string | null;
  } = {},
) {
  const day = (d: number | null | undefined) => (d === null || d === undefined ? null : dateOnlyToDb(addDays(TEST_TODAY, d)));
  return t.db.fundraiser.create({
    data: {
      name: `Fundraiser ${++n}`,
      status: opts.status ?? "UPCOMING",
      startsOn: day(opts.starts === undefined ? 5 : opts.starts),
      endsOn: day(opts.ends),
      volunteerLimit: opts.limit ?? null,
      goalAmount: opts.goal ?? null,
      raisedAmount: opts.raised ?? 0,
      leadId: opts.leadId ?? null,
      createdById: p.bizLead.id,
      volunteers: { create: (opts.helpers ?? []).map((h) => ({ userId: h.id })) },
    },
  });
}

const validInput = (over: Record<string, unknown> = {}) => ({
  name: "Car wash at the high school",
  kind: "EVENT",
  status: "UPCOMING",
  description: "Bring towels and buckets.",
  location: "Anaheim High parking lot",
  link: "",
  startsOn: addDays(TEST_TODAY, 9),
  endsOn: "",
  goalAmount: "$500",
  raisedAmount: "",
  leadId: "",
  volunteerLimit: "6",
  ...over,
});

/** The ValidationError's per-field message for `field`. */
async function fieldError(promise: Promise<unknown>, field: string): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).fieldErrors[field];
}

describe("who can manage fundraisers", () => {
  it("lets the Business subteam and staff create, edit, update, and remove", async () => {
    for (const who of ["bizMember", "bizLead", "swLead", "buildLead", "captain", "mentor", "teacher", "owner"] as const) {
      const ctx = ctxFor(p[who]);
      const { id } = await createFundraiser(ctx, validInput({ name: `By ${who}` }));
      const row = await t.db.fundraiser.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ name: `By ${who}`, kind: "EVENT", status: "UPCOMING", goalAmount: 500, raisedAmount: 0, createdById: p[who].id });
      await updateFundraiser(ctx, { ...validInput({ name: `Edited by ${who}` }), fundraiserId: id });
      await updateRaisedAmount(ctx, { fundraiserId: id, raisedAmount: "120" });
      expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: `Edited by ${who}`, raisedAmount: 120 });
      await expect(deleteFundraiser(ctx, { fundraiserId: id })).resolves.toEqual({ name: `Edited by ${who}` });
      expect(await t.db.fundraiser.count({ where: { id } })).toBe(0);
    }
  });

  it("refuses software and build members, and pending or disabled accounts", async () => {
    const f = await makeFundraiser({ helpers: [p.swMember] });
    for (const who of ["swMember", "buildMember", "pendingBiz", "disabledBiz"] as const) {
      const ctx = ctxFor(p[who]);
      await expect(createFundraiser(ctx, validInput())).rejects.toThrow(ForbiddenError);
      await expect(updateFundraiser(ctx, { ...validInput(), fundraiserId: f.id })).rejects.toThrow(ForbiddenError);
      await expect(updateRaisedAmount(ctx, { fundraiserId: f.id, raisedAmount: "5" })).rejects.toThrow(ForbiddenError);
      await expect(deleteFundraiser(ctx, { fundraiserId: f.id })).rejects.toThrow(ForbiddenError);
      await expect(removeVolunteer(ctx, { fundraiserId: f.id, userId: p.swMember.id })).rejects.toThrow(ForbiddenError);
      await expect(updateSeasonGoal(ctx, { goal: "1000" })).rejects.toThrow(ForbiddenError);
    }
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ name: f.name, raisedAmount: 0 });
    expect(await t.db.fundraiserVolunteer.count({ where: { fundraiserId: f.id } })).toBe(1);
  });

  it("shows everyone the page, with the edit tools only for managers", async () => {
    const f = await makeFundraiser();
    for (const who of ["swMember", "buildMember", "bizMember", "captain"] as const) {
      const page = await getFundraisingPage(p[who], { today: TEST_TODAY }, t.db);
      const item = page.current.find((x) => x.id === f.id);
      expect(item, who).toBeDefined();
      const manage = who === "bizMember" || who === "captain";
      expect(page.canManage, who).toBe(manage);
      expect(item!.canManage, who).toBe(manage);
      expect(item!.canVolunteer, who).toBe(true);
    }
    const detail = await getFundraiser(p.buildMember, f.id, { today: TEST_TODAY }, t.db);
    expect(detail).toMatchObject({ id: f.id, canManage: false, canVolunteer: true, createdBy: { id: p.bizLead.id } });
    expect(await getFundraiser(p.buildMember, "missing", { today: TEST_TODAY }, t.db)).toBeNull();
  });
});

describe("fundraiser fields", () => {
  const ctx = () => ctxFor(p.bizMember);

  it("requires a name and keeps it within the limit", async () => {
    expect(await fieldError(createFundraiser(ctx(), validInput({ name: "  " })), "name")).toBe("Name is required.");
    expect(await fieldError(createFundraiser(ctx(), validInput({ name: "x".repeat(121) })), "name")).toMatch(/at most 120/);
  });

  it("reads dollar amounts like people type them", async () => {
    const { id } = await createFundraiser(ctx(), validInput({ goalAmount: "1.5k", raisedAmount: "$1,250.40" }));
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id } })).toMatchObject({ goalAmount: 1500, raisedAmount: 1250 });
    const noGoal = await createFundraiser(ctx(), validInput({ goalAmount: "", raisedAmount: "" }));
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id: noGoal.id } })).toMatchObject({ goalAmount: null, raisedAmount: 0 });
    expect(await fieldError(createFundraiser(ctx(), validInput({ goalAmount: "0" })), "goalAmount")).toBe(
      "Set a goal above $0, or leave it empty.",
    );
    expect(await fieldError(createFundraiser(ctx(), validInput({ goalAmount: "lots" })), "goalAmount")).toMatch(/dollars/);
    expect(await fieldError(createFundraiser(ctx(), validInput({ raisedAmount: "-20" })), "raisedAmount")).toBe("The amount can't be negative.");
  });

  it("wants the end date on or after the start date", async () => {
    expect(
      await fieldError(createFundraiser(ctx(), validInput({ startsOn: "2026-10-10", endsOn: "2026-10-09" })), "endsOn"),
    ).toBe("The end date can't be before the start date.");
    expect(await fieldError(createFundraiser(ctx(), validInput({ startsOn: "2026-02-30" })), "startsOn")).toBe("Pick a valid date.");
    const { id } = await createFundraiser(ctx(), validInput({ startsOn: "2026-10-10", endsOn: "2026-10-10" }));
    const row = await t.db.fundraiser.findUniqueOrThrow({ where: { id } });
    expect(row.startsOn).toEqual(dateOnlyToDb("2026-10-10"));
    expect(row.endsOn).toEqual(dateOnlyToDb("2026-10-10"));
  });

  it("catches a year typo: dates more than 5 years back or 2 years ahead", async () => {
    // A desktop date field turns a two-digit year into 0026.
    expect(await fieldError(createFundraiser(ctx(), validInput({ startsOn: "0026-10-03" })), "startsOn")).toBe(FUNDRAISER_DATE_TOO_EARLY);
    expect(FUNDRAISER_DATE_TOO_EARLY).toBe("That date is more than 5 years ago. Check the year.");
    // Postgres can't store year 0: refused with a field error, not a crash.
    expect(await fieldError(createFundraiser(ctx(), validInput({ startsOn: "0000-01-01" })), "startsOn")).toBe(FUNDRAISER_DATE_TOO_EARLY);
    expect(await fieldError(createFundraiser(ctx(), validInput({ startsOn: "2026-10-01", endsOn: "9999-12-31" })), "endsOn")).toBe(
      FUNDRAISER_DATE_TOO_LATE,
    );
    expect(await fieldError(createFundraiser(ctx(), validInput({ startsOn: addDays(TEST_TODAY, 2 * 365 + 1) })), "startsOn")).toBe(
      FUNDRAISER_DATE_TOO_LATE,
    );
    // The edges are fine (an old fundraiser can be recorded).
    await createFundraiser(ctx(), validInput({ status: "DONE", startsOn: addDays(TEST_TODAY, -5 * 365), endsOn: addDays(TEST_TODAY, -5 * 365) }));
    await createFundraiser(ctx(), validInput({ startsOn: addDays(TEST_TODAY, 2 * 365) }));
    expect(await t.db.fundraiser.count({ where: { startsOn: { lt: dateOnlyToDb("1000-01-01") } } })).toBe(0);
  });

  it("lets an edit keep a date that's out of range now, but not change to one", async () => {
    const f = await makeFundraiser({ status: "DONE", starts: -6 * 365, ends: -6 * 365 + 2 });
    const kept = { startsOn: addDays(TEST_TODAY, -6 * 365), endsOn: addDays(TEST_TODAY, -6 * 365 + 2) };
    await updateFundraiser(ctx(), { ...validInput({ status: "DONE", name: "Old but kept", ...kept }), fundraiserId: f.id });
    expect((await t.db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).name).toBe("Old but kept");
    expect(
      await fieldError(updateFundraiser(ctx(), { ...validInput({ ...kept, endsOn: addDays(kept.endsOn, 1) }), fundraiserId: f.id }), "endsOn"),
    ).toBe(FUNDRAISER_DATE_TOO_EARLY);
  });

  it("shows every problem at once, the dates' order included", async () => {
    const err = await createFundraiser(ctx(), validInput({ goalAmount: "abc", startsOn: "2026-10-10", endsOn: "2026-10-08", volunteerLimit: "0" })).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    const { fieldErrors, userMessage } = err as ValidationError;
    expect(Object.keys(fieldErrors).sort()).toEqual(["endsOn", "goalAmount", "volunteerLimit"]);
    expect(fieldErrors.endsOn).toBe("The end date can't be before the start date.");
    expect(userMessage).toBe("Please fix the highlighted fields.");
    // A bad start date is its own problem, not an order problem.
    expect(await fieldError(createFundraiser(ctx(), validInput({ startsOn: "2026-02-30", endsOn: "2026-10-08" })), "endsOn")).toBeUndefined();
  });

  it("only takes http(s) links, adding https:// to a bare address", async () => {
    const { id } = await createFundraiser(ctx(), validInput({ link: "gofundme.example.com/huskyteers" }));
    expect((await t.db.fundraiser.findUniqueOrThrow({ where: { id } })).link).toBe("https://gofundme.example.com/huskyteers");
    for (const bad of ["javascript:alert(1)", "ftp://files.example.com/x", "not a link"]) {
      expect(await fieldError(createFundraiser(ctx(), validInput({ link: bad })), "link"), bad).toBe(
        "Enter a web link, like https://example.com/donate",
      );
    }
  });

  it("checks the spots limit, kind, and status", async () => {
    for (const bad of ["0", "201", "2.5", "-1", "lots"]) {
      expect(await fieldError(createFundraiser(ctx(), validInput({ volunteerLimit: bad })), "volunteerLimit"), bad).toBe(
        "Enter a number from 1 to 200, or leave it empty for no limit.",
      );
    }
    const unlimited = await createFundraiser(ctx(), validInput({ volunteerLimit: "" }));
    expect((await t.db.fundraiser.findUniqueOrThrow({ where: { id: unlimited.id } })).volunteerLimit).toBeNull();
    expect(await fieldError(createFundraiser(ctx(), validInput({ kind: "RAFFLE" })), "kind")).toBeDefined();
    expect(await fieldError(createFundraiser(ctx(), validInput({ status: "SOMEDAY" })), "status")).toBeDefined();
    const defaults = await createFundraiser(ctx(), validInput({ kind: "", status: "" }));
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id: defaults.id } })).toMatchObject({ kind: "EVENT", status: "PLANNING" });
  });

  it("needs an active person as the lead, but an edit can keep a lead who has left", async () => {
    const leaving = await makeUser(t.db, { role: "MEMBER", subteam: "BUSINESS", name: "Leaving Soon" });
    for (const bad of [p.pendingBiz.id, p.disabledSw.id, "missing"]) {
      expect(await fieldError(createFundraiser(ctx(), validInput({ leadId: bad })), "leadId")).toBe("Pick someone who's active on the team.");
    }
    const { id } = await createFundraiser(ctx(), validInput({ leadId: leaving.id }));
    await t.db.user.update({ where: { id: leaving.id }, data: { status: "DISABLED" } });
    await updateFundraiser(ctx(), { ...validInput({ leadId: leaving.id, name: "Still led by them" }), fundraiserId: id });
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id } })).toMatchObject({ leadId: leaving.id, name: "Still led by them" });
    // Switching to someone else who isn't active is refused.
    expect(await fieldError(updateFundraiser(ctx(), { ...validInput({ leadId: p.disabledBiz.id }), fundraiserId: id }), "leadId")).toBeDefined();
  });

  it("doesn't count helpers whose account was disabled while the fundraiser is open", async () => {
    const leaver = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Left The Team" });
    const f = await makeFundraiser({ limit: 1, helpers: [leaver] });
    await t.db.user.update({ where: { id: leaver.id }, data: { status: "DISABLED" } });

    const before = await getFundraiser(p.swMember, f.id, { today: TEST_TODAY }, t.db);
    expect(before).toMatchObject({ volunteerCount: 0, spotsLeft: 1, canVolunteer: true, helpers: [], volunteers: [] });
    await volunteer(ctxFor(p.swMember), { fundraiserId: f.id });
    const after = await getFundraiser(p.buildMember, f.id, { today: TEST_TODAY }, t.db);
    expect(after!.helpers.map((h) => h.name)).toEqual(["Maya Software"]);
    expect(after).toMatchObject({ volunteerCount: 1, spotsLeft: 0, canVolunteer: false });
    await expect(volunteer(ctxFor(p.buildMember), { fundraiserId: f.id })).rejects.toThrow("The only spot is taken.");
    // The edit's spots check counts the same way.
    await updateFundraiser(ctx(), { ...validInput({ volunteerLimit: "1" }), fundraiserId: f.id });

    // Once it's over, the list shows everyone who signed up.
    await t.db.fundraiser.update({ where: { id: f.id }, data: { status: "DONE" } });
    const done = await getFundraiser(p.buildMember, f.id, { today: TEST_TODAY }, t.db);
    expect(done!.helpers.map((h) => h.name)).toEqual(["Left The Team", "Maya Software"]);
  });

  it("won't set fewer spots than people already signed up", async () => {
    const f = await makeFundraiser({ limit: 5, helpers: [crowd[0], crowd[1], crowd[2]] });
    expect(await fieldError(updateFundraiser(ctx(), { ...validInput({ volunteerLimit: "2" }), fundraiserId: f.id }), "volunteerLimit")).toBe(
      "3 people already signed up. Set at least 3 spots, or take someone off the list first.",
    );
    await updateFundraiser(ctx(), { ...validInput({ volunteerLimit: "3" }), fundraiserId: f.id });
    expect((await t.db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).volunteerLimit).toBe(3);
  });

  it("keeps a newer amount raised when an open edit form leaves the amount as it loaded it", async () => {
    const f = await makeFundraiser({ raised: 100 });
    // The form was opened at $100; meanwhile someone used the quick box.
    await updateRaisedAmount(ctxFor(p.bizLead), { fundraiserId: f.id, raisedAmount: "300" });
    await updateFundraiser(ctx(), {
      ...validInput({ name: "Renamed while the amount changed", raisedAmount: "100" }),
      fundraiserId: f.id,
      loadedRaisedAmount: "100",
    });
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      name: "Renamed while the amount changed",
      raisedAmount: 300,
    });
  });

  it("refuses to overwrite a newer amount raised with a different typed one, until it's saved again", async () => {
    const f = await makeFundraiser({ raised: 100, limit: 6 });
    await updateRaisedAmount(ctxFor(p.bizLead), { fundraiserId: f.id, raisedAmount: "300" });
    const stale = { ...validInput({ name: "Not saved", raisedAmount: "150" }), fundraiserId: f.id, loadedRaisedAmount: "100" };
    expect(await fieldError(updateFundraiser(ctx(), stale), "raisedAmount")).toBe(raisedChangedMessage(300));
    expect(raisedChangedMessage(300)).toBe("The amount raised was changed to $300 while you were editing. Save again to replace it with yours.");
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ name: f.name, raisedAmount: 300 });
    // The page reloads the form's copy ($300), so saving again replaces it.
    await updateFundraiser(ctx(), { ...stale, loadedRaisedAmount: "300" });
    expect(await t.db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({ name: "Not saved", raisedAmount: 150 });
    // Typing the same amount someone else just saved isn't a conflict; without a loaded amount the typed one is saved.
    await updateRaisedAmount(ctxFor(p.bizLead), { fundraiserId: f.id, raisedAmount: "500" });
    await updateFundraiser(ctx(), { ...validInput({ raisedAmount: "500" }), fundraiserId: f.id, loadedRaisedAmount: "150" });
    await updateFundraiser(ctx(), { ...validInput({ raisedAmount: "40" }), fundraiserId: f.id });
    expect((await t.db.fundraiser.findUniqueOrThrow({ where: { id: f.id } })).raisedAmount).toBe(40);
  });

  it("handles missing fundraisers", async () => {
    await expect(updateFundraiser(ctx(), { ...validInput(), fundraiserId: "missing" })).rejects.toThrow(NotFoundError);
    await expect(deleteFundraiser(ctx(), { fundraiserId: "missing" })).rejects.toThrow(NotFoundError);
    await expect(updateRaisedAmount(ctx(), { fundraiserId: "missing", raisedAmount: "4" })).rejects.toThrow(NotFoundError);
    await expect(updateRaisedAmount(ctx(), { fundraiserId: "x", raisedAmount: "" })).rejects.toThrow(ValidationError);
  });

  it("removing a fundraiser removes its helper list", async () => {
    const f = await makeFundraiser({ helpers: [crowd[3], crowd[4]] });
    await deleteFundraiser(ctx(), { fundraiserId: f.id });
    expect(await t.db.fundraiserVolunteer.count({ where: { fundraiserId: f.id } })).toBe(0);
  });
});

describe("helping", () => {
  it("lets any active member sign up and leave again", async () => {
    const f = await makeFundraiser({ limit: 4 });
    for (const who of [p.swMember, p.buildMember, p.bizMember, p.captain]) await volunteer(ctxFor(who), { fundraiserId: f.id });
    const page = await getFundraisingPage(p.swMember, { today: TEST_TODAY }, t.db);
    const item = page.current.find((x) => x.id === f.id)!;
    expect(item.volunteers.map((v) => v.name)).toEqual(["Maya Software", "Ethan Build", "Gwen Business", "Casey Captain"]);
    expect(item).toMatchObject({ isVolunteer: true, canLeave: true, canVolunteer: false, spotsLeft: 0, volunteerCount: 4 });
    // Full: someone else sees no "I'll help".
    const other = (await getFundraisingPage(crowd[5], { today: TEST_TODAY }, t.db)).current.find((x) => x.id === f.id)!;
    expect(other).toMatchObject({ canVolunteer: false, canLeave: false, isVolunteer: false });
    await expect(volunteer(ctxFor(crowd[5]), { fundraiserId: f.id })).rejects.toThrow("All 4 spots are taken.");

    await unvolunteer(ctxFor(p.swMember), { fundraiserId: f.id });
    await expect(unvolunteer(ctxFor(p.swMember), { fundraiserId: f.id })).rejects.toThrow(NotFoundError);
    await volunteer(ctxFor(crowd[5]), { fundraiserId: f.id });
    expect(await t.db.fundraiserVolunteer.count({ where: { fundraiserId: f.id } })).toBe(4);
  });

  it("won't sign someone up twice", async () => {
    const f = await makeFundraiser();
    await volunteer(ctxFor(p.buildMember), { fundraiserId: f.id });
    await expect(volunteer(ctxFor(p.buildMember), { fundraiserId: f.id })).rejects.toThrow("You're already helping with this one.");
  });

  it("gives the last spot to exactly one of several people racing for it", async () => {
    const f = await makeFundraiser({ limit: 3, helpers: [crowd[0], crowd[1]] });
    const racers = crowd.slice(2, 8);
    const results = await Promise.allSettled(racers.map((who) => volunteer(ctxFor(who), { fundraiserId: f.id })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(ConflictError);
        expect((r.reason as ConflictError).userMessage).toBe(fundraiserFullMessage(3));
      }
    }
    expect(await t.db.fundraiserVolunteer.count({ where: { fundraiserId: f.id } })).toBe(3);
  });

  it("closes the helper list once a fundraiser is done, cancelled, or its last day has passed", async () => {
    const cases: [Parameters<typeof makeFundraiser>[0], string | null][] = [
      [{ status: "DONE" }, "This fundraiser is over."],
      [{ status: "CANCELLED" }, "This fundraiser was cancelled."],
      [{ status: "ACTIVE", starts: -3, ends: -1 }, "This fundraiser is over."],
      [{ status: "UPCOMING", starts: -1, ends: null }, "This fundraiser is over."], // one-day, yesterday
      [{ status: "ACTIVE", starts: -3, ends: 0 }, null], // last day is today
      [{ status: "PLANNING", starts: null, ends: null }, null], // no dates yet
    ];
    for (const [opts, closed] of cases) {
      const f = await makeFundraiser({ ...opts, helpers: [p.bizMember] });
      const label = JSON.stringify(opts);
      if (closed) {
        await expect(volunteer(ctxFor(p.swMember), { fundraiserId: f.id }), label).rejects.toThrow(closed);
        await expect(unvolunteer(ctxFor(p.bizMember), { fundraiserId: f.id }), label).rejects.toThrow(ConflictError);
        expect(await t.db.fundraiserVolunteer.count({ where: { fundraiserId: f.id } }), label).toBe(1);
        const item = await getFundraiser(p.bizMember, f.id, { today: TEST_TODAY }, t.db);
        expect(item, label).toMatchObject({ closedReason: closed, canLeave: false, canVolunteer: false, isVolunteer: true });
      } else {
        await volunteer(ctxFor(p.swMember), { fundraiserId: f.id });
        await unvolunteer(ctxFor(p.bizMember), { fundraiserId: f.id });
        expect((await t.db.fundraiserVolunteer.findMany({ where: { fundraiserId: f.id } })).map((v) => v.userId), label).toEqual([p.swMember.id]);
      }
    }
  });

  it("marks open fundraisers whose dates have passed", async () => {
    const f = await makeFundraiser({ status: "UPCOMING", starts: -2 });
    expect(await getFundraiser(p.bizMember, f.id, { today: TEST_TODAY }, t.db)).toMatchObject({ datesPassed: true, canVolunteer: false });
    const done = await makeFundraiser({ status: "DONE", starts: -2 });
    expect(await getFundraiser(p.bizMember, done.id, { today: TEST_TODAY }, t.db)).toMatchObject({ datesPassed: false });
    const open = await makeFundraiser({ status: "UPCOMING", starts: 0 });
    expect(await getFundraiser(p.bizMember, open.id, { today: TEST_TODAY }, t.db)).toMatchObject({ datesPassed: false, canVolunteer: true });
  });

  it("lets managers take anyone off the list, even after it's over", async () => {
    const f = await makeFundraiser({ status: "DONE", helpers: [p.swMember, p.buildMember] });
    await expect(removeVolunteer(ctxFor(p.bizMember), { fundraiserId: f.id, userId: p.swMember.id })).resolves.toEqual({ name: "Maya Software" });
    await expect(removeVolunteer(ctxFor(p.bizMember), { fundraiserId: f.id, userId: p.swMember.id })).rejects.toThrow(NotFoundError);
    expect((await t.db.fundraiserVolunteer.findMany({ where: { fundraiserId: f.id } })).map((v) => v.userId)).toEqual([p.buildMember.id]);
  });

  it("refuses inactive accounts, missing fundraisers, and bad input", async () => {
    const f = await makeFundraiser();
    await expect(volunteer(ctxFor(p.disabledSw), { fundraiserId: f.id })).rejects.toThrow(ForbiddenError);
    await expect(volunteer(ctxFor(p.pendingBiz), { fundraiserId: f.id })).rejects.toThrow(ForbiddenError);
    await expect(unvolunteer(ctxFor(p.disabledSw), { fundraiserId: f.id })).rejects.toThrow(ForbiddenError);
    await expect(volunteer(ctxFor(p.swMember), { fundraiserId: "missing" })).rejects.toThrow(NotFoundError);
    await expect(unvolunteer(ctxFor(p.swMember), { fundraiserId: "missing" })).rejects.toThrow(NotFoundError);
    await expect(volunteer(ctxFor(p.swMember), {})).rejects.toThrow(ValidationError);
  });

  it("is rate limited per person", async () => {
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Busy Helper" });
    await t.db.rateLimit.create({
      data: { key: `fundraiser-help:${busy.id}`, count: FUNDRAISER_HELP_RATE_LIMIT.limit, windowStart: TEST_NOW },
    });
    const f = await makeFundraiser();
    await expect(volunteer(ctxFor(busy), { fundraiserId: f.id })).rejects.toThrow(RateLimitError);
  });
});

describe("the page and its totals", () => {
  let s: TestDb;
  let biz: Actor;
  let member: Actor;
  beforeAll(async () => {
    s = await createTestDb();
    biz = await makeUser(s.db, { role: "MEMBER", subteam: "BUSINESS", name: "Biz Person" });
    member = await makeUser(s.db, { role: "MEMBER", subteam: "BUILD", name: "Build Person" });
  });
  afterAll(async () => {
    await s?.drop();
  });

  async function add(name: string, status: FundraiserStatus, over: Record<string, unknown> = {}) {
    const { id } = await createFundraiser(contextFor(s.db, biz), validInput({ name, status, volunteerLimit: "", ...over }));
    return id;
  }

  it("starts empty", async () => {
    const page = await getFundraisingPage(member, { today: TEST_TODAY }, s.db);
    expect(page).toMatchObject({ current: [], planning: [], datesPassed: [], done: [], cancelled: [], doneTotal: 0, cancelledTotal: 0 });
    expect(page.summary).toEqual({
      raised: 0,
      goalSum: 0,
      seasonGoal: null,
      seasonStart: null,
      target: null,
      targetKind: null,
      upcomingCount: 0,
      helpingCount: 0,
    });
  });

  it("adds up money raised and goals (not cancelled ones), and groups the fundraisers", async () => {
    const later = await add("Restaurant night", "UPCOMING", { startsOn: addDays(TEST_TODAY, 20), goalAmount: "400", raisedAmount: "" });
    const soon = await add("Bake sale", "UPCOMING", { startsOn: addDays(TEST_TODAY, 2), goalAmount: "300", raisedAmount: "50" });
    const now = await add("Online drive", "ACTIVE", { kind: "ONLINE", startsOn: addDays(TEST_TODAY, -5), endsOn: addDays(TEST_TODAY, 10), goalAmount: "", raisedAmount: "700" });
    const planning = await add("Candy grams", "PLANNING", { startsOn: "", goalAmount: "200" });
    const oldDone = await add("Summer car wash", "DONE", { startsOn: addDays(TEST_TODAY, -60), goalAmount: "500", raisedAmount: "620" });
    const newDone = await add("Demo day", "DONE", { startsOn: addDays(TEST_TODAY, -10), goalAmount: "", raisedAmount: "80" });
    const cancelled = await add("Rained out", "CANCELLED", { startsOn: addDays(TEST_TODAY, -2), goalAmount: "1000", raisedAmount: "30" });
    const ended = await add("Forgot to close", "ACTIVE", { startsOn: addDays(TEST_TODAY, -4), endsOn: addDays(TEST_TODAY, -1), goalAmount: "", raisedAmount: "" });
    const staleUpcoming = await add("Still says upcoming", "UPCOMING", { startsOn: addDays(TEST_TODAY, -6), goalAmount: "", raisedAmount: "" });
    const stalePlan = await add("Plan that slipped", "PLANNING", { startsOn: addDays(TEST_TODAY, -3), goalAmount: "", raisedAmount: "" });
    await volunteer(contextFor(s.db, member), { fundraiserId: soon });
    await volunteer(contextFor(s.db, member), { fundraiserId: planning });

    const page = await getFundraisingPage(member, { today: TEST_TODAY }, s.db);
    // Happening now first, then upcoming soonest first; ones whose dates passed get their own group (most recent first).
    expect(page.current.map((f) => f.id)).toEqual([now, soon, later]);
    expect(page.datesPassed.map((f) => f.id)).toEqual([ended, stalePlan, staleUpcoming]);
    expect(page.datesPassed.find((f) => f.id === ended)).toMatchObject({ closedReason: "This fundraiser is over.", datesPassed: true, canVolunteer: false });
    expect(page.current.every((f) => !f.datesPassed)).toBe(true);
    // The section count and the summary's "coming up" follow the same rule.
    expect(page.summary.upcomingCount).toBe(page.current.length);
    expect(page.planning.map((f) => f.id)).toEqual([planning]);
    expect(page.done.map((f) => f.id)).toEqual([newDone, oldDone]);
    expect(page.cancelled.map((f) => f.id)).toEqual([cancelled]);
    expect(page.doneTotal).toBe(2);
    expect(page.cancelledTotal).toBe(1);

    expect(page.summary).toEqual({
      raised: 50 + 700 + 620 + 80,
      goalSum: 400 + 300 + 200 + 500,
      seasonGoal: null,
      seasonStart: null,
      target: 1400,
      targetKind: "goals",
      upcomingCount: 3, // restaurant night, bake sale, online drive — not the one that already ended
      helpingCount: 2,
    });
  });

  it("measures against the season goal once it's set, and back to the goals when cleared", async () => {
    const ctx = contextFor(s.db, biz);
    await expect(updateSeasonGoal(ctx, { goal: "$5,000" })).resolves.toEqual({ goal: 5000, seasonStart: null });
    let summary = await getFundraisingSummary(member, { today: TEST_TODAY }, s.db);
    expect(summary).toMatchObject({ seasonGoal: 5000, target: 5000, targetKind: "season", goalSum: 1400 });
    const note = await s.db.teamNote.findUniqueOrThrow({ where: { key: FUNDRAISING_SEASON_GOAL_KEY } });
    expect(note).toMatchObject({ body: "5000", updatedById: biz.id });

    expect(await fieldError(updateSeasonGoal(ctx, { goal: "0" }), "goal")).toBe("Set a goal above $0, or leave it empty.");
    expect(await fieldError(updateSeasonGoal(ctx, { goal: "a lot" }), "goal")).toMatch(/dollars/);
    await expect(updateSeasonGoal(contextFor(s.db, member), { goal: "9000" })).rejects.toThrow(ForbiddenError);

    await expect(updateSeasonGoal(ctx, { goal: "" })).resolves.toEqual({ goal: null, seasonStart: null });
    summary = await getFundraisingSummary(member, { today: TEST_TODAY }, s.db);
    expect(summary).toMatchObject({ seasonGoal: null, target: 1400, targetKind: "goals" });
  });

  it("counts only this season's fundraisers once a season start is set", async () => {
    const ctx = contextFor(s.db, biz);
    const seasonStart = addDays(TEST_TODAY, -30);
    await expect(updateSeasonGoal(ctx, { goal: "3000", seasonStart })).resolves.toEqual({ goal: 3000, seasonStart });
    expect((await s.db.teamNote.findUniqueOrThrow({ where: { key: FUNDRAISING_SEASON_START_KEY } })).body).toBe(seasonStart);
    // Out: "Summer car wash" (-60, $620 of $500) and the cancelled one. In: everything else, undated ones by when they were added.
    const summary = await getFundraisingSummary(member, { today: TEST_TODAY }, s.db);
    expect(summary).toMatchObject({ seasonStart, seasonGoal: 3000, target: 3000, raised: 50 + 700 + 80, goalSum: 400 + 300 + 200 });

    // A fundraiser that ended on the season's first day counts; one that ended the day before doesn't.
    await add("First day", "DONE", { startsOn: addDays(seasonStart, -3), endsOn: seasonStart, goalAmount: "", raisedAmount: "11" });
    await add("Day before", "DONE", { startsOn: addDays(seasonStart, -1), goalAmount: "", raisedAmount: "13" });
    expect((await getFundraisingSummary(member, { today: TEST_TODAY }, s.db)).raised).toBe(50 + 700 + 80 + 11);

    // A year typo is caught; every problem shows at once.
    expect(await fieldError(updateSeasonGoal(ctx, { goal: "3000", seasonStart: "0026-09-01" }), "seasonStart")).toBe(FUNDRAISER_DATE_TOO_EARLY);
    const both = await updateSeasonGoal(ctx, { goal: "0", seasonStart: "2026-02-30" }).then(
      () => null,
      (e: unknown) => e as ValidationError,
    );
    expect(Object.keys(both!.fieldErrors).sort()).toEqual(["goal", "seasonStart"]);

    // Clearing the start counts every fundraiser again (all-time).
    await expect(updateSeasonGoal(ctx, { goal: "3000", seasonStart: "" })).resolves.toEqual({ goal: 3000, seasonStart: null });
    expect(await getFundraisingSummary(member, { today: TEST_TODAY }, s.db)).toMatchObject({
      seasonStart: null,
      raised: 50 + 700 + 620 + 80 + 11 + 13,
    });
  });

  it("lists the most recently finished first, one-day fundraisers included", async () => {
    const oneDay = await add("One-day, 25 days ago", "DONE", { startsOn: addDays(TEST_TODAY, -25), endsOn: "" });
    const ended30 = await add("Ended 30 days ago", "DONE", { startsOn: addDays(TEST_TODAY, -45), endsOn: addDays(TEST_TODAY, -30) });
    const ended200 = await add("Ended 200 days ago", "DONE", { startsOn: addDays(TEST_TODAY, -210), endsOn: addDays(TEST_TODAY, -200) });
    const undated = await add("No dates", "DONE", { startsOn: "", endsOn: "" });
    const mine = new Set([oneDay, ended30, ended200, undated]);
    let page = await getFundraisingPage(member, { today: TEST_TODAY }, s.db);
    expect(page.done.map((f) => f.id).filter((id) => mine.has(id))).toEqual([oneDay, ended30, ended200, undated]);

    // With more than a page of older multi-day ones, the recent one-day one still makes the list.
    for (let i = 0; i < FUNDRAISERS_DONE_LIMIT + 1; i++) {
      await s.db.fundraiser.create({
        data: { name: `Old ${i}`, status: "DONE", startsOn: dateOnlyToDb(addDays(TEST_TODAY, -400 - i)), endsOn: dateOnlyToDb(addDays(TEST_TODAY, -300 - i)) },
      });
    }
    page = await getFundraisingPage(member, { today: TEST_TODAY }, s.db);
    expect(page.done).toHaveLength(FUNDRAISERS_DONE_LIMIT);
    expect(page.doneTotal).toBeGreaterThan(FUNDRAISERS_DONE_LIMIT);
    expect(page.done.map((f) => f.id)).toContain(oneDay);
    expect(page.done.map((f) => f.id)).not.toContain(undated);
    const lastDays = page.done.map((f) => f.endsOn ?? f.startsOn ?? "");
    expect(lastDays).toEqual([...lastDays].sort().reverse());
  });

  it("lists active people as possible leads, Business first", async () => {
    await makeUser(s.db, { role: "MEMBER", subteam: "SOFTWARE", status: "DISABLED", name: "Gone Person" });
    const groups = await getFundraiserLeadOptions(s.db);
    expect(groups.map((g) => g.label)).toEqual(["Business", "Build"]);
    expect(groups.flatMap((g) => g.options.map((o) => o.name))).toEqual(["Biz Person", "Build Person"]);
  });
});

describe("fundraising helpers", () => {
  it("works out when the helper list closes", () => {
    const at = (status: FundraiserStatus, startsOn: string | null, endsOn: string | null) =>
      fundraiserClosedReason({ status, startsOn, endsOn }, "2026-09-24");
    expect(at("UPCOMING", "2026-09-24", null)).toBeNull();
    expect(at("UPCOMING", "2026-09-23", null)).toBe("This fundraiser is over.");
    expect(at("ACTIVE", "2026-09-20", "2026-09-24")).toBeNull();
    expect(at("PLANNING", null, null)).toBeNull();
    expect(at("DONE", "2026-10-01", null)).toBe("This fundraiser is over.");
    expect(at("CANCELLED", null, null)).toBe("This fundraiser was cancelled.");
  });

  it("formats dates, spots, and progress", () => {
    expect(fundraiserDatesLabel({ startsOn: "2026-10-03", endsOn: null }, TEST_TODAY)).toBe("Sat, Oct 3");
    expect(fundraiserDatesLabel({ startsOn: "2026-10-03", endsOn: "2026-10-04" }, TEST_TODAY)).toBe("Sat, Oct 3 – Sun, Oct 4");
    expect(fundraiserDatesLabel({ startsOn: null, endsOn: "2026-10-30" }, TEST_TODAY)).toBe("Until Fri, Oct 30");
    expect(fundraiserDatesLabel({ startsOn: null, endsOn: null }, TEST_TODAY)).toBeNull();
    expect(helperSpotsLabel(2, 4, true)).toBe("2 of 4 spots taken · 2 left");
    expect(helperSpotsLabel(1, 1, true)).toBe("1 of 1 spot taken · full");
    expect(helperSpotsLabel(3, null, true)).toBe("3 helping · no limit");
    expect(helperSpotsLabel(0, null, false)).toBe("Nobody yet");
    expect(goalPercent(250, 1000)).toBe(25);
    // No floating-point rounding down: 29 / 100 * 100 is 28.999… in floating point.
    expect(goalPercent(29, 100)).toBe(29);
    expect(goalPercent(145, 500)).toBe(29);
    expect(goalPercent(285, 500)).toBe(57);
    expect(goalPercent(290, 500)).toBe(58);
    for (let goal = 1; goal <= 1000; goal++) {
      for (const raised of [0, 1, Math.floor(goal / 3), goal - 1, goal]) {
        expect(goalPercent(raised, goal)).toBe(Math.floor((raised * 100) / goal));
        if ((raised * 100) % goal === 0) expect(goalPercent(raised, goal)).toBe((raised * 100) / goal);
      }
    }
    expect(goalPercent(1500, 1000)).toBe(150);
    expect(goalPercent(10, null)).toBe(0);
    expect(parseSeasonGoal("5000")).toBe(5000);
    expect(parseSeasonGoal("")).toBeNull();
    expect(parseSeasonGoal("0")).toBeNull();
    expect(parseSeasonGoal("nope")).toBeNull();
    expect(parseSeasonStart("2026-09-01")).toBe("2026-09-01");
    expect(parseSeasonStart("")).toBeNull();
    expect(parseSeasonStart("2026-02-30")).toBeNull();
    expect(suggestedSeasonStart("2026-09-24")).toBe("2026-09-01");
    expect(suggestedSeasonStart("2027-03-10")).toBe("2026-09-01");
    expect(suggestedSeasonStart("2026-08-31")).toBe("2025-09-01");
  });
});
