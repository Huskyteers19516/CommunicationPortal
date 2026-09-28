import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Subteam } from "@/generated/prisma/enums";
import { addDays, dateOnlyToDb, type DateOnly } from "@/lib/dates";
import {
  MEETING_DATE_IN_FUTURE,
  MEETING_DATE_TOO_OLD,
  meetingDateProblem,
  meetingUpdateFocusHref,
  missingMeetingUpdates,
  parseMeetingFeedFilters,
  prefillMeetingDate,
  subteamList,
} from "@/lib/meeting-updates";
import { type Actor, actorSelect } from "@/server/actor";
import type { Db } from "@/server/db";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import {
  getMeetingUpdate,
  getMeetingUpdatesBetween,
  getMeetingUpdatesFeed,
  getTodayUpdateStatus,
  MEETING_DAYS_PER_PAGE,
  PAGE_UPDATES_MAX,
} from "@/server/queries/meeting-updates";
import {
  createMeetingUpdate,
  deleteMeetingUpdate,
  MEETING_UPDATE_CHANGED,
  MEETING_UPDATE_CHANGED_BEFORE_REMOVE,
  MEETING_UPDATE_RATE_LIMIT,
  updateMeetingUpdate,
} from "@/server/services/meeting-updates";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY } from "./helpers/factories";

type Who =
  | "owner"
  | "captain"
  | "mentor"
  | "teacher"
  | "swLead"
  | "buildLead"
  | "bizLead"
  | "swMember"
  | "buildMember"
  | "buildMember2"
  | "bizMember"
  | "noSubteam"
  | "pendingBuild"
  | "disabledBuild";

let t: TestDb;
let p: Record<Who, Actor>;

async function makePeople(db: Db): Promise<Record<Who, Actor>> {
  return {
    owner: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true, name: "Olive Owner" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Mia Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Theo Teacher" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Lead" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Amara Lead" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ethan Build" }),
    buildMember2: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Zara Build" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Gwen Business" }),
    noSubteam: await makeUser(db, { role: "MEMBER", subteam: null, name: "Nia Nosubteam" }),
    pendingBuild: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING", name: "Pat Pending" }),
    disabledBuild: await makeUser(db, { role: "MEMBER", subteam: "BUILD", status: "DISABLED", name: "Dana Disabled" }),
  };
}

beforeAll(async () => {
  t = await createTestDb();
  p = await makePeople(t.db);
});

afterAll(async () => {
  await t?.drop();
});

afterEach(() => {
  vi.useRealTimers();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);

const input = (over: Record<string, unknown> = {}) => ({
  meetingDate: TEST_TODAY,
  subteam: "BUILD",
  body: "Finished the intake CAD and printed two roller hubs.",
  nextSteps: "Assemble the intake.",
  blockers: "",
  ...over,
});

/** An update straight in the DB (bypassing the service). */
async function makeUpdate(
  db: Db,
  author: Actor | null,
  opts: { subteam?: Subteam; date?: DateOnly; body?: string; createdAt?: Date } = {},
) {
  return db.meetingUpdate.create({
    data: {
      meetingDate: dateOnlyToDb(opts.date ?? TEST_TODAY),
      subteam: opts.subteam ?? author?.subteam ?? "BUILD",
      body: opts.body ?? "Worked on the robot.",
      authorId: author?.id ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

/** The edit form's fields for an update as it is now (plus overrides). */
async function editInput(id: string, over: Record<string, unknown> = {}) {
  const row = await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } });
  return {
    updateId: id,
    version: row.updatedAt.toISOString(),
    meetingDate: row.meetingDate.toISOString().slice(0, 10),
    subteam: row.subteam,
    body: row.body,
    nextSteps: row.nextSteps,
    blockers: row.blockers,
    ...over,
  };
}

/** The ValidationError's per-field message for `field`. */
async function fieldError(promise: Promise<unknown>, field: string): Promise<string | undefined> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  return (err as ValidationError).fieldErrors[field];
}

describe("who can write updates", () => {
  it("lets a member write for their own subteam only", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input({ body: "  Built the drivetrain.  " }));
    const row = await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      subteam: "BUILD",
      body: "Built the drivetrain.",
      nextSteps: "Assemble the intake.",
      blockers: "",
      authorId: p.buildMember.id,
      lastEditedAt: null,
      lastEditedById: null,
    });
    expect(row.meetingDate.toISOString().slice(0, 10)).toBe(TEST_TODAY);
    for (const subteam of ["SOFTWARE", "BUSINESS"]) {
      await expect(createMeetingUpdate(ctxFor(p.buildMember), input({ subteam }))).rejects.toThrow(ForbiddenError);
    }
    await expect(createMeetingUpdate(ctxFor(p.swMember), input({ subteam: "BUILD" }))).rejects.toThrow(ForbiddenError);
    await expect(createMeetingUpdate(ctxFor(p.swMember), input({ subteam: "SOFTWARE" }))).resolves.toHaveProperty("id");
  });

  it("lets leaders write for their subteam, and the captain, mentors, teachers, and owners for any", async () => {
    await expect(createMeetingUpdate(ctxFor(p.swLead), input({ subteam: "SOFTWARE" }))).resolves.toHaveProperty("id");
    await expect(createMeetingUpdate(ctxFor(p.swLead), input({ subteam: "BUILD" }))).rejects.toThrow(ForbiddenError);
    await expect(createMeetingUpdate(ctxFor(p.bizLead), input({ subteam: "BUILD" }))).rejects.toThrow(ForbiddenError);
    for (const who of ["captain", "mentor", "teacher", "owner"] as const) {
      for (const subteam of ["SOFTWARE", "BUILD", "BUSINESS"] as const) {
        const { id } = await createMeetingUpdate(ctxFor(p[who]), input({ subteam, body: `${who} for ${subteam}` }));
        expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } }), `${who} ${subteam}`).toMatchObject({ subteam, authorId: p[who].id });
      }
    }
  });

  it("refuses people without a subteam, and pending or disabled accounts", async () => {
    await expect(createMeetingUpdate(ctxFor(p.noSubteam), input())).rejects.toThrow(/Ask a leader to set your subteam/);
    await expect(createMeetingUpdate(ctxFor(p.pendingBuild), input())).rejects.toThrow(ForbiddenError);
    await expect(createMeetingUpdate(ctxFor(p.disabledBuild), input())).rejects.toThrow(ForbiddenError);
  });

  it("allows several updates for the same subteam and day, each with its own author", async () => {
    const date = addDays(TEST_TODAY, -3);
    const a = await createMeetingUpdate(ctxFor(p.buildMember), input({ meetingDate: date, body: "Wiring" }));
    const b = await createMeetingUpdate(ctxFor(p.buildMember2), input({ meetingDate: date, body: "Chassis" }));
    const rows = await t.db.meetingUpdate.findMany({ where: { id: { in: [a.id, b.id] } }, orderBy: { body: "asc" } });
    expect(rows.map((r) => [r.body, r.authorId])).toEqual([
      ["Chassis", p.buildMember2.id],
      ["Wiring", p.buildMember.id],
    ]);
  });

  it("is rate limited per person (only saves that pass the checks count)", async () => {
    const busy = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Busy Builder" });
    await t.db.rateLimit.create({
      data: { key: `meeting-update:${busy.id}`, count: MEETING_UPDATE_RATE_LIMIT.limit - 1, windowStart: TEST_NOW },
    });
    await expect(createMeetingUpdate(ctxFor(busy), input({ body: "" }))).rejects.toThrow(ValidationError);
    await expect(createMeetingUpdate(ctxFor(busy), input())).resolves.toHaveProperty("id");
    await expect(createMeetingUpdate(ctxFor(busy), input())).rejects.toThrow(RateLimitError);
    expect(await t.db.meetingUpdate.count({ where: { authorId: busy.id } })).toBe(1);
  });
});

describe("update fields", () => {
  const ctx = () => ctxFor(p.buildMember);

  it("refuses a meeting date in the future (team timezone) or more than a year back", async () => {
    expect(await fieldError(createMeetingUpdate(ctx(), input({ meetingDate: addDays(TEST_TODAY, 1) })), "meetingDate")).toBe(MEETING_DATE_IN_FUTURE);
    expect(await fieldError(createMeetingUpdate(ctx(), input({ meetingDate: addDays(TEST_TODAY, -366) })), "meetingDate")).toBe(MEETING_DATE_TOO_OLD);
    await expect(createMeetingUpdate(ctx(), input({ meetingDate: addDays(TEST_TODAY, -365) }))).resolves.toHaveProperty("id");
    // 11:30 PM in Anaheim is still the 24th there, although it's already the 25th in UTC.
    const lateNight = { ...ctx(), now: new Date("2026-09-25T06:30:00Z") };
    expect(await fieldError(createMeetingUpdate(lateNight, input({ meetingDate: "2026-09-25" })), "meetingDate")).toBe(MEETING_DATE_IN_FUTURE);
    await expect(createMeetingUpdate(lateNight, input({ meetingDate: "2026-09-24" }))).resolves.toHaveProperty("id");
  });

  it("needs a real date", async () => {
    expect(await fieldError(createMeetingUpdate(ctx(), input({ meetingDate: "" })), "meetingDate")).toBe("Pick the meeting date.");
    expect(await fieldError(createMeetingUpdate(ctx(), input({ meetingDate: undefined })), "meetingDate")).toBe("Pick the meeting date.");
    expect(await fieldError(createMeetingUpdate(ctx(), input({ meetingDate: "2026-02-30" })), "meetingDate")).toBe("Pick a valid date.");
    expect(await fieldError(createMeetingUpdate(ctx(), input({ meetingDate: "next tuesday" })), "meetingDate")).toBe("Pick a valid date.");
  });

  it("needs a subteam", async () => {
    expect(await fieldError(createMeetingUpdate(ctx(), input({ subteam: "" })), "subteam")).toBe("Pick the subteam this update is for.");
    expect(await fieldError(createMeetingUpdate(ctx(), input({ subteam: "ROBOTS" })), "subteam")).toBe("Pick the subteam this update is for.");
  });

  it("needs “What we did”, and keeps every field within its limit", async () => {
    expect(await fieldError(createMeetingUpdate(ctx(), input({ body: "   \n " })), "body")).toBe("Write what the subteam did.");
    expect(await fieldError(createMeetingUpdate(ctx(), input({ body: undefined })), "body")).toBe("Write what the subteam did.");
    expect(await fieldError(createMeetingUpdate(ctx(), input({ body: "x".repeat(10001) })), "body")).toMatch(/at most 10,000 characters/);
    expect(await fieldError(createMeetingUpdate(ctx(), input({ nextSteps: "x".repeat(5001) })), "nextSteps")).toMatch(/“Next time” can be at most 5,000/);
    expect(await fieldError(createMeetingUpdate(ctx(), input({ blockers: "x".repeat(5001) })), "blockers")).toMatch(/“Problems or help needed” can be at most 5,000/);
    const { id } = await createMeetingUpdate(
      ctx(),
      input({ body: "x".repeat(10000), nextSteps: "y".repeat(5000), blockers: "  Out of M3 screws.  " }),
    );
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ blockers: "Out of M3 screws." });
  });

  it("counts a line break as one character (browsers send \\r\\n) and stores \\n", async () => {
    const body = "ab\r\n".repeat(3333) + "c"; // 3 × 3333 + 1 = 10,000 characters with \n
    const { id } = await createMeetingUpdate(ctx(), input({ body }));
    const row = await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } });
    expect(row.body).toHaveLength(10000);
    expect(row.body).not.toContain("\r");
  });

  it("drops NUL characters (Postgres can't store them) instead of failing", async () => {
    const { id } = await createMeetingUpdate(ctx(), input({ body: "Wired\u0000 the arm", nextSteps: "\u0000Test it", blockers: "None\u0000" }));
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ body: "Wired the arm", nextSteps: "Test it", blockers: "None" });
    expect(await fieldError(createMeetingUpdate(ctx(), input({ body: "\u0000\u0000" })), "body")).toBe("Write what the subteam did.");
  });

  it("reports every problem at once", async () => {
    const err = await createMeetingUpdate(ctx(), input({ meetingDate: addDays(TEST_TODAY, 2), body: "" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).userMessage).toBe("Please fix the highlighted fields.");
    expect((err as ValidationError).fieldErrors).toEqual({ meetingDate: MEETING_DATE_IN_FUTURE, body: "Write what the subteam did." });
  });

  it("date helpers match the service", () => {
    expect(meetingDateProblem(TEST_TODAY, TEST_TODAY)).toBeNull();
    expect(meetingDateProblem(addDays(TEST_TODAY, 1), TEST_TODAY)).toBe(MEETING_DATE_IN_FUTURE);
    expect(meetingDateProblem(addDays(TEST_TODAY, -366), TEST_TODAY)).toBe(MEETING_DATE_TOO_OLD);
    expect(prefillMeetingDate("2026-09-20", TEST_TODAY)).toBe("2026-09-20");
    expect(prefillMeetingDate("2026-09-30", TEST_TODAY)).toBeUndefined();
    expect(prefillMeetingDate("junk", TEST_TODAY)).toBeUndefined();
    const get = (q: string) => {
      const sp = new URLSearchParams(q);
      return parseMeetingFeedFilters((k) => sp.get(k) ?? undefined);
    };
    expect(get("subteam=BUILD&who=mine&page=3")).toEqual({ subteam: "BUILD", mine: true, page: 3 });
    expect(get("subteam=build&who=all&page=-2")).toEqual({ subteam: undefined, mine: false, page: undefined });
    expect(get("page=1e3")).toEqual({ subteam: undefined, mine: false, page: undefined });
    expect(meetingUpdateFocusHref("abc123")).toBe("/updates?focus=abc123#update-abc123");
  });

  it("lists the meeting days missing a subteam's update", () => {
    const [mon, tue, wed] = ["2026-09-21", "2026-09-22", "2026-09-23"];
    const updates = [
      { meetingDate: mon, subteam: "SOFTWARE" as const },
      { meetingDate: mon, subteam: "BUSINESS" as const },
      { meetingDate: wed, subteam: "SOFTWARE" as const },
      { meetingDate: wed, subteam: "BUILD" as const },
      { meetingDate: wed, subteam: "BUSINESS" as const },
      // Days nobody met (no attendance) don't count.
      { meetingDate: "2026-09-26", subteam: "BUILD" as const },
    ];
    // Two sessions on Tuesday (Regular and Flex) are one meeting day.
    expect(missingMeetingUpdates([wed, tue, mon, tue], updates)).toEqual([
      { date: mon, subteams: ["BUILD"] },
      { date: tue, subteams: ["SOFTWARE", "BUILD", "BUSINESS"] },
    ]);
    expect(missingMeetingUpdates([], updates)).toEqual([]);
    expect(subteamList(["BUILD"])).toBe("Build");
    expect(subteamList(["BUSINESS", "BUILD"], "or")).toBe("Build or Business");
    expect(subteamList(["BUILD", "SOFTWARE", "BUSINESS"])).toBe("all three subteams");
  });
});

describe("editing and removing", () => {
  it("lets the author edit their own update and records who edited it", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input());
    const later = { ...ctxFor(p.buildMember), now: new Date(TEST_NOW.getTime() + 60_000) };
    await expect(updateMeetingUpdate(later, await editInput(id, { body: "Built and tested the intake.", blockers: "Need more zip ties." }))).resolves.toEqual({
      id,
      changed: true,
    });
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({
      body: "Built and tested the intake.",
      blockers: "Need more zip ties.",
      authorId: p.buildMember.id,
      lastEditedAt: later.now,
      lastEditedById: p.buildMember.id,
    });
    await expect(deleteMeetingUpdate(ctxFor(p.buildMember), { updateId: id })).resolves.toEqual({ subteam: "BUILD", meetingDate: TEST_TODAY });
    expect(await t.db.meetingUpdate.count({ where: { id } })).toBe(0);
  });

  it("doesn't let another member (even from the same subteam) edit or remove it", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input());
    for (const who of ["buildMember2", "swMember", "bizMember", "noSubteam", "pendingBuild", "disabledBuild"] as const) {
      await expect(updateMeetingUpdate(ctxFor(p[who]), await editInput(id, { body: "hijacked" })), who).rejects.toThrow(ForbiddenError);
      await expect(deleteMeetingUpdate(ctxFor(p[who]), { updateId: id }), who).rejects.toThrow(ForbiddenError);
    }
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ lastEditedAt: null, authorId: p.buildMember.id });
  });

  it("lets the subteam's leader edit and remove its updates, but not another subteam's", async () => {
    const build = await createMeetingUpdate(ctxFor(p.buildMember), input());
    const software = await createMeetingUpdate(ctxFor(p.swMember), input({ subteam: "SOFTWARE" }));
    await updateMeetingUpdate(ctxFor(p.buildLead), await editInput(build.id, { nextSteps: "Test on the field." }));
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id: build.id } })).toMatchObject({
      nextSteps: "Test on the field.",
      authorId: p.buildMember.id,
      lastEditedById: p.buildLead.id,
    });
    await expect(updateMeetingUpdate(ctxFor(p.buildLead), await editInput(software.id, { body: "x" }))).rejects.toThrow(ForbiddenError);
    await expect(deleteMeetingUpdate(ctxFor(p.buildLead), { updateId: software.id })).rejects.toThrow(ForbiddenError);
    await expect(updateMeetingUpdate(ctxFor(p.swLead), await editInput(build.id, { body: "x" }))).rejects.toThrow(ForbiddenError);
    await expect(deleteMeetingUpdate(ctxFor(p.swLead), { updateId: build.id })).rejects.toThrow(ForbiddenError);
    await expect(deleteMeetingUpdate(ctxFor(p.buildLead), { updateId: build.id })).resolves.toEqual({ subteam: "BUILD", meetingDate: TEST_TODAY });
    await expect(deleteMeetingUpdate(ctxFor(p.swLead), { updateId: software.id })).resolves.toEqual({ subteam: "SOFTWARE", meetingDate: TEST_TODAY });
  });

  it("lets the captain, mentors, teachers, and owners edit and remove any update", async () => {
    for (const who of ["captain", "mentor", "teacher", "owner"] as const) {
      const { id } = await createMeetingUpdate(ctxFor(p.bizMember), input({ subteam: "BUSINESS" }));
      await updateMeetingUpdate(ctxFor(p[who]), await editInput(id, { body: `Fixed by ${who}` }));
      expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } }), who).toMatchObject({ body: `Fixed by ${who}`, lastEditedById: p[who].id });
      await deleteMeetingUpdate(ctxFor(p[who]), { updateId: id });
    }
  });

  it("moves an update to another subteam only for someone who writes for that subteam", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input());
    await expect(updateMeetingUpdate(ctxFor(p.buildMember), await editInput(id, { subteam: "SOFTWARE" }))).rejects.toThrow(ForbiddenError);
    await expect(updateMeetingUpdate(ctxFor(p.buildLead), await editInput(id, { subteam: "BUSINESS" }))).rejects.toThrow(ForbiddenError);
    expect((await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).subteam).toBe("BUILD");
    await updateMeetingUpdate(ctxFor(p.captain), await editInput(id, { subteam: "SOFTWARE" }));
    expect((await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).subteam).toBe("SOFTWARE");
  });

  it("lets an author who changed subteams keep their old update's subteam, or move it to their new one", async () => {
    const mover = await makeUser(t.db, { role: "MEMBER", subteam: "BUILD", name: "Mo Mover" });
    const { id } = await createMeetingUpdate(ctxFor(mover), input());
    const moved = await t.db.user.update({ where: { id: mover.id }, data: { subteam: "SOFTWARE" }, select: actorSelect });
    await updateMeetingUpdate(ctxFor(moved), await editInput(id, { body: "Still a Build update" }));
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ subteam: "BUILD", body: "Still a Build update" });
    await expect(updateMeetingUpdate(ctxFor(moved), await editInput(id, { subteam: "BUSINESS" }))).rejects.toThrow(ForbiddenError);
    await updateMeetingUpdate(ctxFor(moved), await editInput(id, { subteam: "SOFTWARE" }));
    expect((await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).subteam).toBe("SOFTWARE");
  });

  it("lets an edit keep a date older than a year, but not move it out of range", async () => {
    const old = addDays(TEST_TODAY, -400);
    const row = await makeUpdate(t.db, p.buildMember, { date: old });
    await updateMeetingUpdate(ctxFor(p.buildMember), await editInput(row.id, { body: "Old notes, fixed typo" }));
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ body: "Old notes, fixed typo" });
    expect(await fieldError(updateMeetingUpdate(ctxFor(p.buildMember), await editInput(row.id, { meetingDate: addDays(old, 1) })), "meetingDate")).toBe(MEETING_DATE_TOO_OLD);
    expect(await fieldError(updateMeetingUpdate(ctxFor(p.buildMember), await editInput(row.id, { meetingDate: addDays(TEST_TODAY, 1) })), "meetingDate")).toBe(MEETING_DATE_IN_FUTURE);
    await updateMeetingUpdate(ctxFor(p.buildMember), await editInput(row.id, { meetingDate: addDays(TEST_TODAY, -1) }));
    expect((await t.db.meetingUpdate.findUniqueOrThrow({ where: { id: row.id } })).meetingDate).toEqual(dateOnlyToDb(addDays(TEST_TODAY, -1)));
  });

  it("validates the edit form like the new one", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input());
    expect(await fieldError(updateMeetingUpdate(ctxFor(p.buildMember), await editInput(id, { body: " " })), "body")).toBe("Write what the subteam did.");
    expect(await fieldError(updateMeetingUpdate(ctxFor(p.buildMember), await editInput(id, { blockers: "x".repeat(5001) })), "blockers")).toMatch(/at most 5,000/);
  });

  it("doesn't mark an update edited when nothing changed", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input());
    const before = await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } });
    // Same text (with extra spaces and \r\n line breaks that normalize to the same thing).
    await expect(
      updateMeetingUpdate(ctxFor(p.buildLead), await editInput(id, { body: `  ${before.body}  `, nextSteps: before.nextSteps.replace(/\n/g, "\r\n") })),
    ).resolves.toEqual({ id, changed: false });
    const after = await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } });
    expect(after.lastEditedAt).toBeNull();
    expect(after.lastEditedById).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("refuses a save from a form opened before someone else's edit (version)", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input({ body: "First draft" }));
    const stale = await editInput(id, { body: "Author's second draft" });
    await updateMeetingUpdate(ctxFor(p.buildLead), await editInput(id, { body: "Leader's fix" }));
    await expect(updateMeetingUpdate(ctxFor(p.buildMember), stale)).rejects.toThrow(MEETING_UPDATE_CHANGED);
    await expect(updateMeetingUpdate(ctxFor(p.buildMember), stale)).rejects.toThrow(ConflictError);
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ body: "Leader's fix", lastEditedById: p.buildLead.id });
    await expect(updateMeetingUpdate(ctxFor(p.buildMember), { ...stale, version: "not a date" })).rejects.toThrow(ConflictError);
    // With the newest version (the page reloaded the form's copy), saving again replaces it.
    await updateMeetingUpdate(ctxFor(p.buildMember), await editInput(id, { body: "Author's second draft" }));
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ body: "Author's second draft", lastEditedById: p.buildMember.id });
  });

  it("moves the version forward on every save, even within the same millisecond", async () => {
    // Freeze the clock: the create, the leader's edit, and the stale save all happen "at once".
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-24T19:00:00.123Z"));
    const now = { ...ctxFor(p.buildMember), now: new Date() };
    const { id } = await createMeetingUpdate(now, input({ body: "First draft" }));
    const stale = await editInput(id, { body: "Member's stale text" });
    await updateMeetingUpdate({ ...ctxFor(p.buildLead), now: new Date() }, await editInput(id, { body: "Leader's fix" }));
    const afterLeader = await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } });
    expect(afterLeader.updatedAt.getTime()).toBeGreaterThan(new Date(stale.version).getTime());
    await expect(updateMeetingUpdate(now, stale)).rejects.toThrow(ConflictError);
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ body: "Leader's fix", lastEditedById: p.buildLead.id });
    // A save whose clock is behind the last write still moves the version forward.
    const behind = { ...ctxFor(p.buildLead), now: new Date(afterLeader.updatedAt.getTime() - 60_000) };
    await updateMeetingUpdate(behind, await editInput(id, { body: "Leader's second fix" }));
    expect((await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).updatedAt.getTime()).toBe(afterLeader.updatedAt.getTime() + 1);
  });

  /** `db`, but `before` runs just before meetingUpdate.deleteMany (someone else's change, between the check and the delete). */
  function raceBeforeDelete(db: Db, before: () => Promise<unknown>): Db {
    return new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop);
        if (prop !== "meetingUpdate") return typeof value === "function" ? value.bind(target) : value;
        return new Proxy(target.meetingUpdate, {
          get(delegate, key) {
            const fn = Reflect.get(delegate, key);
            if (key !== "deleteMany") return typeof fn === "function" ? fn.bind(delegate) : fn;
            return async (args: Parameters<typeof delegate.deleteMany>[0]) => {
              await before();
              return delegate.deleteMany(args);
            };
          },
        });
      },
    });
  }

  it("doesn't remove an update that moved to another subteam, or changed, after the permission check", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.captain), input({ body: "Captain wrote for Build" }));
    // The captain moves it to Software while the Build leader's remove is under way.
    const moved = raceBeforeDelete(t.db, () => t.db.meetingUpdate.update({ where: { id }, data: { subteam: "SOFTWARE" } }));
    await expect(deleteMeetingUpdate({ ...ctxFor(p.buildLead), db: moved }, { updateId: id })).rejects.toThrow(MEETING_UPDATE_CHANGED_BEFORE_REMOVE);
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ subteam: "SOFTWARE" });

    // Someone edits it meanwhile: the remove doesn't throw their edit away unseen.
    const edited = raceBeforeDelete(t.db, async () =>
      updateMeetingUpdate({ ...ctxFor(p.swLead), now: new Date(TEST_NOW.getTime() + 60_000) }, await editInput(id, { body: "Sam's fix" })),
    );
    await expect(deleteMeetingUpdate({ ...ctxFor(p.captain), db: edited }, { updateId: id })).rejects.toThrow(ConflictError);
    expect(await t.db.meetingUpdate.findUniqueOrThrow({ where: { id } })).toMatchObject({ body: "Sam's fix" });

    // Removed meanwhile: "That update was removed."
    const gone = raceBeforeDelete(t.db, () => t.db.meetingUpdate.delete({ where: { id } }));
    await expect(deleteMeetingUpdate({ ...ctxFor(p.captain), db: gone }, { updateId: id })).rejects.toThrow(NotFoundError);
  });

  it("says when the update is gone", async () => {
    const { id } = await createMeetingUpdate(ctxFor(p.buildMember), input());
    const form = await editInput(id, { body: "Too late" });
    await deleteMeetingUpdate(ctxFor(p.buildLead), { updateId: id });
    await expect(updateMeetingUpdate(ctxFor(p.buildMember), form)).rejects.toThrow(NotFoundError);
    await expect(deleteMeetingUpdate(ctxFor(p.buildMember), { updateId: id })).rejects.toThrow(NotFoundError);
    await expect(deleteMeetingUpdate(ctxFor(p.buildMember), {})).rejects.toThrow(ValidationError);
  });
});

describe("the feed and other readers", () => {
  let s: TestDb;
  let q: Record<Who, Actor>;

  beforeAll(async () => {
    s = await createTestDb();
    q = await makePeople(s.db);
  });

  afterAll(async () => {
    await s?.drop();
  });

  const at = (minutes: number) => new Date(TEST_NOW.getTime() + minutes * 60_000);

  it("is empty before anyone writes, and null for accounts that aren't active", async () => {
    expect(await getMeetingUpdatesFeed(q.buildMember, {}, s.db)).toEqual({
      days: [],
      page: 1,
      pageCount: 1,
      dayCount: 0,
      anyAtAll: false,
      writable: ["BUILD"],
    });
    expect((await getMeetingUpdatesFeed(q.captain, {}, s.db))?.writable).toEqual(["SOFTWARE", "BUILD", "BUSINESS"]);
    expect((await getMeetingUpdatesFeed(q.noSubteam, {}, s.db))?.writable).toEqual([]);
    expect(await getMeetingUpdatesFeed(q.disabledBuild, {}, s.db)).toBeNull();
  });

  it("groups each day's updates by subteam, newest day first, in the order they were written", async () => {
    const b2 = await makeUpdate(s.db, q.buildMember2, { body: "Chassis", createdAt: at(30) });
    const b1 = await makeUpdate(s.db, q.buildMember, { body: "Wiring", createdAt: at(10) });
    const sw = await makeUpdate(s.db, q.swMember, { body: "Autonomous", createdAt: at(5) });
    const older = await makeUpdate(s.db, q.bizMember, { date: addDays(TEST_TODAY, -2), body: "Sponsor emails" });
    await updateMeetingUpdate(contextFor(s.db, q.buildLead), {
      updateId: b1.id,
      version: b1.updatedAt.toISOString(),
      meetingDate: TEST_TODAY,
      subteam: "BUILD",
      body: "Wiring, checked by the leader",
      nextSteps: "",
      blockers: "Need a new battery",
    });

    const feed = await getMeetingUpdatesFeed(q.buildLead, {}, s.db);
    expect(feed).toMatchObject({ page: 1, pageCount: 1, dayCount: 2, anyAtAll: true });
    expect(feed!.days.map((d) => d.date)).toEqual([TEST_TODAY, addDays(TEST_TODAY, -2)]);
    const [today, twoDaysAgo] = feed!.days;
    expect(today.bySubteam.BUILD.map((u) => u.id)).toEqual([b1.id, b2.id]);
    expect(today.bySubteam.SOFTWARE.map((u) => u.id)).toEqual([sw.id]);
    expect(today.bySubteam.BUSINESS).toEqual([]);
    expect(twoDaysAgo.bySubteam.BUSINESS.map((u) => u.id)).toEqual([older.id]);
    expect(twoDaysAgo.bySubteam.BUILD).toEqual([]);

    const edited = today.bySubteam.BUILD[0];
    expect(edited).toMatchObject({
      body: "Wiring, checked by the leader",
      blockers: "Need a new battery",
      author: { id: q.buildMember.id, name: "Ethan Build", role: "MEMBER", subteam: "BUILD" },
      lastEditedBy: { id: q.buildLead.id, name: "Blake Lead" },
      mine: false,
      canEdit: true,
    });
    expect(edited.lastEditedAt).toEqual(TEST_NOW);
    expect(today.bySubteam.BUILD[1]).toMatchObject({ lastEditedAt: null, lastEditedBy: null, createdAt: at(30) });
    // The Build leader edits Build updates, not Software's.
    expect(today.bySubteam.SOFTWARE[0].canEdit).toBe(false);

    const asMember = await getMeetingUpdatesFeed(q.buildMember, {}, s.db);
    const build = asMember!.days[0].bySubteam.BUILD;
    expect(build.map((u) => [u.mine, u.canEdit])).toEqual([
      [true, true],
      [false, false],
    ]);
    const asMentor = await getMeetingUpdatesFeed(q.mentor, {}, s.db);
    expect(asMentor!.days.flatMap((d) => [...d.bySubteam.SOFTWARE, ...d.bySubteam.BUILD, ...d.bySubteam.BUSINESS]).every((u) => u.canEdit)).toBe(true);
  });

  it("filters by subteam and by who wrote it", async () => {
    const build = await getMeetingUpdatesFeed(q.swMember, { subteam: "BUILD" }, s.db);
    expect(build!.days.map((d) => d.date)).toEqual([TEST_TODAY]);
    expect(build!.days[0].bySubteam.BUILD).toHaveLength(2);
    expect(build!.days[0].bySubteam.SOFTWARE).toEqual([]);

    const business = await getMeetingUpdatesFeed(q.swMember, { subteam: "BUSINESS" }, s.db);
    expect(business!.days.map((d) => d.date)).toEqual([addDays(TEST_TODAY, -2)]);

    const mine = await getMeetingUpdatesFeed(q.buildMember2, { mine: true }, s.db);
    expect(mine!.days).toHaveLength(1);
    expect(mine!.days[0].bySubteam.BUILD.map((u) => u.body)).toEqual(["Chassis"]);

    const nothing = await getMeetingUpdatesFeed(q.buildMember2, { mine: true, subteam: "SOFTWARE" }, s.db);
    expect(nothing).toMatchObject({ days: [], dayCount: 0, anyAtAll: true });
  });

  it("pages by meeting day and opens the page with a just-saved update", async () => {
    // 22 more days, three weeks to two months back: 24 days in all.
    const days = Array.from({ length: 22 }, (_, i) => addDays(TEST_TODAY, -(20 + i)));
    await s.db.meetingUpdate.createMany({
      data: days.map((d, i) => ({ meetingDate: dateOnlyToDb(d), subteam: i % 2 ? "SOFTWARE" : "BUILD", body: `Day ${d}`, authorId: q.swLead.id })),
    });
    const first = await getMeetingUpdatesFeed(q.buildMember, {}, s.db);
    expect(first).toMatchObject({ page: 1, pageCount: 3, dayCount: 24 });
    expect(first!.days).toHaveLength(MEETING_DAYS_PER_PAGE);
    expect(first!.days[0].date).toBe(TEST_TODAY);

    const second = await getMeetingUpdatesFeed(q.buildMember, { page: 2 }, s.db);
    expect(second!.days.map((d) => d.date)).toEqual(days.slice(8, 18));
    const last = await getMeetingUpdatesFeed(q.buildMember, { page: 99 }, s.db);
    expect(last).toMatchObject({ page: 3 });
    expect(last!.days.map((d) => d.date)).toEqual(days.slice(18));

    const target = await s.db.meetingUpdate.findFirstOrThrow({ where: { meetingDate: dateOnlyToDb(days[12]) } });
    expect((await getMeetingUpdatesFeed(q.buildMember, { focusId: target.id }, s.db))!.page).toBe(2);
    // An explicit page wins; an unknown id opens the first page.
    expect((await getMeetingUpdatesFeed(q.buildMember, { focusId: target.id, page: 3 }, s.db))!.page).toBe(3);
    expect((await getMeetingUpdatesFeed(q.buildMember, { focusId: "missing" }, s.db))!.page).toBe(1);

    const software = await getMeetingUpdatesFeed(q.buildMember, { subteam: "SOFTWARE" }, s.db);
    expect(software).toMatchObject({ pageCount: 2, dayCount: 12 });
  });

  it("loads one update for the edit page", async () => {
    const row = await makeUpdate(s.db, q.bizMember, { subteam: "BUSINESS", body: "Pitch deck" });
    const detail = await getMeetingUpdate(q.bizMember, row.id, s.db);
    expect(detail).toMatchObject({ id: row.id, subteam: "BUSINESS", body: "Pitch deck", mine: true, canEdit: true, version: row.updatedAt.toISOString() });
    expect(await getMeetingUpdate(q.bizLead, row.id, s.db)).toMatchObject({ mine: false, canEdit: true });
    expect(await getMeetingUpdate(q.buildLead, row.id, s.db)).toMatchObject({ canEdit: false });
    expect(await getMeetingUpdate(q.bizMember, "missing", s.db)).toBeNull();
    expect(await getMeetingUpdate(q.disabledBuild, row.id, s.db)).toBeNull();
    await s.db.meetingUpdate.delete({ where: { id: row.id } });
  });

  it("getMeetingUpdatesBetween returns a date range by day, then subteam, then time written", async () => {
    const start = addDays(TEST_TODAY, -13);
    const between = await getMeetingUpdatesBetween(start, TEST_TODAY, s.db);
    expect(between.map((u) => [u.meetingDate, u.subteam, u.body])).toEqual([
      [addDays(TEST_TODAY, -2), "BUSINESS", "Sponsor emails"],
      [TEST_TODAY, "SOFTWARE", "Autonomous"],
      [TEST_TODAY, "BUILD", "Wiring, checked by the leader"],
      [TEST_TODAY, "BUILD", "Chassis"],
    ]);
    expect(between[2]).toMatchObject({ authorId: q.buildMember.id, authorName: "Ethan Build", lastEditedByName: "Blake Lead", blockers: "Need a new battery" });
    expect(between[3]).toMatchObject({ authorName: "Zara Build", lastEditedAt: null, lastEditedByName: null });

    // Both ends are included.
    const edges = await getMeetingUpdatesBetween(addDays(TEST_TODAY, -21), addDays(TEST_TODAY, -20), s.db);
    expect(edges.map((u) => u.meetingDate)).toEqual([addDays(TEST_TODAY, -21), addDays(TEST_TODAY, -20)]);
    expect(await getMeetingUpdatesBetween(TEST_TODAY, start, s.db)).toEqual([]);
    expect(await getMeetingUpdatesBetween("junk", TEST_TODAY, s.db)).toEqual([]);
  });

  it("tells the Today page whether today's update is written for the viewer's subteam", async () => {
    const yesterday = addDays(TEST_TODAY, -1);
    expect(await getTodayUpdateStatus(q.bizMember, TEST_TODAY, s.db)).toEqual({
      today: TEST_TODAY,
      subteams: [{ subteam: "BUSINESS", updates: [] }],
    });
    expect(await getTodayUpdateStatus(q.buildMember, TEST_TODAY, s.db)).toMatchObject({
      subteams: [
        {
          subteam: "BUILD",
          updates: [
            { authorName: "Ethan Build", mine: true },
            { authorName: "Zara Build", mine: false },
          ],
        },
      ],
    });
    // Yesterday: nothing yet for Build.
    expect((await getTodayUpdateStatus(q.buildLead, yesterday, s.db))!.subteams).toEqual([{ subteam: "BUILD", updates: [] }]);
    const captain = await getTodayUpdateStatus(q.captain, TEST_TODAY, s.db);
    expect(captain!.subteams.map((x) => [x.subteam, x.updates.length])).toEqual([
      ["SOFTWARE", 1],
      ["BUILD", 2],
      ["BUSINESS", 0],
    ]);
    expect(await getTodayUpdateStatus(q.noSubteam, TEST_TODAY, s.db)).toBeNull();
    expect(await getTodayUpdateStatus(q.disabledBuild, TEST_TODAY, s.db)).toBeNull();
  });

  it("keeps the most recently written updates when a page has more than the cap", async () => {
    const flooder = await makeUser(s.db, { role: "MEMBER", subteam: "BUILD", name: "Flo Flooder" });
    const date = addDays(TEST_TODAY, -100);
    await s.db.meetingUpdate.createMany({
      data: Array.from({ length: PAGE_UPDATES_MAX + 1 }, (_, i) => ({
        meetingDate: dateOnlyToDb(date),
        subteam: "BUILD" as const,
        body: `Flood ${i}`,
        authorId: flooder.id,
        createdAt: at(i),
      })),
    });
    const feed = await getMeetingUpdatesFeed(flooder, { mine: true }, s.db);
    const build = feed!.days[0].bySubteam.BUILD;
    expect(build).toHaveLength(PAGE_UPDATES_MAX);
    // Oldest first on the page, and the oldest one is the one left out.
    expect(build[0].body).toBe("Flood 1");
    expect(build.at(-1)!.body).toBe(`Flood ${PAGE_UPDATES_MAX}`);
    await s.db.meetingUpdate.deleteMany({ where: { authorId: flooder.id } });
  });
});
