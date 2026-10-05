import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import { formatDollars, formatDollarsCompact, parseDollars } from "@/lib/money";
import {
  DEFAULT_IMPORT_COLUMNS,
  type ExistingSponsor,
  headerField,
  parseLooseDate,
  parseSponsorshipSheet,
  parseStageText,
  planSponsorshipImport,
  SPONSORSHIP_IMPORT_MAX_COLUMNS,
  SPONSORSHIP_IMPORT_MAX_PASTED_ROWS,
  SPONSORSHIP_IMPORT_MAX_ROWS,
  SPONSORSHIP_IMPORT_TEXT_MAX,
} from "@/lib/sponsorship-import";
import {
  bulkRemoveMessage,
  bulkRemoveQuestion,
  listSponsorNames,
  matchOwner,
  mentionsPassword,
  parseSponsorshipFilter,
  SPONSORSHIP_BULK_REMOVE_MAX,
  selectUpTo,
  sponsorNameKey,
  withHttps,
} from "@/lib/sponsorships";
import { parseHttpUrl } from "@/lib/urls";
import { parseHttpUrl as parseHttpUrlFromResources } from "@/server/services/resources";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { canDeleteSponsorship, canUseSponsorships } from "@/server/permissions";
import {
  getSponsorship,
  getSponsorshipImportContext,
  getSponsorshipInfo,
  getSponsorshipOwnerOptions,
  listSponsorships,
  sponsorshipExists,
} from "@/server/queries/sponsorships";
import {
  createSponsorship,
  deleteSponsorship,
  deleteSponsorships,
  importSponsorships,
  SPONSORSHIP_CHANGED,
  SPONSORSHIP_IMPORTS_PER_HOUR,
  SPONSORSHIP_WRITES_LIMITED,
  SPONSORSHIP_WRITES_PER_HOUR,
  setSponsorshipStage,
  updateSponsorship,
  updateSponsorshipInfo,
} from "@/server/services/sponsorships";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

let t: TestDb;
let ava: Actor; // Business member
let daniel: Actor; // Business member
let amara: Actor; // Business leader
let maya: Actor; // Software member
let ethan: Actor; // Build member
let priya: Actor; // Software leader
let marcus: Actor; // Build leader
let jordan: Actor; // Captain
let elena: Actor; // Mentor
let david: Actor; // Teacher
let olivia: Actor; // Owner (a Build member with the Owner flag)
let pendingBiz: Actor;
let disabledBiz: Actor;
let pendingLeader: Actor;

beforeAll(async () => {
  t = await createTestDb();
  ava = await makeUser(t.db, { name: "Ava Thompson", role: "MEMBER", subteam: "BUSINESS" });
  daniel = await makeUser(t.db, { name: "Daniel Park", role: "MEMBER", subteam: "BUSINESS" });
  amara = await makeUser(t.db, { name: "Amara Okafor", role: "BUSINESS_LEADER" });
  maya = await makeUser(t.db, { name: "Maya Patel", role: "MEMBER", subteam: "SOFTWARE" });
  ethan = await makeUser(t.db, { name: "Ethan Chen", role: "MEMBER", subteam: "BUILD" });
  priya = await makeUser(t.db, { name: "Priya Raman", role: "SOFTWARE_LEADER" });
  marcus = await makeUser(t.db, { name: "Marcus Johnson", role: "BUILD_LEADER" });
  jordan = await makeUser(t.db, { name: "Jordan Lee", role: "CAPTAIN" });
  elena = await makeUser(t.db, { name: "Elena Petrova", role: "MENTOR" });
  david = await makeUser(t.db, { name: "David Kim", role: "TEACHER" });
  olivia = await makeUser(t.db, { name: "Olivia Stone", role: "MEMBER", subteam: "BUILD", isAdmin: true });
  pendingBiz = await makeUser(t.db, { name: "Pat Pending", role: "MEMBER", subteam: "BUSINESS", status: "PENDING" });
  disabledBiz = await makeUser(t.db, { name: "Dana Gone", role: "MEMBER", subteam: "BUSINESS", status: "DISABLED" });
  pendingLeader = await makeUser(t.db, { name: "Quinn Waiting", role: "BUSINESS_LEADER", status: "PENDING" });
});
afterAll(async () => {
  await t.drop();
});

const ctx = (actor: Actor) => contextFor(t.db, actor);

let seq = 0;
/** A sponsorship written straight to the DB (bypasses the service and its rate limit). */
async function makeSponsorship(data: Partial<Parameters<TestDb["db"]["sponsorship"]["create"]>[0]["data"]> = {}) {
  return t.db.sponsorship.create({ data: { name: `Sponsor ${++seq}`, ...data } as { name: string } });
}

async function row(id: string) {
  return t.db.sponsorship.findUniqueOrThrow({ where: { id } });
}

const day = (d: Date | null) => (d ? dbToDateOnly(d) : null);

let existingSeq = 0;
/** A sponsor "already here", as the import compares it. */
function existingSponsor(name: string, fields: Partial<ExistingSponsor> = {}): ExistingSponsor {
  return {
    id: `existing-${++existingSeq}`,
    name,
    stage: "NOT_STARTED",
    amountReceived: null,
    submittedOn: null,
    acceptedOn: null,
    closesOn: null,
    contactName: "",
    contactEmail: "",
    website: "",
    ...fields,
  };
}

// ── Permissions ───────────────────────────────────────────────────────────────

describe("who can use Sponsorships", () => {
  it("the Business subteam and staff; not other subteams' members", () => {
    for (const a of [ava, daniel, amara, priya, marcus, jordan, elena, david, olivia]) expect(canUseSponsorships(a), a.name).toBe(true);
    for (const a of [maya, ethan]) expect(canUseSponsorships(a), a.name).toBe(false);
  });

  it("everyone allowed can add a sponsor", async () => {
    for (const a of [ava, amara, priya, marcus, jordan, elena, david, olivia]) {
      const { id } = await createSponsorship(ctx(a), { name: `Added by ${a.name}` });
      expect((await row(id)).createdById).toBe(a.id);
    }
  });

  it("other subteams' members and accounts that aren't active are turned away everywhere", async () => {
    const s = await makeSponsorship();
    for (const a of [maya, ethan, pendingBiz, disabledBiz, pendingLeader]) {
      const c = ctx(a);
      await expect(createSponsorship(c, { name: "Nope" }), a.name).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateSponsorship(c, { sponsorshipId: s.id, name: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setSponsorshipStage(c, { sponsorshipId: s.id, stage: "SUBMITTED" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteSponsorship(c, { sponsorshipId: s.id })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(updateSponsorshipInfo(c, { body: "Nope" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(importSponsorships(c, { text: "Company\nNope", skipDuplicates: "on" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await row(s.id)).stage).toBe("NOT_STARTED");
    expect(await t.db.sponsorship.count({ where: { name: "Nope" } })).toBe(0);
  });

  it("queries return nothing for people without access", async () => {
    const s = await makeSponsorship();
    for (const a of [maya, ethan, pendingBiz, disabledBiz]) {
      expect(await listSponsorships(a, { filter: "all", today: TEST_TODAY }, t.db)).toBeNull();
      expect(await getSponsorship(a, s.id, t.db)).toBeNull();
      expect(await getSponsorshipInfo(a, t.db)).toBeNull();
      expect(await getSponsorshipImportContext(a, t.db)).toBeNull();
      expect(await getSponsorshipOwnerOptions(a, t.db)).toEqual({ business: [], staff: [] });
    }
    expect(await getSponsorship(ava, s.id, t.db)).toMatchObject({ id: s.id, name: s.name });
  });
});

// ── Validation ────────────────────────────────────────────────────────────────

describe("sponsorship fields", () => {
  it("saves every field, cleaned up", async () => {
    const { id } = await createSponsorship(ctx(ava), {
      name: "  Polymaker  ",
      website: "polymaker.com/sponsorship",
      contactName: "Jamie Rivera",
      contactEmail: " mailto:Jamie@Polymaker.example.com ",
      asking: "10 spools of PLA",
      amountReceived: "$1,000",
      stage: "DO_SOON",
      ownerId: daniel.id,
      closesOn: "2026-10-12",
      notes: "Ask for the education program.",
    });
    const s = await row(id);
    expect(s).toMatchObject({
      name: "Polymaker",
      website: "https://polymaker.com/sponsorship",
      contactName: "Jamie Rivera",
      contactEmail: "jamie@polymaker.example.com",
      asking: "10 spools of PLA",
      amountReceived: 1000,
      stage: "DO_SOON",
      ownerId: daniel.id,
      notes: "Ask for the education program.",
      createdById: ava.id,
    });
    expect(day(s.closesOn)).toBe("2026-10-12");
    expect(s.submittedOn).toBeNull();
  });

  it("empty optional fields are stored empty", async () => {
    const { id } = await createSponsorship(ctx(ava), {
      name: "Costco",
      website: "",
      contactEmail: "",
      amountReceived: "",
      ownerId: "",
      submittedOn: "",
    });
    expect(await row(id)).toMatchObject({ website: "", contactEmail: "", amountReceived: null, ownerId: null, stage: "NOT_STARTED", submittedOn: null });
  });

  it.each([
    ["$1,000", 1000],
    ["1000", 1000],
    ["1,000.00", 1000],
    [" $ 2,500 ", 2500],
    ["$1.5k", 1500],
    ["0", 0],
    ["99.50", 100],
  ])("reads the amount %j as %d dollars", async (amountReceived, expected) => {
    const { id } = await createSponsorship(ctx(amara), { name: "Amount check", amountReceived });
    expect((await row(id)).amountReceived).toBe(expected);
  });

  it.each([
    ["-500", "The amount can't be negative."],
    ["$-5", "The amount can't be negative."],
    ["lots", "Enter the amount in dollars, like 1,000 or $1,000."],
    ["1.000,50", "Enter the amount in dollars, like 1,000 or $1,000."],
    ["20,000,000", "Amounts can be up to $10,000,000."],
  ])("rejects the amount %j", async (amountReceived, message) => {
    const err = await createSponsorship(ctx(amara), { name: "Bad amount", amountReceived }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.amountReceived).toBe(message);
  });

  it("checks name, website, email, dates, and lengths", async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ name: "" }, "name", "Sponsor name is required."],
      [{ name: "x".repeat(LIMITS.sponsorNameMax + 1) }, "name", `Sponsor name must be at most ${LIMITS.sponsorNameMax} characters.`],
      [{ name: "A", website: "javascript:alert(1)" }, "website", "Enter the website's full address, like https://example.com"],
      [{ name: "A", website: "ftp://files.example.com" }, "website", "Enter the website's full address, like https://example.com"],
      [{ name: "A", website: "not a site" }, "website", "Enter the website's full address, like https://example.com"],
      [{ name: "A", contactEmail: "not-an-email" }, "contactEmail", "Enter a valid email address."],
      [{ name: "A", contactName: "x".repeat(LIMITS.nameMax + 1) }, "contactName", `Contact name must be at most ${LIMITS.nameMax} characters.`],
      [{ name: "A", asking: "x".repeat(LIMITS.sponsorAskingMax + 1) }, "asking", `What we're asking for must be at most ${LIMITS.sponsorAskingMax} characters.`],
      [{ name: "A", notes: "x".repeat(LIMITS.sponsorNotesMax + 1) }, "notes", `Notes must be at most ${LIMITS.sponsorNotesMax} characters.`],
      [{ name: "A", closesOn: "2026-02-30" }, "closesOn", "Pick a valid date."],
      [{ name: "A", submittedOn: "next week" }, "submittedOn", "Pick a valid date."],
      [{ name: "A", stage: "MAYBE" }, "stage", "Pick a stage."],
    ];
    for (const [input, field, message] of cases) {
      const err = await createSponsorship(ctx(jordan), input).catch((e) => e);
      expect(err, field).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors[field], JSON.stringify(input).slice(0, 60)).toBe(message);
    }
  });

  it("reports every bad field at once", async () => {
    const err = await createSponsorship(ctx(jordan), { name: "", contactEmail: "nope", amountReceived: "-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(Object.keys((err as ValidationError).fieldErrors).sort()).toEqual(["amountReceived", "contactEmail", "name"]);
    expect((err as ValidationError).userMessage).toBe("Please fix the highlighted fields.");
  });

  it("the person must be active and able to use Sponsorships", async () => {
    for (const person of [ava, amara, jordan, elena, priya, olivia]) {
      const { id } = await createSponsorship(ctx(amara), { name: `Owned by ${person.name}`, ownerId: person.id });
      expect((await row(id)).ownerId).toBe(person.id);
    }
    for (const person of [maya, ethan, pendingBiz, disabledBiz, pendingLeader]) {
      const err = await createSponsorship(ctx(amara), { name: "Bad owner", ownerId: person.id }).catch((e) => e);
      expect(err, person.name).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors.ownerId).toBe("Pick someone on the Business team or a leader.");
    }
    const err = await createSponsorship(ctx(amara), { name: "Bad owner", ownerId: "no-such-user" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
  });

  it("an edit may keep a person who can't be picked any more (but not switch to one)", async () => {
    const leaving = await makeUser(t.db, { name: "Lee Leaving", role: "MEMBER", subteam: "BUSINESS" });
    const { id } = await createSponsorship(ctx(amara), { name: "Kept owner", ownerId: leaving.id });
    await t.db.user.update({ where: { id: leaving.id }, data: { status: "DISABLED" } });
    await updateSponsorship(ctx(amara), { sponsorshipId: id, name: "Kept owner (renamed)", ownerId: leaving.id });
    expect(await row(id)).toMatchObject({ name: "Kept owner (renamed)", ownerId: leaving.id });
    const other = await createSponsorship(ctx(amara), { name: "Other" });
    await expect(updateSponsorship(ctx(amara), { sponsorshipId: other.id, name: "Other", ownerId: leaving.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("editing a missing sponsor is NotFound", async () => {
    await expect(updateSponsorship(ctx(ava), { sponsorshipId: "missing", name: "X" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setSponsorshipStage(ctx(ava), { sponsorshipId: "missing", stage: "SUBMITTED" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(deleteSponsorship(ctx(ava), { sponsorshipId: "missing" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("limits how many changes one person makes per hour", async () => {
    const busy = await makeUser(t.db, { name: "Busy Bee", role: "MEMBER", subteam: "BUSINESS" });
    await t.db.rateLimit.create({ data: { key: `sponsorship:${busy.id}`, count: SPONSORSHIP_WRITES_PER_HOUR, windowStart: TEST_NOW } });
    await expect(createSponsorship(ctx(busy), { name: "One too many" })).rejects.toBeInstanceOf(RateLimitError);
    const s = await makeSponsorship();
    await expect(setSponsorshipStage(ctx(busy), { sponsorshipId: s.id, stage: "DO_SOON" })).rejects.toBeInstanceOf(RateLimitError);
    // The info note shares the allowance, and says which one ran out (not "Too many attempts").
    await expect(updateSponsorshipInfo(ctx(busy), { body: "Team address" })).rejects.toThrow(SPONSORSHIP_WRITES_LIMITED);
  });
});

// ── Stages and their dates ────────────────────────────────────────────────────

describe("changing the stage", () => {
  it("Submitted fills the submitted date with today; Accepted fills the accepted date", async () => {
    const s = await makeSponsorship({ stage: "IN_PROGRESS" });
    const first = await setSponsorshipStage(ctx(ava), { sponsorshipId: s.id, stage: "SUBMITTED" });
    expect(first).toEqual({ id: s.id, stage: "SUBMITTED", filled: { field: "submittedOn", date: TEST_TODAY } });
    expect(day((await row(s.id)).submittedOn)).toBe(TEST_TODAY);

    const second = await setSponsorshipStage(ctx(ava), { sponsorshipId: s.id, stage: "ACCEPTED" });
    expect(second.filled).toEqual({ field: "acceptedOn", date: TEST_TODAY });
    const after = await row(s.id);
    expect(after.stage).toBe("ACCEPTED");
    expect(day(after.acceptedOn)).toBe(TEST_TODAY);
    expect(day(after.submittedOn)).toBe(TEST_TODAY);
  });

  it("uses today in the team's timezone", async () => {
    const s = await makeSponsorship();
    // 11:30 PM in Anaheim is already the next day in UTC.
    const late = { ...ctx(ava), now: new Date("2026-09-25T06:30:00Z") };
    await setSponsorshipStage(late, { sponsorshipId: s.id, stage: "SUBMITTED" });
    expect(day((await row(s.id)).submittedOn)).toBe("2026-09-24");
  });

  it("never overwrites a date someone entered", async () => {
    const s = await makeSponsorship({ submittedOn: dateOnlyToDb("2026-09-01"), acceptedOn: dateOnlyToDb("2026-09-10") });
    expect((await setSponsorshipStage(ctx(ava), { sponsorshipId: s.id, stage: "SUBMITTED" })).filled).toBeNull();
    expect((await setSponsorshipStage(ctx(ava), { sponsorshipId: s.id, stage: "ACCEPTED" })).filled).toBeNull();
    const after = await row(s.id);
    expect(day(after.submittedOn)).toBe("2026-09-01");
    expect(day(after.acceptedOn)).toBe("2026-09-10");
  });

  it("other stages leave the dates alone", async () => {
    const s = await makeSponsorship({ stage: "SUBMITTED" });
    for (const stage of ["DECLINED", "FINISHED", "DO_SOON", "NOT_STARTED", "IN_PROGRESS"] as const) {
      expect((await setSponsorshipStage(ctx(daniel), { sponsorshipId: s.id, stage })).filled).toBeNull();
    }
    const after = await row(s.id);
    expect(after).toMatchObject({ stage: "IN_PROGRESS", submittedOn: null, acceptedOn: null });
  });

  it("the edit form fills the date only when the stage moves there and the date is left empty", async () => {
    const { id } = await createSponsorship(ctx(ava), { name: "Form stages", stage: "IN_PROGRESS" });
    await updateSponsorship(ctx(ava), { sponsorshipId: id, name: "Form stages", stage: "SUBMITTED", submittedOn: "" });
    expect(day((await row(id)).submittedOn)).toBe(TEST_TODAY);

    // Still Submitted, date cleared on purpose: stays empty.
    await updateSponsorship(ctx(ava), { sponsorshipId: id, name: "Form stages", stage: "SUBMITTED", submittedOn: "" });
    expect((await row(id)).submittedOn).toBeNull();

    // Moving to Accepted with a date typed in keeps that date.
    await updateSponsorship(ctx(ava), { sponsorshipId: id, name: "Form stages", stage: "ACCEPTED", acceptedOn: "2026-09-20" });
    expect(day((await row(id)).acceptedOn)).toBe("2026-09-20");
  });

  it("adding a sponsor as Submitted fills today unless a date is given", async () => {
    const a = await createSponsorship(ctx(ava), { name: "Already sent", stage: "SUBMITTED" });
    expect(day((await row(a.id)).submittedOn)).toBe(TEST_TODAY);
    const b = await createSponsorship(ctx(ava), { name: "Sent a while ago", stage: "SUBMITTED", submittedOn: "2026-08-15" });
    expect(day((await row(b.id)).submittedOn)).toBe("2026-08-15");
  });
});

// ── Removing ──────────────────────────────────────────────────────────────────

describe("removing a sponsor", () => {
  it("whoever added it can remove it", async () => {
    const { id } = await createSponsorship(ctx(daniel), { name: "Mine to remove" });
    await deleteSponsorship(ctx(daniel), { sponsorshipId: id });
    expect(await t.db.sponsorship.findUnique({ where: { id } })).toBeNull();
  });

  it("other members and other subteams' leaders can't remove someone else's", async () => {
    const { id } = await createSponsorship(ctx(daniel), { name: "Daniel's" });
    for (const a of [ava, priya, marcus]) {
      expect(canDeleteSponsorship(a, { createdById: daniel.id }), a.name).toBe(false);
      await expect(deleteSponsorship(ctx(a), { sponsorshipId: id }), a.name).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await t.db.sponsorship.findUnique({ where: { id } })).not.toBeNull();
  });

  it("the Business leader, captain, mentors, teachers, and owners can remove any", async () => {
    for (const a of [amara, jordan, elena, david, olivia]) {
      const { id } = await createSponsorship(ctx(daniel), { name: `For ${a.name} to remove` });
      await deleteSponsorship(ctx(a), { sponsorshipId: id });
      expect(await t.db.sponsorship.findUnique({ where: { id } }), a.name).toBeNull();
    }
  });

  it("a sponsor whose creator left can be removed by the Business leader, not by members", async () => {
    const s = await makeSponsorship({ createdById: null });
    await expect(deleteSponsorship(ctx(ava), { sponsorshipId: s.id })).rejects.toBeInstanceOf(ForbiddenError);
    await deleteSponsorship(ctx(amara), { sponsorshipId: s.id });
  });

  it("the edit page says who can remove it", async () => {
    const { id } = await createSponsorship(ctx(daniel), { name: "Who can delete" });
    expect((await getSponsorship(daniel, id, t.db))?.canDelete).toBe(true);
    expect((await getSponsorship(ava, id, t.db))?.canDelete).toBe(false);
    expect((await getSponsorship(amara, id, t.db))?.canDelete).toBe(true);
    expect(await getSponsorship(ava, "missing", t.db)).toBeNull();
  });
});

// ── Removing several at once ──────────────────────────────────────────────────

describe("removing several sponsors at once", () => {
  beforeEach(async () => {
    await t.db.rateLimit.deleteMany();
  });

  let bulkSeq = 0;
  /** Sponsors named "<prefix> 1", "<prefix> 2"… added by `by` (null = someone who left). */
  async function sponsors(n: number, by: Actor | null, prefix = `Bulk ${++bulkSeq}`) {
    const made = [];
    for (let i = 1; i <= n; i++) made.push(await makeSponsorship({ name: `${prefix} ${i}`, createdById: by?.id ?? null }));
    return made;
  }
  const exists = async (ids: string[]) => t.db.sponsorship.count({ where: { id: { in: ids } } });
  const bulk = (actor: Actor, sponsorshipIds: unknown) => deleteSponsorships(ctx(actor), { sponsorshipIds });

  it("the Business leader, captain, mentors, teachers, and owners remove every one they pick, in the order picked", async () => {
    for (const a of [amara, jordan, elena, david, olivia]) {
      const [x, y] = await sponsors(2, daniel, `${a.name}'s pick`);
      const [orphan] = await sponsors(1, null, `${a.name}'s orphan`);
      const result = await bulk(a, [y.id, orphan.id, x.id]);
      expect(result, a.name).toEqual({ removed: [y.name, orphan.name, x.name], notAllowed: [], missing: 0 });
      expect(await exists([x.id, y.id, orphan.id]), a.name).toBe(0);
    }
  });

  it("anyone else removes only the ones they added; the rest are named back and kept", async () => {
    for (const a of [ava, priya, marcus]) {
      const mine = await sponsors(2, a);
      const [theirs] = await sponsors(1, daniel);
      const [orphan] = await sponsors(1, null);
      const result = await bulk(a, [theirs.id, mine[0].id, orphan.id, mine[1].id]);
      expect(result, a.name).toEqual({ removed: [mine[0].name, mine[1].name], notAllowed: [theirs.name, orphan.name], missing: 0 });
      expect(await exists(mine.map((s) => s.id)), a.name).toBe(0);
      expect(await exists([theirs.id, orphan.id]), a.name).toBe(2);
    }
  });

  it("nothing is removed when none of the picks are theirs", async () => {
    const theirs = await sponsors(2, daniel);
    expect(await bulk(ava, theirs.map((s) => s.id))).toEqual({ removed: [], notAllowed: theirs.map((s) => s.name), missing: 0 });
    expect(await exists(theirs.map((s) => s.id))).toBe(2);
  });

  it("other subteams' members and accounts that aren't active are turned away before anything is looked up", async () => {
    const picks = await sponsors(2, null);
    for (const a of [maya, ethan, pendingBiz, disabledBiz, pendingLeader]) {
      for (const input of [picks.map((s) => s.id), [], "x".repeat(500)]) {
        const err = await bulk(a, input).catch((e) => e);
        expect(err, a.name).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).userMessage).toBe("Sponsorships are for the Business team and leaders.");
      }
    }
    // Not even their own (added back when they could still use Sponsorships).
    const [own] = await sponsors(1, disabledBiz);
    await expect(bulk(disabledBiz, [own.id])).rejects.toBeInstanceOf(ForbiddenError);
    expect(await exists([...picks.map((s) => s.id), own.id])).toBe(3);
    expect(await t.db.rateLimit.count()).toBe(0);
  });

  it("ids that don't exist are only counted, never named", async () => {
    const [s] = await sponsors(1, ava);
    expect(await bulk(ava, ["missing-1", s.id, "missing-2"])).toEqual({ removed: [s.name], notAllowed: [], missing: 2 });
    expect(await bulk(amara, [s.id])).toEqual({ removed: [], notAllowed: [], missing: 1 });
  });

  it("takes 1 to 200 ids; repeats count once", async () => {
    for (const input of [[], "", undefined]) {
      const err = await bulk(amara, input).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).userMessage).toBe("Pick at least one sponsor to remove.");
    }
    const tooMany = Array.from({ length: SPONSORSHIP_BULK_REMOVE_MAX + 1 }, (_, i) => `id-${i}`);
    const err = await bulk(amara, tooMany).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toBe("You can remove up to 200 sponsors at once.");
    await expect(bulk(amara, ["x".repeat(65)])).rejects.toBeInstanceOf(ValidationError);
    expect(await t.db.rateLimit.count()).toBe(0);

    // 200 is fine (here, none of them exist).
    expect(await bulk(amara, tooMany.slice(0, SPONSORSHIP_BULK_REMOVE_MAX))).toEqual({ removed: [], notAllowed: [], missing: 200 });

    // Repeats (e.g. the same sponsor in the phone and desktop lists) count once, also toward the 200.
    const [a, b] = await sponsors(2, ava);
    const repeated = [a.id, a.id, b.id, ...Array.from({ length: SPONSORSHIP_BULK_REMOVE_MAX }, () => a.id)];
    expect(await bulk(ava, repeated)).toEqual({ removed: [a.name, b.name], notAllowed: [], missing: 0 });

    // One id on its own (a form with one box ticked) works too.
    const [c] = await sponsors(1, ava);
    expect(await bulk(ava, c.id)).toEqual({ removed: [c.name], notAllowed: [], missing: 0 });
  });

  it("removes their attached files too, and only theirs", async () => {
    const [picked, kept] = await sponsors(2, ava);
    const addFile = (sponsorshipId: string, filename: string) =>
      t.db.sponsorshipFile.create({
        data: { sponsorshipId, filename, contentType: "application/pdf", size: 5, data: Buffer.from("%PDF-"), uploadedById: daniel.id },
      });
    await addFile(picked.id, "form.pdf");
    await addFile(picked.id, "signed.pdf");
    await addFile(kept.id, "keep.pdf");
    expect(await bulk(ava, [picked.id])).toMatchObject({ removed: [picked.name] });
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: picked.id } })).toBe(0);
    expect(await t.db.sponsorshipFile.count({ where: { sponsorshipId: kept.id } })).toBe(1);
  });

  it("counts once toward the hourly allowance, however many it removes", async () => {
    const busy = await makeUser(t.db, { name: "Bulk Busy", role: "MEMBER", subteam: "BUSINESS" });
    const counter = async () => (await t.db.rateLimit.findUnique({ where: { key: `sponsorship:${busy.id}` } }))?.count;

    const first = await sponsors(5, busy);
    await bulk(busy, first.map((s) => s.id));
    expect(await counter()).toBe(1);

    await t.db.rateLimit.update({ where: { key: `sponsorship:${busy.id}` }, data: { count: SPONSORSHIP_WRITES_PER_HOUR - 1 } });
    const last = await sponsors(3, busy);
    expect((await bulk(busy, last.map((s) => s.id))).removed).toHaveLength(3);
    expect(await counter()).toBe(SPONSORSHIP_WRITES_PER_HOUR);

    const over = await sponsors(2, busy);
    await expect(bulk(busy, over.map((s) => s.id))).rejects.toBeInstanceOf(RateLimitError);
    expect(await exists(over.map((s) => s.id))).toBe(2);
  });

  it("the list says which sponsors the viewer can remove, and whether to offer Select", async () => {
    const newbie = await makeUser(t.db, { name: "Nell Newbie", role: "MEMBER", subteam: "BUSINESS" });
    await sponsors(1, daniel);
    const list = async (actor: Actor) => (await listSponsorships(actor, { filter: "all", today: TEST_TODAY }, t.db))!;

    expect((await list(newbie)).canBulkRemove).toBe(false);
    expect((await list(newbie)).items.every((i) => !i.canDelete)).toBe(true);
    const all = await list(amara);
    expect(all.canBulkRemove).toBe(true);
    expect(all.items.every((i) => i.canDelete)).toBe(true);

    const [own] = await sponsors(1, newbie);
    const after = await list(newbie);
    expect(after.canBulkRemove).toBe(true);
    expect(after.items.filter((i) => i.canDelete).map((i) => i.id)).toEqual([own.id]);
  });

  it("the list's “Sponsor added.” note isn't shown again for one that's been removed since", async () => {
    // (The page shows it for ?added=<id> only while sponsorshipExists; a removed one used to be announced as added.)
    const [kept, gone] = await sponsors(2, ava);
    await bulk(ava, [gone.id]);
    expect(await sponsorshipExists(ava, kept.id, t.db)).toBe(true);
    expect(await sponsorshipExists(ava, gone.id, t.db)).toBe(false);
    expect(await sponsorshipExists(ava, "", t.db)).toBe(false);
    expect(await sponsorshipExists(ava, "x".repeat(65), t.db)).toBe(false);
    // Nothing for people who can't use Sponsorships.
    for (const a of [maya, pendingBiz, disabledBiz]) expect(await sponsorshipExists(a, kept.id, t.db), a.name).toBe(false);
  });
});

describe("“Select all” in the list's Select mode", () => {
  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `s${i + from}`);

  it("ticks every removable sponsor shown when there are 200 or fewer", () => {
    expect([...selectUpTo(ids(12), new Set())]).toEqual(ids(12));
    expect([...selectUpTo(ids(200), new Set())]).toHaveLength(200);
    expect([...selectUpTo([], new Set())]).toEqual([]);
  });

  it("stops at 200, so the Remove it leads to is never refused", () => {
    const shown = ids(217);
    const picked = selectUpTo(shown, new Set());
    expect(picked.size).toBe(SPONSORSHIP_BULK_REMOVE_MAX);
    expect([...picked]).toEqual(shown.slice(0, 200));
    // Pressing it again doesn't add more.
    expect(selectUpTo(shown, picked).size).toBe(200);
  });

  it("keeps what's already ticked and fills up the rest in the list's order", () => {
    const shown = ids(217);
    const picked = selectUpTo(shown, new Set(["s217", "s216"]));
    expect(picked.size).toBe(200);
    expect(picked.has("s217") && picked.has("s216")).toBe(true);
    expect(picked.has("s198")).toBe(true);
    expect(picked.has("s199")).toBe(false);
    // Picks that aren't shown any more don't count toward the 200 (the list only sends what's shown).
    expect(selectUpTo(ids(3), new Set(["gone"]))).toEqual(new Set(["gone", "s1", "s2", "s3"]));
    expect([...selectUpTo(ids(3), new Set(["s2"]), 2)]).toEqual(["s2", "s1"]);
  });
});

describe("what removing several says", () => {
  it("lists up to 5 names, then how many more", () => {
    expect(listSponsorNames([])).toBe("");
    expect(listSponsorNames(["A"])).toBe("“A”");
    expect(listSponsorNames(["A", "B"])).toBe("“A” and “B”");
    expect(listSponsorNames(["A", "B", "C"])).toBe("“A”, “B” and “C”");
    expect(listSponsorNames(["A", "B", "C", "D", "E"])).toBe("“A”, “B”, “C”, “D” and “E”");
    expect(listSponsorNames(["A", "B", "C", "D", "E", "F", "G"])).toBe("“A”, “B”, “C”, “D”, “E” and 2 more");
  });

  it("asks before removing, mentioning attached files and that it can't be undone", () => {
    expect(bulkRemoveQuestion(["Acme"], 0)).toBe("Remove “Acme” from Sponsorships? Any attached files are removed too. This can't be undone.");
    expect(bulkRemoveQuestion(["Acme"], 1)).toBe("Remove “Acme” from Sponsorships? 1 attached file is removed too. This can't be undone.");
    const names = Array.from({ length: 12 }, (_, i) => `S${i + 1}`);
    expect(bulkRemoveQuestion(names, 3)).toBe(
      "Remove 12 sponsors? “S1”, “S2”, “S3”, “S4”, “S5” and 7 more. 3 attached files are removed too. This can't be undone.",
    );
  });

  it("says how many were removed, who to ask about the rest, and how many were already gone", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `S${i + 1}`);
    expect(bulkRemoveMessage({ removed: names(12), notAllowed: [], missing: 0 })).toBe("Removed 12 sponsors.");
    expect(bulkRemoveMessage({ removed: names(1), notAllowed: [], missing: 0 })).toBe("Removed 1 sponsor.");
    expect(bulkRemoveMessage({ removed: names(3), notAllowed: ["Acme", "Beta"], missing: 0 })).toBe(
      "Removed 3 sponsors. You can't remove “Acme” and “Beta” — ask the Business leader.",
    );
    expect(bulkRemoveMessage({ removed: names(2), notAllowed: [], missing: 1 })).toBe("Removed 2 sponsors. 1 was already removed.");
    expect(bulkRemoveMessage({ removed: [], notAllowed: ["Acme"], missing: 2 })).toBe(
      "You can't remove “Acme” — ask the Business leader. 2 were already removed.",
    );
    expect(bulkRemoveMessage({ removed: [], notAllowed: [], missing: 1 })).toBe("That sponsor was already removed.");
    expect(bulkRemoveMessage({ removed: [], notAllowed: [], missing: 3 })).toBe("Those sponsors were already removed.");
  });
});

// ── The list ──────────────────────────────────────────────────────────────────

describe("listSponsorships", () => {
  beforeAll(async () => {
    await t.db.sponsorship.deleteMany();
    const d = (n: number) => dateOnlyToDb(addDays(TEST_TODAY, n));
    await t.db.sponsorship.createMany({
      data: [
        { name: "zeta Corp", stage: "NOT_STARTED" },
        { name: "Alpha Inc", stage: "NOT_STARTED", closesOn: d(20), ownerId: ava.id },
        { name: "beta LLC", stage: "NOT_STARTED", closesOn: d(3) },
        { name: "Past Due Co", stage: "DO_SOON", closesOn: d(-2), ownerId: ava.id },
        { name: "Soon Co", stage: "IN_PROGRESS", closesOn: d(14) },
        { name: "Waiting Co", stage: "SUBMITTED", closesOn: d(5), submittedOn: d(-3), ownerId: daniel.id },
        { name: "Waiting Too", stage: "SUBMITTED" },
        { name: "Yes Co", stage: "ACCEPTED", amountReceived: 500, acceptedOn: d(-1) },
        { name: "Paid Co", stage: "FINISHED", amountReceived: 1500, ownerId: ava.id },
        { name: "No Co", stage: "DECLINED", closesOn: d(1) },
      ],
    });
  });

  const names = async (actor: Actor, filter: Parameters<typeof listSponsorships>[1]["filter"], mine = false) =>
    (await listSponsorships(actor, { filter, mine, today: TEST_TODAY }, t.db))!.items.map((i) => i.name);

  it("sorts by stage, then soonest deadline (none last), then name", async () => {
    expect(await names(ava, "all")).toEqual([
      "beta LLC",
      "Alpha Inc",
      "zeta Corp",
      "Past Due Co",
      "Soon Co",
      "Waiting Co",
      "Waiting Too",
      "Yes Co",
      "No Co",
      "Paid Co",
    ]);
  });

  it("filters by stage group and by person", async () => {
    expect(await names(ava, "todo")).toEqual(["beta LLC", "Alpha Inc", "zeta Corp", "Past Due Co", "Soon Co"]);
    expect(await names(ava, "submitted")).toEqual(["Waiting Co", "Waiting Too"]);
    expect(await names(ava, "accepted")).toEqual(["Yes Co"]);
    expect(await names(ava, "finished")).toEqual(["Paid Co"]);
    expect(await names(ava, "declined")).toEqual(["No Co"]);
    expect(await names(ava, "all", true)).toEqual(["Alpha Inc", "Past Due Co", "Paid Co"]);
    expect(await names(ava, "todo", true)).toEqual(["Alpha Inc", "Past Due Co"]);
    expect(await names(jordan, "all", true)).toEqual([]);
  });

  it("returns plain items with dates as days and the person's name", async () => {
    const list = await listSponsorships(ava, { filter: "submitted", today: TEST_TODAY }, t.db);
    expect(list!.items[0]).toMatchObject({
      name: "Waiting Co",
      stage: "SUBMITTED",
      owner: { id: daniel.id, name: "Daniel Park" },
      submittedOn: addDays(TEST_TODAY, -3),
      closesOn: addDays(TEST_TODAY, 5),
      acceptedOn: null,
      amountReceived: null,
    });
  });

  it("sums up the whole team, whatever the filters", async () => {
    const { summary } = (await listSponsorships(ava, { filter: "declined", mine: true, today: TEST_TODAY }, t.db))!;
    expect(summary).toEqual({
      total: 10,
      totalReceived: 2000,
      paying: 2,
      counts: { NOT_STARTED: 3, DO_SOON: 1, IN_PROGRESS: 1, SUBMITTED: 2, ACCEPTED: 1, DECLINED: 1, FINISHED: 1 },
      // beta LLC (3 days) and Soon Co (14 days); not past-due, not 20 days out, not submitted/declined ones.
      closingSoon: 2,
      waiting: 2,
      // The accepted and the finished one are thanked on the team website (the default) without a logo.
      logoNeeded: 2,
    });
  });

  it("never links to a website that isn't http(s)", async () => {
    const s = await makeSponsorship({ name: "Sneaky", website: "javascript:alert(1)" });
    expect((await getSponsorship(ava, s.id, t.db))!.website).toBe("");
    await t.db.sponsorship.delete({ where: { id: s.id } });
  });

  it("parses the filter from the URL", () => {
    expect(parseSponsorshipFilter("todo")).toBe("todo");
    expect(parseSponsorshipFilter(["declined"])).toBe("declined");
    expect(parseSponsorshipFilter("nope")).toBe("all");
    expect(parseSponsorshipFilter(undefined)).toBe("all");
  });
});

// ── People options ────────────────────────────────────────────────────────────

describe("getSponsorshipOwnerOptions", () => {
  it("lists active Business people first, then staff; never other members or inactive accounts", async () => {
    const { business, staff } = await getSponsorshipOwnerOptions(ava, t.db);
    const b = business.map((o) => o.name);
    const s = staff.map((o) => o.name);
    expect(b).toEqual(expect.arrayContaining(["Amara Okafor", "Ava Thompson", "Daniel Park"]));
    expect(s).toEqual(expect.arrayContaining(["David Kim", "Elena Petrova", "Jordan Lee", "Marcus Johnson", "Olivia Stone", "Priya Raman"]));
    for (const n of ["Maya Patel", "Ethan Chen", "Pat Pending", "Dana Gone", "Quinn Waiting"]) {
      expect([...b, ...s]).not.toContain(n);
    }
    expect(b).toEqual([...b].sort());
  });
});

// ── Info for applications ─────────────────────────────────────────────────────

describe("sponsorship info note", () => {
  it("starts empty, saves, and can be cleared", async () => {
    expect(await getSponsorshipInfo(ava, t.db)).toEqual({ body: "", updatedByName: null, updatedAt: null });
    await updateSponsorshipInfo(ctx(ava), { body: "  Team address: 123 Example Ave, Anaheim, CA\nPacket: https://docs.example.com/packet  " });
    const info = await getSponsorshipInfo(jordan, t.db);
    expect(info).toMatchObject({ body: "Team address: 123 Example Ave, Anaheim, CA\nPacket: https://docs.example.com/packet", updatedByName: "Ava Thompson" });
    await updateSponsorshipInfo(ctx(amara), { body: "" });
    expect(await getSponsorshipInfo(ava, t.db)).toMatchObject({ body: "", updatedByName: "Amara Okafor" });
    expect(await t.db.teamNote.count()).toBe(1);
  });

  it("has a length limit", async () => {
    const err = await updateSponsorshipInfo(ctx(ava), { body: "x".repeat(LIMITS.teamNoteMax + 1) }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.body).toBe(`Info must be at most ${LIMITS.teamNoteMax} characters.`);
  });

  it("a note typed up to the box's limit fits, although browsers send its line breaks as CRLF", async () => {
    await t.db.rateLimit.deleteMany();
    // What the textarea holds: exactly LIMITS.teamNoteMax characters, each line break counted once (its maxLength).
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: `.padEnd(99, "x"));
    const typed = lines.join("\n");
    expect(typed).toHaveLength(LIMITS.teamNoteMax - 1);
    // The form sends each line break as "\r\n": 99 characters more than the box counted.
    expect(await updateSponsorshipInfo(ctx(amara), { body: `${lines.join("\r\n")}!` })).toEqual({ mentionsPassword: false });
    const saved = (await getSponsorshipInfo(ava, t.db))?.body;
    expect(saved).toBe(`${typed}!`);
    expect(saved).toHaveLength(LIMITS.teamNoteMax);
    expect(saved).not.toContain("\r");

    // One character more is too long.
    const err = await updateSponsorshipInfo(ctx(amara), { body: `${lines.join("\r\n")}!!` }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.body).toBe(`Info must be at most ${LIMITS.teamNoteMax} characters.`);
    expect((await getSponsorshipInfo(ava, t.db))?.body).toBe(`${typed}!`);
  });

  it("saves text with a password in it anyway, and says it looks like one", async () => {
    await t.db.rateLimit.deleteMany();
    expect(await updateSponsorshipInfo(ctx(ava), { body: "Grant portal\nLogin: team@example.com\nPassword: hunter2" })).toEqual({
      mentionsPassword: true,
    });
    expect((await getSponsorshipInfo(ava, t.db))?.body).toBe("Grant portal\nLogin: team@example.com\nPassword: hunter2");
    expect(await updateSponsorshipInfo(ctx(ava), { body: "Passport photo for the grant: ask Amara" })).toEqual({ mentionsPassword: false });
    expect(await updateSponsorshipInfo(ctx(ava), { body: "" })).toEqual({ mentionsPassword: false });
  });
});

describe("mentionsPassword", () => {
  it.each([
    "Password: hunter2",
    "grant portal PASSWORD is in here",
    "wifi password hunter2",
    "Passwords: see below",
    "Door passcode 4821",
    "passwd=hunter2",
    "pwd: hunter2",
    "Portal PWD hunter2",
    "login/pwd hunter2",
    "pw: hunter2",
    "PW : hunter2",
    "Grant portal pw=hunter2",
    "team@example.com / pw: hunter2",
    "wifiPassword hunter2",
    "Pass: hunter2",
    "Grant portal user / pass: hunter2",
    "pass=hunter2",
    "P/W: hunter2",
    "pswd: hunter2",
    "Passwordless login, but the old password is hunter2",
  ])("flags %j", (text) => {
    expect(mentionsPassword(text)).toBe(true);
  });

  it.each([
    "",
    "Passport photo for the grant",
    "passports for the trip",
    "Bypass the front desk, go to room 12",
    "Pass the form to Amara",
    "Compass Robotics",
    "Powder coating sponsor",
    "PW bags from the store",
    "https://docs.example.com/pwdx-list",
    "Team address: 123 Example Ave, Anaheim, CA\nTeam email: team@example.com\nGrant links: https://docs.example.com/grants",
    "upw: not a label",
    "spwd",
    "Passwordless login via the email link",
    "Bypass: use the side door",
    "Compass: north entrance",
    "Boarding pass for the trip",
    "Login pass the form to Amara",
    "éPwd",
    "Ünpw: x",
  ])("doesn't flag %j", (text) => {
    expect(mentionsPassword(text)).toBe(false);
  });
});

// ── Import: the pure parser ───────────────────────────────────────────────────

const GWEN_HEADER = "AMOUNT RECEIVED\tCOMPLETION STAGE\tBRAND/COMPANY\tEmail\tDATE ANNOUNCED\tDATE COMPLETED\tPERSON";

describe("parseSponsorshipSheet", () => {
  const parse = (text: string) => parseSponsorshipSheet(text, { today: TEST_TODAY });

  it("reads the Business team's sheet with its header row", () => {
    const result = parse(
      [
        GWEN_HEADER,
        "$500\tAccepted\tREV Robotics\tsponsors@rev.example.com\t9/20/2026\t9/1/2026\tAmara",
        "\tHaven't touched\tCostco\t\t\t\t",
        "\tWork in Progress\tBoeing\tstem@boeing.example.com\t\t\tLeila",
        "",
        "$1,200.00\tSubmitted\tHome Depot\t\t\t8/15/26\tAva",
      ].join("\n"),
    );
    expect(result.hasHeader).toBe(true);
    expect(result.columns).toEqual(["amountReceived", "stage", "name", "contactEmail", "acceptedOn", "submittedOn", "owner"]);
    expect(result.unnamedRows).toEqual([]);
    expect(result.rows.map((r) => [r.row, r.name, r.stage, r.amountReceived, r.ownerName])).toEqual([
      [2, "REV Robotics", "ACCEPTED", 500, "Amara"],
      [3, "Costco", "NOT_STARTED", null, ""],
      [4, "Boeing", "IN_PROGRESS", null, "Leila"],
      [6, "Home Depot", "SUBMITTED", 1200, "Ava"],
    ]);
    expect(result.rows[0]).toMatchObject({ contactEmail: "sponsors@rev.example.com", acceptedOn: "2026-09-20", submittedOn: "2026-09-01", warnings: [] });
    expect(result.rows[3].submittedOn).toBe("2026-08-15");
  });

  it("without a header row, reads columns in the Business team's order", () => {
    expect(DEFAULT_IMPORT_COLUMNS).toEqual(["amountReceived", "stage", "name", "contactEmail", "acceptedOn", "submittedOn", "owner"]);
    const result = parse("$250\tSubmitted\tPolymaker\tpartners@polymaker.example.com\t\t10/1/2026\tDaniel\n\tDo soon\tBambu Lab\t\t\t\t");
    expect(result.hasHeader).toBe(false);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ row: 1, name: "Polymaker", amountReceived: 250, stage: "SUBMITTED", submittedOn: "2026-10-01", ownerName: "Daniel" });
    expect(result.rows[1]).toMatchObject({ row: 2, name: "Bambu Lab", stage: "DO_SOON" });
  });

  it("matches other headers loosely, in any order, ignoring unknown columns", () => {
    const result = parse(
      [
        "Sponsor,Website,Contact person,Contact email,What we're hoping to receive,Status,Owner,Deadline,Heard back,Notes,Favorite color",
        "Polymaker,polymaker.com,Jamie Rivera,JAMIE@polymaker.example.com,10 spools,needs work,Ava,Oct 12,,Call first,green",
      ].join("\n"),
    );
    expect(result.hasHeader).toBe(true);
    expect(result.columns).toEqual([
      "name",
      "website",
      "contactName",
      "contactEmail",
      "asking",
      "stage",
      "owner",
      "closesOn",
      "acceptedOn",
      "notes",
      null,
    ]);
    expect(result.rows[0]).toMatchObject({
      name: "Polymaker",
      website: "https://polymaker.com",
      contactName: "Jamie Rivera",
      contactEmail: "jamie@polymaker.example.com",
      asking: "10 spools",
      stage: "IN_PROGRESS",
      ownerName: "Ava",
      closesOn: "2026-10-12",
      acceptedOn: null,
      notes: "Call first",
      warnings: [],
    });
  });

  it.each([
    ["AMOUNT RECEIVED", "amountReceived"],
    ["COMPLETION STAGE", "stage"],
    ["BRAND/COMPANY", "name"],
    ["E-mail", "contactEmail"],
    ["DATE ANNOUNCED", "acceptedOn"],
    ["DATE COMPLETED", "submittedOn"],
    ["Date closes", "closesOn"],
    ["Due", "closesOn"],
    ["PERSON", "owner"],
    ["Who", "owner"],
    ["Person of contact", "contactName"],
    ["Link", "website"],
    ["URL", "website"],
    ["Asking", "asking"],
    ["Request", "asking"],
    ["Received", "amountReceived"],
    ["Notes", "notes"],
    ["Company name", "name"],
    ["Sponsor website", "website"],
    ["Contact email", "contactEmail"],
    ["Shirt size", null],
  ])("header %j → %s", (cell, field) => {
    expect(headerField(cell)).toBe(field);
  });

  it.each([
    ["Haven't touched", "NOT_STARTED"],
    ["haven’t   started", "NOT_STARTED"],
    ["Not started", "NOT_STARTED"],
    ["", "NOT_STARTED"],
    ["Do soon", "DO_SOON"],
    ["DO SOON", "DO_SOON"],
    ["Work in Progress", "IN_PROGRESS"],
    ["in progress", "IN_PROGRESS"],
    ["Needs work", "IN_PROGRESS"],
    ["Submitted", "SUBMITTED"],
    ["sent", "SUBMITTED"],
    ["Accepted", "ACCEPTED"],
    ["approved", "ACCEPTED"],
    ["Yes", "ACCEPTED"],
    ["Declined", "DECLINED"],
    ["rejected", "DECLINED"],
    ["No", "DECLINED"],
    ["Finished", "FINISHED"],
    ["done", "FINISHED"],
    ["Received", "FINISHED"],
    ["Complete", "FINISHED"],
    ["Submitted 10/2", "SUBMITTED"],
    ["Declined (try again in spring)", "DECLINED"],
    ["banana", null],
  ])("stage %j → %s", (text, stage) => {
    expect(parseStageText(text)).toBe(stage);
  });

  it.each([
    ["2026-10-12", "2026-10-12"],
    ["10/12/2026", "2026-10-12"],
    ["10/12/26", "2026-10-12"],
    ["10-12-2026", "2026-10-12"],
    ["10/12", "2026-10-12"],
    ["October 12", "2026-10-12"],
    ["Oct 12", "2026-10-12"],
    ["oct. 12th", "2026-10-12"],
    ["Oct 12, 2027", "2027-10-12"],
    ["12 October 2026", "2026-10-12"],
    ["Mon, Oct 12", "2026-10-12"],
    ["10/12/2026 0:00:00", "2026-10-12"],
    // No year: the first such day on or after ~6 months before today (2026-09-24).
    ["Apr 3", "2026-04-03"],
    ["Mar 1", "2027-03-01"],
    ["Sep 1", "2026-09-01"],
    ["Feb 29", "2028-02-29"],
    ["Feb 30", null],
    ["13/1/2026", null],
    ["next week", null],
    ["", null],
  ])("date %j → %s", (text, expected) => {
    expect(parseLooseDate(text, TEST_TODAY)).toBe(expected);
  });

  it("handles quoted CSV cells with commas, quotes, and line breaks", () => {
    const result = parse('Company,Notes,Amount\n"Boeing, Inc.","Line one\nSaid ""yes"" on the call","$1,500"\nPolymaker,,');
    expect(result.rows.map((r) => [r.name, r.notes, r.amountReceived])).toEqual([
      ["Boeing, Inc.", 'Line one\nSaid "yes" on the call', 1500],
      ["Polymaker", "", null],
    ]);
  });

  it("handles quoted multi-line cells pasted from Google Sheets (tab-separated)", () => {
    const result = parse('Company\tNotes\tStage\r\nREV Robotics\t"Two lines\r\nof notes"\tSubmitted\r\n');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ name: "REV Robotics", notes: "Two lines\nof notes", stage: "SUBMITTED" });
  });

  it("a stray quote doesn't swallow the rest of the paste", () => {
    const result = parse('Company\tNotes\n"Best" Robotics\tok\nPolymaker\tfine');
    expect(result.rows.map((r) => r.name)).toEqual(['"Best" Robotics', "Polymaker"]);
  });

  it("warns about anything it couldn't read and keeps it in the notes", () => {
    const result = parse(
      [
        "Company\tStage\tEmail\tAmount received\tDate completed\tNotes",
        "Polymaker\tmaybe later\tcall Jamie\t10 spools\tsoon-ish\tKeep this",
      ].join("\n"),
    );
    const r = result.rows[0];
    expect(r.stage).toBe("NOT_STARTED");
    expect(r.contactEmail).toBe("");
    expect(r.amountReceived).toBeNull();
    expect(r.submittedOn).toBeNull();
    expect(r.warnings).toEqual([
      "Email “call Jamie” isn't an email address, so it went into the notes.",
      "Didn't recognize the stage “maybe later”, so it's set to Haven't started.",
      "Received “10 spools” isn't a dollar amount, so it went into the notes.",
      "Couldn't read the submitted date “soon-ish”, so it went into the notes.",
    ]);
    expect(r.notes).toBe("Keep this\nEmail: call Jamie\nStage: maybe later\nReceived: 10 spools\nSubmitted: soon-ish");
  });

  it("a link in the email column is the website; extra emails go to the notes", () => {
    const result = parse("Company\tEmail\nPolymaker\thttps://polymaker.com/edu\nBoeing\ta@boeing.example.com, b@boeing.example.com");
    expect(result.rows[0]).toMatchObject({ website: "https://polymaker.com/edu", contactEmail: "", warnings: [] });
    expect(result.rows[1]).toMatchObject({ contactEmail: "a@boeing.example.com", notes: "Other emails: b@boeing.example.com" });
  });

  it("skips blank rows and reports rows without a sponsor name", () => {
    const result = parse(`${GWEN_HEADER}\n\n\t\t\t\t\t\t\n$100\tFinished\t\t\t\t\t\nTOTAL\t\t\t\t\t\t\n\tSubmitted\tPolymaker\t\t\t\t`);
    expect(result.rows.map((r) => r.name)).toEqual(["Polymaker"]);
    expect(result.unnamedRows).toEqual([4, 5]);
  });

  it("a single column is a list of sponsor names (with or without a header)", () => {
    expect(parse("Polymaker\nBambu Lab\n").rows.map((r) => [r.name, r.stage])).toEqual([
      ["Polymaker", "NOT_STARTED"],
      ["Bambu Lab", "NOT_STARTED"],
    ]);
    const withHeader = parse("Company\nPolymaker");
    expect(withHeader.hasHeader).toBe(true);
    expect(withHeader.rows.map((r) => r.name)).toEqual(["Polymaker"]);
  });

  it("doesn't mistake a data row for a header", () => {
    const result = parse("\tSubmitted\tBoeing Grant\t\t\t\tAva\n\tAccepted\tSponsor Co\t\t\t\t");
    expect(result.hasHeader).toBe(false);
    expect(result.rows.map((r) => r.name)).toEqual(["Boeing Grant", "Sponsor Co"]);
  });
});

describe("import helpers", () => {
  it("parseDollars", () => {
    expect(parseDollars("$1,000")).toEqual({ ok: true, value: 1000 });
    expect(parseDollars("1,000.00")).toEqual({ ok: true, value: 1000 });
    expect(parseDollars("n/a")).toEqual({ ok: true, value: null });
    expect(parseDollars("-")).toEqual({ ok: true, value: null });
    expect(parseDollars("250 USD")).toEqual({ ok: true, value: 250 });
    expect(parseDollars("(500)")).toMatchObject({ ok: false });
    expect(parseDollars("1,00")).toMatchObject({ ok: false });
    expect(parseDollars(String(LIMITS.sponsorAmountMax))).toEqual({ ok: true, value: LIMITS.sponsorAmountMax });
  });

  it("formats dollars", () => {
    expect(formatDollars(1250)).toBe("$1,250");
    expect(formatDollarsCompact(9_500)).toBe("$9,500");
    expect(formatDollarsCompact(12_500)).toBe("$12.5K");
    expect(formatDollarsCompact(125_000)).toBe("$125K");
    expect(formatDollarsCompact(1_250_000)).toBe("$1.25M");
  });

  it("withHttps and sponsorNameKey", () => {
    expect(withHttps("polymaker.com")).toBe("https://polymaker.com");
    expect(withHttps("www.rev.example.com/sponsors?x=1")).toBe("https://www.rev.example.com/sponsors?x=1");
    expect(withHttps("http://a.example.com")).toBe("http://a.example.com");
    expect(withHttps("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(withHttps("not a site")).toBe("not a site");
    expect(sponsorNameKey("  REV   Robotics ")).toBe(sponsorNameKey("rev robotics"));
  });

  it("matchOwner: full name, unique first name, or first name + last initial", () => {
    const people = [
      { id: "1", name: "Ava Thompson" },
      { id: "2", name: "Daniel Park" },
      { id: "3", name: "Daniel Ortiz" },
      { id: "4", name: "Zoë Müller" },
    ];
    expect(matchOwner("ava", people)).toEqual({ kind: "match", owner: people[0], by: "first" });
    expect(matchOwner("AVA THOMPSON", people)).toEqual({ kind: "match", owner: people[0], by: "full" });
    expect(matchOwner("Daniel", people)).toEqual({ kind: "ambiguous" });
    expect(matchOwner("Daniel P.", people)).toEqual({ kind: "match", owner: people[1], by: "initial" });
    expect(matchOwner("zoe muller", people)).toEqual({ kind: "match", owner: people[3], by: "full" });
    expect(matchOwner("Bob", people)).toEqual({ kind: "none" });
    expect(matchOwner("", people)).toEqual({ kind: "none" });
  });

  it("planSponsorshipImport marks duplicates, matches people, and flags rows that can't be saved", () => {
    const plan = planSponsorshipImport(
      ["Company\tPerson\tNotes", "REV Robotics\tAva\t", "rev  robotics\t\t", "Polymaker\tBob\t", `${"x".repeat(121)}\t\t`].join("\n"),
      { today: TEST_TODAY, owners: [{ id: "a", name: "Ava Thompson" }], existing: [existingSponsor("POLYMAKER")], skipDuplicates: true },
    );
    expect(plan.rows.map((r) => [r.name.slice(0, 12), r.owner?.id ?? null, r.duplicate, r.errors.length])).toEqual([
      ["REV Robotics", "a", false, 0],
      ["rev  robotic", null, true, 0],
      ["Polymaker", null, true, 0],
      ["xxxxxxxxxxxx", null, false, 1],
    ]);
    expect(plan.rows[2].notes).toBe("Person: Bob");
    expect(plan.rows[2].warnings).toEqual(["“Bob” isn't anyone who can use this page, so no one is picked. The name went into the notes."]);
    expect(plan).toMatchObject({ toAdd: 2, duplicates: 2, rowsWithErrors: 1, tooMany: false });

    const keepAll = planSponsorshipImport("Company\nREV Robotics\nREV Robotics", {
      today: TEST_TODAY,
      owners: [],
      existing: [existingSponsor("REV Robotics")],
      skipDuplicates: false,
    });
    expect(keepAll).toMatchObject({ toAdd: 2, duplicates: 0 });
  });
});

// ── Import: the service ───────────────────────────────────────────────────────

describe("importSponsorships", () => {
  beforeEach(async () => {
    await t.db.sponsorship.deleteMany();
    await t.db.rateLimit.deleteMany();
  });

  it("imports pasted rows, matching people by name and keeping the sheet's dates", async () => {
    const text = [
      GWEN_HEADER,
      "$500\tAccepted\tREV Robotics\tsponsors@rev.example.com\t9/20/2026\t\tAmara",
      "\tSubmitted\tPolymaker\t\t\t\tava",
      "\tWork in progress\tBoeing\t\t\t\tBob Smith",
    ].join("\n");
    const result = await importSponsorships(ctx(ava), { text, skipDuplicates: "on" });
    expect(result).toEqual({ added: 3, updated: 0, skipped: 0 });
    const rows = await t.db.sponsorship.findMany({ orderBy: { name: "asc" } });
    expect(rows.map((r) => [r.name, r.stage, r.ownerId, r.amountReceived, r.createdById])).toEqual([
      ["Boeing", "IN_PROGRESS", null, null, ava.id],
      ["Polymaker", "SUBMITTED", ava.id, null, ava.id],
      ["REV Robotics", "ACCEPTED", amara.id, 500, ava.id],
    ]);
    expect(rows[0].notes).toBe("Person: Bob Smith");
    // Imported as they were in the sheet: no "today" filled in.
    expect(rows[1].submittedOn).toBeNull();
    expect(day(rows[2].acceptedOn)).toBe("2026-09-20");
    expect(rows[2].contactEmail).toBe("sponsors@rev.example.com");
  });

  it("skips sponsors that are already here (same name, any case), and repeats in the paste", async () => {
    await makeSponsorship({ name: "REV Robotics", stage: "FINISHED" });
    const text = "Company\tStage\nrev robotics\tSubmitted\nBambu Lab\tDo soon\nBAMBU LAB\tDo soon";
    expect(await importSponsorships(ctx(amara), { text, skipDuplicates: "on" })).toEqual({ added: 1, updated: 0, skipped: 2 });
    expect(await t.db.sponsorship.count()).toBe(2);
    expect((await t.db.sponsorship.findFirstOrThrow({ where: { name: "REV Robotics" } })).stage).toBe("FINISHED");

    // Unchecked: everything is added.
    expect(await importSponsorships(ctx(amara), { text })).toEqual({ added: 3, updated: 0, skipped: 0 });
    expect(await t.db.sponsorship.count()).toBe(5);
  });

  it("is all or nothing: one bad row stops the whole import", async () => {
    const text = ["Company\tNotes", "Good One\t", `${"x".repeat(LIMITS.sponsorNameMax + 1)}\t`, "Good Two\t"].join("\n");
    const err = await importSponsorships(ctx(ava), { text, skipDuplicates: "on" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toBe(
      `Nothing was imported. Row 3: Sponsor name must be at most ${LIMITS.sponsorNameMax} characters. Fix it in the sheet and paste again.`,
    );
    expect((err as ValidationError).fieldErrors.text).toBeTruthy();
    expect(await t.db.sponsorship.count()).toBe(0);
  });

  it("names several bad rows", async () => {
    const long = "x".repeat(LIMITS.sponsorAskingMax + 1);
    const text = ["Company\tAsking", `A\t${long}`, `B\t${long}`, "C\tok", `D\t${long}`, `E\t${long}`, `F\t${long}`].join("\n");
    const err = await importSponsorships(ctx(ava), { text, skipDuplicates: "on" }).catch((e) => e);
    expect((err as ValidationError).userMessage).toMatch(/^Nothing was imported: 5 rows need fixing\. Row 2: .* Row 3: .* Row 5: .* \(and 2 more\)$/);
    expect(await t.db.sponsorship.count()).toBe(0);
  });

  it("imports up to 200 sponsors at a time", async () => {
    const rows = (n: number) => ["Company", ...Array.from({ length: n }, (_, i) => `Sponsor ${i + 1}`)].join("\n");
    const err = await importSponsorships(ctx(jordan), { text: rows(SPONSORSHIP_IMPORT_MAX_ROWS + 1), skipDuplicates: "on" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toBe("That's 201 sponsors to add. Import up to 200 at a time.");
    expect(await t.db.sponsorship.count()).toBe(0);

    expect(await importSponsorships(ctx(jordan), { text: rows(SPONSORSHIP_IMPORT_MAX_ROWS), skipDuplicates: "on" })).toEqual({
      added: 200,
      updated: 0,
      skipped: 0,
    });
    expect(await t.db.sponsorship.count()).toBe(200);
  });

  it("needs something with a sponsor name in it", async () => {
    for (const text of ["", "   \n\t\n"]) {
      const err = await importSponsorships(ctx(ava), { text, skipDuplicates: "on" }).catch((e) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).userMessage).toBe("Paste some rows from your spreadsheet first.");
    }
    const err = await importSponsorships(ctx(ava), { text: `${GWEN_HEADER}\n$100\tFinished\t\t\t\t\t`, skipDuplicates: "on" }).catch((e) => e);
    expect((err as ValidationError).userMessage).toMatch(/^None of the rows has a sponsor name/);
  });

  it("everything already here: nothing added, nothing wrong", async () => {
    await makeSponsorship({ name: "Polymaker" });
    expect(await importSponsorships(ctx(ava), { text: "Company\nPolymaker", skipDuplicates: "on" })).toEqual({ added: 0, updated: 0, skipped: 1 });
  });

  it("the preview context has the people and the names already here", async () => {
    await makeSponsorship({ name: "Polymaker" });
    const context = await getSponsorshipImportContext(ava, t.db);
    expect(context!.existing).toEqual([
      {
        id: expect.any(String),
        name: "Polymaker",
        stage: "NOT_STARTED",
        amountReceived: null,
        submittedOn: null,
        acceptedOn: null,
        closesOn: null,
        contactName: "",
        contactEmail: "",
        website: "",
      },
    ]);
    expect(context!.owners.map((o) => o.name)).toContain("Ava Thompson");
    expect(context!.owners.map((o) => o.name)).not.toContain("Maya Patel");
  });
});

// ── Review fixes: regressions ─────────────────────────────────────────────────

describe("the edit form can't undo a change made since it was opened", () => {
  beforeEach(async () => {
    await t.db.rateLimit.deleteMany();
  });

  it("saving a stale form is a conflict and keeps the stage change (and its date)", async () => {
    const { id } = await createSponsorship(ctx(ava), { name: "Stale form Co", notes: "First note" });
    const opened = await getSponsorship(ava, id, t.db);
    const version = opened!.updatedAt.toISOString();
    // Someone moves it to Submitted from the list while the form is open.
    await new Promise((r) => setTimeout(r, 5));
    const change = await setSponsorshipStage(ctx(amara), { sponsorshipId: id, stage: "SUBMITTED" });
    expect(change.filled?.field).toBe("submittedOn");

    const err = await updateSponsorship(ctx(ava), {
      sponsorshipId: id,
      version,
      name: "Stale form Co",
      stage: "NOT_STARTED",
      submittedOn: "",
      notes: "Called them",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).userMessage).toBe(SPONSORSHIP_CHANGED);
    expect(SPONSORSHIP_CHANGED).toBe("Someone changed this sponsor since you opened it — reload to see the latest.");
    const after = await row(id);
    expect(after).toMatchObject({ stage: "SUBMITTED", notes: "First note" });
    expect(day(after.submittedOn)).toBe(TEST_TODAY);
  });

  it("a form opened after the change saves normally", async () => {
    const { id } = await createSponsorship(ctx(ava), { name: "Fresh form Co" });
    await setSponsorshipStage(ctx(amara), { sponsorshipId: id, stage: "SUBMITTED" });
    const version = (await getSponsorship(ava, id, t.db))!.updatedAt.toISOString();
    await updateSponsorship(ctx(ava), { sponsorshipId: id, version, name: "Fresh form Co", stage: "SUBMITTED", submittedOn: TEST_TODAY, notes: "Sent" });
    expect(await row(id)).toMatchObject({ stage: "SUBMITTED", notes: "Sent" });
    // Saving again with the version from before that save is now stale too.
    await expect(updateSponsorship(ctx(ava), { sponsorshipId: id, version, name: "Fresh form Co", notes: "Again" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("a garbled version is a conflict, and a missing sponsor is still NotFound", async () => {
    const { id } = await createSponsorship(ctx(ava), { name: "Garbled version Co" });
    await expect(updateSponsorship(ctx(ava), { sponsorshipId: id, version: "yesterday", name: "X" })).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateSponsorship(ctx(ava), { sponsorshipId: "missing", version: new Date().toISOString(), name: "X" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect((await row(id)).name).toBe("Garbled version Co");
  });

  it("the stage menu only changes the stage (and an empty date), never other fields", async () => {
    const { id } = await createSponsorship(ctx(ava), {
      name: "Stage only Co",
      notes: "Keep me",
      amountReceived: "250",
      contactEmail: "keep@example.com",
      acceptedOn: "2026-09-01",
    });
    await setSponsorshipStage(ctx(daniel), { sponsorshipId: id, stage: "ACCEPTED" });
    const after = await row(id);
    expect(after).toMatchObject({ stage: "ACCEPTED", notes: "Keep me", amountReceived: 250, contactEmail: "keep@example.com", name: "Stage only Co" });
    expect(day(after.acceptedOn)).toBe("2026-09-01");
  });
});

describe("adding and removing say what happened", () => {
  beforeEach(async () => {
    await t.db.rateLimit.deleteMany();
  });

  it("adding a name that's already here is allowed, and says how many share it", async () => {
    const first = await createSponsorship(ctx(ava), { name: "Twin Name Robotics" });
    expect(first.sameName).toBe(0);
    const second = await createSponsorship(ctx(ava), { name: "  twin name ROBOTICS " });
    expect(second.sameName).toBe(1);
    expect(await t.db.sponsorship.count({ where: { name: { equals: "twin name robotics", mode: "insensitive" } } })).toBe(2);
  });

  it("removing returns the name for the confirmation", async () => {
    const { id } = await createSponsorship(ctx(ava), { name: "Gone Soon Co" });
    expect(await deleteSponsorship(ctx(ava), { sponsorshipId: id })).toEqual({ name: "Gone Soon Co" });
  });
});

describe("the Closing soon filter", () => {
  beforeAll(async () => {
    await t.db.sponsorship.deleteMany();
    const d = (n: number) => dateOnlyToDb(addDays(TEST_TODAY, n));
    await t.db.sponsorship.createMany({
      data: [
        { name: "Later Co", stage: "NOT_STARTED", closesOn: d(20) },
        { name: "Soon B", stage: "IN_PROGRESS", closesOn: d(14), ownerId: ava.id },
        { name: "Soon A", stage: "NOT_STARTED", closesOn: d(3) },
        { name: "Today Co", stage: "DO_SOON", closesOn: d(0) },
        { name: "Past Co", stage: "DO_SOON", closesOn: d(-1) },
        { name: "Sent Co", stage: "SUBMITTED", closesOn: d(2) },
        { name: "No Date Co", stage: "NOT_STARTED" },
      ],
    });
  });

  it("lists what's still to do with a deadline in the next 2 weeks, soonest first, matching the stat card", async () => {
    const list = (await listSponsorships(ava, { filter: "closing", today: TEST_TODAY }, t.db))!;
    expect(list.items.map((i) => i.name)).toEqual(["Today Co", "Soon A", "Soon B"]);
    expect(list.summary.closingSoon).toBe(list.items.length);
    const mine = (await listSponsorships(ava, { filter: "closing", mine: true, today: TEST_TODAY }, t.db))!;
    expect(mine.items.map((i) => i.name)).toEqual(["Soon B"]);
  });

  it("parses from the URL; Object keys aren't filters", () => {
    expect(parseSponsorshipFilter("closing")).toBe("closing");
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) expect(parseSponsorshipFilter(key)).toBe("all");
  });
});

describe("import: big or crafted pastes are handled fast", () => {
  beforeEach(async () => {
    await t.db.sponsorship.deleteMany();
    await t.db.rateLimit.deleteMany();
  });

  /** A header with `cells` extra empty columns, then `rows` one-letter rows (the reviewer's crafted paste). */
  const crafted = (cells: number, rows: number) => `Company\tWebsite${"\t".repeat(cells)}\n${"a\n".repeat(rows)}`;
  /** The biggest crafted paste the server accepts. */
  const biggest = (cells: number) => crafted(cells, Math.floor((SPONSORSHIP_IMPORT_TEXT_MAX - (16 + cells)) / 2));

  it("reads a max-size crafted paste in well under a second", () => {
    for (const cells of [100, 20_000, 150_000]) {
      const text = biggest(cells);
      expect(text.length).toBeLessThanOrEqual(SPONSORSHIP_IMPORT_TEXT_MAX);
      const started = performance.now();
      const parsed = parseSponsorshipSheet(text, { today: TEST_TODAY });
      const plan = planSponsorshipImport(text, { today: TEST_TODAY, owners: [], existing: [], skipDuplicates: true });
      expect(performance.now() - started, `${cells} columns`).toBeLessThan(1000);
      expect(parsed.columns.length).toBeLessThanOrEqual(SPONSORSHIP_IMPORT_MAX_COLUMNS);
      expect(parsed.rows.length).toBe(SPONSORSHIP_IMPORT_MAX_PASTED_ROWS);
      expect(parsed.tooManyRows).toBe(true);
      expect(plan.tooMany).toBe(true);
    }
  });

  it("the server turns it down fast, before the import lock, without using up the import allowance", async () => {
    const text = biggest(100_000);
    const started = performance.now();
    const err = await importSponsorships(ctx(ava), { text, skipDuplicates: "on" }).catch((e) => e);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toBe("That's more than 1,000 rows. Paste up to 1,000 at a time.");
    expect(await t.db.rateLimit.count()).toBe(0);
    expect(await t.db.sponsorship.count()).toBe(0);
  });

  it("pastes over the length limit are refused", async () => {
    const err = await importSponsorships(ctx(ava), { text: `Company\n${"x".repeat(SPONSORSHIP_IMPORT_TEXT_MAX)}` }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).fieldErrors.text).toBe("That's too much to paste at once. Paste up to 1,000 rows at a time.");
  });

  it("reads 1,000 rows, not 1,001", () => {
    const names = (n: number) => ["Company", ...Array.from({ length: n }, (_, i) => `Sponsor ${i + 1}`)].join("\n");
    expect(parseSponsorshipSheet(names(SPONSORSHIP_IMPORT_MAX_PASTED_ROWS), { today: TEST_TODAY }).tooManyRows).toBe(false);
    expect(parseSponsorshipSheet(names(SPONSORSHIP_IMPORT_MAX_PASTED_ROWS + 1), { today: TEST_TODAY }).tooManyRows).toBe(true);
    // Blank rows don't count.
    const spaced = `Company\n${Array.from({ length: SPONSORSHIP_IMPORT_MAX_PASTED_ROWS }, (_, i) => `S${i}\n\n`).join("")}`;
    expect(parseSponsorshipSheet(spaced, { today: TEST_TODAY }).tooManyRows).toBe(false);
  });

  it("ignores columns past the limit, and says so", () => {
    // 41 columns: the Notes column is the 41st.
    const header = ["Company", "Stage", ...Array.from({ length: SPONSORSHIP_IMPORT_MAX_COLUMNS - 2 }, (_, i) => `Extra ${i}`), "Notes"].join("\t");
    const data = ["Polymaker", "Submitted", ...Array.from({ length: SPONSORSHIP_IMPORT_MAX_COLUMNS - 2 }, () => ""), "Past the limit"].join("\t");
    const parsed = parseSponsorshipSheet(`${header}\n${data}`, { today: TEST_TODAY });
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.extraColumns).toBe(true);
    expect(parsed.columns).toHaveLength(SPONSORSHIP_IMPORT_MAX_COLUMNS);
    expect(parsed.rows[0]).toMatchObject({ name: "Polymaker", stage: "SUBMITTED", notes: "" });
    expect(parseSponsorshipSheet("Company\tNotes\nPolymaker\tHi", { today: TEST_TODAY }).extraColumns).toBe(false);
  });
});

describe("import: the preview and the server agree", () => {
  beforeEach(async () => {
    await t.db.sponsorship.deleteMany();
    await t.db.rateLimit.deleteMany();
  });

  const plan = (text: string, existing: ExistingSponsor[] = [], updateExisting = false) =>
    planSponsorshipImport(text, { today: TEST_TODAY, owners: [{ id: ava.id, name: "Ava Thompson" }], existing, skipDuplicates: true, updateExisting });

  it("emails the server won't take go into the notes with a warning (not a failed import)", async () => {
    const text = "Company\tEmail\nJosé Co\tjosé@acme.example.com\nDots Co\tjane..doe@acme.example.com\nGood Co\tok@acme.example.com";
    const p = plan(text);
    expect(p.rowsWithErrors).toBe(0);
    expect(p.rows.map((r) => r.contactEmail)).toEqual(["", "", "ok@acme.example.com"]);
    expect(p.rows[0].warnings).toEqual(["Email “josé@acme.example.com” isn't a valid email address, so it went into the notes."]);
    expect(p.rows[0].notes).toBe("Email: josé@acme.example.com");

    expect(await importSponsorships(ctx(ava), { text, skipDuplicates: "on" })).toEqual({ added: 3, updated: 0, skipped: 0 });
    const saved = await t.db.sponsorship.findFirstOrThrow({ where: { name: "José Co" } });
    expect(saved).toMatchObject({ contactEmail: "", notes: "Email: josé@acme.example.com" });
  });

  it("websites the server won't take go into the notes with a warning", async () => {
    // Looks like a link, but is too long once its accents are percent-encoded.
    const long = `example.com/${"é".repeat(700)}`;
    const text = `Company\tWebsite\nLong Link Co\t${long}\nFine Co\tpolymaker.com`;
    const p = plan(text);
    expect(p.rowsWithErrors).toBe(0);
    expect(p.rows[0].website).toBe("");
    expect(p.rows[0].warnings[0]).toMatch(/^Website “example\.com\/é+” isn't a web address, so it went into the notes\.$/);
    expect(await importSponsorships(ctx(ava), { text, skipDuplicates: "on" })).toMatchObject({ added: 2 });
    expect((await t.db.sponsorship.findFirstOrThrow({ where: { name: "Fine Co" } })).website).toBe("https://polymaker.com/");
  });

  it("the preview shows the server's own messages for rows that can't be saved", async () => {
    const text = `Company\tContact\nLong Contact Co\t${"x".repeat(LIMITS.nameMax + 1)}`;
    const p = plan(text);
    expect(p.rowsWithErrors).toBe(1);
    expect(p.rows[0].errors).toEqual([`Contact name must be at most ${LIMITS.nameMax} characters.`]);
    const err = await importSponsorships(ctx(ava), { text, skipDuplicates: "on" }).catch((e) => e);
    expect((err as ValidationError).userMessage).toBe(
      `Nothing was imported. Row 2: Contact name must be at most ${LIMITS.nameMax} characters. Fix it in the sheet and paste again.`,
    );
  });

  it("a paste that fails the checks doesn't use up the hourly import allowance", async () => {
    await t.db.rateLimit.create({ data: { key: `sponsorship-import:${daniel.id}`, count: SPONSORSHIP_IMPORTS_PER_HOUR - 1, windowStart: TEST_NOW } });
    const bad = `Company\tNotes\nBad Co\t${"x".repeat(LIMITS.sponsorNotesMax + 1)}`;
    for (let i = 0; i < 3; i++) {
      await expect(importSponsorships(ctx(daniel), { text: bad, skipDuplicates: "on" })).rejects.toBeInstanceOf(ValidationError);
      await expect(importSponsorships(ctx(daniel), { text: "   ", skipDuplicates: "on" })).rejects.toBeInstanceOf(ValidationError);
    }
    // The last one allowed this hour still goes through…
    expect(await importSponsorships(ctx(daniel), { text: "Company\nGood Co", skipDuplicates: "on" })).toMatchObject({ added: 1 });
    // …and then the limit applies.
    await expect(importSponsorships(ctx(daniel), { text: "Company\nAnother Co", skipDuplicates: "on" })).rejects.toBeInstanceOf(RateLimitError);
  });

  it("'constructor', 'toString', and '__proto__' are just unknown stages", async () => {
    for (const word of ["Constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(parseStageText(word), word).toBeNull();
    }
    const text = "Company\tStage\tDeadline\nAcme\tConstructor\tconstructor 12\nBeta\t__proto__\t";
    const p = plan(text);
    expect(p.rows.map((r) => [r.stage, r.closesOn])).toEqual([
      ["NOT_STARTED", null],
      ["NOT_STARTED", null],
    ]);
    expect(p.rows[0].warnings).toContain("Didn't recognize the stage “Constructor”, so it's set to Haven't started.");
    expect(p.rowsWithErrors).toBe(0);
    expect(await importSponsorships(ctx(ava), { text, skipDuplicates: "on" })).toMatchObject({ added: 2 });
  });

  it("the 200 limit counts sponsors to add, not the ones already here", async () => {
    const names = Array.from({ length: 210 }, (_, i) => `Cap Sponsor ${i}`);
    const p = plan(`Company\n${names.join("\n")}`, names.slice(0, 205).map((n) => existingSponsor(n)));
    expect(p).toMatchObject({ tooMany: false, toAdd: 5, duplicates: 205 });

    await t.db.sponsorship.createMany({ data: names.slice(0, 205).map((name) => ({ name })) });
    expect(await importSponsorships(ctx(jordan), { text: `Company\n${names.join("\n")}`, skipDuplicates: "on" })).toEqual({
      added: 5,
      updated: 0,
      skipped: 205,
    });
  });

  it("a single column with commas in the names isn't split", () => {
    expect(parseSponsorshipSheet("Company\nPolymaker\nAcme, Inc.\n", { today: TEST_TODAY }).rows.map((r) => r.name)).toEqual([
      "Polymaker",
      "Acme, Inc.",
    ]);
    const noHeader = parseSponsorshipSheet("Polymaker\nREV Robotics\nAcme, Inc.\n", { today: TEST_TODAY });
    expect(noHeader.rows.map((r) => r.name)).toEqual(["Polymaker", "REV Robotics", "Acme, Inc."]);
    expect(noHeader.unnamedRows).toEqual([]);
    // CSV still works with a header row, or with values in the Business sheet's order.
    expect(parseSponsorshipSheet("Company,Stage\nAcme,Submitted", { today: TEST_TODAY }).rows[0]).toMatchObject({ name: "Acme", stage: "SUBMITTED" });
    expect(parseSponsorshipSheet("$500,Accepted,REV Robotics\n,Do soon,Bambu Lab", { today: TEST_TODAY }).rows).toMatchObject([
      { name: "REV Robotics", stage: "ACCEPTED", amountReceived: 500 },
      { name: "Bambu Lab", stage: "DO_SOON" },
    ]);
  });

  it("a person matched by first name alone gets a warning to check it", () => {
    const p = plan("Company\tPerson\nA Co\tAva\nB Co\tAva Thompson\nC Co\tava t.");
    expect(p.rows.map((r) => r.owner?.id)).toEqual([ava.id, ava.id, ava.id]);
    expect(p.rows[0].warnings).toEqual(["Matched “Ava” to Ava Thompson by first name — check it."]);
    expect(p.rows[1].warnings).toEqual([]);
    expect(p.rows[2].warnings).toEqual([]);
  });

  it("keeps the header text for the column list", () => {
    const parsed = parseSponsorshipSheet(`${GWEN_HEADER}\tFavorite color\n$1\tDone\tAcme\t\t\t\t\tgreen`, { today: TEST_TODAY });
    expect(parsed.headers).toEqual([...GWEN_HEADER.split("\t"), "Favorite color"]);
    expect(parsed.columns).toEqual(["amountReceived", "stage", "name", "contactEmail", "acceptedOn", "submittedOn", "owner", null]);
  });

  it("warns when the dates don't fit the stage or each other, or are in the future", () => {
    const p = plan(
      [
        "Company\tStage\tDate submitted\tDate accepted",
        "Early Co\tSubmitted\t9/1/2026\t9/10/2026",
        "Backwards Co\tAccepted\t9/20/2026\t9/1/2026",
        "Future Co\tSubmitted\t10/30/2026\t",
        "Fine Co\tAccepted\t9/1/2026\t9/10/2026",
      ].join("\n"),
    );
    expect(p.rows.map((r) => r.warnings)).toEqual([
      ["Has an accepted date (Sep 10) but the stage is Submitted — check which is right."],
      ["The accepted date (Sep 1) is before the submitted date (Sep 20) — check the dates."],
      ["The submitted date (Oct 30) is in the future — check it."],
      [],
    ]);
  });

  it("parseHttpUrl lives in src/lib/urls.ts and is still exported from the resources service", () => {
    expect(parseHttpUrlFromResources).toBe(parseHttpUrl);
    expect(parseHttpUrl("polymaker.com")).toBeNull();
    expect(parseHttpUrl("https://polymaker.com")).toBe("https://polymaker.com/");
  });
});

describe("import: updating sponsors that are already here", () => {
  beforeEach(async () => {
    await t.db.sponsorship.deleteMany();
    await t.db.rateLimit.deleteMany();
  });

  const SHEET = [
    "Company\tStage\tAmount received\tDate accepted\tContact email\tNotes",
    "Boeing\tAccepted\t$1,000\t9/20/2026\t\tFrom the sheet",
    "Polymaker\t\t\t\t\t",
    "New Co\tDo soon\t\t\t\t",
  ].join("\n");

  it("the preview shows what's different, and only updates when asked", () => {
    const existing = [
      existingSponsor("Boeing", { stage: "IN_PROGRESS", contactEmail: "stem@boeing.example.com" }),
      existingSponsor("Polymaker", { stage: "SUBMITTED", amountReceived: 300 }),
    ];
    const skip = planSponsorshipImport(SHEET, { today: TEST_TODAY, owners: [], existing, skipDuplicates: true });
    expect(skip).toMatchObject({ toAdd: 1, toUpdate: 0, duplicates: 2, outdated: 1 });
    const boeing = skip.rows[0];
    expect(boeing).toMatchObject({ duplicate: true, update: false, existing: existing[0], changes: ["stage", "amountReceived", "acceptedOn"] });
    // Empty cells aren't differences: Polymaker's empty row changes nothing, and Boeing keeps its email.
    expect(skip.rows[1].changes).toEqual([]);

    const update = planSponsorshipImport(SHEET, { today: TEST_TODAY, owners: [], existing, skipDuplicates: true, updateExisting: true });
    expect(update).toMatchObject({ toAdd: 1, toUpdate: 1, duplicates: 1, outdated: 0 });
    expect(update.rows[0].update).toBe(true);
  });

  it("the server copies what's different from the sheet and never erases with empty cells", async () => {
    const boeing = await makeSponsorship({ name: "Boeing", stage: "IN_PROGRESS", contactEmail: "stem@boeing.example.com", notes: "Ours", ownerId: daniel.id });
    const poly = await makeSponsorship({ name: "Polymaker", stage: "SUBMITTED", amountReceived: 300 });

    // Off by default: skipped.
    expect(await importSponsorships(ctx(ava), { text: SHEET, skipDuplicates: "on" })).toEqual({ added: 1, updated: 0, skipped: 2 });
    expect((await row(boeing.id)).stage).toBe("IN_PROGRESS");

    await t.db.sponsorship.deleteMany({ where: { name: "New Co" } });
    expect(await importSponsorships(ctx(ava), { text: SHEET, skipDuplicates: "on", updateExisting: "on" })).toEqual({
      added: 1,
      updated: 1,
      skipped: 1,
    });
    const b = await row(boeing.id);
    expect(b).toMatchObject({ stage: "ACCEPTED", amountReceived: 1000, contactEmail: "stem@boeing.example.com", notes: "Ours", ownerId: daniel.id });
    expect(day(b.acceptedOn)).toBe("2026-09-20");
    expect(await row(poly.id)).toMatchObject({ stage: "SUBMITTED", amountReceived: 300 });
    expect(await t.db.sponsorship.count({ where: { name: "Boeing" } })).toBe(1);
  });

  it("updates need 'don't add again' on, skip names that are here twice, and are re-checked", async () => {
    await makeSponsorship({ name: "Boeing", stage: "IN_PROGRESS" });
    // Unchecked "don't add": the row is added again; nothing is updated.
    expect(await importSponsorships(ctx(ava), { text: "Company\tStage\nBoeing\tAccepted", updateExisting: "on" })).toEqual({
      added: 1,
      updated: 0,
      skipped: 0,
    });
    // Two Boeings here now: which one to update isn't clear, so neither is.
    expect(await importSponsorships(ctx(ava), { text: "Company\tStage\nBoeing\tFinished", skipDuplicates: "on", updateExisting: "on" })).toEqual({
      added: 0,
      updated: 0,
      skipped: 1,
    });
    expect(await t.db.sponsorship.count({ where: { stage: "FINISHED" } })).toBe(0);

    await t.db.sponsorship.deleteMany();
    await makeSponsorship({ name: "Solo Co" });
    const text = `Company\tContact\nSolo Co\t${"x".repeat(LIMITS.nameMax + 1)}`;
    const err = await importSponsorships(ctx(ava), { text, skipDuplicates: "on", updateExisting: "on" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toMatch(/^Nothing was imported\. Row 2: Contact name must be at most/);
    // Without updating, that row is only skipped, so it isn't a problem.
    expect(await importSponsorships(ctx(ava), { text, skipDuplicates: "on" })).toEqual({ added: 0, updated: 0, skipped: 1 });
  });

  it("counts updates toward the 200 limit", () => {
    const names = Array.from({ length: 150 }, (_, i) => `Upd ${i}`);
    const existing = names.map((n) => existingSponsor(n));
    const text = ["Company\tStage", ...names.map((n) => `${n}\tSubmitted`), ...Array.from({ length: 60 }, (_, i) => `New ${i}\tDo soon`)].join("\n");
    expect(planSponsorshipImport(text, { today: TEST_TODAY, owners: [], existing, skipDuplicates: true })).toMatchObject({ tooMany: false, toAdd: 60 });
    expect(planSponsorshipImport(text, { today: TEST_TODAY, owners: [], existing, skipDuplicates: true, updateExisting: true })).toMatchObject({
      tooMany: true,
      toAdd: 60,
      toUpdate: 150,
    });
  });
});
