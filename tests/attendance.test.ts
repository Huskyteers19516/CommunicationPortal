import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEventKind, Role, Subteam } from "@/generated/prisma/enums";
import {
  adminCreditOptions,
  ATTENDANCE_EDIT_DAYS,
  type AttendanceSettings,
  attendanceScanPath,
  cameWith,
  CREDIT_OPTIONS,
  creditBreakdown,
  creditLabel,
  creditMenuGroups,
  creditOptionFits,
  creditOptionOf,
  creditOptionsFor,
  DEFAULT_ATTENDANCE_SETTINGS,
  defaultCreditOption,
  extraMeetingAnswerDay,
  extraMeetingDays,
  extraMeetingsOn,
  firstReportIndex,
  formatCredits,
  formatSixths,
  formatWeekdays,
  HAND_CREDIT_IDS,
  isExtraCreditOption,
  isExtraMeetingDay,
  isFlexDay,
  isRegularDay,
  isTeamDay,
  memberCreditOptions,
  metWeeklyTarget,
  parseAttendanceSettings,
  parseReportIndex,
  parseWeeklyTarget,
  REPORT_PERIODS_MAX,
  reportPeriodFor,
  reportPeriodsBetween,
  reportPeriodsUpTo,
  serializeAttendanceSettings,
  sixthsToDecimal,
  sumCredits,
  teamDaysFrom,
  upcomingTeamDays,
  weekdayOf,
  weekOf,
  weekProgressText,
  weekStartOf,
} from "@/lib/attendance";
import { LIMITS } from "@/lib/constants";
import { addDays, dateOnlyToDb } from "@/lib/dates";
import { parsePeopleParam, prefillAssigneeIds, prefillBackHref, prefillDueDate } from "@/lib/task-prefill";
import type { Actor } from "@/server/actor";
import {
  CODE_SLOT_MS,
  currentCodes,
  matchTypedCode,
  newSessionSecret,
  normalizeTypedCode,
  parseQrToken,
  qrTokenFor,
  safeEqual,
  slotAt,
  typedCodeFor,
  verifyQrToken,
} from "@/server/attendance/codes";
import {
  attendanceChangeQuery,
  attendanceChangesCsv,
  changeKindOf,
  describeAttendanceChange,
  hasAttendanceChangeFilters,
  parseAttendanceChangeFilters,
  reportChangesCsv,
} from "@/server/attendance/changes";
import { findNoShows } from "@/server/attendance/no-shows";
import { deliverNotification } from "@/server/notifications/deliver";
import { attendanceNoShowsPayload, type DiscordPayload, deliverDiscord, type FetchLike } from "@/server/notifications/discord";
import { buildReport, csvCell, csvRow, periodWeeks, reportCsv, startOfDayInTimezone } from "@/server/attendance/report";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { canFixAttendance, canGiveExtraCredit, canViewAttendanceChanges } from "@/server/permissions";
import { extraMeetingWindow, getAttendanceSettings, getSavedAttendanceSettings } from "@/server/queries/attendance-settings";
import { getAssignableUsers } from "@/server/queries/tasks";
import { deleteUser, HAS_ACTIVITY_MESSAGE } from "@/server/services/admin";
import { createCalendarEvent, deleteCalendarEvent } from "@/server/services/calendar";
import {
  ADDED_BY_HAND,
  addPerson,
  BY_HAND_PARTIAL_ONLY,
  CANT_DELETE_SESSION,
  CODE_ATTEMPT_LIMIT,
  CODE_WRONG,
  canEditSessionOn,
  checkInWithCode,
  checkInWithToken,
  closeSession,
  CREDIT_PAST_DAY,
  deleteSession,
  EC_ONLY,
  FLEX_CREDIT_ONLY,
  FLEX_FULL_CREDIT,
  MARKED_NOT_HERE,
  NOTE_CHANGED,
  NOT_CHECKED_IN,
  NOT_YOURSELF,
  OWN_CREDIT,
  NOTHING_OPEN,
  OLD_SESSION,
  OTHER_DAY,
  openSession,
  PICK_HAND_CREDIT,
  PLAN_CHANGED,
  QR_EXPIRED,
  REGULAR_CREDIT_ONLY,
  REGULAR_NO_PICK,
  removePerson,
  SESSION_CLOSED,
  setCredit,
  UNDO_TOO_LATE,
  setDayPlan,
  setMyCredit,
  setRsvp,
  setSessionNote,
  updateSettings,
} from "@/server/services/attendance";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

// TEST_TODAY is Thursday 2026-09-24 (a regular day and a Flex day with the default schedule: regular meetings on
// Mon, Tue, and Thu, Flex on Tue and Thu). Friday the 25th, Wednesdays, and weekends are days off.
const MINUTE = 60_000;
const at = (ms: number) => new Date(TEST_NOW.getTime() + ms);

let t: TestDb;
type Who = "owner" | "captain" | "mentor" | "teacher" | "bizLead" | "swLead" | "buildLead" | "member" | "member2" | "bizMember";
let p: Record<Who, Actor>;

beforeAll(async () => {
  t = await createTestDb();
  const spec: Record<Who, { role: Role; subteam?: Subteam | null; isAdmin?: boolean }> = {
    owner: { role: "MEMBER", subteam: "SOFTWARE", isAdmin: true },
    captain: { role: "CAPTAIN" },
    mentor: { role: "MENTOR" },
    teacher: { role: "TEACHER" },
    bizLead: { role: "BUSINESS_LEADER" },
    swLead: { role: "SOFTWARE_LEADER" },
    buildLead: { role: "BUILD_LEADER" },
    member: { role: "MEMBER", subteam: "BUILD" },
    member2: { role: "MEMBER", subteam: "SOFTWARE" },
    bizMember: { role: "MEMBER", subteam: "BUSINESS" },
  };
  const entries = await Promise.all(
    Object.entries(spec).map(async ([who, s]) => [who, await makeUser(t.db, { ...s, name: who })] as const),
  );
  p = Object.fromEntries(entries) as Record<Who, Actor>;
});

afterAll(async () => {
  await t.drop();
});

async function resetAttendance() {
  await t.db.attendanceChange.deleteMany();
  await t.db.attendanceRecord.deleteMany();
  await t.db.attendanceSession.deleteMany();
  await t.db.attendanceRsvp.deleteMany();
  await t.db.attendancePlan.deleteMany();
  await t.db.rateLimit.deleteMany();
  await t.db.teamNote.deleteMany();
}

async function secretOf(sessionId: string) {
  const s = await t.db.attendanceSession.findUniqueOrThrow({ where: { id: sessionId }, select: { secret: true } });
  return s.secret;
}

// ── Codes (pure) ──────────────────────────────────────────────────────────────

describe("rotating codes", () => {
  const secret = newSessionSecret();
  const sessionId = "csession123";

  it("makes a QR token that verifies for about 5 minutes, then expires", () => {
    const slot = slotAt(TEST_NOW);
    const token = qrTokenFor(secret, sessionId, slot);
    const parsed = parseQrToken(token);
    expect(parsed).toEqual({ sessionId, slot, signature: expect.any(String) });
    expect(parsed!.signature).toHaveLength(22);
    expect(verifyQrToken(parsed!, secret, TEST_NOW)).toBe("ok");
    expect(verifyQrToken(parsed!, secret, at(5 * MINUTE))).toBe("ok");
    expect(verifyQrToken(parsed!, secret, at(5 * MINUTE + CODE_SLOT_MS))).toBe("expired");
    // A token from the future (beyond a slot of clock skew) is not ours.
    expect(verifyQrToken({ ...parsed!, slot: slot + 2, signature: parseQrToken(qrTokenFor(secret, sessionId, slot + 2))!.signature }, secret, TEST_NOW)).toBe(
      "invalid",
    );
  });

  it("rejects tampered or foreign tokens as invalid (never 'expired')", () => {
    const slot = slotAt(TEST_NOW) - 100;
    const parsed = parseQrToken(qrTokenFor(secret, sessionId, slot))!;
    expect(verifyQrToken(parsed, secret, TEST_NOW)).toBe("expired");
    expect(verifyQrToken(parsed, newSessionSecret(), TEST_NOW)).toBe("invalid");
    expect(verifyQrToken({ ...parsed, slot: slot + 1 }, secret, TEST_NOW)).toBe("invalid");
    const flipped = parsed.signature[0] === "A" ? `B${parsed.signature.slice(1)}` : `A${parsed.signature.slice(1)}`;
    expect(verifyQrToken({ ...parsed, signature: flipped }, secret, TEST_NOW)).toBe("invalid");
    expect(verifyQrToken({ ...parsed, sessionId: "cother" }, secret, TEST_NOW)).toBe("invalid");
  });

  it("parses only well-formed tokens", () => {
    expect(parseQrToken("")).toBeNull();
    expect(parseQrToken("abc")).toBeNull();
    expect(parseQrToken("abc.1.short")).toBeNull();
    expect(parseQrToken(`abc.!!.${"a".repeat(22)}`)).toBeNull();
    expect(parseQrToken(`../x.1.${"a".repeat(22)}`)).toBeNull();
    expect(parseQrToken(`abc.1.${"a".repeat(23)}`)).toBeNull();
    expect(parseQrToken(`abc.z.${"a".repeat(22)}`)).toEqual({ sessionId: "abc", slot: 35, signature: "a".repeat(22) });
  });

  it("derives a 6-digit typed code per slot, accepted for about 2 minutes", () => {
    const slot = slotAt(TEST_NOW);
    const code = typedCodeFor(secret, sessionId, slot);
    expect(code).toMatch(/^\d{6}$/);
    expect(typedCodeFor(secret, sessionId, slot)).toBe(code);
    expect(currentCodes(secret, sessionId, TEST_NOW).code).toBe(code);
    const sessions = [{ id: sessionId, secret }];
    expect(matchTypedCode(code, sessions, TEST_NOW)).toBe(sessionId);
    expect(matchTypedCode(code, sessions, at(90_000))).toBe(sessionId); // 3 slots later
    expect(matchTypedCode(code, sessions, at(120_000))).toBeNull(); // 4 slots later
    expect(matchTypedCode(code, [{ id: sessionId, secret: newSessionSecret() }], TEST_NOW)).toBeNull();
  });

  it("matches a typed code to the right one of today's sessions", () => {
    const a = { id: "cregular", secret: newSessionSecret() };
    const b = { id: "cflex", secret: newSessionSecret() };
    const slot = slotAt(TEST_NOW);
    expect(matchTypedCode(typedCodeFor(b.secret, b.id, slot), [a, b], TEST_NOW)).toBe("cflex");
    expect(matchTypedCode(typedCodeFor(a.secret, a.id, slot - 1), [a, b], TEST_NOW)).toBe("cregular");
  });

  it("normalizes typed codes and compares in constant time", () => {
    expect(normalizeTypedCode("123 456")).toBe("123456");
    expect(normalizeTypedCode("123-456")).toBe("123456");
    expect(normalizeTypedCode("12345")).toBeNull();
    expect(normalizeTypedCode("1234567")).toBeNull();
    expect(normalizeTypedCode("12a456")).toBeNull();
    expect(safeEqual("123456", "123456")).toBe(true);
    expect(safeEqual("123456", "123457")).toBe(false);
    expect(safeEqual("123456", "12345")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("gives every session its own random secret", () => {
    expect(newSessionSecret()).not.toBe(newSessionSecret());
    expect(newSessionSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("in-app scanner links", () => {
  const origins = ["https://portal.example.com"];
  it("follows only our own /attendance/scan/ links", () => {
    expect(attendanceScanPath("https://portal.example.com/attendance/scan/abc.1.xyz", origins)).toBe("/attendance/scan/abc.1.xyz");
    expect(attendanceScanPath("https://evil.example.com/attendance/scan/abc", origins)).toBeNull();
    expect(attendanceScanPath("https://portal.example.com/today", origins)).toBeNull();
    expect(attendanceScanPath("https://portal.example.com/attendance/scan/abc?next=x", origins)).toBeNull();
    expect(attendanceScanPath("https://u:p@portal.example.com/attendance/scan/abc", origins)).toBeNull();
    expect(attendanceScanPath("javascript:alert(1)", origins)).toBeNull();
    expect(attendanceScanPath("WIFI:S:guest;;", origins)).toBeNull();
  });
});

// ── Running attendance ────────────────────────────────────────────────────────

describe("openSession / closeSession", () => {
  beforeEach(resetAttendance);

  it("only teachers, the Business leader, the captain, mentors, and owners can start attendance", async () => {
    for (const who of ["member", "bizMember", "swLead", "buildLead"] as const) {
      await expect(openSession(contextFor(t.db, p[who]), { kind: "REGULAR" }), who).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const who of ["teacher", "bizLead", "captain", "mentor", "owner"] as const) {
      await resetAttendance();
      const { id, created } = await openSession(contextFor(t.db, p[who]), { kind: "REGULAR" });
      expect(created, who).toBe(true);
      const row = await t.db.attendanceSession.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ kind: "REGULAR", date: dateOnlyToDb(TEST_TODAY), openedById: p[who].id, closedAt: null });
    }
    await expect(openSession(contextFor(t.db, p.teacher), { kind: "OTHER" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("reuses today's open session, and reopens a closed one with a fresh secret", async () => {
    const ctx = contextFor(t.db, p.teacher);
    const first = await openSession(ctx, { kind: "FLEX" });
    const secret = await secretOf(first.id);
    const again = await openSession(contextFor(t.db, p.bizLead), { kind: "FLEX" });
    expect(again).toEqual({ id: first.id, reopened: false, created: false });
    expect(await secretOf(first.id)).toBe(secret);

    await expect(closeSession(contextFor(t.db, p.member), { sessionId: first.id })).rejects.toBeInstanceOf(ForbiddenError);
    await closeSession(ctx, { sessionId: first.id });
    await closeSession(ctx, { sessionId: first.id }); // closing twice is fine
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id: first.id } })).closedAt).toEqual(TEST_NOW);

    const reopened = await openSession(ctx, { kind: "FLEX" });
    expect(reopened).toEqual({ id: first.id, reopened: true, created: false });
    const row = await t.db.attendanceSession.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.closedAt).toBeNull();
    expect(row.secret).not.toBe(secret);
    expect(row.openedById).toBe(p.teacher.id); // still "started by" the first person

    // Regular and Flex are separate sessions on the same day.
    const regular = await openSession(ctx, { kind: "REGULAR" });
    expect(regular.id).not.toBe(first.id);
    await expect(closeSession(ctx, { sessionId: "nope" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("uses the team timezone for 'today'", async () => {
    // 2026-09-25 06:00 UTC is still Thursday the 24th in Anaheim.
    const ctx = { ...contextFor(t.db, p.teacher), now: new Date("2026-09-25T06:00:00Z") };
    const { id } = await openSession(ctx, { kind: "REGULAR" });
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id } })).date).toEqual(dateOnlyToDb("2026-09-24"));
  });
});

// ── Checking in ───────────────────────────────────────────────────────────────

describe("checking in", () => {
  let sessionId: string;
  beforeEach(async () => {
    await resetAttendance();
    ({ id: sessionId } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" }));
  });

  it("scanning the QR code checks you in once; scanning again says you're already in", async () => {
    const token = currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).token;
    const ctx = contextFor(t.db, p.member);
    expect(await checkInWithToken(ctx, { token })).toEqual({ sessionId, kind: "REGULAR", already: false });
    expect(await checkInWithToken({ ...ctx, now: at(MINUTE) }, { token })).toEqual({ sessionId, kind: "REGULAR", already: true });
    const records = await t.db.attendanceRecord.findMany({ where: { sessionId } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ userId: p.member.id, method: "QR", checkedInAt: TEST_NOW, markedById: null });
  });

  it("a scanned link still works after signing in (a few minutes), then expires", async () => {
    const token = currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).token;
    await checkInWithToken({ ...contextFor(t.db, p.member), now: at(4 * MINUTE) }, { token });
    await expect(checkInWithToken({ ...contextFor(t.db, p.member2), now: at(6 * MINUTE) }, { token })).rejects.toThrow(QR_EXPIRED);
    // An old link of someone already on the list is still good news.
    expect(await checkInWithToken({ ...contextFor(t.db, p.member), now: at(30 * MINUTE) }, { token })).toMatchObject({ already: true });
  });

  it("refuses forged tokens, closed sessions, other days, and inactive accounts", async () => {
    const secret = await secretOf(sessionId);
    const token = currentCodes(secret, sessionId, TEST_NOW).token;
    const ctx = contextFor(t.db, p.member);
    await expect(checkInWithToken(ctx, { token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}` })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(checkInWithToken(ctx, { token: "garbage" })).rejects.toBeInstanceOf(ValidationError);
    await expect(checkInWithToken(ctx, { token: currentCodes(newSessionSecret(), sessionId, TEST_NOW).token })).rejects.toBeInstanceOf(
      ValidationError,
    );

    const inactive = await makeUser(t.db, { status: "DISABLED" });
    await expect(checkInWithToken(contextFor(t.db, inactive), { token })).rejects.toBeInstanceOf(ForbiddenError);

    await closeSession(contextFor(t.db, p.teacher), { sessionId });
    await expect(checkInWithToken(ctx, { token })).rejects.toThrow(SESSION_CLOSED);

    // Yesterday's session (never closed) with a fresh token: not today's.
    const old = await t.db.attendanceSession.create({
      data: { date: dateOnlyToDb(addDays(TEST_TODAY, -1)), kind: "REGULAR", secret: newSessionSecret(), openedById: p.teacher.id },
    });
    const oldToken = currentCodes(old.secret, old.id, TEST_NOW).token;
    await expect(checkInWithToken(ctx, { token: oldToken })).rejects.toThrow(OTHER_DAY);
    expect(await t.db.attendanceRecord.count()).toBe(0);
  });

  it("the typed code checks you in to today's open session", async () => {
    const flex = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    const code = currentCodes(await secretOf(flex.id), flex.id, TEST_NOW).code;
    const ctx = contextFor(t.db, p.member2);
    expect(await checkInWithCode(ctx, { code: `${code.slice(0, 3)} ${code.slice(3)}` })).toEqual({
      sessionId: flex.id,
      kind: "FLEX",
      already: false,
    });
    expect(await checkInWithCode(ctx, { code })).toMatchObject({ already: true });
    expect(await t.db.attendanceRecord.findFirst({ where: { userId: p.member2.id } })).toMatchObject({ method: "CODE", sessionId: flex.id });

    // A code from 1.5 minutes ago still works; from 2.5 minutes ago it doesn't.
    const secret = await secretOf(sessionId);
    const recent = typedCodeFor(secret, sessionId, slotAt(TEST_NOW) - 3);
    expect(await checkInWithCode(contextFor(t.db, p.member), { code: recent })).toMatchObject({ sessionId, already: false });
    const stale = typedCodeFor(secret, sessionId, slotAt(TEST_NOW) - 5);
    const err = await checkInWithCode(contextFor(t.db, p.bizMember), { code: stale }).catch((e: unknown) => e);
    // (1 in a million: the stale code could equal a current one.)
    if (err instanceof ValidationError) expect(err.fieldErrors.code).toBe(CODE_WRONG);
  });

  it("checks the code's format first, and only today's open sessions count", async () => {
    const ctx = contextFor(t.db, p.member);
    const bad = await checkInWithCode(ctx, { code: "12345" }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ValidationError);
    expect((bad as ValidationError).fieldErrors.code).toMatch(/6-digit/);
    const code = currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).code;
    await closeSession(contextFor(t.db, p.teacher), { sessionId });
    await expect(checkInWithCode(ctx, { code })).rejects.toThrow(NOTHING_OPEN);
    // Tomorrow, today's code is no good either.
    await expect(checkInWithCode({ ...ctx, now: at(24 * 60 * MINUTE) }, { code })).rejects.toThrow(NOTHING_OPEN);
  });

  it("limits typed-code attempts so codes can't be guessed", async () => {
    const ctx = contextFor(t.db, p.member);
    const right = currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).code;
    const wrong = right === "000000" ? "000001" : "000000";
    for (let i = 0; i < CODE_ATTEMPT_LIMIT.limit; i++) {
      await expect(checkInWithCode(ctx, { code: wrong })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(checkInWithCode(ctx, { code: right })).rejects.toBeInstanceOf(RateLimitError);
    // Someone else isn't affected; and after the window it works again.
    await expect(checkInWithCode(contextFor(t.db, p.member2), { code: right })).resolves.toMatchObject({ already: false });
    const later = { ...ctx, now: at(CODE_ATTEMPT_LIMIT.windowMs + 1000) };
    const laterCode = currentCodes(await secretOf(sessionId), sessionId, later.now).code;
    await expect(checkInWithCode(later, { code: laterCode })).resolves.toMatchObject({ already: false });
  });
});

describe("adding and removing people by hand", () => {
  let sessionId: string;
  beforeEach(async () => {
    await resetAttendance();
    ({ id: sessionId } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" }));
  });

  it("every admin adds and removes people (leaders too); members and pending accounts can't", async () => {
    const pending = await makeUser(t.db, { role: "TEACHER", status: "PENDING" });
    for (const [who, actor] of [
      ["member", p.member],
      ["bizMember", p.bizMember],
      ["pending", pending],
    ] as const) {
      await expect(addPerson(contextFor(t.db, actor), { sessionId, userId: p.member.id, option: "1/2" }), who).rejects.toBeInstanceOf(ForbiddenError);
    }
    const admins = ["swLead", "buildLead", "bizLead", "captain", "mentor", "teacher", "owner"] as const;
    for (const who of admins) {
      expect(await addPerson(contextFor(t.db, p[who]), { sessionId, userId: p.member.id, option: "1/2" }), who).toEqual({ name: "member", option: "1/2" });
      const row = await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId, userId: p.member.id } });
      expect(row, who).toMatchObject({
        method: "MANUAL",
        markedById: p[who].id,
        credit: 3,
        creditKind: "REGULAR",
        creditChangedById: p[who].id,
        creditChangedAt: TEST_NOW,
      });
      await expect(addPerson(contextFor(t.db, p.captain), { sessionId, userId: p.member.id, option: "1/3" }), who).rejects.toThrow(
        "member is already on the list.",
      );
      await expect(removePerson(contextFor(t.db, p.member), { sessionId, userId: p.member.id })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removePerson(contextFor(t.db, pending), { sessionId, userId: p.member.id })).rejects.toBeInstanceOf(ForbiddenError);
      expect(await removePerson(contextFor(t.db, p[who]), { sessionId, userId: p.member.id }), who).toEqual({ name: "member" });
      await expect(removePerson(contextFor(t.db, p[who]), { sessionId, userId: p.member.id }), who).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it("by hand it's only part credit, EC, or No credit — never 1 or Flex (those need the scan)", async () => {
    const flex = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    const teacher = contextFor(t.db, p.teacher);
    for (const [option, message] of [
      ["1", BY_HAND_PARTIAL_ONLY],
      ["1flex", REGULAR_CREDIT_ONLY],
      ["1/2flex", REGULAR_CREDIT_ONLY],
    ] as const) {
      const err = await addPerson(teacher, { sessionId, userId: p.member.id, option }).catch((e: unknown) => e);
      expect((err as ValidationError).fieldErrors.option, option).toBe(message);
    }
    for (const [option, message] of [
      ["1", FLEX_FULL_CREDIT],
      ["1flex", BY_HAND_PARTIAL_ONLY],
      ["1/2flex", BY_HAND_PARTIAL_ONLY],
    ] as const) {
      const err = await addPerson(teacher, { sessionId: flex.id, userId: p.member.id, option }).catch((e: unknown) => e);
      expect((err as ValidationError).fieldErrors.option, option).toBe(message);
    }
    // What it counts as has to be picked.
    const missing = await addPerson(teacher, { sessionId, userId: p.member.id }).catch((e: unknown) => e);
    expect((missing as ValidationError).fieldErrors.option).toBe(PICK_HAND_CREDIT);
    await expect(addPerson(teacher, { sessionId, userId: p.member.id, option: "" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addPerson(teacher, { sessionId, userId: p.member.id, option: "2" })).rejects.toBeInstanceOf(ValidationError);
    expect(await t.db.attendanceRecord.count()).toBe(0);

    // Each partial one, EC, and No credit work (at Regular and at Flex).
    const people = [p.member, p.member2, p.bizMember, p.swLead, p.buildLead, p.captain];
    const options = ["2/3", "1/2", "1/3", "1/2ec", "1ec", "none"] as const;
    for (const [i, option] of options.entries()) {
      await addPerson(teacher, { sessionId, userId: people[i].id, option });
      await addPerson(teacher, { sessionId: flex.id, userId: people[i].id, option });
    }
    const rows = await t.db.attendanceRecord.findMany({ where: { sessionId }, select: { userId: true, credit: true, creditKind: true } });
    expect(new Map(rows.map((r) => [r.userId, [r.credit, r.creditKind]]))).toEqual(
      new Map([
        [p.member.id, [4, "REGULAR"]],
        [p.member2.id, [3, "REGULAR"]],
        [p.bizMember.id, [2, "REGULAR"]],
        [p.swLead.id, [3, "EXTRA"]],
        [p.buildLead.id, [6, "EXTRA"]],
        [p.captain.id, [0, "REGULAR"]],
      ]),
    );
    expect(await t.db.attendanceRecord.count({ where: { sessionId: flex.id } })).toBe(6);
  });

  it("nobody adds themselves by hand (another admin does, or they scan in), so nobody gives themselves credit", async () => {
    for (const who of ["bizLead", "teacher", "owner", "swLead"] as const) {
      for (const option of ["2/3", "1ec", "none"] as const) {
        await expect(addPerson(contextFor(t.db, p[who]), { sessionId, userId: p[who].id, option }), `${who} ${option}`).rejects.toThrow(NOT_YOURSELF);
      }
    }
    expect(await t.db.attendanceRecord.count()).toBe(0);
    expect(await t.db.attendanceChange.count()).toBe(0);
    // Another admin can, and it's in the log like anyone's.
    await addPerson(contextFor(t.db, p.teacher), { sessionId, userId: p.bizLead.id, option: "2/3" });
    expect(await t.db.attendanceRecord.findFirstOrThrow({ where: { userId: p.bizLead.id } })).toMatchObject({
      credit: 4,
      creditChangedById: p.teacher.id,
    });
    expect(await t.db.attendanceChange.count({ where: { action: "ADDED", userId: p.bizLead.id, changedById: p.teacher.id } })).toBe(1);
  });

  it("Undo (right after a no-show quick action) takes the hand entry off only while it's still that", async () => {
    const lead = contextFor(t.db, p.swLead);
    await addPerson(lead, { sessionId, userId: p.member.id, option: "1/2" });
    // Undo with what it gave: gone, and the log says so.
    expect(await removePerson(lead, { sessionId, userId: p.member.id, from: "1/2" })).toEqual({ name: "member" });
    expect(await t.db.attendanceRecord.count({ where: { sessionId, userId: p.member.id } })).toBe(0);
    expect(await t.db.attendanceChange.findFirstOrThrow({ where: { action: "REMOVED", userId: p.member.id } })).toMatchObject({
      fromCredit: 3,
      fromKind: "REGULAR",
      changedById: p.swLead.id,
    });
    // Changed since (another admin, or they scanned in): Undo leaves it alone.
    await addPerson(lead, { sessionId, userId: p.member.id, option: "1/3" });
    await setCredit({ ...contextFor(t.db, p.captain), now: at(MINUTE) }, { sessionId, userId: p.member.id, option: "2/3" });
    await expect(removePerson(lead, { sessionId, userId: p.member.id, from: "1/3" })).rejects.toThrow(UNDO_TOO_LATE);
    await addPerson(lead, { sessionId, userId: p.member2.id, option: "none" });
    await checkInWithCode(contextFor(t.db, p.member2), { code: currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).code });
    await expect(removePerson(lead, { sessionId, userId: p.member2.id, from: "none" })).rejects.toThrow(UNDO_TOO_LATE);
    expect(await t.db.attendanceRecord.count({ where: { sessionId } })).toBe(2);
    await expect(removePerson(lead, { sessionId, userId: p.member.id, from: "3/4" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("works on closed sessions (fixing the list later), but only for active people", async () => {
    await closeSession(contextFor(t.db, p.teacher), { sessionId });
    await addPerson(contextFor(t.db, p.owner), { sessionId, userId: p.member2.id, option: "1/3" });
    const gone = await makeUser(t.db, { status: "DISABLED" });
    await expect(addPerson(contextFor(t.db, p.owner), { sessionId, userId: gone.id, option: "1/3" })).rejects.toBeInstanceOf(ValidationError);
    await expect(addPerson(contextFor(t.db, p.owner), { sessionId: "nope", userId: p.member.id, option: "1/3" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("'What we did' is for runners, with a length limit", async () => {
    await expect(setSessionNote(contextFor(t.db, p.swLead), { sessionId, note: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    await setSessionNote(contextFor(t.db, p.teacher), { sessionId, note: "  Drive practice  " });
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id: sessionId } })).note).toBe("Drive practice");
    await expect(
      setSessionNote(contextFor(t.db, p.teacher), { sessionId, note: "x".repeat(LIMITS.attendanceNoteMax + 1) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await setSessionNote(contextFor(t.db, p.teacher), { sessionId, note: "" });
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id: sessionId } })).note).toBe("");
    await expect(setSessionNote(contextFor(t.db, p.teacher), { sessionId: "nope", note: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ── Coming? ───────────────────────────────────────────────────────────────────

describe("Coming? answers", () => {
  beforeEach(resetAttendance);
  const friday = addDays(TEST_TODAY, 1); // no meeting
  const saturday = addDays(TEST_TODAY, 2);
  const monday = addDays(TEST_TODAY, 4); // regular, not Flex
  const tuesday = addDays(TEST_TODAY, 5); // regular + Flex

  it("saves Regular Yes/Half/No and Flex Yes/No for your own days", async () => {
    const ctx = contextFor(t.db, p.member);
    expect(await setRsvp(ctx, { date: TEST_TODAY, regular: "HALF" })).toEqual({ date: TEST_TODAY, regular: "HALF", flex: null, note: "" });
    expect(await setRsvp(ctx, { date: TEST_TODAY, flex: "YES" })).toEqual({ date: TEST_TODAY, regular: "HALF", flex: "YES", note: "" });
    expect(await setRsvp(ctx, { date: TEST_TODAY, note: " Leaving at 5 " })).toMatchObject({ regular: "HALF", flex: "YES", note: "Leaving at 5" });
    // Only your own: a userId in the input is ignored.
    await setRsvp(ctx, { date: tuesday, regular: "NO", userId: p.member2.id });
    const rows = await t.db.attendanceRsvp.findMany({ orderBy: { date: "asc" } });
    expect(rows.map((r) => [r.userId, r.regular, r.flex])).toEqual([
      [p.member.id, "HALF", "YES"],
      [p.member.id, "NO", null],
    ]);
  });

  it("Flex only on Flex days, Half never for Flex, and nothing on days off", async () => {
    const ctx = contextFor(t.db, p.member);
    const flexOnMonday = await setRsvp(ctx, { date: monday, flex: "YES" }).catch((e: unknown) => e);
    expect(flexOnMonday).toBeInstanceOf(ValidationError);
    expect((flexOnMonday as ValidationError).fieldErrors.flex).toBe("There's no Flex that day.");
    await expect(setRsvp(ctx, { date: TEST_TODAY, flex: "HALF" })).rejects.toBeInstanceOf(ValidationError);
    const weekend = await setRsvp(ctx, { date: saturday, regular: "YES" }).catch((e: unknown) => e);
    expect((weekend as ValidationError).fieldErrors.date).toBe("There's no practice that day.");
    // Fridays and Wednesdays aren't meeting days any more.
    const offDay = await setRsvp(ctx, { date: friday, regular: "YES" }).catch((e: unknown) => e);
    expect((offDay as ValidationError).fieldErrors.date).toBe("There's no practice that day.");
    await expect(setRsvp(ctx, { date: addDays(TEST_TODAY, 6), regular: "YES" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setRsvp(ctx, { date: TEST_TODAY, regular: "MAYBE" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setRsvp(ctx, { date: "2026-02-30", regular: "YES" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setRsvp(ctx, { date: TEST_TODAY, note: "x".repeat(LIMITS.rsvpNoteMax + 1) })).rejects.toBeInstanceOf(ValidationError);
    expect(await t.db.attendanceRsvp.count()).toBe(0);
  });

  it("past days are read-only, and answers go up to rsvpDaysAhead days out", async () => {
    const ctx = contextFor(t.db, p.member);
    await expect(setRsvp(ctx, { date: addDays(TEST_TODAY, -1), regular: "YES" })).rejects.toBeInstanceOf(ConflictError);
    await expect(setRsvp(ctx, { date: addDays(TEST_TODAY, -1), regular: "" })).rejects.toBeInstanceOf(ConflictError);
    const far = addDays(TEST_TODAY, LIMITS.rsvpDaysAhead + 1);
    await expect(setRsvp(ctx, { date: far, regular: "YES" })).rejects.toBeInstanceOf(ValidationError);
    const farthest = addDays(TEST_TODAY, LIMITS.rsvpDaysAhead); // 28 days after a Thursday: a Thursday
    await expect(setRsvp(ctx, { date: farthest, regular: "YES" })).resolves.toMatchObject({ regular: "YES" });
  });

  it("clearing everything removes the answer; clearing works even after the schedule changed", async () => {
    const ctx = contextFor(t.db, p.member);
    await setRsvp(ctx, { date: TEST_TODAY, regular: "YES", note: "hi" });
    await setRsvp(ctx, { date: TEST_TODAY, regular: "" });
    expect(await t.db.attendanceRsvp.count()).toBe(1); // the note is still there
    await setRsvp(ctx, { date: TEST_TODAY, note: "" });
    expect(await t.db.attendanceRsvp.count()).toBe(0);

    await setRsvp(ctx, { date: monday, regular: "YES" });
    await updateSettings(contextFor(t.db, p.teacher), { regularDays: ["2", "4"], flexDays: ["2", "4"], reportStart: "2026-08-31" });
    await expect(setRsvp(ctx, { date: monday, regular: "NO" })).rejects.toBeInstanceOf(ValidationError);
    await setRsvp(ctx, { date: monday, regular: "" });
    expect(await t.db.attendanceRsvp.count()).toBe(0);
  });

  it("inactive accounts can't answer", async () => {
    const pending = await makeUser(t.db, { status: "PENDING" });
    await expect(setRsvp(contextFor(t.db, pending), { date: TEST_TODAY, regular: "YES" })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ── Plans and settings ────────────────────────────────────────────────────────

describe("day plans", () => {
  beforeEach(resetAttendance);
  const monday = addDays(TEST_TODAY, 4); // the next team day

  it("staff write the plan; members can't", async () => {
    await expect(setDayPlan(contextFor(t.db, p.member), { date: monday, plan: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const who of ["swLead", "buildLead", "bizLead", "captain", "mentor", "teacher", "owner"] as const) {
      await expect(setDayPlan(contextFor(t.db, p[who]), { date: monday, plan: `Plan by ${who}` }), who).resolves.toMatchObject({
        plan: `Plan by ${who}`,
      });
    }
    const row = await t.db.attendancePlan.findUniqueOrThrow({ where: { date: dateOnlyToDb(monday) } });
    expect(row).toMatchObject({ plan: "Plan by owner", updatedById: p.owner.id });
    await setDayPlan(contextFor(t.db, p.captain), { date: monday, plan: "  " });
    expect(await t.db.attendancePlan.count()).toBe(0);
  });

  it("not for past days, days off, or too far ahead; with a length limit", async () => {
    const ctx = contextFor(t.db, p.captain);
    await expect(setDayPlan(ctx, { date: addDays(TEST_TODAY, -1), plan: "x" })).rejects.toBeInstanceOf(ConflictError);
    await expect(setDayPlan(ctx, { date: addDays(TEST_TODAY, 1), plan: "x" })).rejects.toBeInstanceOf(ValidationError); // Friday
    await expect(setDayPlan(ctx, { date: addDays(TEST_TODAY, 2), plan: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setDayPlan(ctx, { date: addDays(TEST_TODAY, LIMITS.rsvpDaysAhead + 1), plan: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setDayPlan(ctx, { date: monday, plan: "x".repeat(LIMITS.attendancePlanMax + 1) })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("schedule settings", () => {
  beforeEach(resetAttendance);

  it("defaults to regular meetings on Mon, Tue, and Thu, Flex on Tue/Thu", async () => {
    const s = await getAttendanceSettings(TEST_TODAY, t.db);
    expect(s).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
    expect(s).toMatchObject({ regularDays: [1, 2, 4], flexDays: [2, 4], extraDays: [] });
    expect(isRegularDay(s, TEST_TODAY)).toBe(true);
    expect(isFlexDay(s, TEST_TODAY)).toBe(true);
    expect(isRegularDay(s, addDays(TEST_TODAY, 1))).toBe(false); // Friday
    expect(isFlexDay(s, addDays(TEST_TODAY, 1))).toBe(false);
    expect(isRegularDay(s, addDays(TEST_TODAY, 4))).toBe(true); // Monday
    expect(isFlexDay(s, addDays(TEST_TODAY, 4))).toBe(false);
    expect(isTeamDay(s, addDays(TEST_TODAY, 6))).toBe(false); // Wednesday
    // Thu Sep 24 – Thu Oct 22: 5 Thursdays, 4 Mondays, 4 Tuesdays.
    const upcoming = upcomingTeamDays(s, TEST_TODAY, LIMITS.rsvpDaysAhead);
    expect(upcoming).toHaveLength(13);
    expect(upcoming.slice(0, 4)).toEqual([TEST_TODAY, "2026-09-28", "2026-09-29", "2026-10-01"]);
    expect(new Set(upcoming.map((d) => weekdayOf(d)))).toEqual(new Set([1, 2, 4]));
    expect(formatWeekdays(s.regularDays)).toBe("Mon, Tue, Thu");
    expect(formatWeekdays([0, 6, 1])).toBe("Mon, Sat, Sun");
    expect(formatWeekdays([])).toBe("None");
  });

  it("runners change it; staff who only plan and members can't", async () => {
    const input = { regularDays: ["1", "3", "5"], flexDays: "4", reportStart: "2026-09-07" };
    await expect(updateSettings(contextFor(t.db, p.swLead), input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSettings(contextFor(t.db, p.member), input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await updateSettings(contextFor(t.db, p.bizLead), input)).toEqual({
      regularDays: [1, 3, 5],
      flexDays: [4],
      reportStart: "2026-09-07",
      weeklyTarget: 2,
    });
    expect(await getAttendanceSettings(TEST_TODAY, t.db)).toEqual({
      regularDays: [1, 3, 5],
      flexDays: [4],
      reportStart: "2026-09-07",
      weeklyTarget: 2,
      extraDays: [],
    });
  });

  it("needs a Monday to start reports and at least one day", async () => {
    const ctx = contextFor(t.db, p.teacher);
    const notMonday = await updateSettings(ctx, { regularDays: ["1"], flexDays: [], reportStart: "2026-09-08" }).catch((e: unknown) => e);
    expect((notMonday as ValidationError).fieldErrors.reportStart).toMatch(/Monday/);
    const none = await updateSettings(ctx, { regularDays: [], flexDays: [], reportStart: "2026-09-07" }).catch((e: unknown) => e);
    expect((none as ValidationError).fieldErrors.regularDays).toBe("Pick at least one day.");
    await expect(updateSettings(ctx, { regularDays: ["9"], flexDays: [], reportStart: "2026-09-07" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSettings(ctx, { regularDays: ["", "1"], flexDays: [], reportStart: "2026-09-07" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSettings(ctx, { regularDays: ["1.5"], flexDays: [], reportStart: "2026-09-07" })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateSettings(ctx, { regularDays: ["1"], flexDays: [], reportStart: "1999-01-04" })).rejects.toBeInstanceOf(ValidationError);
  });
});

// ── Extra meetings (Team calendar events of the kind MEETING) ───────────────────

describe("extra meetings", () => {
  const saturday = addDays(TEST_TODAY, 2); // 2026-09-26: no regular meeting
  const sunday = addDays(TEST_TODAY, 3);
  const clear = async () => {
    await resetAttendance();
    await t.db.calendarEvent.deleteMany();
  };
  beforeEach(clear);
  afterAll(clear);

  async function meeting(startsOn: string, endsOn: string | null = null, kind: CalendarEventKind = "MEETING") {
    return t.db.calendarEvent.create({
      data: {
        title: `Meeting ${startsOn}`,
        kind,
        startsOn: dateOnlyToDb(startsOn),
        endsOn: endsOn ? dateOnlyToDb(endsOn) : null,
        createdById: p.captain.id,
      },
      select: { id: true },
    });
  }

  it("each day one covers counts as a regular day in every helper (without adding Flex)", () => {
    const s: AttendanceSettings = { ...DEFAULT_ATTENDANCE_SETTINGS, extraDays: [saturday] };
    expect(isExtraMeetingDay(s, saturday)).toBe(true);
    expect(isRegularDay(s, saturday)).toBe(true);
    expect(isTeamDay(s, saturday)).toBe(true);
    expect(isFlexDay(s, saturday)).toBe(false);
    expect(isRegularDay(s, sunday)).toBe(false);
    expect(teamDaysFrom(s, TEST_TODAY, 5)).toEqual([TEST_TODAY, saturday, "2026-09-28"]);
    const upcoming = upcomingTeamDays(s, TEST_TODAY, LIMITS.rsvpDaysAhead);
    expect(upcoming).toHaveLength(14);
    expect(upcoming.slice(0, 3)).toEqual([TEST_TODAY, saturday, "2026-09-28"]);
    // Without it, Saturday is a day off again.
    expect(isTeamDay(DEFAULT_ATTENDANCE_SETTINGS, saturday)).toBe(false);
    // One on a regular Flex day (a Tuesday) keeps its Flex.
    const tuesday = addDays(TEST_TODAY, 5);
    expect(isFlexDay({ ...DEFAULT_ATTENDANCE_SETTINGS, extraDays: [tuesday] }, tuesday)).toBe(true);
  });

  it("Coming? and the planner list every day people can answer for, however many extra meetings there are", () => {
    // Past the old 14-day cap: 13 regular days (Thu Sep 24 – Thu Oct 22) and 3 extra meetings, the last one far out.
    const extras = [saturday, "2026-10-03", "2026-10-21"];
    const upcoming = upcomingTeamDays({ ...DEFAULT_ATTENDANCE_SETTINGS, extraDays: extras }, TEST_TODAY, LIMITS.rsvpDaysAhead);
    expect(upcoming).toHaveLength(16);
    expect(upcoming).toEqual(expect.arrayContaining(extras));
    expect(upcoming.at(-1)).toBe(addDays(TEST_TODAY, LIMITS.rsvpDaysAhead));
    // Every day a meeting day: the whole window, and nothing past it.
    const everyDay: AttendanceSettings = { ...DEFAULT_ATTENDANCE_SETTINGS, regularDays: [0, 1, 2, 3, 4, 5, 6] };
    expect(upcomingTeamDays(everyDay, TEST_TODAY, LIMITS.rsvpDaysAhead)).toHaveLength(LIMITS.rsvpDaysAhead + 1);
  });

  it("say from which day people can answer Coming? for one (its calendar page links straight there)", () => {
    const ahead = LIMITS.rsvpDaysAhead;
    const answer = (startsOn: string, endsOn: string | null = null) => extraMeetingAnswerDay({ startsOn, endsOn }, TEST_TODAY, ahead);
    expect(answer(saturday)).toBe(saturday);
    expect(answer(saturday, addDays(saturday, 1))).toBe(saturday);
    expect(answer(TEST_TODAY)).toBe(TEST_TODAY);
    // Started yesterday and still going: from today.
    expect(answer(addDays(TEST_TODAY, -1), saturday)).toBe(TEST_TODAY);
    // The last day people can answer for, and one past it ("later": answer up to 4 weeks ahead).
    expect(answer(addDays(TEST_TODAY, ahead))).toBe(addDays(TEST_TODAY, ahead));
    expect(answer(addDays(TEST_TODAY, ahead + 1))).toBe("later");
    expect(answer(addDays(TEST_TODAY, 60), addDays(TEST_TODAY, 61))).toBe("later");
    // Over: nothing to answer.
    expect(answer(addDays(TEST_TODAY, -1))).toBeNull();
    expect(answer(addDays(TEST_TODAY, -3), addDays(TEST_TODAY, -1))).toBeNull();
  });

  it("works out the days they cover: multi-day ones, clipped to the window, each day once", () => {
    const meetings = [
      { startsOn: "2026-09-26", endsOn: "2026-09-28" },
      { startsOn: "2026-09-27", endsOn: null },
      { startsOn: "2026-09-20", endsOn: "2026-09-22" },
      { startsOn: "2026-10-30", endsOn: null },
    ];
    expect(extraMeetingDays(meetings, "2026-09-21", "2026-10-01")).toEqual(["2026-09-21", "2026-09-22", "2026-09-26", "2026-09-27", "2026-09-28"]);
    expect(extraMeetingDays(meetings, "2026-10-02", "2026-10-29")).toEqual([]);
    expect(extraMeetingDays([], "2026-09-21", "2026-10-01")).toEqual([]);
    expect(extraMeetingsOn(meetings, "2026-09-27")).toEqual([meetings[0], meetings[1]]);
    expect(extraMeetingsOn(meetings, "2026-09-29")).toEqual([]);
  });

  it("are never saved with the schedule: parsing ignores them and saving leaves them out", async () => {
    const saved = { regularDays: [1, 2, 4], flexDays: [2, 4], reportStart: "2026-08-31", weeklyTarget: 2 };
    expect(parseAttendanceSettings(JSON.stringify({ ...saved, extraDays: [saturday] })).extraDays).toEqual([]);
    const loaded: AttendanceSettings = { ...DEFAULT_ATTENDANCE_SETTINGS, extraDays: [saturday] };
    expect(JSON.parse(serializeAttendanceSettings(loaded))).toEqual(saved);

    await meeting(saturday);
    const teacher = contextFor(t.db, p.teacher);
    const result = await updateSettings(teacher, { regularDays: ["1", "2", "4"], flexDays: ["2", "4"], reportStart: "2026-08-31", extraDays: [sunday] });
    expect(result).toEqual(saved);
    const note = await t.db.teamNote.findUniqueOrThrow({ where: { key: "attendance-settings" } });
    expect(JSON.parse(note.body)).toEqual(saved);
    // A day slipped into the saved JSON never counts; the calendar's still does.
    await t.db.teamNote.update({ where: { key: "attendance-settings" }, data: { body: JSON.stringify({ ...saved, extraDays: [sunday] }) } });
    expect((await getAttendanceSettings(TEST_TODAY, t.db)).extraDays).toEqual([saturday]);
  });

  it("getAttendanceSettings loads the ones from today to the last day people can answer for (only the Extra meeting kind)", async () => {
    expect(extraMeetingWindow(TEST_TODAY)).toEqual({ from: TEST_TODAY, to: addDays(TEST_TODAY, LIMITS.rsvpDaysAhead) });
    await meeting(saturday);
    await meeting(sunday, null, "TEAM"); // a team event isn't a meeting
    await meeting("2026-10-10", "2026-10-11"); // Saturday and Sunday
    await meeting("2026-09-21", "2026-09-25"); // started Monday, still on: today and Friday
    await meeting(addDays(TEST_TODAY, LIMITS.rsvpDaysAhead + 3)); // too far ahead to answer for
    await meeting("2026-09-19"); // last Saturday: nothing asks about past days
    await meeting("2026-08-01"); // long past
    const s = await getAttendanceSettings(TEST_TODAY, t.db);
    expect(s.extraDays).toEqual([TEST_TODAY, "2026-09-25", saturday, "2026-10-10", "2026-10-11"]);
    expect(isTeamDay(s, sunday)).toBe(false);
    expect(upcomingTeamDays(s, TEST_TODAY, LIMITS.rsvpDaysAhead)).toEqual(expect.arrayContaining(["2026-09-25", saturday, "2026-10-10", "2026-10-11"]));
    await expect(setRsvp(contextFor(t.db, p.member), { date: "2026-09-25", regular: "YES" })).resolves.toMatchObject({ regular: "YES" });
  });

  it("the saved schedule alone (reports, the Schedule form) never has them", async () => {
    await meeting(saturday);
    expect(await getSavedAttendanceSettings(t.db)).toEqual({ regularDays: [1, 2, 4], flexDays: [2, 4], reportStart: "2026-08-31", weeklyTarget: 2 });
    await updateSettings(contextFor(t.db, p.teacher), { regularDays: ["1", "3"], flexDays: [], reportStart: "2026-09-07" });
    expect(await getSavedAttendanceSettings(t.db)).toEqual({ regularDays: [1, 3], flexDays: [], reportStart: "2026-09-07", weeklyTarget: 2 });
  });

  it("members answer Coming? for them (Yes / Half / No, no Flex), and staff plan them", async () => {
    const member = contextFor(t.db, p.member);
    const before = await setRsvp(member, { date: saturday, regular: "YES" }).catch((e: unknown) => e);
    expect((before as ValidationError).fieldErrors.date).toBe("There's no practice that day.");
    await expect(setDayPlan(contextFor(t.db, p.captain), { date: saturday, plan: "Intake day" })).rejects.toBeInstanceOf(ValidationError);

    await meeting(saturday);
    expect(await setRsvp(member, { date: saturday, regular: "HALF", note: "Until noon" })).toEqual({
      date: saturday,
      regular: "HALF",
      flex: null,
      note: "Until noon",
    });
    const flex = await setRsvp(member, { date: saturday, flex: "YES" }).catch((e: unknown) => e);
    expect((flex as ValidationError).fieldErrors.flex).toBe("There's no Flex that day.");
    await expect(setDayPlan(contextFor(t.db, p.captain), { date: saturday, plan: "Intake day" })).resolves.toMatchObject({ plan: "Intake day" });
  });

  it("one added on the Team calendar counts right away (every day of it); removing it keeps what was saved", async () => {
    const captain = contextFor(t.db, p.captain);
    const member = contextFor(t.db, p.member);
    const { id } = await createCalendarEvent(captain, {
      title: "Extra build weekend",
      kind: "MEETING",
      startsOn: saturday,
      endsOn: sunday,
      startTime: "09:00",
      endTime: "13:00",
    });
    await setRsvp(member, { date: saturday, regular: "YES" });
    await setRsvp(member, { date: sunday, regular: "NO", note: "Away" });
    await setDayPlan(captain, { date: sunday, plan: "Wiring" });

    await deleteCalendarEvent(captain, { eventId: id });
    // The days are off again: no new answers or plans, but what was saved stays, and clearing still works.
    await expect(setRsvp(member, { date: saturday, regular: "HALF" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setDayPlan(captain, { date: sunday, plan: "Wiring, then drive practice" })).rejects.toBeInstanceOf(ValidationError);
    expect(await t.db.attendanceRsvp.count()).toBe(2);
    expect(await t.db.attendancePlan.count()).toBe(1);
    await setRsvp(member, { date: sunday, regular: "", note: "" });
    expect(await t.db.attendanceRsvp.count()).toBe(1);
    await expect(setDayPlan(captain, { date: sunday, plan: "" })).resolves.toMatchObject({ plan: "" });
    expect(await t.db.attendancePlan.count()).toBe(0);
  });

  it("attendance can be taken on one (Regular), like on any meeting day", async () => {
    await meeting(saturday);
    // Saturday morning in Anaheim.
    const ctx = { ...contextFor(t.db, p.teacher), now: new Date("2026-09-26T17:00:00Z") };
    const { id, created } = await openSession(ctx, { kind: "REGULAR" });
    expect(created).toBe(true);
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id } })).date).toEqual(dateOnlyToDb(saturday));
    const code = currentCodes(await secretOf(id), id, ctx.now).code;
    await expect(checkInWithCode({ ...contextFor(t.db, p.member), now: ctx.now }, { code })).resolves.toMatchObject({ sessionId: id, already: false });
  });
});

// ── Reports ───────────────────────────────────────────────────────────────────

describe("two-week reports", () => {
  it("cuts the season into two-week periods from the start Monday", () => {
    const s = DEFAULT_ATTENDANCE_SETTINGS; // starts Mon 2026-08-31
    expect(reportPeriodFor(s, "2026-08-31")).toEqual({ index: 0, start: "2026-08-31", end: "2026-09-13" });
    expect(reportPeriodFor(s, TEST_TODAY)).toEqual({ index: 1, start: "2026-09-14", end: "2026-09-27" });
    expect(reportPeriodsUpTo(s, TEST_TODAY).map((x) => x.index)).toEqual([1, 0]);
    expect(reportPeriodsUpTo(s, "2026-08-01")).toEqual([]);
  });

  it("counts attendance, said-yes-but-didn't-come, and came-without-answering", () => {
    const people = [
      { id: "a", name: "Ada", subteam: "BUILD" as const },
      { id: "b", name: "Ben", subteam: "SOFTWARE" as const },
      { id: "c", name: "Cy", subteam: null },
    ];
    const report = buildReport({
      sessions: [
        { id: "r1", date: "2026-09-15", kind: "REGULAR", openedByName: "Teacher", note: "Drive practice" },
        { id: "f1", date: "2026-09-15", kind: "FLEX", openedByName: null, note: "" },
        { id: "r2", date: "2026-09-16", kind: "REGULAR", openedByName: "Captain", note: "" },
      ],
      records: [
        { sessionId: "r1", userId: "a" },
        { sessionId: "r2", userId: "a" },
        { sessionId: "f1", userId: "a" },
        { sessionId: "r1", userId: "b" },
      ],
      rsvps: [
        { userId: "a", date: "2026-09-15", regular: "YES", flex: null }, // came to Flex without answering Flex
        { userId: "a", date: "2026-09-16", regular: "HALF", flex: null },
        { userId: "b", date: "2026-09-16", regular: "YES", flex: null }, // said yes, didn't come
        { userId: "c", date: "2026-09-15", regular: "NO", flex: "YES" }, // said yes to Flex, didn't come
      ],
      people,
    });
    expect(report.held).toEqual({ regular: 2, flex: 1 });
    expect(report.sessions.map((s) => [s.id, s.present, s.saidYes])).toEqual([
      ["f1", 1, 1],
      ["r1", 2, 1],
      ["r2", 1, 2],
    ]);
    const byId = Object.fromEntries(report.people.map((r) => [r.id, r]));
    expect(byId.a).toMatchObject({ regular: { attended: 2, held: 2 }, flex: { attended: 1, held: 1 }, saidYesMissed: 0, cameUnanswered: 1 });
    expect(byId.b).toMatchObject({ regular: { attended: 1, held: 2 }, flex: { attended: 0, held: 1 }, saidYesMissed: 1, cameUnanswered: 1 });
    expect(byId.c).toMatchObject({ regular: { attended: 0, held: 2 }, saidYesMissed: 1, cameUnanswered: 0 });
    expect(report.people.map((r) => r.name)).toEqual(["Ada", "Ben", "Cy"]);

    const csv = reportCsv(report, { start: "2026-09-14", end: "2026-09-27" });
    expect(csv.split("\r\n")[2]).toBe("Name,Subteam,Regular attended,Regular held,Flex attended,Flex held,Said yes but didn't come,Came without answering");
    expect(csv).toContain("Ada,Build,2,2,1,1,0,1");
    expect(csv).toContain("2026-09-15,Regular,Teacher,2,1,Drive practice");
  });

  it("escapes CSV cells, including spreadsheet formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("=HYPERLINK(\"x\")")).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell(3)).toBe("3");
    expect(csvCell(null)).toBe("");
    expect(csvRow(["=1+1", "ok"])).toBe("'=1+1,ok");
  });

  it("finds where a team day starts in the team timezone", () => {
    expect(startOfDayInTimezone("2026-09-24", TEST_TZ).toISOString()).toBe("2026-09-24T07:00:00.000Z");
    expect(startOfDayInTimezone("2026-12-01", TEST_TZ).toISOString()).toBe("2026-12-01T08:00:00.000Z");
    // Daylight saving changes during these days, but midnight is still before the switch.
    expect(startOfDayInTimezone("2026-03-08", TEST_TZ).toISOString()).toBe("2026-03-08T08:00:00.000Z");
    expect(startOfDayInTimezone("2026-11-01", TEST_TZ).toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(startOfDayInTimezone("2026-09-24", "UTC").toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });
});

// ── ?people= on New task ──────────────────────────────────────────────────────

describe("?people= prefill on New task", () => {
  it("reads a comma list, dropping junk and repeats", () => {
    expect(parsePeopleParam("a,b, c,,a")).toEqual(["a", "b", "c"]);
    expect(parsePeopleParam(["a", "b,c"])).toEqual(["a", "b", "c"]);
    expect(parsePeopleParam(undefined)).toEqual([]);
    expect(parsePeopleParam("ok,<script>,../x")).toEqual(["ok"]);
    expect(parsePeopleParam(Array.from({ length: 500 }, (_, i) => `id${i}`).join(","))).toHaveLength(200);
  });

  it("keeps only people the actor can assign", async () => {
    const requested = [p.member.id, p.member2.id, p.bizMember.id, "cnotaperson"];
    // A Build leader can assign Build people only.
    const buildGroups = await getAssignableUsers(p.buildLead, t.db);
    expect(prefillAssigneeIds(requested, buildGroups)).toEqual([p.member.id]);
    // The captain can assign anyone active.
    const captainGroups = await getAssignableUsers(p.captain, t.db);
    expect(prefillAssigneeIds(requested, captainGroups)).toEqual([p.member.id, p.member2.id, p.bizMember.id]);
    // People shown only with a note (e.g. not active) aren't picked.
    expect(prefillAssigneeIds(["x", "y"], [{ people: [{ id: "x" }, { id: "y", note: "Not active" }] }])).toEqual(["x"]);
  });
});

// ── Fixing mistakes ───────────────────────────────────────────────────────────

type PastRecord = { userId: string; method: "QR" | "CODE" | "MANUAL"; credit?: number; creditKind?: "REGULAR" | "EXTRA" | "FLEX" };

/** A session on another day (made directly, like the seed), with these check-ins. */
async function pastSession(daysAgo: number, records: PastRecord[] = [], kind: "REGULAR" | "FLEX" = "REGULAR") {
  return t.db.attendanceSession.create({
    data: {
      date: dateOnlyToDb(addDays(TEST_TODAY, -daysAgo)),
      kind,
      secret: newSessionSecret(),
      openedById: p.bizLead.id,
      closedAt: TEST_NOW,
      records: { create: records.map((r) => ({ ...r, checkedInAt: TEST_NOW })) },
    },
    select: { id: true },
  });
}

describe("deleting a session started by mistake", () => {
  beforeEach(resetAttendance);

  it("runners delete today's session, check-ins and all; others can't", async () => {
    const { id } = await openSession(contextFor(t.db, p.bizLead), { kind: "REGULAR" });
    const token = currentCodes(await secretOf(id), id, TEST_NOW).token;
    await checkInWithToken(contextFor(t.db, p.member), { token });
    for (const who of ["member", "swLead", "buildLead"] as const) {
      await expect(deleteSession(contextFor(t.db, p[who]), { sessionId: id }), who).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await deleteSession(contextFor(t.db, p.bizLead), { sessionId: id })).toEqual({ kind: "REGULAR", date: TEST_TODAY });
    expect(await t.db.attendanceSession.count()).toBe(0);
    expect(await t.db.attendanceRecord.count()).toBe(0);
    await expect(deleteSession(contextFor(t.db, p.bizLead), { sessionId: id })).rejects.toBeInstanceOf(NotFoundError);
    // Starting it again afterwards makes a fresh one.
    expect(await openSession(contextFor(t.db, p.bizLead), { kind: "REGULAR" })).toMatchObject({ created: true });
  });

  it("an earlier day's session can go only while nobody checked themselves in to it", async () => {
    const scanned = await pastSession(2, [{ userId: p.member.id, method: "QR" }]);
    const err = await deleteSession(contextFor(t.db, p.teacher), { sessionId: scanned.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe(CANT_DELETE_SESSION);
    expect(await t.db.attendanceRecord.count({ where: { sessionId: scanned.id } })).toBe(1);

    const byHand = await pastSession(2, [{ userId: p.member.id, method: "MANUAL" }], "FLEX");
    await deleteSession(contextFor(t.db, p.captain), { sessionId: byHand.id });
    expect(await t.db.attendanceSession.count({ where: { id: byHand.id } })).toBe(0);
  });
});

describe("old sessions", () => {
  beforeEach(resetAttendance);

  it("admins fix who was there and credits any time, however old; 'What we did' and delete keep the week rule for runners", async () => {
    expect(canEditSessionOn(p.bizLead, addDays(TEST_TODAY, -ATTENDANCE_EDIT_DAYS), TEST_TODAY)).toBe(true);
    expect(canEditSessionOn(p.bizLead, addDays(TEST_TODAY, -ATTENDANCE_EDIT_DAYS - 1), TEST_TODAY)).toBe(false);

    const old = await pastSession(200, [
      { userId: p.member2.id, method: "QR" },
      { userId: p.bizMember.id, method: "QR" },
    ]);
    for (const who of ["swLead", "buildLead", "bizLead", "captain", "mentor", "teacher", "owner"] as const) {
      const ctx = contextFor(t.db, p[who]);
      await addPerson(ctx, { sessionId: old.id, userId: p.member.id, option: "1/3" });
      await setCredit(ctx, { sessionId: old.id, userId: p.member2.id, option: "2/3" });
      await setCredit(ctx, { sessionId: old.id, userId: p.member2.id, option: "1" });
      await removePerson(ctx, { sessionId: old.id, userId: p.member.id });
    }
    expect(await t.db.attendanceChange.count({ where: { sessionId: old.id } })).toBe(7 * 4);

    // "What we did" and deleting it: runners, and after a week only teachers, mentors, and owners.
    for (const who of ["bizLead", "captain"] as const) {
      const ctx = contextFor(t.db, p[who]);
      await expect(setSessionNote(ctx, { sessionId: old.id, note: "rewrite" }), who).rejects.toThrow(OLD_SESSION);
      await expect(deleteSession(ctx, { sessionId: old.id }), who).rejects.toThrow(OLD_SESSION);
    }
    await expect(setSessionNote(contextFor(t.db, p.swLead), { sessionId: old.id, note: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const who of ["teacher", "mentor", "owner"] as const) {
      await setSessionNote(contextFor(t.db, p[who]), { sessionId: old.id, note: `Note by ${who}` });
    }
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id: old.id } })).note).toBe("Note by owner");
    const recent = await pastSession(ATTENDANCE_EDIT_DAYS);
    await setSessionNote(contextFor(t.db, p.captain), { sessionId: recent.id, note: "Fixed later" });
  });
});

describe("saving over someone else's text", () => {
  beforeEach(resetAttendance);

  it("'What we did' isn't silently replaced when it changed since the form loaded", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const teacher = contextFor(t.db, p.teacher);
    const bizLead = contextFor(t.db, p.bizLead);
    // Both open the empty note; the teacher saves first.
    await setSessionNote(teacher, { sessionId: id, note: "Drive practice", base: "" });
    const err = await setSessionNote(bizLead, { sessionId: id, note: "Sponsor calls", base: "" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe(NOTE_CHANGED);
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id } })).note).toBe("Drive practice");
    // Saving again from the latest text works (line breaks sent as CRLF by forms still match).
    await setSessionNote(teacher, { sessionId: id, note: "Drive practice\nAuto paths", base: "Drive practice" });
    await setSessionNote(bizLead, { sessionId: id, note: "Drive practice\nAuto paths\nSponsor calls", base: "Drive practice\r\nAuto paths" });
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id } })).note).toBe("Drive practice\nAuto paths\nSponsor calls");
    // Saving the same text as what's there is fine even from an old form.
    await expect(setSessionNote(teacher, { sessionId: id, note: "Drive practice\nAuto paths\nSponsor calls", base: "old" })).resolves.toBeUndefined();
  });

  it("a day's plan isn't silently replaced either (creating, changing, or removing it)", async () => {
    const nextDay = addDays(TEST_TODAY, 4); // the next team day (Monday)
    const captain = contextFor(t.db, p.captain);
    const swLead = contextFor(t.db, p.swLead);
    await setDayPlan(captain, { date: nextDay, plan: "Drive practice", base: "" });
    await expect(setDayPlan(swLead, { date: nextDay, plan: "Auto paths", base: "" })).rejects.toThrow(PLAN_CHANGED);
    await setDayPlan(swLead, { date: nextDay, plan: "Drive practice, then auto paths", base: "Drive practice" });
    await expect(setDayPlan(captain, { date: nextDay, plan: "", base: "Drive practice" })).rejects.toThrow(PLAN_CHANGED);
    await expect(setDayPlan(captain, { date: nextDay, plan: "Scrimmage", base: "Drive practice" })).rejects.toThrow(PLAN_CHANGED);
    expect((await t.db.attendancePlan.findUniqueOrThrow({ where: { date: dateOnlyToDb(nextDay) } })).plan).toBe(
      "Drive practice, then auto paths",
    );
    await setDayPlan(captain, { date: nextDay, plan: "", base: "Drive practice, then auto paths" });
    expect(await t.db.attendancePlan.count()).toBe(0);
  });
});

describe("accounts with attendance history", () => {
  beforeEach(resetAttendance);

  it("can't be deleted (it would drop out of past reports): disable them instead", async () => {
    const leaver = await makeUser(t.db, { name: "Leaver" });
    const answered = await makeUser(t.db, { name: "Answered" });
    const s = await pastSession(3, [{ userId: leaver.id, method: "QR" }]);
    await setRsvp(contextFor(t.db, answered), { date: TEST_TODAY, regular: "YES" });
    for (const user of [leaver, answered]) {
      await t.db.user.update({ where: { id: user.id }, data: { status: "REJECTED" } });
      await expect(deleteUser(contextFor(t.db, p.owner), { userId: user.id })).rejects.toThrow(HAS_ACTIVITY_MESSAGE);
    }
    expect(await t.db.attendanceRecord.count({ where: { sessionId: s.id } })).toBe(1);
    expect(await t.db.attendanceRsvp.count({ where: { userId: answered.id } })).toBe(1);
  });
});

describe("report details", () => {
  it("doesn't count sessions from before someone joined (unless they came)", () => {
    const report = buildReport({
      sessions: [
        { id: "r1", date: "2026-09-14", kind: "REGULAR", openedByName: null, note: "" },
        { id: "r2", date: "2026-09-16", kind: "REGULAR", openedByName: null, note: "" },
        { id: "f1", date: "2026-09-17", kind: "FLEX", openedByName: null, note: "" },
        { id: "r3", date: "2026-09-21", kind: "REGULAR", openedByName: null, note: "" },
      ],
      records: [
        { sessionId: "r3", userId: "new" },
        { sessionId: "r1", userId: "early" }, // came before their account existed (added by hand later)
      ],
      rsvps: [],
      people: [
        { id: "new", name: "New", subteam: "BUILD", since: "2026-09-17" },
        { id: "early", name: "Early", subteam: null, since: "2026-09-20" },
        { id: "old", name: "Old", subteam: null },
      ],
    });
    const byId = Object.fromEntries(report.people.map((r) => [r.id, r]));
    expect(byId.new).toMatchObject({ regular: { attended: 1, held: 1 }, flex: { attended: 0, held: 1 } });
    expect(byId.early).toMatchObject({ regular: { attended: 1, held: 2 }, flex: { attended: 0, held: 0 } });
    expect(byId.old).toMatchObject({ regular: { attended: 0, held: 3 }, flex: { attended: 0, held: 1 } });
    expect(report.held).toEqual({ regular: 3, flex: 1 });
  });

  it("CSV quotes semicolons (another list separator) and lists what got done", () => {
    expect(csvCell("x;=HYPERLINK(1)")).toBe('"x;=HYPERLINK(1)"');
    const report = buildReport({
      sessions: [{ id: "r1", date: "2026-09-15", kind: "REGULAR", openedByName: "T", note: "a;b" }],
      records: [],
      rsvps: [],
      people: [],
    });
    const csv = reportCsv(report, { start: "2026-09-14", end: "2026-09-27" }, {
      tasks: [{ title: "=cmd", subteam: "BUILD", people: ["Ada"] }, { title: "Intake CAD", subteam: null, people: ["Ada", "Ben"] }],
      parts: [{ name: "Side plate", quantity: 2, madeBy: null }],
      notebook: [{ title: "Intake", notebook: "Hardware", page: "Intake", author: "Cy" }],
    });
    const lines = csv.split("\r\n");
    expect(lines).toContain("Date,Kind,Run by,Came,Said yes,What we did");
    expect(lines).toContain('2026-09-15,Regular,T,0,0,"a;b"');
    expect(lines).toContain("What got done");
    expect(lines).toContain(",'=cmd,Build,Ada");
    expect(lines).toContain(',Intake CAD,Whole team,"Ada, Ben"');
    expect(lines).toContain(",Side plate,2,");
    expect(lines).toContain(",Intake,Hardware,Intake,Cy");
  });

  it("keeps periods from before 'Reports start' reachable (negative indices)", () => {
    const s = { ...DEFAULT_ATTENDANCE_SETTINGS, reportStart: "2026-09-28" }; // moved to next season
    expect(reportPeriodFor(s, TEST_TODAY)).toEqual({ index: -1, start: "2026-09-14", end: "2026-09-27" });
    expect(firstReportIndex(s, "2026-08-31", -1)).toBe(-2);
    expect(firstReportIndex(s, null, -1)).toBe(0); // nothing taken yet: no reports
    expect(firstReportIndex(DEFAULT_ATTENDANCE_SETTINGS, "2026-09-20", 1)).toBe(0);
    expect(firstReportIndex(s, "1990-01-01", 5)).toBe(5 - REPORT_PERIODS_MAX + 1);
    expect(reportPeriodsBetween(s, -2, -1).map((x) => x.start)).toEqual(["2026-09-14", "2026-08-31"]);
    expect(reportPeriodsBetween(s, 0, -1)).toEqual([]);
    expect(parseReportIndex("0")).toBe(0);
    expect(parseReportIndex("12")).toBe(12);
    expect(parseReportIndex("-3")).toBe(-3);
    for (const bad of ["-0", "01", "1.5", "", "abc", "123456", "1e3"]) expect(parseReportIndex(bad), bad).toBeNull();
  });
});

describe("?due= and ?back= on New task", () => {
  it("uses the planned day as the due date when it's a real day in range", () => {
    expect(prefillDueDate("2026-09-29", "2026-09-01", "2026-12-31")).toBe("2026-09-29");
    expect(prefillDueDate(["2026-09-29", "x"], "2026-09-01", "2026-12-31")).toBe("2026-09-29");
    expect(prefillDueDate("2026-02-30", "2026-01-01", "2026-12-31")).toBeNull();
    expect(prefillDueDate("2027-06-01", "2026-09-01", "2026-12-31")).toBeNull();
    expect(prefillDueDate(undefined, "2026-09-01", "2026-12-31")).toBeNull();
  });

  it("only goes back to Who's coming", () => {
    expect(prefillBackHref("/attendance/plan?day=2026-09-29")).toBe("/attendance/plan?day=2026-09-29");
    for (const bad of ["https://evil.example.com", "//evil.example.com", "/attendance/plan?day=x", "/admin", undefined]) {
      expect(prefillBackHref(bad)).toBeNull();
    }
  });
});

// ── Credits and the weekly target ─────────────────────────────────────────────

describe("credit options (pure)", () => {
  it("Regular sessions fit 1, 2/3, 1/2, 1/3, 1/2 EC, 1 EC; Flex sessions 1/2 Flex and 1 Flex; No credit is 0", () => {
    expect(creditOptionsFor("REGULAR").map((o) => o.label)).toEqual(["1", "2/3", "1/2", "1/3", "1/2 EC", "1 EC"]);
    expect(creditOptionsFor("FLEX").map((o) => o.label)).toEqual(["1/2 Flex", "1 Flex"]);
    expect(CREDIT_OPTIONS.map((o) => [o.id, o.credit, o.kind])).toEqual([
      ["1", 6, "REGULAR"],
      ["2/3", 4, "REGULAR"],
      ["1/2", 3, "REGULAR"],
      ["1/3", 2, "REGULAR"],
      ["1/2ec", 3, "EXTRA"],
      ["1ec", 6, "EXTRA"],
      ["1/2flex", 3, "FLEX"],
      ["1flex", 6, "FLEX"],
      ["none", 0, "REGULAR"],
    ]);
    expect(defaultCreditOption("REGULAR").id).toBe("1");
    expect(defaultCreditOption("FLEX").id).toBe("1flex");
    expect(creditOptionFits("1ec", "REGULAR")).toBe(true);
    expect(creditOptionFits("1ec", "FLEX")).toBe(false);
    expect(creditOptionFits("1/2flex", "REGULAR")).toBe(false);
    expect(creditOptionFits("none", "REGULAR")).toBe(false);
    expect(creditOptionFits("nope", "REGULAR")).toBe(false);
    expect(creditOptionOf(3, "EXTRA")).toBe("1/2ec");
    expect(creditOptionOf(6, "FLEX")).toBe("1flex");
    expect(creditOptionOf(5, "REGULAR")).toBeNull();
    expect(creditOptionOf(0, "REGULAR")).toBe("none");
    expect(creditOptionOf(0, "FLEX")).toBe("none");
    expect(creditLabel(4, "REGULAR")).toBe("2/3");
    expect(creditLabel(6, "EXTRA")).toBe("1 EC");
    expect(creditLabel(5, "EXTRA")).toBe("5/6 EC");
    expect(creditLabel(0, "REGULAR")).toBe("No credit");
    expect(isExtraCreditOption("1/2ec")).toBe(true);
    expect(isExtraCreditOption("1/2")).toBe(false);
    expect(cameWith({ credit: 0 })).toBe(false);
    expect(cameWith({ credit: 2 })).toBe(true);
  });

  it("members pick only at Flex; admins' menus follow the check-in method and whether they may give EC", () => {
    expect(memberCreditOptions("REGULAR")).toEqual([]);
    expect(memberCreditOptions("FLEX").map((o) => o.id)).toEqual(["1/2flex", "1flex"]);
    expect(HAND_CREDIT_IDS).toEqual(["2/3", "1/2", "1/3", "1/2ec", "1ec", "none"]);
    const ids = (kind: "REGULAR" | "FLEX", method: "QR" | "CODE" | "MANUAL", canGiveExtraCredit: boolean) =>
      adminCreditOptions({ kind, method, canGiveExtraCredit }).map((o) => o.label);
    expect(ids("REGULAR", "QR", true)).toEqual(["1", "2/3", "1/2", "1/3", "1/2 EC", "1 EC", "No credit"]);
    expect(ids("REGULAR", "CODE", false)).toEqual(["1", "2/3", "1/2", "1/3", "No credit"]);
    expect(ids("REGULAR", "MANUAL", true)).toEqual(["2/3", "1/2", "1/3", "1/2 EC", "1 EC", "No credit"]);
    expect(ids("REGULAR", "MANUAL", false)).toEqual(["2/3", "1/2", "1/3", "No credit"]);
    expect(ids("FLEX", "QR", true)).toEqual(["1 Flex", "1/2 Flex", "2/3", "1/2", "1/3", "1/2 EC", "1 EC", "No credit"]);
    expect(ids("FLEX", "QR", false)).toEqual(["1 Flex", "1/2 Flex", "2/3", "1/2", "1/3", "No credit"]);
    expect(ids("FLEX", "MANUAL", false)).toEqual(["2/3", "1/2", "1/3", "No credit"]);
    // A record added by hand never offers 1 or Flex credit.
    for (const kind of ["REGULAR", "FLEX"] as const) {
      for (const ec of [true, false]) {
        const hand = adminCreditOptions({ kind, method: "MANUAL", canGiveExtraCredit: ec });
        expect(hand.some((o) => o.id === "1" || o.kind === "FLEX")).toBe(false);
      }
    }
  });

  it("who may give EC: the Business leader, teachers, mentors, and owners (not other leaders or the captain)", () => {
    const yes = ["bizLead", "mentor", "teacher", "owner"] as const;
    const no = ["member", "member2", "bizMember", "swLead", "buildLead", "captain"] as const;
    for (const who of yes) expect(canGiveExtraCredit(p[who]), who).toBe(true);
    for (const who of no) expect(canGiveExtraCredit(p[who]), who).toBe(false);
    // Every admin fixes attendance and reads the change log; members don't.
    for (const who of ["swLead", "buildLead", "bizLead", "captain", "mentor", "teacher", "owner"] as const) {
      expect([canFixAttendance(p[who]), canViewAttendanceChanges(p[who])], who).toEqual([true, true]);
    }
    for (const who of ["member", "member2", "bizMember"] as const) {
      expect([canFixAttendance(p[who]), canViewAttendanceChanges(p[who])], who).toEqual([false, false]);
    }
  });

  it("formats sixths as mixed numbers, and as decimals for spreadsheets", () => {
    const cases: [number, string][] = [
      [12, "2"],
      [10, "1 2/3"],
      [9, "1 1/2"],
      [8, "1 1/3"],
      [7, "1 1/6"],
      [6, "1"],
      [5, "5/6"],
      [4, "2/3"],
      [3, "1/2"],
      [2, "1/3"],
      [1, "1/6"],
      [0, "0"],
      [-3, "0"],
      [21, "3 1/2"],
    ];
    for (const [n, text] of cases) expect(formatSixths(n), String(n)).toBe(text);
    expect(sixthsToDecimal(10)).toBe("1.67");
    expect(sixthsToDecimal(3)).toBe("0.5");
    expect(sixthsToDecimal(12)).toBe("2");
    expect(sixthsToDecimal(0)).toBe("0");
    // People read totals with fraction characters and "of" (not "1 2/3 / 2"); spreadsheets get decimals.
    const shown: [number, string][] = [
      [27, "4½"],
      [4, "⅔"],
      [10, "1⅔"],
      [5, "⅚"],
      [7, "1⅙"],
      [2, "⅓"],
      [12, "2"],
      [0, "0"],
      [-1, "0"],
    ];
    for (const [n, text] of shown) expect(formatCredits(n), String(n)).toBe(text);
    expect(weekProgressText(10, 2)).toBe("1⅔ of 2");
    expect(weekProgressText(27, 2)).toBe("4½ of 2");
    expect(weekProgressText(4, 2)).toBe("⅔ of 2");
    expect(metWeeklyTarget(11, 2)).toBe(false);
    expect(metWeeklyTarget(12, 2)).toBe(true);
    expect(metWeeklyTarget(15, 2)).toBe(true);
  });

  it("adds up a week: every kind counts toward the total, with a breakdown", () => {
    const week = sumCredits([
      { credit: 6, creditKind: "REGULAR" },
      { credit: 3, creditKind: "FLEX" },
      { credit: 3, creditKind: "EXTRA" },
    ]);
    expect(week).toEqual({ total: 12, regular: 6, extra: 3, flex: 3 });
    expect(creditBreakdown(week)).toBe("1 regular · ½ Flex · ½ EC");
    expect(creditBreakdown(sumCredits([{ credit: 4, creditKind: "REGULAR" }]))).toBe("⅔ regular");
    expect(creditBreakdown(sumCredits([]))).toBe("");
  });

  it("weeks run Monday to Sunday, by calendar day (month, year, and daylight-saving changes don't matter)", () => {
    expect(weekStartOf("2026-09-21")).toBe("2026-09-21"); // Monday
    expect(weekStartOf(TEST_TODAY)).toBe("2026-09-21"); // Thursday
    expect(weekStartOf("2026-09-27")).toBe("2026-09-21"); // Sunday: still that week
    expect(weekStartOf("2026-09-28")).toBe("2026-09-28");
    expect(weekOf(TEST_TODAY)).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(weekOf("2027-01-01")).toEqual({ start: "2026-12-28", end: "2027-01-03" });
    // Clocks go back on Sunday Nov 1 and forward on Sunday Mar 8 (Pacific).
    expect(weekOf("2026-11-01")).toEqual({ start: "2026-10-26", end: "2026-11-01" });
    expect(weekOf("2026-11-02")).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(weekOf("2026-03-08")).toEqual({ start: "2026-03-02", end: "2026-03-08" });
  });
});

describe("weekly target setting", () => {
  beforeEach(resetAttendance);

  it("parses only a whole number from 1 to 7 (default 2), and saves it with the schedule, nothing else", () => {
    const base = { regularDays: [1, 2, 4], flexDays: [2, 4], reportStart: "2026-08-31" };
    expect(parseAttendanceSettings(JSON.stringify(base)).weeklyTarget).toBe(2);
    expect(parseAttendanceSettings(JSON.stringify({ ...base, weeklyTarget: 3 })).weeklyTarget).toBe(3);
    for (const bad of ["3", 2.5, 0, 8, -1, null, true]) {
      expect(parseAttendanceSettings(JSON.stringify({ ...base, weeklyTarget: bad })).weeklyTarget, String(bad)).toBe(2);
    }
    expect(parseAttendanceSettings("not json").weeklyTarget).toBe(2);
    expect(parseWeeklyTarget("3")).toBe(3);
    expect(parseWeeklyTarget(" 7 ")).toBe(7);
    for (const bad of ["0", "8", "2.5", "x", "", 1.5, undefined]) expect(parseWeeklyTarget(bad), String(bad)).toBeNull();
    const loaded = { ...base, weeklyTarget: 4, extraDays: ["2026-09-26"], junk: "x" } as AttendanceSettings;
    expect(JSON.parse(serializeAttendanceSettings(loaded))).toEqual({ ...base, weeklyTarget: 4 });
  });

  it("runners change it on the Schedule page; leaving it out keeps the saved one; out of range is refused", async () => {
    const ctx = contextFor(t.db, p.teacher);
    const input = { regularDays: ["1", "2", "4"], flexDays: ["2", "4"], reportStart: "2026-08-31" };
    expect(await updateSettings(ctx, { ...input, weeklyTarget: "3" })).toMatchObject({ weeklyTarget: 3 });
    expect((await getSavedAttendanceSettings(t.db)).weeklyTarget).toBe(3);
    expect(await updateSettings(ctx, input)).toMatchObject({ weeklyTarget: 3 });
    expect((await getAttendanceSettings(TEST_TODAY, t.db)).weeklyTarget).toBe(3);
    for (const bad of ["0", "8", "2.5", "two", 3.5]) {
      const err = await updateSettings(ctx, { ...input, weeklyTarget: bad }).catch((e: unknown) => e);
      expect(err, String(bad)).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).fieldErrors.weeklyTarget).toBe("Pick 1 to 7 times a week.");
    }
    await expect(updateSettings(contextFor(t.db, p.swLead), { ...input, weeklyTarget: "1" })).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getSavedAttendanceSettings(t.db)).weeklyTarget).toBe(3);
  });
});

describe("credits at check-in", () => {
  beforeEach(resetAttendance);

  it("a member's own check-in counts as 1 at Regular and 1 Flex at Flex (scanning or typing the code)", async () => {
    const regular = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const flex = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    await checkInWithToken(contextFor(t.db, p.member), { token: currentCodes(await secretOf(regular.id), regular.id, TEST_NOW).token });
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(await secretOf(flex.id), flex.id, TEST_NOW).code });
    const rows = await t.db.attendanceRecord.findMany({ select: { sessionId: true, userId: true, credit: true, creditKind: true, creditChangedById: true } });
    expect(rows).toEqual(
      expect.arrayContaining([
        { sessionId: regular.id, userId: p.member.id, credit: 6, creditKind: "REGULAR", creditChangedById: null },
        { sessionId: flex.id, userId: p.member.id, credit: 6, creditKind: "FLEX", creditChangedById: null },
      ]),
    );
    // Members' own check-ins aren't in the change log.
    expect(await t.db.attendanceChange.count()).toBe(0);
  });

  it("put down as No credit before they got here, scanning in makes it a real check-in (logged); a scan an admin set to No credit stays", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const secret = await secretOf(id);
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member.id, option: "none" });
    const scanAt = at(20 * MINUTE);
    expect(await checkInWithToken({ ...contextFor(t.db, p.member), now: scanAt }, { token: currentCodes(secret, id, scanAt).token })).toEqual({
      sessionId: id,
      kind: "REGULAR",
      already: false,
    });
    expect(await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId: id, userId: p.member.id } })).toMatchObject({
      method: "QR",
      credit: 6,
      creditKind: "REGULAR",
      checkedInAt: scanAt,
      markedById: null,
      creditChangedById: null,
    });
    // History says why the "not here" entry changed: the member scanned in over it.
    expect(await t.db.attendanceChange.findFirstOrThrow({ where: { action: "CREDIT_CHANGED", userId: p.member.id } })).toMatchObject({
      changedById: p.member.id,
      fromCredit: 0,
      toCredit: 6,
      toKind: "REGULAR",
    });
    // Scanned, then an admin said No credit: scanning again doesn't undo it.
    await checkInWithCode(contextFor(t.db, p.bizMember), { code: currentCodes(secret, id, TEST_NOW).code });
    await setCredit(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.bizMember.id, option: "none" });
    await expect(checkInWithCode(contextFor(t.db, p.bizMember), { code: currentCodes(secret, id, TEST_NOW).code })).rejects.toThrow(MARKED_NOT_HERE);
    await expect(checkInWithToken(contextFor(t.db, p.bizMember), { token: currentCodes(secret, id, TEST_NOW).token })).rejects.toThrow(MARKED_NOT_HERE);
    expect(await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId: id, userId: p.bizMember.id } })).toMatchObject({ credit: 0 });
  });

  it("given part credit by hand before they got here, scanning in while it's open counts as 1 (reviewers' high finding, P2)", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const flex = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member2.id, option: "1/2" });
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: flex.id, userId: p.member2.id, option: "1/3" });
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member.id, option: "1/2ec" });
    const later = { ...contextFor(t.db, p.member2), now: at(15 * MINUTE) };
    expect(await checkInWithCode(later, { code: currentCodes(await secretOf(id), id, later.now).code })).toEqual({
      sessionId: id,
      kind: "REGULAR",
      already: false,
    });
    await checkInWithToken(later, { token: currentCodes(await secretOf(flex.id), flex.id, later.now).token });
    await checkInWithToken(contextFor(t.db, p.member), { token: currentCodes(await secretOf(id), id, TEST_NOW).token });
    const rows = await t.db.attendanceRecord.findMany({
      where: { userId: { in: [p.member.id, p.member2.id] } },
      select: { sessionId: true, userId: true, method: true, credit: true, creditKind: true, creditChangedById: true },
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        { sessionId: id, userId: p.member2.id, method: "CODE", credit: 6, creditKind: "REGULAR", creditChangedById: null },
        { sessionId: flex.id, userId: p.member2.id, method: "QR", credit: 6, creditKind: "FLEX", creditChangedById: null },
        // 1/2 EC is less than a check-in's 1: the scan counts.
        { sessionId: id, userId: p.member.id, method: "QR", credit: 6, creditKind: "REGULAR", creditChangedById: null },
      ]),
    );
    // Scanning again: already in.
    expect(await checkInWithCode(later, { code: currentCodes(await secretOf(id), id, later.now).code })).toMatchObject({ already: true });
    // Each upgrade is one row by the person themselves.
    expect(await t.db.attendanceChange.count({ where: { action: "CREDIT_CHANGED", changedById: p.member2.id } })).toBe(2);
    // Closed: the hand entry stays as it was (nobody can scan in any more).
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.bizMember.id, option: "1/3" });
    await closeSession(contextFor(t.db, p.teacher), { sessionId: id });
    await expect(checkInWithToken(contextFor(t.db, p.bizMember), { token: currentCodes(await secretOf(id), id, TEST_NOW).token })).rejects.toThrow(
      SESSION_CLOSED,
    );
    expect(await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId: id, userId: p.bizMember.id } })).toMatchObject({ method: "MANUAL", credit: 2 });
  });

  it("a hand entry an admin changed later: No credit stays (P3); part credit becomes a scan the admins can raise to 1", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const secret = await secretOf(id);
    const lead = contextFor(t.db, p.bizLead);
    const later = { ...contextFor(t.db, p.captain), now: at(30 * MINUTE) };
    // Added as 1/2, then set to No credit because they left: scanning doesn't undo that (like a scan set to No credit).
    await addPerson(lead, { sessionId: id, userId: p.member.id, option: "1/2" });
    await setCredit(later, { sessionId: id, userId: p.member.id, option: "none" });
    await expect(checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(secret, id, TEST_NOW).code })).rejects.toThrow(MARKED_NOT_HERE);
    expect(await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId: id, userId: p.member.id } })).toMatchObject({
      method: "MANUAL",
      credit: 0,
      creditChangedById: p.captain.id,
    });
    // Added as 1/3, then an admin made it 2/3: scanning keeps 2/3 (theirs) but it's a scan now, so 1 is allowed.
    await addPerson(lead, { sessionId: id, userId: p.member2.id, option: "1/3" });
    await setCredit(later, { sessionId: id, userId: p.member2.id, option: "2/3" });
    expect(await checkInWithToken(contextFor(t.db, p.member2), { token: currentCodes(secret, id, TEST_NOW).token })).toEqual({
      sessionId: id,
      kind: "REGULAR",
      already: false,
      kept: { label: "2/3", by: "captain" },
    });
    expect(await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId: id, userId: p.member2.id } })).toMatchObject({
      method: "QR",
      credit: 4,
      creditChangedById: p.captain.id,
      markedById: null,
    });
    await expect(setCredit(contextFor(t.db, p.teacher), { sessionId: id, userId: p.member2.id, option: "1" })).resolves.toMatchObject({ option: "1" });
    // Added as 1 EC (as much as a check-in): the scan keeps it, and it's a scan now.
    await addPerson(lead, { sessionId: id, userId: p.bizMember.id, option: "1ec" });
    expect(await checkInWithCode(contextFor(t.db, p.bizMember), { code: currentCodes(secret, id, TEST_NOW).code })).toMatchObject({
      already: false,
      kept: { label: "1 EC", by: "bizLead" },
    });
    expect(await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId: id, userId: p.bizMember.id } })).toMatchObject({
      method: "CODE",
      credit: 6,
      creditKind: "EXTRA",
    });
    // None of these scans changed a credit, so none is in the log.
    expect(await t.db.attendanceChange.count({ where: { changedById: { in: [p.member.id, p.member2.id, p.bizMember.id] } } })).toBe(0);
  });

  it("an old link doesn't count for someone who's only on the list by hand (they need a fresh code)", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const old = currentCodes(await secretOf(id), id, at(-20 * MINUTE)).token;
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member.id, option: "1/2" });
    await expect(checkInWithToken(contextFor(t.db, p.member), { token: old })).rejects.toThrow(QR_EXPIRED);
    await checkInWithToken(contextFor(t.db, p.member2), { token: currentCodes(await secretOf(id), id, TEST_NOW).token });
    expect(await checkInWithToken(contextFor(t.db, p.member2), { token: old })).toMatchObject({ already: true });
  });
});

describe("picking your own credit (Flex only)", () => {
  let flexId: string;
  let regularId: string;
  beforeEach(async () => {
    await resetAttendance();
    ({ id: regularId } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" }));
    ({ id: flexId } = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" }));
    for (const who of ["member", "member2"] as const) {
      for (const id of [regularId, flexId]) {
        await checkInWithToken(contextFor(t.db, p[who]), { token: currentCodes(await secretOf(id), id, TEST_NOW).token });
      }
    }
  });

  const mine = (sessionId: string, userId: string) =>
    t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId, userId }, select: { credit: true, creditKind: true, creditChangedAt: true } });

  it("at Regular there's nothing to pick: a check-in counts as 1", async () => {
    for (const option of ["1/2", "1/3", "2/3", "1ec", "1", "none"]) {
      await expect(setMyCredit(contextFor(t.db, p.member), { sessionId: regularId, option }), option).rejects.toThrow(REGULAR_NO_PICK);
    }
    expect(await mine(regularId, p.member.id)).toEqual({ credit: 6, creditKind: "REGULAR", creditChangedAt: null });
  });

  it("at Flex, 1/2 Flex or 1 Flex, your own only, and switching back and forth that day", async () => {
    const ctx = contextFor(t.db, p.member);
    expect(await setMyCredit(ctx, { sessionId: flexId, option: "1/2flex" })).toEqual({ option: "1/2flex", unchanged: false });
    expect(await mine(flexId, p.member.id)).toEqual({ credit: 3, creditKind: "FLEX", creditChangedAt: null });
    expect(await setMyCredit(ctx, { sessionId: flexId, option: "1flex", userId: p.member2.id })).toMatchObject({ option: "1flex" });
    expect(await mine(flexId, p.member.id)).toMatchObject({ credit: 6, creditKind: "FLEX" });
    expect(await mine(flexId, p.member2.id)).toMatchObject({ credit: 6, creditKind: "FLEX" }); // a userId is ignored
    expect(await setMyCredit(ctx, { sessionId: flexId, option: "1flex" })).toEqual({ option: "1flex", unchanged: true });
    await setMyCredit(ctx, { sessionId: flexId, option: "1/2flex" });

    for (const option of ["1", "1/2", "2/3", "1/3", "1ec", "1/2ec", "none"]) {
      const err = await setMyCredit(ctx, { sessionId: flexId, option }).catch((e: unknown) => e);
      expect((err as ValidationError).fieldErrors.option, option).toBe(FLEX_CREDIT_ONLY);
    }
    await expect(setMyCredit(ctx, { sessionId: flexId, option: "3/4" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setMyCredit(ctx, { sessionId: flexId })).rejects.toBeInstanceOf(ValidationError);
    await expect(setMyCredit(contextFor(t.db, p.bizMember), { sessionId: flexId, option: "1/2flex" })).rejects.toThrow(NOT_CHECKED_IN);
    const pending = await makeUser(t.db, { status: "PENDING" });
    await expect(setMyCredit(contextFor(t.db, pending), { sessionId: flexId, option: "1/2flex" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await mine(flexId, p.member.id)).toMatchObject({ credit: 3, creditKind: "FLEX" });
    // Own picks aren't in the change log.
    expect(await t.db.attendanceChange.count()).toBe(0);
  });

  it("only on the day (team timezone): late that evening yes, after midnight or for an earlier day no", async () => {
    const ctx = contextFor(t.db, p.member);
    // 11:30 PM in Anaheim on the same day.
    await expect(setMyCredit({ ...ctx, now: new Date("2026-09-25T06:30:00Z") }, { sessionId: flexId, option: "1/2flex" })).resolves.toMatchObject({
      option: "1/2flex",
    });
    await expect(setMyCredit({ ...ctx, now: new Date("2026-09-25T07:30:00Z") }, { sessionId: flexId, option: "1flex" })).rejects.toThrow(
      CREDIT_PAST_DAY,
    );
    const earlier = await pastSession(2, [{ userId: p.member.id, method: "QR", credit: 6, creditKind: "FLEX" }], "FLEX");
    await expect(setMyCredit(ctx, { sessionId: earlier.id, option: "1/2flex" })).rejects.toThrow(CREDIT_PAST_DAY);
    expect(await mine(flexId, p.member.id)).toMatchObject({ credit: 3 });
  });

  it("once an admin changed it, it's theirs: the member is told who to ask; added by hand it's the admins' too", async () => {
    await setCredit(contextFor(t.db, p.buildLead), { sessionId: flexId, userId: p.member.id, option: "1/2flex" });
    const err = await setMyCredit(contextFor(t.db, p.member), { sessionId: flexId, option: "1flex" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).message).toBe("buildLead set how much this counts. Ask them if it's wrong.");
    expect(await mine(flexId, p.member.id)).toMatchObject({ credit: 3, creditKind: "FLEX" });
    // Added by hand (by another admin): admins change it on the session's page, not with the member picker.
    await addPerson(contextFor(t.db, p.captain), { sessionId: flexId, userId: p.teacher.id, option: "1/2" });
    await expect(setMyCredit(contextFor(t.db, p.teacher), { sessionId: flexId, option: "1flex" })).rejects.toThrow(ADDED_BY_HAND);
  });
});

describe("admins changing credits", () => {
  let sessionId: string;
  let flexId: string;
  beforeEach(async () => {
    await resetAttendance();
    ({ id: sessionId } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" }));
    ({ id: flexId } = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" }));
    await checkInWithToken(contextFor(t.db, p.member), { token: currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).token });
    await checkInWithToken(contextFor(t.db, p.member), { token: currentCodes(await secretOf(flexId), flexId, TEST_NOW).token });
  });

  const record = (id: string, userId: string) => t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId: id, userId } });

  it("every admin changes anyone's (recording who and when); members and pending accounts can't", async () => {
    const pending = await makeUser(t.db, { role: "CAPTAIN", status: "PENDING" });
    for (const [who, actor] of [
      ["member", p.member],
      ["member2", p.member2],
      ["pending", pending],
    ] as const) {
      await expect(setCredit(contextFor(t.db, actor), { sessionId, userId: p.member.id, option: "1/2" }), who).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const [who, option] of [
      ["swLead", "1/2"],
      ["buildLead", "1/3"],
      ["captain", "2/3"],
      ["bizLead", "1ec"],
      ["mentor", "1/2ec"],
      ["teacher", "none"],
      ["owner", "1"],
    ] as const) {
      const later = { ...contextFor(t.db, p[who]), now: at(30 * MINUTE) };
      expect(await setCredit(later, { sessionId, userId: p.member.id, option }), who).toEqual({ name: "member", option, unchanged: false });
      expect(await record(sessionId, p.member.id), who).toMatchObject({ creditChangedById: p[who].id, creditChangedAt: later.now });
    }
    expect(await record(sessionId, p.member.id)).toMatchObject({ credit: 6, creditKind: "REGULAR" });
    // Picking what it already is changes nothing (not even who changed it, or the log).
    const logged = await t.db.attendanceChange.count();
    expect(await setCredit(contextFor(t.db, p.captain), { sessionId, userId: p.member.id, option: "1" })).toMatchObject({ unchanged: true });
    expect((await record(sessionId, p.member.id)).creditChangedById).toBe(p.owner.id);
    expect(await t.db.attendanceChange.count()).toBe(logged);
  });

  it("EC only by the Business leader, teachers, mentors, and owners; any admin may change an EC credit to something else", async () => {
    for (const who of ["swLead", "buildLead", "captain"] as const) {
      for (const option of ["1ec", "1/2ec"]) {
        await expect(setCredit(contextFor(t.db, p[who]), { sessionId, userId: p.member.id, option }), `${who} ${option}`).rejects.toThrow(EC_ONLY);
        await expect(addPerson(contextFor(t.db, p[who]), { sessionId, userId: p.member2.id, option }), `${who} ${option}`).rejects.toThrow(EC_ONLY);
      }
    }
    expect(await record(sessionId, p.member.id)).toMatchObject({ credit: 6, creditKind: "REGULAR" });
    for (const [who, option] of [
      ["bizLead", "1ec"],
      ["teacher", "1/2ec"],
      ["mentor", "1ec"],
      ["owner", "1/2ec"],
    ] as const) {
      await expect(setCredit(contextFor(t.db, p[who]), { sessionId, userId: p.member.id, option }), who).resolves.toMatchObject({ option });
    }
    // Now 1/2 EC: the Build leader can't make it 1 EC, but can take the EC away.
    await expect(setCredit(contextFor(t.db, p.buildLead), { sessionId, userId: p.member.id, option: "1ec" })).rejects.toThrow(EC_ONLY);
    await setCredit(contextFor(t.db, p.buildLead), { sessionId, userId: p.member.id, option: "1/2" });
    expect(await record(sessionId, p.member.id)).toMatchObject({ credit: 3, creditKind: "REGULAR", creditChangedById: p.buildLead.id });
    // EC at Flex too (for those who may give it).
    await setCredit(contextFor(t.db, p.bizLead), { sessionId: flexId, userId: p.member.id, option: "1ec" });
    expect(await record(flexId, p.member.id)).toMatchObject({ credit: 6, creditKind: "EXTRA" });
  });

  it("a scan can go back to 1 (or 1 Flex), down to part credit, or No credit; added by hand never to 1 or Flex", async () => {
    const lead = contextFor(t.db, p.swLead);
    for (const option of ["none", "1/3", "2/3", "1"] as const) {
      await setCredit(lead, { sessionId, userId: p.member.id, option });
    }
    expect(await record(sessionId, p.member.id)).toMatchObject({ credit: 6, creditKind: "REGULAR" });
    for (const option of ["1/2", "none", "1/2flex", "1flex"] as const) {
      await setCredit(lead, { sessionId: flexId, userId: p.member.id, option });
    }
    expect(await record(flexId, p.member.id)).toMatchObject({ credit: 6, creditKind: "FLEX" });
    const wrong = await setCredit(lead, { sessionId, userId: p.member.id, option: "1flex" }).catch((e: unknown) => e);
    expect((wrong as ValidationError).fieldErrors.option).toBe(REGULAR_CREDIT_ONLY);
    const full = await setCredit(lead, { sessionId: flexId, userId: p.member.id, option: "1" }).catch((e: unknown) => e);
    expect((full as ValidationError).fieldErrors.option).toBe(FLEX_FULL_CREDIT);

    // Added by hand: 1 and Flex credit need a scan.
    await addPerson(lead, { sessionId, userId: p.member2.id, option: "none" });
    await addPerson(lead, { sessionId: flexId, userId: p.member2.id, option: "1/3" });
    for (const [id, option] of [
      [sessionId, "1"],
      [flexId, "1flex"],
      [flexId, "1/2flex"],
    ] as const) {
      const err = await setCredit(contextFor(t.db, p.owner), { sessionId: id, userId: p.member2.id, option }).catch((e: unknown) => e);
      expect((err as ValidationError).fieldErrors.option, option).toBe(BY_HAND_PARTIAL_ONLY);
    }
    await setCredit(lead, { sessionId, userId: p.member2.id, option: "2/3" });
    await setCredit(lead, { sessionId: flexId, userId: p.member2.id, option: "none" });
    expect(await record(sessionId, p.member2.id)).toMatchObject({ method: "MANUAL", credit: 4 });
    expect(await record(flexId, p.member2.id)).toMatchObject({ method: "MANUAL", credit: 0 });
  });

  it("a change made since the menu loaded (by the member or another admin) isn't overwritten unseen", async () => {
    // The page showed "1 Flex"; meanwhile the member picked 1/2 Flex.
    await setMyCredit(contextFor(t.db, p.member), { sessionId: flexId, option: "1/2flex" });
    const stale = await setCredit(contextFor(t.db, p.bizLead), { sessionId: flexId, userId: p.member.id, option: "none", from: "1flex" }).catch(
      (e: unknown) => e,
    );
    expect(stale).toBeInstanceOf(ConflictError);
    expect((stale as ConflictError).message).toBe("It was just changed to 1/2 Flex by member. Check it, then pick again if it's still wrong.");
    // From what's there now, it works; then another admin's stale menu is refused, naming the admin.
    await setCredit(contextFor(t.db, p.bizLead), { sessionId: flexId, userId: p.member.id, option: "none", from: "1/2flex" });
    const again = await setCredit(contextFor(t.db, p.captain), { sessionId: flexId, userId: p.member.id, option: "1flex", from: "1/2flex" }).catch(
      (e: unknown) => e,
    );
    expect((again as ConflictError).message).toBe("It was just changed to No credit by bizLead. Check it, then pick again if it's still wrong.");
    expect(await record(flexId, p.member.id)).toMatchObject({ credit: 0, creditChangedById: p.bizLead.id });
    // A value no option has shows as "" in the menu.
    await t.db.attendanceRecord.updateMany({ where: { sessionId, userId: p.member.id }, data: { credit: 5 } });
    await expect(setCredit(contextFor(t.db, p.captain), { sessionId, userId: p.member.id, option: "1", from: "" })).resolves.toMatchObject({ option: "1" });
    await expect(setCredit(contextFor(t.db, p.captain), { sessionId, userId: p.member.id, option: "1/2", from: "bad" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("only people on the list, and never your own (another admin changes it)", async () => {
    const teacher = contextFor(t.db, p.teacher);
    await expect(setCredit(teacher, { sessionId, userId: p.member2.id, option: "1/2" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(setCredit(teacher, { sessionId: "nope", userId: p.member.id, option: "1/2" })).rejects.toBeInstanceOf(NotFoundError);
    await checkInWithToken(teacher, { token: currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).token });
    for (const option of ["1/2", "1ec", "none", "1"] as const) {
      await expect(setCredit(teacher, { sessionId, userId: p.teacher.id, option }), option).rejects.toThrow(OWN_CREDIT);
    }
    expect(await record(sessionId, p.teacher.id)).toMatchObject({ credit: 6, creditKind: "REGULAR", creditChangedById: null });
    expect(await t.db.attendanceChange.count()).toBe(0);
    // Another admin can; it's locked to them and logged.
    await setCredit(contextFor(t.db, p.bizLead), { sessionId, userId: p.teacher.id, option: "1/2" });
    expect(await record(sessionId, p.teacher.id)).toMatchObject({ credit: 3, creditChangedById: p.bizLead.id });
    expect(await t.db.attendanceChange.count({ where: { action: "CREDIT_CHANGED", userId: p.teacher.id, changedById: p.bizLead.id } })).toBe(1);
  });

  it("an admin can't raise their own credit over another admin's correction, or give themselves EC without a scan (reviewers' P1)", async () => {
    // (a) Scanned in, another admin says No credit (logged); raising it back themselves is refused.
    await checkInWithToken(contextFor(t.db, p.swLead), { token: currentCodes(await secretOf(sessionId), sessionId, TEST_NOW).token });
    await setCredit(contextFor(t.db, p.bizLead), { sessionId, userId: p.swLead.id, option: "none" });
    await expect(setCredit(contextFor(t.db, p.swLead), { sessionId, userId: p.swLead.id, option: "1" })).rejects.toThrow(OWN_CREDIT);
    expect(await record(sessionId, p.swLead.id)).toMatchObject({ credit: 0, creditChangedById: p.bizLead.id });
    // (b) The Business leader can't add themselves as 1/3 and then make it 1 EC.
    await expect(addPerson(contextFor(t.db, p.bizLead), { sessionId, userId: p.bizLead.id, option: "1/3" })).rejects.toThrow(NOT_YOURSELF);
    await addPerson(contextFor(t.db, p.teacher), { sessionId, userId: p.bizLead.id, option: "1/3" });
    await expect(setCredit(contextFor(t.db, p.bizLead), { sessionId, userId: p.bizLead.id, option: "1ec" })).rejects.toThrow(OWN_CREDIT);
    expect(await record(sessionId, p.bizLead.id)).toMatchObject({ method: "MANUAL", credit: 2, creditKind: "REGULAR" });
    // What the log says matches the records.
    const log = await t.db.attendanceChange.findMany({ select: { action: true, userId: true, changedById: true, toCredit: true } });
    expect(log).toHaveLength(2);
    expect(log).toEqual(
      expect.arrayContaining([
        { action: "CREDIT_CHANGED", userId: p.swLead.id, changedById: p.bizLead.id, toCredit: 0 },
        { action: "ADDED", userId: p.bizLead.id, changedById: p.teacher.id, toCredit: 2 },
      ]),
    );
  });
});

describe("said they'd come, not checked in (no-shows)", () => {
  beforeEach(resetAttendance);

  async function answers() {
    const today = TEST_TODAY; // a Thursday: regular practice and Flex
    await setRsvp(contextFor(t.db, p.member), { date: today, regular: "YES", flex: "YES" });
    await setRsvp(contextFor(t.db, p.member2), { date: today, regular: "HALF", flex: "NO" });
    await setRsvp(contextFor(t.db, p.bizMember), { date: today, regular: "NO", flex: "YES" });
    await setRsvp(contextFor(t.db, p.swLead), { date: addDays(today, 4), regular: "YES" }); // another day
    const gone = await makeUser(t.db, { name: "gone", status: "DISABLED" });
    await t.db.attendanceRsvp.create({ data: { userId: gone.id, date: dateOnlyToDb(today), regular: "YES", flex: "YES" } });
  }

  it("Regular: said Yes or Half; Flex: said Yes — and not on the list (any credit, No credit too, counts as dealt with)", async () => {
    await answers();
    const regular = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const flex = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    const sessions = await t.db.attendanceSession.findMany({ select: { id: true, date: true, kind: true } });
    const names = async () => {
      const map = await findNoShows(t.db, sessions);
      return { regular: (map.get(regular.id) ?? []).map((x) => [x.name, x.answer]), flex: (map.get(flex.id) ?? []).map((x) => [x.name, x.answer]) };
    };
    expect(await names()).toEqual({
      regular: [
        ["member", "YES"],
        ["member2", "HALF"],
      ],
      flex: [
        ["bizMember", "YES"],
        ["member", "YES"],
      ],
    });
    // Checking in, part credit by hand, or No credit: off the list.
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(await secretOf(regular.id), regular.id, TEST_NOW).code });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: regular.id, userId: p.member2.id, option: "none" });
    await addPerson(contextFor(t.db, p.swLead), { sessionId: flex.id, userId: p.bizMember.id, option: "1/3" });
    expect(await names()).toEqual({ regular: [], flex: [["member", "YES"]] });
    expect(await findNoShows(t.db, [])).toEqual(new Map());
  });

  it("closing posts them to the leaders' Discord channel (an event), not when nobody's missing, and never twice", async () => {
    await answers();
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const ctx = contextFor(t.db, p.bizLead);
    expect(await closeSession(ctx, { sessionId: id })).toEqual({ id, kind: "REGULAR", noShows: 2 });
    expect(ctx.notifier.events).toEqual([{ type: "attendance.no_shows", sessionId: id, userIds: [p.member.id, p.member2.id] }]);
    // Closing again (already closed): nothing new.
    await closeSession(ctx, { sessionId: id });
    expect(ctx.notifier.events).toHaveLength(1);
    // Reopened, everyone dealt with, closed again: no post.
    await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    await addPerson(ctx, { sessionId: id, userId: p.member.id, option: "1/2" });
    await addPerson(ctx, { sessionId: id, userId: p.member2.id, option: "none" });
    const again = contextFor(t.db, p.teacher);
    expect(await closeSession(again, { sessionId: id })).toMatchObject({ noShows: 0 });
    expect(again.notifier.ofType("attendance.no_shows")).toEqual([]);
  });

  it("never lists (or posts) the person who started the session: they ran practice", async () => {
    await answers();
    await setRsvp(contextFor(t.db, p.bizLead), { date: TEST_TODAY, regular: "YES", flex: "YES" });
    const { id } = await openSession(contextFor(t.db, p.bizLead), { kind: "REGULAR" });
    const session = await t.db.attendanceSession.findUniqueOrThrow({ where: { id }, select: { id: true, date: true, kind: true, openedById: true } });
    const names = async (s: typeof session | Omit<typeof session, "openedById">) => (await findNoShows(t.db, [s])).get(id)?.map((x) => x.name);
    expect(await names(session)).toEqual(["member", "member2"]);
    // Callers that don't say who started it list everyone.
    expect(await names({ id: session.id, date: session.date, kind: session.kind })).toEqual(["bizLead", "member", "member2"]);
    const ctx = contextFor(t.db, p.teacher);
    expect(await closeSession(ctx, { sessionId: id })).toMatchObject({ noShows: 2 });
    expect(ctx.notifier.events).toEqual([{ type: "attendance.no_shows", sessionId: id, userIds: [p.member.id, p.member2.id] }]);
  });

  it("a session left open from an earlier day can still be closed, and that sends the post", async () => {
    const day = addDays(TEST_TODAY, -2); // Tuesday: regular practice
    for (const who of ["member", "member2"] as const) {
      await t.db.attendanceRsvp.create({ data: { userId: p[who].id, date: dateOnlyToDb(day), regular: "YES" } });
    }
    const { id } = await pastSession(2);
    await t.db.attendanceSession.update({ where: { id }, data: { closedAt: null } });
    const ctx = contextFor(t.db, p.teacher);
    expect(await closeSession(ctx, { sessionId: id })).toEqual({ id, kind: "REGULAR", noShows: 2 });
    expect(ctx.notifier.ofType("attendance.no_shows")).toHaveLength(1);
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id } })).closedAt).toEqual(TEST_NOW);
  });

  it("working out who didn't come never stops attendance from closing", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const broken = new Proxy(t.db, {
      get(target, key) {
        if (key === "attendanceRsvp") return { findMany: () => Promise.reject(new Error("database hiccup")) };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = { ...contextFor(t.db, p.teacher), db: broken };
      expect(await closeSession(ctx, { sessionId: id })).toMatchObject({ noShows: 0 });
      expect(ctx.notifier.events).toEqual([]);
    } finally {
      quiet.mockRestore();
    }
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id } })).closedAt).toEqual(TEST_NOW);
  });
});

describe("the Discord post about no-shows", () => {
  beforeEach(resetAttendance);
  const WEBHOOK = "https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-JKL";

  /** A stand-in for Discord: records POSTs and answers like `?wait=true`. */
  function fakeDiscord(status = 200) {
    const posts: { url: string; body: DiscordPayload }[] = [];
    const fetch: FetchLike = async (url, init) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return status === 200 ? Response.json({ id: String(1000 + posts.length) }) : new Response("nope", { status });
    };
    return { posts, fetch };
  }

  it("names who said they'd come and still isn't on the list, links the session, and pings nobody (no email)", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    const tricky = await makeUser(t.db, { name: "@everyone *Zed*" });
    const event = { type: "attendance.no_shows" as const, sessionId: id, userIds: [p.member2.id, tricky.id, p.member.id] };
    // Dealt with after it closed: left out.
    await addPerson(contextFor(t.db, p.teacher), { sessionId: id, userId: p.member2.id, option: "none" });
    const d = fakeDiscord();
    const sent: string[] = [];
    await deliverNotification(t.db, event, {
      transport: { name: "fake", send: async (m) => void sent.push(m.to) },
      appUrl: "https://portal.example.org/",
      discord: { webhookUrl: WEBHOOK, fetch: d.fetch },
    });
    expect(sent).toEqual([]);
    expect(d.posts).toHaveLength(1);
    const [embed] = d.posts[0].body.embeds;
    expect(embed.title).toBe("Regular attendance · Thu, Sep 24");
    expect(embed.url).toBe(`https://portal.example.org/attendance/sessions/${id}`);
    expect(embed.description).toBe("2 said they'd come but didn't check in: @\u200beveryone \\*Zed\\*, member");
    expect(d.posts[0].body.allowed_mentions).toEqual({ parse: [] });
    const log = await t.db.emailLog.findFirstOrThrow({ where: { kind: "discord:attendance.no_shows" } });
    expect(log).toMatchObject({ to: "Discord", status: "SENT", subject: "Regular attendance · Thu, Sep 24" });

    // Everyone dealt with by the time it's sent, the session gone, or Discord not set up: no post.
    await addPerson(contextFor(t.db, p.teacher), { sessionId: id, userId: p.member.id, option: "1/2" });
    await addPerson(contextFor(t.db, p.teacher), { sessionId: id, userId: tricky.id, option: "none" });
    await deliverDiscord(t.db, event, { webhookUrl: WEBHOOK, fetch: d.fetch });
    await deliverDiscord(t.db, { ...event, sessionId: "gone" }, { webhookUrl: WEBHOOK, fetch: d.fetch });
    await deliverDiscord(t.db, { ...event, userIds: [p.bizMember.id] }, { webhookUrl: null, fetch: d.fetch });
    expect(d.posts).toHaveLength(1);
    await t.db.user.delete({ where: { id: tricky.id } });
  });

  it("a Discord failure is logged, never thrown", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "FLEX" });
    const d = fakeDiscord(500);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        deliverDiscord(t.db, { type: "attendance.no_shows", sessionId: id, userIds: [p.member.id] }, { webhookUrl: WEBHOOK, fetch: d.fetch }),
      ).resolves.toBeUndefined();
    } finally {
      quiet.mockRestore();
    }
    expect(await t.db.emailLog.findFirstOrThrow({ where: { kind: "discord:attendance.no_shows", status: "FAILED" } })).toMatchObject({
      subject: "Flex attendance · Thu, Sep 24",
    });
    expect(attendanceNoShowsPayload({ sessionId: id, kind: "FLEX", date: "2026-09-24", names: ["A", "B", "C"] }, "https://x.org").embeds[0].description).toBe(
      "3 said they'd come but didn't check in: A, B, C",
    );
  });
});

describe("the change log", () => {
  beforeEach(resetAttendance);

  const logged = () =>
    t.db.attendanceChange.findMany({
      orderBy: [{ createdAt: "asc" }, { action: "asc" }],
      select: {
        sessionId: true,
        sessionDate: true,
        sessionKind: true,
        userId: true,
        userName: true,
        changedById: true,
        action: true,
        fromCredit: true,
        fromKind: true,
        toCredit: true,
        toKind: true,
        createdAt: true,
      },
    });

  it("adding by hand, taking off, and changing someone's credit each write a row in the same step", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    await checkInWithCode(contextFor(t.db, p.member2), { code: currentCodes(await secretOf(id), id, TEST_NOW).code });
    const day = dateOnlyToDb(TEST_TODAY);
    const base = { sessionId: id, sessionDate: day, sessionKind: "REGULAR" as const };
    await addPerson({ ...contextFor(t.db, p.buildLead), now: at(MINUTE) }, { sessionId: id, userId: p.member.id, option: "1/3" });
    await setCredit({ ...contextFor(t.db, p.bizLead), now: at(2 * MINUTE) }, { sessionId: id, userId: p.member.id, option: "1ec" });
    await setCredit({ ...contextFor(t.db, p.captain), now: at(3 * MINUTE) }, { sessionId: id, userId: p.member2.id, option: "none" });
    await removePerson({ ...contextFor(t.db, p.swLead), now: at(4 * MINUTE) }, { sessionId: id, userId: p.member.id });
    expect(await logged()).toEqual([
      { ...base, userId: p.member.id, userName: "member", changedById: p.buildLead.id, action: "ADDED", fromCredit: null, fromKind: null, toCredit: 2, toKind: "REGULAR", createdAt: at(MINUTE) },
      { ...base, userId: p.member.id, userName: "member", changedById: p.bizLead.id, action: "CREDIT_CHANGED", fromCredit: 2, fromKind: "REGULAR", toCredit: 6, toKind: "EXTRA", createdAt: at(2 * MINUTE) },
      { ...base, userId: p.member2.id, userName: "member2", changedById: p.captain.id, action: "CREDIT_CHANGED", fromCredit: 6, fromKind: "REGULAR", toCredit: 0, toKind: "REGULAR", createdAt: at(3 * MINUTE) },
      { ...base, userId: p.member.id, userName: "member", changedById: p.swLead.id, action: "REMOVED", fromCredit: 6, fromKind: "EXTRA", toCredit: null, toKind: null, createdAt: at(4 * MINUTE) },
    ]);
  });

  it("changes that are refused (or change nothing) write nothing", async () => {
    const { id } = await openSession(contextFor(t.db, p.teacher), { kind: "REGULAR" });
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(await secretOf(id), id, TEST_NOW).code });
    await expect(setCredit(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member.id, option: "1ec" })).rejects.toThrow(EC_ONLY);
    await expect(setCredit(contextFor(t.db, p.member), { sessionId: id, userId: p.member.id, option: "1/2" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setCredit(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member.id, option: "1/2", from: "1/3" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    await setCredit(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member.id, option: "1" }); // already 1
    await expect(addPerson(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member.id, option: "1/2" })).rejects.toBeInstanceOf(ConflictError);
    await expect(addPerson(contextFor(t.db, p.swLead), { sessionId: id, userId: p.member2.id, option: "1" })).rejects.toBeInstanceOf(ValidationError);
    expect(await t.db.attendanceChange.count()).toBe(0);
    expect(await t.db.attendanceRecord.count({ where: { userId: p.member2.id } })).toBe(0);
  });

  it("deleting a session writes one SESSION_DELETED row plus a REMOVED row for everyone who was on it; the rows outlive it", async () => {
    const { id } = await openSession(contextFor(t.db, p.bizLead), { kind: "FLEX" });
    await checkInWithCode(contextFor(t.db, p.member), { code: currentCodes(await secretOf(id), id, TEST_NOW).code });
    await setMyCredit(contextFor(t.db, p.member), { sessionId: id, option: "1/2flex" });
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: id, userId: p.member2.id, option: "none" });
    await deleteSession({ ...contextFor(t.db, p.bizLead), now: at(MINUTE) }, { sessionId: id });
    const rows = (await logged()).filter((r) => r.createdAt.getTime() === at(MINUTE).getTime());
    const day = dateOnlyToDb(TEST_TODAY);
    const base = { sessionId: null, sessionDate: day, sessionKind: "FLEX" as const, changedById: p.bizLead.id, toCredit: null, toKind: null, createdAt: at(MINUTE) };
    expect(rows).toEqual(
      expect.arrayContaining([
        { ...base, userId: null, userName: "", action: "SESSION_DELETED", fromCredit: null, fromKind: null },
        { ...base, userId: p.member.id, userName: "member", action: "REMOVED", fromCredit: 3, fromKind: "FLEX" },
        { ...base, userId: p.member2.id, userName: "member2", action: "REMOVED", fromCredit: 0, fromKind: "REGULAR" },
      ]),
    );
    expect(rows).toHaveLength(3);
    // The earlier ADDED row stays too (its session is gone).
    expect(await t.db.attendanceChange.count({ where: { action: "ADDED", sessionId: null } })).toBe(1);
    // A refused delete (someone scanned in on an earlier day) writes nothing.
    const scanned = await pastSession(2, [{ userId: p.member.id, method: "QR" }]);
    await expect(deleteSession(contextFor(t.db, p.teacher), { sessionId: scanned.id })).rejects.toThrow(CANT_DELETE_SESSION);
    expect(await t.db.attendanceChange.count({ where: { sessionDate: dateOnlyToDb(addDays(TEST_TODAY, -2)) } })).toBe(0);
  });

  it("sentences, filters, and the CSV (pure)", () => {
    const row = {
      id: "c1",
      createdAt: new Date("2026-09-29T22:04:00Z"),
      action: "CREDIT_CHANGED" as const,
      sessionId: "s1",
      sessionDate: "2026-09-29",
      sessionKind: "REGULAR" as const,
      userId: "u1",
      userName: "Ethan Chen",
      changedByName: "Amara Okafor",
      fromCredit: 6,
      fromKind: "REGULAR" as const,
      toCredit: 3,
      toKind: "REGULAR" as const,
    };
    expect(describeAttendanceChange(row, "2026-09-24")).toBe("Amara Okafor changed Ethan Chen's Regular · Tue, Sep 29 from 1 to 1/2");
    expect(describeAttendanceChange({ ...row, action: "ADDED", fromCredit: null, fromKind: null, toCredit: 3, toKind: "EXTRA" })).toBe(
      "Amara Okafor added Ethan Chen to Regular · Tue, Sep 29 as 1/2 EC",
    );
    expect(describeAttendanceChange({ ...row, action: "ADDED", fromCredit: null, fromKind: null, toCredit: 0 })).toBe(
      "Amara Okafor marked Ethan Chen as not here (No credit) for Regular · Tue, Sep 29",
    );
    expect(describeAttendanceChange({ ...row, action: "REMOVED", toCredit: null, toKind: null, changedByName: null })).toBe(
      "Someone took Ethan Chen off Regular · Tue, Sep 29 (was 1)",
    );
    expect(describeAttendanceChange({ ...row, action: "SESSION_DELETED", sessionKind: "FLEX", userId: null, userName: "" })).toBe(
      "Amara Okafor deleted Flex · Tue, Sep 29",
    );

    expect(parseAttendanceChangeFilters({})).toEqual({ person: undefined, by: undefined, action: undefined, from: undefined, to: undefined, page: 1 });
    expect(
      parseAttendanceChangeFilters({ person: "abc", by: ["def", "x"], action: "REMOVED", from: "2026-09-30", to: "2026-09-01", page: "3" }),
    ).toEqual({ person: "abc", by: "def", action: "REMOVED", from: "2026-09-01", to: "2026-09-30", page: 3 });
    expect(
      parseAttendanceChangeFilters(new URLSearchParams("person=a%20b&by=<x>&action=DROP&from=2026-02-30&to=nope&page=-2")),
    ).toEqual({ person: undefined, by: undefined, action: undefined, from: undefined, to: undefined, page: 1 });
    expect(attendanceChangeQuery({ person: "abc", action: "ADDED", from: "2026-09-01" }, 2)).toBe("?person=abc&action=ADDED&from=2026-09-01&page=2");
    expect(attendanceChangeQuery({}, 1)).toBe("");
    expect(hasAttendanceChangeFilters({ page: 4 })).toBe(false);
    expect(hasAttendanceChangeFilters({ page: 1, to: "2026-09-01" })).toBe(true);

    const csv = attendanceChangesCsv([row, { ...row, id: "c2", userName: "=HYPERLINK(1)", changedByName: "+cmd", toCredit: 0 }], TEST_TZ);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("When,Action,Attendance day,Kind,Person,Changed by,Before,After,What happened");
    expect(lines[1]).toBe(
      `2026-09-29 15:04,Credit changed,2026-09-29,Regular,Ethan Chen,Amara Okafor,1 regular,1/2 regular,"Amara Okafor changed Ethan Chen's Regular · Tue, Sep 29 from 1 to 1/2"`,
    );
    // Formulas stay text.
    expect(lines[2]).toContain(",'=HYPERLINK(1),'+cmd,1 regular,No credit,");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("tells 'marked not here' and 'scanned in' apart (badge, filter, sentence, CSV), and the report's CSV lists the changes (pure)", () => {
    const row = {
      id: "c1",
      createdAt: new Date("2026-09-29T22:04:00Z"),
      action: "ADDED" as const,
      sessionId: "s1",
      sessionDate: "2026-09-29",
      sessionKind: "REGULAR" as const,
      userId: "u1",
      userName: "Ethan Chen",
      changedById: "a1",
      changedByName: "Amara Okafor",
      fromCredit: null,
      fromKind: null,
      toCredit: 0,
      toKind: "REGULAR" as const,
    };
    const scanned = { ...row, id: "c2", action: "CREDIT_CHANGED" as const, changedById: "u1", changedByName: "Ethan Chen", fromCredit: 3, fromKind: "REGULAR" as const, toCredit: 6 };
    expect(changeKindOf(row)).toBe("NOT_HERE");
    expect(changeKindOf({ ...row, toCredit: 3 })).toBe("ADDED");
    expect(changeKindOf(scanned)).toBe("SCANNED_IN");
    expect(changeKindOf({ ...scanned, changedById: "a1" })).toBe("CREDIT_CHANGED");
    expect(changeKindOf({ ...scanned, changedById: undefined })).toBe("CREDIT_CHANGED");
    expect(describeAttendanceChange(scanned, "2026-09-24")).toBe("Ethan Chen scanned in to Regular · Tue, Sep 29: now 1 (was 1/2 by hand)");
    expect(describeAttendanceChange({ ...row, action: "REMOVED", changedById: "u1", changedByName: "Ethan Chen", fromCredit: 6, toCredit: null }, "2026-09-24")).toBe(
      "Ethan Chen took themselves off Regular · Tue, Sep 29 (was 1)",
    );
    for (const action of ["NOT_HERE", "SCANNED_IN", "ADDED"] as const) {
      expect(parseAttendanceChangeFilters({ action }).action, action).toBe(action);
    }
    const csv = attendanceChangesCsv([row, scanned], TEST_TZ).split("\r\n");
    expect(csv[1]).toContain(",Marked not here,");
    expect(csv[2]).toContain(",Scanned in,");

    const block = reportChangesCsv([row, scanned], 5, TEST_TZ).split("\r\n");
    expect(block[0]).toBe("");
    expect(block[1]).toBe("Changes by admins");
    expect(block[2]).toBe("When,Action,Attendance day,Kind,Person,Changed by,Before,After,What happened");
    expect(block[3]).toContain("Amara Okafor marked Ethan Chen as not here (No credit)");
    expect(block[5]).toBe("Showing the newest 2 of 5. The rest are in Attendance changes.");
    expect(reportChangesCsv([], 0, TEST_TZ)).toBe("\r\nChanges by admins\r\nNo changes by admins in these two weeks.\r\n");
  });

  it("credit menus group Flex and regular credit at Flex sessions (pure)", () => {
    const labels = (groups: ReturnType<typeof creditMenuGroups>) => groups.map((g) => [g.label, g.options.map((o) => o.label)]);
    expect(labels(creditMenuGroups("FLEX", adminCreditOptions({ kind: "FLEX", method: "QR", canGiveExtraCredit: true })))).toEqual([
      ["Flex", ["1 Flex", "1/2 Flex"]],
      ["Regular credit", ["2/3", "1/2", "1/3", "1/2 EC", "1 EC"]],
      [null, ["No credit"]],
    ]);
    expect(labels(creditMenuGroups("FLEX", adminCreditOptions({ kind: "FLEX", method: "MANUAL", canGiveExtraCredit: false })))).toEqual([
      ["Regular credit", ["2/3", "1/2", "1/3"]],
      [null, ["No credit"]],
    ]);
    const regular = adminCreditOptions({ kind: "REGULAR", method: "QR", canGiveExtraCredit: false });
    expect(creditMenuGroups("REGULAR", regular)).toEqual([{ label: null, options: regular }]);
  });
});

describe("No credit in reports", () => {
  it("counts as not coming: not present, 'said yes but didn't come', nothing toward the week", () => {
    const report = buildReport({
      sessions: [{ id: "s1", date: "2026-09-15", kind: "REGULAR", openedByName: "T", note: "" }],
      records: [
        { sessionId: "s1", userId: "a", credit: 0, creditKind: "REGULAR" },
        { sessionId: "s1", userId: "b", credit: 2, creditKind: "REGULAR" },
      ],
      rsvps: [
        { userId: "a", date: "2026-09-15", regular: "YES", flex: null },
        { userId: "b", date: "2026-09-15", regular: "YES", flex: null },
      ],
      people: [
        { id: "a", name: "Ann", subteam: "BUILD" },
        { id: "b", name: "Ben", subteam: "BUILD" },
      ],
      period: { start: "2026-09-14", end: "2026-09-27" },
      weeklyTarget: 2,
    });
    expect(report.sessions[0]).toMatchObject({ present: 1, saidYes: 2 });
    const ann = report.people.find((x) => x.id === "a");
    expect(ann).toMatchObject({ regular: { attended: 0, held: 1 }, saidYesMissed: 1, cameUnanswered: 0 });
    expect(ann?.weeks.map((w) => w.total)).toEqual([0, 0]);
    expect(report.people.find((x) => x.id === "b")).toMatchObject({ regular: { attended: 1, held: 1 }, saidYesMissed: 0 });
    const csv = reportCsv(report, { start: "2026-09-14", end: "2026-09-27" });
    expect(csv).toContain("Ann,Build,0,0,0,0,No,0,0,0,0,No,0,1,0,0,1,0");
  });
});

describe("report weeks", () => {
  const period = { start: "2026-09-14", end: "2026-09-27" };

  it("splits the two weeks Monday to Sunday and adds up each person's credits (every kind counts)", () => {
    expect(periodWeeks(period)).toEqual([
      { start: "2026-09-14", end: "2026-09-20" },
      { start: "2026-09-21", end: "2026-09-27" },
    ]);
    const report = buildReport({
      sessions: [
        { id: "r1", date: "2026-09-14", kind: "REGULAR", openedByName: null, note: "" },
        { id: "f1", date: "2026-09-15", kind: "FLEX", openedByName: null, note: "" },
        { id: "r2", date: "2026-09-20", kind: "REGULAR", openedByName: null, note: "" }, // Sunday: week 1
        { id: "r3", date: "2026-09-21", kind: "REGULAR", openedByName: null, note: "" }, // Monday: week 2
      ],
      records: [
        { sessionId: "r1", userId: "a", credit: 6, creditKind: "REGULAR" },
        { sessionId: "f1", userId: "a", credit: 3, creditKind: "FLEX" },
        { sessionId: "r2", userId: "a", credit: 3, creditKind: "EXTRA" },
        { sessionId: "r3", userId: "a", credit: 4, creditKind: "REGULAR" },
        { sessionId: "r3", userId: "b" }, // no credit given: 1 regular
      ],
      rsvps: [],
      people: [
        { id: "a", name: "Ada", subteam: "BUILD" },
        { id: "b", name: "Ben", subteam: null },
      ],
      period,
      weeklyTarget: 2,
    });
    expect(report.weeks).toEqual(periodWeeks(period));
    expect(report.weeklyTarget).toBe(2);
    const byId = Object.fromEntries(report.people.map((r) => [r.id, r]));
    expect(byId.a.weeks).toEqual([
      { total: 12, regular: 6, extra: 3, flex: 3 },
      { total: 4, regular: 4, extra: 0, flex: 0 },
    ]);
    expect(byId.b.weeks).toEqual([
      { total: 0, regular: 0, extra: 0, flex: 0 },
      { total: 6, regular: 6, extra: 0, flex: 0 },
    ]);
    // A record still means "came": the tallies are the same as before.
    expect(byId.a).toMatchObject({ regular: { attended: 3, held: 3 }, flex: { attended: 1, held: 1 } });

    const lines = reportCsv(report, period).split("\r\n");
    expect(lines[1]).toBe("Weekly target: 2 (regular + EC + Flex)");
    expect(lines[3]).toBe(
      [
        "Name,Subteam",
        "Week 1 (2026-09-14 to 2026-09-20),Week 1 regular,Week 1 EC,Week 1 Flex,Week 1 met the target (2)",
        "Week 2 (2026-09-21 to 2026-09-27),Week 2 regular,Week 2 EC,Week 2 Flex,Week 2 met the target (2)",
        "Regular attended,Regular held,Flex attended,Flex held,Said yes but didn't come,Came without answering",
      ].join(","),
    );
    expect(lines).toContain("Ada,Build,2,1,0.5,0.5,Yes,0.67,0.67,0,0,No,3,3,1,1,0,4");
    expect(lines).toContain("Ben,,0,0,0,0,No,1,1,0,0,No,1,3,0,1,0,1");
  });

  it("without a period (old callers), no week columns", () => {
    const report = buildReport({ sessions: [], records: [], rsvps: [], people: [{ id: "a", name: "Ada", subteam: null }] });
    expect(report.weeks).toEqual([]);
    expect(report.people[0].weeks).toEqual([]);
    expect(reportCsv(report, period).split("\r\n")[2]).toMatch(/^Name,Subteam,Regular attended,/);
  });
});
