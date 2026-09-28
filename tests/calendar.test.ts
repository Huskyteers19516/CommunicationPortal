import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CalendarEventKind } from "@/generated/prisma/enums";
import {
  addMonths,
  buildIcs,
  buildMonthGrid,
  CALENDAR_DATE_TOO_EARLY,
  CALENDAR_DATE_TOO_LATE,
  CALENDAR_END_BEFORE_START,
  CALENDAR_END_TIME_NEEDS_START,
  CALENDAR_END_TIME_ORDER,
  CALENDAR_KIND_MESSAGE,
  CALENDAR_LINK_MESSAGE,
  CALENDAR_SPAN_TOO_LONG,
  CALENDAR_TIME_MESSAGE,
  checkCalendarEventFields,
  countdownLabel,
  escapeIcsText,
  eventCountdown,
  eventIsOver,
  eventsOnDay,
  foldIcsLine,
  formatEventWhen,
  formatMonth,
  formatTime,
  formatTimeShort,
  icsFilename,
  type IcsEvent,
  monthLastDay,
  multiDayTimedEnds,
  parseMonthKey,
  parseTime,
  placeEventsOnGrid,
  timeInTimezone,
  zonedTimeToUtc,
} from "@/lib/calendar";
import { addDays, dateOnlyToDb, todayInTimezone } from "@/lib/dates";
import type { Actor } from "@/server/actor";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import {
  getCalendarEvent,
  getCalendarEventsBetween,
  getCalendarEventsForExport,
  getNextMeet,
  getPastCalendarEvents,
  getUpcomingCalendarEvents,
  ILT_SEASON_LOOKBACK_DAYS,
  isIltOnCalendar,
} from "@/server/queries/calendar";
import {
  CALENDAR_CREATE_RATE_LIMIT,
  CALENDAR_EVENT_CHANGED,
  createCalendarEvent,
  deleteCalendarEvent,
  updateCalendarEvent,
} from "@/server/services/calendar";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

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
  | "bizMember"
  | "pendingLead"
  | "disabledLead";

let t: TestDb;
let p: Record<Who, Actor>;

beforeAll(async () => {
  t = await createTestDb();
  const db = t.db;
  p = {
    owner: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true, name: "Olive Owner" }),
    captain: await makeUser(db, { role: "CAPTAIN", name: "Casey Captain" }),
    mentor: await makeUser(db, { role: "MENTOR", name: "Mia Mentor" }),
    teacher: await makeUser(db, { role: "TEACHER", name: "Theo Teacher" }),
    swLead: await makeUser(db, { role: "SOFTWARE_LEADER", name: "Sam Lead" }),
    buildLead: await makeUser(db, { role: "BUILD_LEADER", name: "Blake Lead" }),
    bizLead: await makeUser(db, { role: "BUSINESS_LEADER", name: "Amara Lead" }),
    swMember: await makeUser(db, { role: "MEMBER", subteam: "SOFTWARE", name: "Maya Software" }),
    buildMember: await makeUser(db, { role: "MEMBER", subteam: "BUILD", name: "Ethan Build" }),
    bizMember: await makeUser(db, { role: "MEMBER", subteam: "BUSINESS", name: "Gwen Business" }),
    pendingLead: await makeUser(db, { role: "BUILD_LEADER", status: "PENDING", name: "Pat Pending" }),
    disabledLead: await makeUser(db, { role: "SOFTWARE_LEADER", status: "DISABLED", name: "Dana Disabled" }),
  };
});

afterAll(async () => {
  await t?.drop();
});

// Each test starts from an empty calendar (the migrations load a few season events into every database).
beforeEach(async () => {
  await t.db.calendarEvent.deleteMany();
});

const ctxFor = (a: Actor) => contextFor(t.db, a);
const day = (n: number) => addDays(TEST_TODAY, n);

const validInput = (over: Record<string, unknown> = {}) => ({
  title: "League Meet 1",
  kind: "MEET",
  startsOn: day(10),
  endsOn: "",
  startTime: "08:00",
  endTime: "17:00",
  location: "Anaheim High School",
  link: "",
  notes: "Bring the robot.",
  ...over,
});

let n = 0;
/** An event straight in the DB (bypassing the service). Days are counted from TEST_TODAY. */
async function makeEvent(
  opts: { title?: string; kind?: CalendarEventKind; starts?: number; ends?: number | null; startTime?: string | null; endTime?: string | null } = {},
) {
  return t.db.calendarEvent.create({
    data: {
      title: opts.title ?? `Event ${++n}`,
      kind: opts.kind ?? "MEET",
      startsOn: dateOnlyToDb(day(opts.starts ?? 5)),
      endsOn: opts.ends === undefined || opts.ends === null ? null : dateOnlyToDb(day(opts.ends)),
      startTime: opts.startTime ?? null,
      endTime: opts.endTime ?? null,
      createdById: p.captain.id,
    },
  });
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

// ---------------------------------------------------------------------------------------------------------------

describe("who can change the calendar", () => {
  it("lets every leader, the captain, mentors, teachers, and owners add, edit, and remove events", async () => {
    for (const who of ["owner", "captain", "mentor", "teacher", "swLead", "buildLead", "bizLead"] as const) {
      const ctx = ctxFor(p[who]);
      const { id } = await createCalendarEvent(ctx, validInput({ title: `By ${who}` }));
      const row = await t.db.calendarEvent.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ title: `By ${who}`, kind: "MEET", startTime: "08:00", endTime: "17:00", createdById: p[who].id, updatedById: null });
      expect(row.startsOn).toEqual(dateOnlyToDb(day(10)));
      await updateCalendarEvent(ctx, { ...validInput({ title: `Edited by ${who}` }), eventId: id, version: row.updatedAt.toISOString() });
      expect(await t.db.calendarEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({ title: `Edited by ${who}`, updatedById: p[who].id });
      await expect(deleteCalendarEvent(ctx, { eventId: id })).resolves.toEqual({ title: `Edited by ${who}`, startsOn: day(10) });
      expect(await t.db.calendarEvent.count({ where: { id } })).toBe(0);
    }
  });

  it("refuses members and pending or disabled accounts", async () => {
    const e = await makeEvent({ title: "Keep me" });
    for (const who of ["swMember", "buildMember", "bizMember", "pendingLead", "disabledLead"] as const) {
      const ctx = ctxFor(p[who]);
      await expect(createCalendarEvent(ctx, validInput())).rejects.toThrow(ForbiddenError);
      await expect(updateCalendarEvent(ctx, { ...validInput({ title: "Hacked" }), eventId: e.id })).rejects.toThrow(ForbiddenError);
      await expect(deleteCalendarEvent(ctx, { eventId: e.id })).rejects.toThrow(ForbiddenError);
    }
    expect(await t.db.calendarEvent.count()).toBe(1);
    expect((await t.db.calendarEvent.findUniqueOrThrow({ where: { id: e.id } })).title).toBe("Keep me");
  });

  it("shows everyone the event, with the edit tools only for staff", async () => {
    const e = await makeEvent();
    for (const who of ["swMember", "bizMember", "buildLead", "teacher", "owner"] as const) {
      const detail = await getCalendarEvent(p[who], e.id, t.db);
      expect(detail?.id, who).toBe(e.id);
      expect(detail?.canManage, who).toBe(!who.endsWith("Member"));
    }
    expect(await getCalendarEvent(p.swMember, "missing", t.db)).toBeNull();
  });

  it("limits how many events one person adds in an hour", async () => {
    // The mentor has already added the most this hour.
    const key = `calendar-create:${p.mentor.id}`;
    const full = { count: CALENDAR_CREATE_RATE_LIMIT.limit, windowStart: TEST_NOW };
    await t.db.rateLimit.upsert({ where: { key }, create: { key, ...full }, update: full });
    await expect(createCalendarEvent(ctxFor(p.mentor), validInput())).rejects.toThrow(RateLimitError);
    expect(await t.db.calendarEvent.count()).toBe(0);
    // Someone else isn't affected.
    await createCalendarEvent(ctxFor(p.teacher), validInput());
  });
});

describe("event fields", () => {
  const ctx = () => ctxFor(p.captain);
  const create = (over: Record<string, unknown>) => createCalendarEvent(ctx(), validInput(over));
  const saved = async (over: Record<string, unknown>) => {
    const { id } = await create(over);
    return t.db.calendarEvent.findUniqueOrThrow({ where: { id } });
  };

  it("requires a title within the limit and a kind", async () => {
    expect(await fieldError(create({ title: "   " }), "title")).toBe("Title is required.");
    expect(await fieldError(create({ title: "x".repeat(121) }), "title")).toMatch(/at most 120/);
    expect(await fieldError(create({ kind: "" }), "kind")).toBe(CALENDAR_KIND_MESSAGE);
    expect(await fieldError(create({ kind: "PARTY" }), "kind")).toBe(CALENDAR_KIND_MESSAGE);
    expect((await saved({ title: "  ILT  ", kind: "ILT" })).title).toBe("ILT");
  });

  it("requires a real date, and catches a year typo (more than 5 years back or 2 years ahead)", async () => {
    expect(await fieldError(create({ startsOn: "" }), "startsOn")).toBe("Pick a date.");
    expect(await fieldError(create({ startsOn: "2026-02-30" }), "startsOn")).toBe("Pick a valid date.");
    expect(await fieldError(create({ startsOn: "0026-10-03" }), "startsOn")).toBe(CALENDAR_DATE_TOO_EARLY);
    expect(await fieldError(create({ startsOn: "0000-01-01" }), "startsOn")).toBe(CALENDAR_DATE_TOO_EARLY);
    expect(await fieldError(create({ startsOn: day(2 * 365 + 1) }), "startsOn")).toBe(CALENDAR_DATE_TOO_LATE);
    expect(await fieldError(create({ startsOn: day(1), endsOn: "9999-12-31" }), "endsOn")).toBe(CALENDAR_DATE_TOO_LATE);
    // The edges are fine.
    await create({ startsOn: day(-5 * 365) });
    await create({ startsOn: day(2 * 365) });
  });

  it("wants the last day on or after the first, and at most 30 days later", async () => {
    expect(await fieldError(create({ startsOn: "2026-10-10", endsOn: "2026-10-09" }), "endsOn")).toBe(CALENDAR_END_BEFORE_START);
    expect(await fieldError(create({ startsOn: "2026-10-01", endsOn: "2026-11-01" }), "endsOn")).toBe(CALENDAR_SPAN_TOO_LONG);
    const month = await saved({ startsOn: "2026-10-01", endsOn: "2026-10-31", startTime: "", endTime: "" });
    expect(month.endsOn).toEqual(dateOnlyToDb("2026-10-31"));
    // A last day equal to the first is a one-day event.
    const oneDay = await saved({ startsOn: "2026-10-10", endsOn: "2026-10-10" });
    expect(oneDay.endsOn).toBeNull();
  });

  it("reads times like people type them and checks their order", async () => {
    for (const bad of ["25:00", "12:60", "abc", "8", "13 pm", "0 am"]) {
      expect(await fieldError(create({ startTime: bad, endTime: "" }), "startTime"), bad).toBe(CALENDAR_TIME_MESSAGE);
    }
    expect(await fieldError(create({ endTime: "9:99" }), "endTime")).toBe(CALENDAR_TIME_MESSAGE);
    expect(await saved({ startTime: "8:30 pm", endTime: "" })).toMatchObject({ startTime: "20:30", endTime: null });
    expect(await saved({ startTime: "12 am", endTime: "07:00:00" })).toMatchObject({ startTime: "00:00", endTime: "07:00" });
    expect(await saved({ startTime: "", endTime: "" })).toMatchObject({ startTime: null, endTime: null });
    // An end time needs a start time; on a one-day event it must be later.
    expect(await fieldError(create({ startTime: "", endTime: "17:00" }), "endTime")).toBe(CALENDAR_END_TIME_NEEDS_START);
    expect(await fieldError(create({ startTime: "17:00", endTime: "17:00" }), "endTime")).toBe(CALENDAR_END_TIME_ORDER);
    expect(await fieldError(create({ startTime: "17:00", endTime: "08:00" }), "endTime")).toBe(CALENDAR_END_TIME_ORDER);
    // Over several days it runs from the first day's start to the last day's end, so an earlier clock time is fine.
    expect(await saved({ startsOn: day(3), endsOn: day(4), startTime: "17:00", endTime: "08:00" })).toMatchObject({
      startTime: "17:00",
      endTime: "08:00",
    });
  });

  it("keeps location and notes within their limits", async () => {
    expect(await fieldError(create({ location: "x".repeat(201) }), "location")).toMatch(/at most 200/);
    expect(await fieldError(create({ notes: "x".repeat(5001) }), "notes")).toMatch(/at most 5000/);
    expect(await saved({ location: "", notes: "" })).toMatchObject({ location: "", notes: "" });
  });

  it("adds https:// to a bare link and refuses anything that isn't a web link", async () => {
    expect((await saved({ link: "ftc-events.firstinspires.org/2026/USCALS" })).link).toBe("https://ftc-events.firstinspires.org/2026/USCALS");
    expect((await saved({ link: "http://example.com/signup" })).link).toBe("http://example.com/signup");
    expect((await saved({ link: "  " })).link).toBe("");
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "not a link", "https://user:pw@example.com"]) {
      expect(await fieldError(create({ link: bad }), "link"), bad).toBe(CALENDAR_LINK_MESSAGE);
    }
  });

  it("shows every problem at once", async () => {
    const err = await create({ title: "", startsOn: "2026-10-10", endsOn: "2026-10-08", startTime: "", endTime: "10:00", link: "javascript:x" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationError);
    const { fieldErrors, userMessage } = err as ValidationError;
    expect(Object.keys(fieldErrors).sort()).toEqual(["endTime", "endsOn", "link", "title"]);
    expect(userMessage).toBe("Please fix the highlighted fields.");
    expect(await t.db.calendarEvent.count()).toBe(0);
  });

  it("lets an edit keep a date that's out of range now, but not change to one", async () => {
    const e = await makeEvent({ starts: -6 * 365, ends: -6 * 365 + 1 });
    const kept = { startsOn: day(-6 * 365), endsOn: day(-6 * 365 + 1) };
    await updateCalendarEvent(ctx(), { ...validInput({ ...kept, title: "Old but kept" }), eventId: e.id });
    expect((await t.db.calendarEvent.findUniqueOrThrow({ where: { id: e.id } })).title).toBe("Old but kept");
    expect(await fieldError(updateCalendarEvent(ctx(), { ...validInput({ ...kept, endsOn: day(-6 * 365 + 2) }), eventId: e.id }), "endsOn")).toBe(
      CALENDAR_DATE_TOO_EARLY,
    );
  });

  it("gives the client and the server the same check", () => {
    const result = checkCalendarEventFields(validInput({ endsOn: day(10), startTime: "9:15 am", link: "example.com" }), TEST_TODAY);
    expect(result).toEqual({
      ok: true,
      value: {
        title: "League Meet 1",
        kind: "MEET",
        startsOn: day(10),
        endsOn: null,
        startTime: "09:15",
        endTime: "17:00",
        location: "Anaheim High School",
        link: "https://example.com/",
        notes: "Bring the robot.",
      },
    });
    expect(checkCalendarEventFields({}, TEST_TODAY)).toEqual({
      ok: false,
      fieldErrors: { title: "Title is required.", kind: CALENDAR_KIND_MESSAGE, startsOn: "Pick a date." },
    });
  });
});

describe("editing and removing", () => {
  it("refuses a save from a form opened before someone else's edit", async () => {
    const { id } = await createCalendarEvent(ctxFor(p.captain), validInput({ title: "Meet" }));
    const opened = (await getCalendarEvent(p.mentor, id, t.db))!.version;
    const openedToo = opened;
    // The mentor saves first…
    await updateCalendarEvent(ctxFor(p.mentor), { ...validInput({ title: "Meet (moved)" }), eventId: id, version: opened });
    // …so the teacher's form (opened at the same time) is stale.
    await expect(
      updateCalendarEvent(ctxFor(p.teacher), { ...validInput({ title: "Meet (teacher)" }), eventId: id, version: openedToo }),
    ).rejects.toThrow(CALENDAR_EVENT_CHANGED);
    let row = await t.db.calendarEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ title: "Meet (moved)", updatedById: p.mentor.id });
    // With the newest version (the page refreshed), saving again replaces it.
    await updateCalendarEvent(ctxFor(p.teacher), { ...validInput({ title: "Meet (teacher)" }), eventId: id, version: row.updatedAt.toISOString() });
    row = await t.db.calendarEvent.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ title: "Meet (teacher)", updatedById: p.teacher.id });
    // A version that isn't a date is a conflict too, not a crash.
    await expect(updateCalendarEvent(ctxFor(p.teacher), { ...validInput(), eventId: id, version: "yesterday" })).rejects.toThrow(ConflictError);
    // Without a version the last save wins.
    await updateCalendarEvent(ctxFor(p.captain), { ...validInput({ title: "No version" }), eventId: id });
    expect((await t.db.calendarEvent.findUniqueOrThrow({ where: { id } })).title).toBe("No version");
  });

  it("says a stale form was changed by someone else even when a field is wrong too, so the next save can't silently replace it", async () => {
    const { id } = await createCalendarEvent(ctxFor(p.captain), validInput({ title: "Meet", location: "Gym" }));
    const opened = (await getCalendarEvent(p.mentor, id, t.db))!.version;
    // Someone else saves a new venue…
    await updateCalendarEvent(ctxFor(p.teacher), { ...validInput({ title: "Meet", location: "New venue" }), eventId: id, version: opened });
    // …then the stale form comes in with an end time before its start time: the conflict wins over the field error.
    const stale = updateCalendarEvent(ctxFor(p.mentor), {
      ...validInput({ title: "Meet", location: "Gym", startTime: "08:00", endTime: "07:00" }),
      eventId: id,
      version: opened,
    });
    await expect(stale).rejects.toBeInstanceOf(ConflictError);
    await expect(stale).rejects.toThrow(CALENDAR_EVENT_CHANGED);
    expect((await t.db.calendarEvent.findUniqueOrThrow({ where: { id } })).location).toBe("New venue");
    // With the fresh version (after the warning), the field error shows as usual.
    const fresh = (await getCalendarEvent(p.mentor, id, t.db))!.version;
    expect(
      await fieldError(updateCalendarEvent(ctxFor(p.mentor), { ...validInput({ endTime: "07:00" }), eventId: id, version: fresh }), "endTime"),
    ).toBe(CALENDAR_END_TIME_ORDER);
  });

  it("says who added and last edited it", async () => {
    const { id } = await createCalendarEvent(ctxFor(p.captain), validInput());
    let detail = await getCalendarEvent(p.swMember, id, t.db);
    expect(detail).toMatchObject({ createdBy: { id: p.captain.id, name: "Casey Captain" }, updatedBy: null, notes: "Bring the robot." });
    await updateCalendarEvent(ctxFor(p.buildLead), { ...validInput(), eventId: id, version: detail!.version });
    detail = await getCalendarEvent(p.swMember, id, t.db);
    expect(detail).toMatchObject({ createdBy: { name: "Casey Captain" }, updatedBy: { id: p.buildLead.id, name: "Blake Lead" } });
    expect(detail!.version).toBe(detail!.updatedAt);
  });

  it("removes an event once; unknown events are not found", async () => {
    const e = await makeEvent({ title: "Gone soon", starts: 3 });
    await expect(deleteCalendarEvent(ctxFor(p.teacher), { eventId: e.id })).resolves.toEqual({ title: "Gone soon", startsOn: day(3) });
    await expect(deleteCalendarEvent(ctxFor(p.teacher), { eventId: e.id })).rejects.toThrow(NotFoundError);
    await expect(updateCalendarEvent(ctxFor(p.teacher), { ...validInput(), eventId: e.id })).rejects.toThrow(NotFoundError);
    await expect(deleteCalendarEvent(ctxFor(p.teacher), {})).rejects.toThrow(ValidationError);
  });
});

describe("the next meet", () => {
  it("is null with nothing coming up", async () => {
    await makeEvent({ kind: "MEET", starts: -3 });
    await makeEvent({ kind: "OUTREACH", starts: 2 });
    expect(await getNextMeet(TEST_TODAY, null, t.db)).toBeNull();
  });

  it("skips past events and non-meet kinds, and lists the next two after it", async () => {
    await makeEvent({ title: "Last week's meet", kind: "MEET", starts: -7 });
    await makeEvent({ title: "Outreach tomorrow", kind: "OUTREACH", starts: 1 });
    await makeEvent({ title: "Deadline", kind: "DEADLINE", starts: 2 });
    await makeEvent({ title: "Team social", kind: "TEAM", starts: 3 });
    await makeEvent({ title: "League Meet 2", kind: "MEET", starts: 12 });
    await makeEvent({ title: "Scrimmage", kind: "SCRIMMAGE", starts: 20 });
    await makeEvent({ title: "ILT", kind: "ILT", starts: 40, ends: 41 });
    await makeEvent({ title: "Regional", kind: "COMPETITION", starts: 60 });
    const next = await getNextMeet(TEST_TODAY, null, t.db);
    expect(next?.event.title).toBe("League Meet 2");
    expect(next?.following.map((e) => e.title)).toEqual(["Scrimmage", "ILT"]);
    expect(eventCountdown(next!.event, TEST_TODAY)).toMatchObject({ daysUntil: 12, happeningNow: false, label: "In 12 days" });
  });

  it("counts a multi-day event in progress, and a meet today", async () => {
    await makeEvent({ title: "Meet later", kind: "MEET", starts: 5 });
    await makeEvent({ title: "ILT weekend", kind: "ILT", starts: -1, ends: 1 });
    let next = await getNextMeet(TEST_TODAY, null, t.db);
    expect(next?.event.title).toBe("ILT weekend");
    expect(eventCountdown(next!.event, TEST_TODAY)).toMatchObject({ happeningNow: true, label: "Happening now" });
    // The day after it ended, the next one takes over.
    next = await getNextMeet(day(2), null, t.db);
    expect(next?.event.title).toBe("Meet later");

    await makeEvent({ title: "Meet today", kind: "MEET", starts: 6, startTime: "18:00" });
    next = await getNextMeet(day(6), null, t.db);
    expect(next?.event.title).toBe("Meet today");
    expect(eventCountdown(next!.event, day(6)).label).toBe("Today");
  });

  it("moves on once today's meet has ended (team timezone)", async () => {
    // The season's Saturdays: 7 AM – 12 PM.
    await makeEvent({ title: "League Scrimmage 0", kind: "SCRIMMAGE", starts: 37, startTime: "07:00", endTime: "12:00" });
    await makeEvent({ title: "League Scrimmage 1", kind: "SCRIMMAGE", starts: 51, startTime: "07:00", endTime: "12:00" });
    await makeEvent({ title: "League Scrimmage 2", kind: "SCRIMMAGE", starts: 72, startTime: "07:00", endTime: "12:00" });
    const meetDay = day(37);
    expect(meetDay).toBe("2026-10-31");
    // 3 PM in Anaheim on Oct 31 (22:00 UTC): Scrimmage 0 is over, so the countdown is to Scrimmage 1.
    const afternoon = new Date("2026-10-31T22:00:00Z");
    expect(todayInTimezone(TEST_TZ, afternoon)).toBe(meetDay);
    expect(timeInTimezone(TEST_TZ, afternoon)).toBe("15:00");
    let next = await getNextMeet(meetDay, timeInTimezone(TEST_TZ, afternoon), t.db);
    expect(next?.event.title).toBe("League Scrimmage 1");
    expect(next?.following.map((e) => e.title)).toEqual(["League Scrimmage 2"]);
    expect(eventCountdown(next!.event, meetDay).label).toBe("In 14 days");
    // Until it ends it's still today's; at its end time it's over.
    expect((await getNextMeet(meetDay, "11:59", t.db))?.event.title).toBe("League Scrimmage 0");
    expect((await getNextMeet(meetDay, "12:00", t.db))?.event.title).toBe("League Scrimmage 1");
    // Without a time, all of today counts.
    expect((await getNextMeet(meetDay, null, t.db))?.event.title).toBe("League Scrimmage 0");

    // Without an end time a meet lasts all day; a multi-day one ends at its last day's end time.
    await makeEvent({ title: "Meet with no end time", kind: "MEET", starts: 37, startTime: "08:00" });
    await makeEvent({ title: "Tournament weekend", kind: "ILT", starts: 35, ends: 37, startTime: "09:00", endTime: "13:00" });
    await makeEvent({ title: "All-day competition", kind: "COMPETITION", starts: 36, ends: 37 });
    next = await getNextMeet(meetDay, "15:00", t.db);
    expect([next!.event, ...next!.following].map((e) => e.title)).toEqual(["All-day competition", "Meet with no end time", "League Scrimmage 1"]);
    next = await getNextMeet(meetDay, "12:30", t.db);
    expect(next?.event.title).toBe("Tournament weekend");
  });

  it("orders meets on the same day by start time (all day first)", async () => {
    await makeEvent({ title: "Afternoon scrimmage", kind: "SCRIMMAGE", starts: 4, startTime: "13:00" });
    await makeEvent({ title: "Morning meet", kind: "MEET", starts: 4, startTime: "08:00", endTime: "12:00" });
    await makeEvent({ title: "All-day competition", kind: "COMPETITION", starts: 4 });
    await makeEvent({ title: "Earlier day", kind: "MEET", starts: 3, startTime: "19:00" });
    const next = await getNextMeet(day(4), null, t.db);
    expect([next!.event, ...next!.following].map((e) => e.title)).toEqual(["All-day competition", "Morning meet", "Afternoon scrimmage"]);
  });
});

describe("the ILT's date", () => {
  it("counts as on the calendar once there's an ILT coming up or one from this season", async () => {
    expect(await isIltOnCalendar(TEST_TODAY, t.db)).toBe(false);
    await makeEvent({ title: "Regional", kind: "COMPETITION", starts: 30 });
    expect(await isIltOnCalendar(TEST_TODAY, t.db)).toBe(false);
    const upcoming = await makeEvent({ title: "ILT", kind: "ILT", starts: 90, ends: 91 });
    expect(await isIltOnCalendar(TEST_TODAY, t.db)).toBe(true);
    await t.db.calendarEvent.delete({ where: { id: upcoming.id } });
    // Last season's: still this season's a few months on, not by the next fall.
    await makeEvent({ title: "Old ILT", kind: "ILT", starts: -ILT_SEASON_LOOKBACK_DAYS - 1, ends: -ILT_SEASON_LOOKBACK_DAYS });
    expect(await isIltOnCalendar(TEST_TODAY, t.db)).toBe(true);
    expect(await isIltOnCalendar(day(1), t.db)).toBe(false);
  });
});

describe("calendar queries", () => {
  it("loads the events that overlap a month grid, leading and trailing days included", async () => {
    // October 2026's grid runs Sun Sep 27 – Sat Oct 31.
    await makeEvent({ title: "Ends in the leading days", kind: "TEAM", starts: -4, ends: 3 }); // Sep 20 – Sep 27
    await makeEvent({ title: "Before the grid", starts: -4, ends: 2 }); // Sep 20 – Sep 26
    await makeEvent({ title: "In October", kind: "OUTREACH", starts: 20 }); // Oct 14
    await makeEvent({ title: "Across the month end", starts: 37, ends: 39 }); // Oct 31 – Nov 2
    await makeEvent({ title: "November", starts: 38 }); // Nov 1
    const grid = buildMonthGrid("2026-10");
    const all = await getCalendarEventsBetween({ from: grid.first, to: grid.last }, t.db);
    expect(all.map((e) => e.title)).toEqual(["Ends in the leading days", "In October", "Across the month end"]);
    expect(all[2]).toMatchObject({ startsOn: "2026-10-31", endsOn: "2026-11-02", kind: "MEET" });
    const outreach = await getCalendarEventsBetween({ from: grid.first, to: grid.last, kind: "OUTREACH" }, t.db);
    expect(outreach.map((e) => e.title)).toEqual(["In October"]);
  });

  it("lists what's coming up (including events in progress) and what's past", async () => {
    await makeEvent({ title: "Past", starts: -10 });
    await makeEvent({ title: "Older", starts: -30, ends: -29 });
    await makeEvent({ title: "In progress", kind: "TEAM", starts: -2, ends: 1 });
    await makeEvent({ title: "Soon", starts: 2, startTime: "09:00" });
    await makeEvent({ title: "Soon, all day", kind: "DEADLINE", starts: 2 });
    await makeEvent({ title: "Ended yesterday", starts: -1 });
    const upcoming = await getUpcomingCalendarEvents({ today: TEST_TODAY }, t.db);
    expect(upcoming.items.map((e) => e.title)).toEqual(["In progress", "Soon, all day", "Soon"]);
    expect(upcoming.truncated).toBe(false);
    expect((await getUpcomingCalendarEvents({ today: TEST_TODAY, kind: "DEADLINE" }, t.db)).items.map((e) => e.title)).toEqual(["Soon, all day"]);
    expect((await getUpcomingCalendarEvents({ today: TEST_TODAY, limit: 1 }, t.db)).truncated).toBe(true);
    const past = await getPastCalendarEvents({ today: TEST_TODAY }, t.db);
    expect(past.items.map((e) => e.title)).toEqual(["Ended yesterday", "Past", "Older"]);
    expect(past.total).toBe(3);
    const capped = await getPastCalendarEvents({ today: TEST_TODAY, limit: 2 }, t.db);
    expect(capped).toMatchObject({ total: 3 });
    expect(capped.items).toHaveLength(2);
  });

  it("exports events from a day onward with their notes", async () => {
    await makeEvent({ title: "Long ago", starts: -400 });
    const kept = await makeEvent({ title: "This season", starts: -100 });
    await t.db.calendarEvent.update({ where: { id: kept.id }, data: { notes: "Wear team shirts", location: "Gym" } });
    const events = await getCalendarEventsForExport(day(-365), t.db);
    expect(events.map((e) => e.title)).toEqual(["This season"]);
    expect(events[0]).toMatchObject({ notes: "Wear team shirts", location: "Gym", link: "" });
    expect(buildIcs(events, { teamTimezone: "America/Los_Angeles", now: TEST_NOW, calendarName: "Team" })).toContain("SUMMARY:This season\r\n");
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe("labels", () => {
  const today = "2026-09-24";
  const ev = (over: Partial<IcsEvent>) => ({ startsOn: "2026-10-17", endsOn: null, startTime: null, endTime: null, ...over });

  it("formats times and parses what people type", () => {
    expect(formatTime("08:00")).toBe("8:00 AM");
    expect(formatTime("00:05")).toBe("12:05 AM");
    expect(formatTime("12:30")).toBe("12:30 PM");
    expect(formatTime("23:59")).toBe("11:59 PM");
    expect(formatTimeShort("08:00")).toBe("8am");
    expect(formatTimeShort("13:30")).toBe("1:30pm");
    expect(parseTime("08:00")).toBe("08:00");
    expect(parseTime(" 7:05 ")).toBe("07:05");
    expect(parseTime("7:05 PM")).toBe("19:05");
    expect(parseTime("7pm")).toBe("19:00");
    expect(parseTime("12:15 a.m.")).toBe("00:15");
    expect(parseTime("12 PM")).toBe("12:00");
    expect(parseTime("23:59:59")).toBe("23:59");
    for (const bad of ["", "7", "24:00", "7:5", "13pm", "noon", "7:00 xm"]) expect(parseTime(bad), bad).toBeNull();
  });

  it("says when an event is", () => {
    expect(formatEventWhen(ev({ startTime: "08:00", endTime: "17:00" }), today)).toBe("Sat, Oct 17 · 8:00 AM – 5:00 PM");
    expect(formatEventWhen(ev({ startTime: "08:00" }), today)).toBe("Sat, Oct 17 · 8:00 AM");
    expect(formatEventWhen(ev({}), today)).toBe("Sat, Oct 17 · All day");
    expect(formatEventWhen(ev({ startsOn: "2027-01-08", endsOn: "2027-01-10" }), today)).toBe("Fri, Jan 8, 2027 – Sun, Jan 10, 2027");
    expect(formatEventWhen(ev({ startsOn: "2026-11-06", endsOn: "2026-11-08" }), today)).toBe("Fri, Nov 6 – Sun, Nov 8");
    expect(formatEventWhen(ev({ startsOn: "2026-11-07", endsOn: "2026-11-08", startTime: "08:00", endTime: "15:00" }), today)).toBe(
      "Sat, Nov 7, 8:00 AM – Sun, Nov 8, 3:00 PM",
    );
  });

  it("shows a multi-day event's times with their days", () => {
    expect(multiDayTimedEnds(ev({ startsOn: "2026-10-09", endsOn: "2026-10-11", startTime: "17:00", endTime: "12:00" }), today)).toEqual({
      starts: "Fri, Oct 9, 5:00 PM",
      ends: "Sun, Oct 11, 12:00 PM",
    });
    expect(multiDayTimedEnds(ev({ startsOn: "2026-10-09", endsOn: "2026-10-11", startTime: "09:00" }), today)).toEqual({
      starts: "Fri, Oct 9, 9:00 AM",
      ends: "Sun, Oct 11",
    });
    // One-day and all-day events show dates and times apart.
    expect(multiDayTimedEnds(ev({ startTime: "08:00", endTime: "17:00" }), today)).toBeNull();
    expect(multiDayTimedEnds(ev({ startsOn: "2026-10-09", endsOn: "2026-10-11" }), today)).toBeNull();
  });

  it("knows the team's wall-clock time and when an event is over", () => {
    expect(timeInTimezone(TEST_TZ, new Date("2026-10-31T22:00:00Z"))).toBe("15:00");
    expect(timeInTimezone(TEST_TZ, new Date("2026-12-05T07:59:00Z"))).toBe("23:59"); // PST
    expect(timeInTimezone(TEST_TZ, new Date("2026-12-05T08:00:00Z"))).toBe("00:00");
    expect(timeInTimezone("UTC", new Date("2026-07-01T00:05:00Z"))).toBe("00:05");
    const meet = ev({ startTime: "07:00", endTime: "12:00" });
    expect(eventIsOver(meet, "2026-10-17", "11:59")).toBe(false);
    expect(eventIsOver(meet, "2026-10-17", "12:00")).toBe(true);
    expect(eventIsOver(meet, "2026-10-17", null)).toBe(false);
    expect(eventIsOver(meet, "2026-10-16", "23:00")).toBe(false);
    expect(eventIsOver(meet, "2026-10-18", "00:00")).toBe(true);
    expect(eventIsOver(ev({ startTime: "07:00" }), "2026-10-17", "23:59")).toBe(false);
    expect(eventIsOver(ev({ startsOn: "2026-10-16", endsOn: "2026-10-17", startTime: "18:00", endTime: "10:00" }), "2026-10-17", "10:30")).toBe(true);
  });

  it("counts down", () => {
    expect(countdownLabel(0)).toBe("Today");
    expect(countdownLabel(1)).toBe("Tomorrow");
    expect(countdownLabel(12)).toBe("In 12 days");
    expect(countdownLabel(-1)).toBe("Yesterday");
    expect(countdownLabel(-5)).toBe("5 days ago");
    expect(countdownLabel(-2, true)).toBe("Happening now");
    expect(eventCountdown({ startsOn: "2026-09-23", endsOn: "2026-09-25" }, today)).toEqual({
      daysUntil: -1,
      happeningNow: true,
      past: false,
      label: "Happening now",
    });
    // A multi-day event that starts today says "Today"; one that ended says how long ago its last day was.
    expect(eventCountdown({ startsOn: today, endsOn: "2026-09-26" }, today).label).toBe("Today");
    expect(eventCountdown({ startsOn: "2026-09-10", endsOn: "2026-09-21" }, today)).toMatchObject({ past: true, label: "3 days ago" });
  });
});

describe("month grid", () => {
  it("parses and steps months", () => {
    expect(parseMonthKey("2026-10")).toBe("2026-10");
    for (const bad of ["2026-13", "2026-1", "2026-00", "abc", "1969-12", "2200-01", undefined, ["2026-10"]]) expect(parseMonthKey(bad)).toBeNull();
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-10", -22)).toBe("2024-12");
    expect(formatMonth("2026-10")).toBe("October 2026");
    expect(monthLastDay("2028-02")).toBe("2028-02-29");
    expect(monthLastDay("2026-02")).toBe("2026-02-28");
  });

  it("builds whole weeks, Sunday first, with the days around the month", () => {
    const oct = buildMonthGrid("2026-10");
    expect(oct).toMatchObject({ first: "2026-09-27", last: "2026-10-31" });
    expect(oct.weeks).toHaveLength(5);
    expect(oct.weeks[0][0]).toEqual({ date: "2026-09-27", day: 27, inMonth: false });
    expect(oct.weeks[0][4]).toEqual({ date: "2026-10-01", day: 1, inMonth: true });
    expect(oct.weeks.every((w) => w.length === 7)).toBe(true);
    // February 2026 starts on a Sunday and ends on a Saturday: exactly 4 weeks.
    const feb = buildMonthGrid("2026-02");
    expect(feb).toMatchObject({ first: "2026-02-01", last: "2026-02-28" });
    expect(feb.weeks).toHaveLength(4);
    expect(feb.weeks.flat().every((d) => d.inMonth)).toBe(true);
    // August 2026 starts on a Saturday: 6 weeks.
    const aug = buildMonthGrid("2026-08");
    expect(aug).toMatchObject({ first: "2026-07-26", last: "2026-09-05" });
    expect(aug.weeks).toHaveLength(6);
  });

  it("places multi-day events on each of their days, in the same lane across a week", () => {
    const e = (id: string, startsOn: string, endsOn: string | null = null, startTime: string | null = null) => ({
      id,
      title: id,
      startsOn,
      endsOn,
      startTime,
      endTime: null,
    });
    const grid = buildMonthGrid("2026-10");
    const events = [
      e("B", "2026-10-03"),
      e("C", "2026-10-02", null, "18:00"),
      e("A", "2026-10-02", "2026-10-05"), // Fri – Mon: crosses into the next week
      e("I", "2026-10-11", "2026-10-12"),
      e("H", "2026-10-12", "2026-10-14"),
      e("Z", "2026-11-20"), // not on this grid
    ];
    const placed = placeEventsOnGrid(grid, events);
    const lanes = (date: string) => (placed.get(date) ?? []).map((pl) => (pl ? pl.event.id : null));
    expect(lanes("2026-10-02")).toEqual(["A", "C"]);
    expect(lanes("2026-10-03")).toEqual(["A", "B"]); // C's lane is free again
    expect(lanes("2026-10-04")).toEqual(["A"]);
    expect(lanes("2026-10-05")).toEqual(["A"]);
    expect(lanes("2026-10-06")).toEqual([]);
    expect(placed.get("2026-10-02")![0]).toMatchObject({ startsHere: true, endsHere: false, segmentStart: true, segmentEnd: false, segmentDays: 2 });
    expect(placed.get("2026-10-03")![0]).toMatchObject({ segmentStart: false, segmentEnd: true });
    // The next week's piece starts on Sunday, continuing from Saturday.
    expect(placed.get("2026-10-04")![0]).toMatchObject({ startsHere: false, segmentStart: true, segmentDays: 2 });
    expect(placed.get("2026-10-05")![0]).toMatchObject({ endsHere: true, segmentEnd: true });
    // A free lane below a busy one is an explicit gap, so bars stay lined up.
    expect(lanes("2026-10-12")).toEqual(["I", "H"]);
    expect(lanes("2026-10-13")).toEqual([null, "H"]);
    expect(placed.has("2026-11-20")).toBe(false);
    expect(eventsOnDay(events, "2026-10-03").map((x) => x.id)).toEqual(["A", "B"]);
    expect(eventsOnDay(events, "2026-10-02").map((x) => x.id)).toEqual(["A", "C"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe(".ics files", () => {
  const LA = "America/Los_Angeles";
  const iso = (d: Date) => d.toISOString();
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const unfold = (s: string) => s.replace(/\r\n /g, "");

  const icsEvent = (over: Partial<IcsEvent> = {}): IcsEvent => ({
    id: "evt1",
    title: "League Meet 2",
    kind: "MEET",
    startsOn: "2026-10-17",
    endsOn: null,
    startTime: null,
    endTime: null,
    location: "",
    link: "",
    notes: "",
    ...over,
  });
  const ics = (events: IcsEvent[], name = "Huskyteers team calendar") => buildIcs(events, { teamTimezone: LA, now: TEST_NOW, calendarName: name });

  it("escapes text values", () => {
    expect(escapeIcsText("a\\b;c,d\ne\r\nf\rg")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\ng");
    expect(escapeIcsText("tab\there, bell\u0007 gone")).toBe("tab\there\\, bell gone");
  });

  it("folds lines at 75 octets without splitting a character", () => {
    const short = `SUMMARY:${"x".repeat(67)}`; // exactly 75
    expect(foldIcsLine(short)).toBe(short);
    const long = `DESCRIPTION:${"abcdefghij".repeat(30)}`;
    const folded = foldIcsLine(long);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(4);
    expect(lines.every((l) => bytes(l) <= 75)).toBe(true);
    expect(bytes(lines[0])).toBe(75);
    expect(lines.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    expect(unfold(folded)).toBe(long);
    // 74 ASCII octets then a 2-octet "é": it moves to the next line whole.
    const edge = foldIcsLine(`${"y".repeat(74)}é`);
    expect(edge.split("\r\n")).toEqual(["y".repeat(74), " é"]);
    // Multi-byte text (2-, 3-, and 4-octet characters).
    const intl = `SUMMARY:${"é".repeat(40)}${"中文".repeat(20)}${"🤖".repeat(25)}`;
    const intlLines = foldIcsLine(intl).split("\r\n");
    for (const l of intlLines) {
      expect(bytes(l)).toBeLessThanOrEqual(75);
      expect(loneSurrogate.test(l)).toBe(false);
    }
    expect(unfold(foldIcsLine(intl))).toBe(intl);
  });

  it("converts the team's wall-clock times to UTC, across daylight saving changes", () => {
    const utc = (date: string, time: string, tz = LA) => iso(zonedTimeToUtc(date, time, tz));
    // Anaheim: PDT is UTC-7, PST is UTC-8.
    expect(utc("2026-10-17", "08:00")).toBe("2026-10-17T15:00:00.000Z");
    expect(utc("2026-12-05", "07:00")).toBe("2026-12-05T15:00:00.000Z");
    // Spring forward (Sun Mar 8, 2026, 2:00 AM → 3:00 AM).
    expect(utc("2026-03-07", "12:00")).toBe("2026-03-07T20:00:00.000Z");
    expect(utc("2026-03-08", "01:30")).toBe("2026-03-08T09:30:00.000Z");
    expect(utc("2026-03-08", "02:30")).toBe("2026-03-08T10:30:00.000Z"); // doesn't exist: moves forward to 3:30 AM
    expect(utc("2026-03-08", "03:30")).toBe("2026-03-08T10:30:00.000Z");
    expect(utc("2026-03-08", "12:00")).toBe("2026-03-08T19:00:00.000Z");
    // Fall back (Sun Nov 1, 2026, 2:00 AM → 1:00 AM).
    expect(utc("2026-11-01", "00:30")).toBe("2026-11-01T07:30:00.000Z");
    expect(utc("2026-11-01", "01:30")).toBe("2026-11-01T08:30:00.000Z"); // happens twice: the first one
    expect(utc("2026-11-01", "02:30")).toBe("2026-11-01T10:30:00.000Z");
    expect(utc("2026-11-01", "12:00")).toBe("2026-11-01T20:00:00.000Z");
    expect(utc("2026-10-31", "23:59")).toBe("2026-11-01T06:59:00.000Z");
    // Other time zones (east of UTC, and the southern hemisphere where DST runs the other way).
    expect(utc("2026-07-01", "12:00", "Europe/Berlin")).toBe("2026-07-01T10:00:00.000Z");
    expect(utc("2026-12-01", "12:00", "Europe/Berlin")).toBe("2026-12-01T11:00:00.000Z");
    expect(utc("2026-03-29", "02:30", "Europe/Berlin")).toBe("2026-03-29T01:30:00.000Z");
    expect(utc("2026-10-25", "02:30", "Europe/Berlin")).toBe("2026-10-25T00:30:00.000Z");
    expect(utc("2026-10-04", "02:30", "Australia/Sydney")).toBe("2026-10-03T16:30:00.000Z");
    expect(utc("2026-04-05", "02:30", "Australia/Sydney")).toBe("2026-04-04T15:30:00.000Z");
    expect(utc("2026-06-15", "09:00", "UTC")).toBe("2026-06-15T09:00:00.000Z");
  });

  it("writes a valid calendar: CRLF, folded lines, escaped text, all-day and timed events", () => {
    const body = ics(
      [
        icsEvent({
          id: "meet2",
          title: "League Meet 2; bring snacks, water",
          startTime: "08:00",
          endTime: "17:00",
          location: "Anaheim High, Gym B",
          link: "https://ftc-events.firstinspires.org/2026/USCALS",
          notes: "Arrive by 7:30.\nPit table 12.",
          updatedAt: new Date("2026-09-20T10:00:00Z"),
        }),
        icsEvent({ id: "ilt", title: "ILT", kind: "ILT", startsOn: "2027-01-08", endsOn: "2027-01-10" }),
        icsEvent({ id: "deadline", title: "Registration due", kind: "DEADLINE", startsOn: "2026-10-01" }),
        icsEvent({ id: "dst", title: "Fall-back meet", startsOn: "2026-11-01", startTime: "00:30", endTime: "17:00" }),
        icsEvent({ id: "open", title: "Open build", kind: "TEAM", startsOn: "2026-10-20", startTime: "18:00" }),
        icsEvent({ id: "camp", title: "Build camp", kind: "TEAM", startsOn: "2026-12-28", endsOn: "2026-12-30", startTime: "09:00" }),
      ],
      "Huskyteers, team calendar",
    );
    // CRLF everywhere, ending with one; nothing longer than 75 octets.
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(/(?<!\r)\n/.test(body)).toBe(false);
    expect(/\r(?!\n)/.test(body)).toBe(false);
    for (const line of body.split("\r\n")) expect(bytes(line)).toBeLessThanOrEqual(75);
    const lines = unfold(body).split("\r\n");
    expect(lines.slice(0, 6)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//FTC 19516 The Huskyteers//Team calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:Huskyteers\\, team calendar",
    ]);
    const vevent = (uid: string) => {
      const start = lines.indexOf(`UID:${uid}@huskyteers-portal`);
      expect(start, uid).toBeGreaterThan(0);
      expect(lines[start - 1]).toBe("BEGIN:VEVENT");
      return lines.slice(start, lines.indexOf("END:VEVENT", start));
    };
    expect(vevent("meet2")).toEqual([
      "UID:meet2@huskyteers-portal",
      "DTSTAMP:20260924T190000Z",
      "DTSTART:20261017T150000Z",
      "DTEND:20261018T000000Z",
      "SUMMARY:League Meet 2\\; bring snacks\\, water",
      "LOCATION:Anaheim High\\, Gym B",
      "DESCRIPTION:Arrive by 7:30.\\nPit table 12.\\n\\nhttps://ftc-events.firstinspires.org/2026/USCALS",
      "URL:https://ftc-events.firstinspires.org/2026/USCALS",
      "CATEGORIES:League meet",
      "LAST-MODIFIED:20260920T100000Z",
    ]);
    // All day: DTEND is the day after the last day.
    expect(vevent("ilt")).toEqual(
      expect.arrayContaining(["DTSTART;VALUE=DATE:20270108", "DTEND;VALUE=DATE:20270111", "CATEGORIES:League tournament (ILT)"]),
    );
    expect(vevent("deadline")).toEqual(expect.arrayContaining(["DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261002"]));
    expect(vevent("deadline").some((l) => l.startsWith("LOCATION") || l.startsWith("DESCRIPTION") || l.startsWith("URL"))).toBe(false);
    // Across the day clocks go back: 12:30 AM is still PDT (UTC-7), 5 PM is PST (UTC-8).
    expect(vevent("dst")).toEqual(expect.arrayContaining(["DTSTART:20261101T073000Z", "DTEND:20261102T010000Z"]));
    // A start time without an end: one day ends when it starts; several days run to the end of the last day.
    expect(vevent("open").some((l) => l.startsWith("DTEND"))).toBe(false);
    expect(vevent("camp")).toEqual(expect.arrayContaining(["DTSTART:20261228T170000Z", "DTEND:20261231T080000Z"]));
    expect(lines.filter((l) => l === "BEGIN:VEVENT")).toHaveLength(6);
  });

  it("folds long summaries in the file and names downloads safely", () => {
    const body = ics([icsEvent({ title: `Robotics 🤖 ${"extravaganza ".repeat(10)}中文` })]);
    for (const line of body.split("\r\n")) {
      expect(bytes(line)).toBeLessThanOrEqual(75);
      expect(loneSurrogate.test(line)).toBe(false);
    }
    expect(unfold(body)).toContain(`SUMMARY:Robotics 🤖 ${"extravaganza ".repeat(10)}中文\r\n`);
    expect(icsFilename("League Meet #2!")).toBe("huskyteers-league-meet-2.ics");
    expect(icsFilename("Café  Night / Outreach")).toBe("huskyteers-cafe-night-outreach.ics");
    expect(icsFilename("中文")).toBe("huskyteers-event.ics");
  });
});
