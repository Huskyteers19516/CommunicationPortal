import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Role, Subteam } from "@/generated/prisma/enums";
import {
  ATTENDANCE_EDIT_DAYS,
  attendanceScanPath,
  DEFAULT_ATTENDANCE_SETTINGS,
  firstReportIndex,
  isFlexDay,
  isRegularDay,
  parseReportIndex,
  REPORT_PERIODS_MAX,
  reportPeriodFor,
  reportPeriodsBetween,
  reportPeriodsUpTo,
  upcomingTeamDays,
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
import { buildReport, csvCell, csvRow, reportCsv, startOfDayInTimezone } from "@/server/attendance/report";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "@/server/errors";
import { getAttendanceSettings } from "@/server/queries/attendance-settings";
import { getAssignableUsers } from "@/server/queries/tasks";
import { deleteUser, HAS_ACTIVITY_MESSAGE } from "@/server/services/admin";
import {
  addPerson,
  CANT_DELETE_SESSION,
  CODE_ATTEMPT_LIMIT,
  CODE_WRONG,
  canEditSessionOn,
  checkInWithCode,
  checkInWithToken,
  closeSession,
  deleteSession,
  NOTE_CHANGED,
  NOTHING_OPEN,
  OLD_SESSION,
  OTHER_DAY,
  openSession,
  PLAN_CHANGED,
  QR_EXPIRED,
  removePerson,
  SESSION_CLOSED,
  setDayPlan,
  setRsvp,
  setSessionNote,
  updateSettings,
} from "@/server/services/attendance";
import { createTestDb, type TestDb } from "./helpers/db";
import { contextFor, makeUser, TEST_NOW, TEST_TODAY, TEST_TZ } from "./helpers/factories";

// TEST_TODAY is Thursday 2026-09-24 (a regular day and a Flex day with the default schedule).
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

  it("runners add and remove people; others can't", async () => {
    for (const who of ["member", "swLead", "buildLead"] as const) {
      await expect(addPerson(contextFor(t.db, p[who]), { sessionId, userId: p.member.id }), who).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await addPerson(contextFor(t.db, p.bizLead), { sessionId, userId: p.member.id })).toEqual({ name: "member" });
    const row = await t.db.attendanceRecord.findFirstOrThrow({ where: { sessionId, userId: p.member.id } });
    expect(row).toMatchObject({ method: "MANUAL", markedById: p.bizLead.id });
    await expect(addPerson(contextFor(t.db, p.captain), { sessionId, userId: p.member.id })).rejects.toBeInstanceOf(ConflictError);

    await expect(removePerson(contextFor(t.db, p.member), { sessionId, userId: p.member.id })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await removePerson(contextFor(t.db, p.mentor), { sessionId, userId: p.member.id })).toEqual({ name: "member" });
    await expect(removePerson(contextFor(t.db, p.mentor), { sessionId, userId: p.member.id })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("works on closed sessions (fixing the list later), but only for active people", async () => {
    await closeSession(contextFor(t.db, p.teacher), { sessionId });
    await addPerson(contextFor(t.db, p.owner), { sessionId, userId: p.member2.id });
    const gone = await makeUser(t.db, { status: "DISABLED" });
    await expect(addPerson(contextFor(t.db, p.owner), { sessionId, userId: gone.id })).rejects.toBeInstanceOf(ValidationError);
    await expect(addPerson(contextFor(t.db, p.owner), { sessionId: "nope", userId: p.member.id })).rejects.toBeInstanceOf(NotFoundError);
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
  const friday = addDays(TEST_TODAY, 1); // regular, not Flex
  const saturday = addDays(TEST_TODAY, 2);
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
    const flexOnFriday = await setRsvp(ctx, { date: friday, flex: "YES" }).catch((e: unknown) => e);
    expect(flexOnFriday).toBeInstanceOf(ValidationError);
    expect((flexOnFriday as ValidationError).fieldErrors.flex).toBe("There's no Flex that day.");
    await expect(setRsvp(ctx, { date: TEST_TODAY, flex: "HALF" })).rejects.toBeInstanceOf(ValidationError);
    const weekend = await setRsvp(ctx, { date: saturday, regular: "YES" }).catch((e: unknown) => e);
    expect((weekend as ValidationError).fieldErrors.date).toBe("There's no practice that day.");
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

    await setRsvp(ctx, { date: friday, regular: "YES" });
    await updateSettings(contextFor(t.db, p.teacher), { regularDays: ["1", "2", "3", "4"], flexDays: ["2", "4"], reportStart: "2026-08-31" });
    await expect(setRsvp(ctx, { date: friday, regular: "NO" })).rejects.toBeInstanceOf(ValidationError);
    await setRsvp(ctx, { date: friday, regular: "" });
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
  const tomorrow = addDays(TEST_TODAY, 1);

  it("staff write the plan; members can't", async () => {
    await expect(setDayPlan(contextFor(t.db, p.member), { date: tomorrow, plan: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    for (const who of ["swLead", "buildLead", "bizLead", "captain", "mentor", "teacher", "owner"] as const) {
      await expect(setDayPlan(contextFor(t.db, p[who]), { date: tomorrow, plan: `Plan by ${who}` }), who).resolves.toMatchObject({
        plan: `Plan by ${who}`,
      });
    }
    const row = await t.db.attendancePlan.findUniqueOrThrow({ where: { date: dateOnlyToDb(tomorrow) } });
    expect(row).toMatchObject({ plan: "Plan by owner", updatedById: p.owner.id });
    await setDayPlan(contextFor(t.db, p.captain), { date: tomorrow, plan: "  " });
    expect(await t.db.attendancePlan.count()).toBe(0);
  });

  it("not for past days, days off, or too far ahead; with a length limit", async () => {
    const ctx = contextFor(t.db, p.captain);
    await expect(setDayPlan(ctx, { date: addDays(TEST_TODAY, -1), plan: "x" })).rejects.toBeInstanceOf(ConflictError);
    await expect(setDayPlan(ctx, { date: addDays(TEST_TODAY, 2), plan: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setDayPlan(ctx, { date: addDays(TEST_TODAY, LIMITS.rsvpDaysAhead + 1), plan: "x" })).rejects.toBeInstanceOf(ValidationError);
    await expect(setDayPlan(ctx, { date: tomorrow, plan: "x".repeat(LIMITS.attendancePlanMax + 1) })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("schedule settings", () => {
  beforeEach(resetAttendance);

  it("defaults to Mon–Fri, Flex on Tue/Thu", async () => {
    const s = await getAttendanceSettings(t.db);
    expect(s).toEqual(DEFAULT_ATTENDANCE_SETTINGS);
    expect(isRegularDay(s, TEST_TODAY)).toBe(true);
    expect(isFlexDay(s, TEST_TODAY)).toBe(true);
    expect(isFlexDay(s, addDays(TEST_TODAY, 1))).toBe(false);
    expect(upcomingTeamDays(s, TEST_TODAY, LIMITS.rsvpDaysAhead)).toHaveLength(14);
    expect(upcomingTeamDays(s, TEST_TODAY, LIMITS.rsvpDaysAhead)[0]).toBe(TEST_TODAY);
  });

  it("runners change it; staff who only plan and members can't", async () => {
    const input = { regularDays: ["1", "3", "5"], flexDays: "4", reportStart: "2026-09-07" };
    await expect(updateSettings(contextFor(t.db, p.swLead), input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSettings(contextFor(t.db, p.member), input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await updateSettings(contextFor(t.db, p.bizLead), input)).toEqual({ regularDays: [1, 3, 5], flexDays: [4], reportStart: "2026-09-07" });
    expect(await getAttendanceSettings(t.db)).toEqual({ regularDays: [1, 3, 5], flexDays: [4], reportStart: "2026-09-07" });
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

/** A session on another day (made directly, like the seed), with these check-ins. */
async function pastSession(daysAgo: number, records: { userId: string; method: "QR" | "CODE" | "MANUAL" }[] = [], kind: "REGULAR" | "FLEX" = "REGULAR") {
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

describe("hand edits of old sessions", () => {
  beforeEach(resetAttendance);

  it("a week back anyone who runs attendance can fix it; older ones only teachers, mentors, and owners", async () => {
    expect(canEditSessionOn(p.bizLead, addDays(TEST_TODAY, -ATTENDANCE_EDIT_DAYS), TEST_TODAY)).toBe(true);
    expect(canEditSessionOn(p.bizLead, addDays(TEST_TODAY, -ATTENDANCE_EDIT_DAYS - 1), TEST_TODAY)).toBe(false);

    const recent = await pastSession(ATTENDANCE_EDIT_DAYS);
    await addPerson(contextFor(t.db, p.bizLead), { sessionId: recent.id, userId: p.member.id });
    await setSessionNote(contextFor(t.db, p.captain), { sessionId: recent.id, note: "Fixed later" });
    await removePerson(contextFor(t.db, p.bizLead), { sessionId: recent.id, userId: p.member.id });

    const old = await pastSession(ATTENDANCE_EDIT_DAYS + 1, [{ userId: p.member2.id, method: "QR" }]);
    for (const who of ["bizLead", "captain"] as const) {
      const ctx = contextFor(t.db, p[who]);
      await expect(addPerson(ctx, { sessionId: old.id, userId: p.member.id }), who).rejects.toThrow(OLD_SESSION);
      await expect(removePerson(ctx, { sessionId: old.id, userId: p.member2.id }), who).rejects.toThrow(OLD_SESSION);
      await expect(setSessionNote(ctx, { sessionId: old.id, note: "rewrite" }), who).rejects.toThrow(OLD_SESSION);
      await expect(deleteSession(ctx, { sessionId: old.id }), who).rejects.toThrow(OLD_SESSION);
    }
    for (const who of ["teacher", "mentor", "owner"] as const) {
      const ctx = contextFor(t.db, p[who]);
      await addPerson(ctx, { sessionId: old.id, userId: p.member.id });
      await removePerson(ctx, { sessionId: old.id, userId: p.member.id });
      await setSessionNote(ctx, { sessionId: old.id, note: `Note by ${who}` });
    }
    expect((await t.db.attendanceSession.findUniqueOrThrow({ where: { id: old.id } })).note).toBe("Note by owner");
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
    const tomorrow = addDays(TEST_TODAY, 1);
    const captain = contextFor(t.db, p.captain);
    const swLead = contextFor(t.db, p.swLead);
    await setDayPlan(captain, { date: tomorrow, plan: "Drive practice", base: "" });
    await expect(setDayPlan(swLead, { date: tomorrow, plan: "Auto paths", base: "" })).rejects.toThrow(PLAN_CHANGED);
    await setDayPlan(swLead, { date: tomorrow, plan: "Drive practice, then auto paths", base: "Drive practice" });
    await expect(setDayPlan(captain, { date: tomorrow, plan: "", base: "Drive practice" })).rejects.toThrow(PLAN_CHANGED);
    await expect(setDayPlan(captain, { date: tomorrow, plan: "Scrimmage", base: "Drive practice" })).rejects.toThrow(PLAN_CHANGED);
    expect((await t.db.attendancePlan.findUniqueOrThrow({ where: { date: dateOnlyToDb(tomorrow) } })).plan).toBe(
      "Drive practice, then auto paths",
    );
    await setDayPlan(captain, { date: tomorrow, plan: "", base: "Drive practice, then auto paths" });
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
      meetingUpdates: [{ meetingDate: "2026-09-15", subteam: "BUILD", authorName: "Ada", body: "=cmd" }],
      tasks: [{ title: "Intake CAD", subteam: null, people: ["Ada", "Ben"] }],
      parts: [{ name: "Side plate", quantity: 2, madeBy: null }],
      notebook: [{ title: "Intake", notebook: "Hardware", page: "Intake", author: "Cy" }],
    });
    const lines = csv.split("\r\n");
    expect(lines).toContain("Date,Kind,Run by,Came,Said yes,What we did");
    expect(lines).toContain('2026-09-15,Regular,T,0,0,"a;b"');
    expect(lines).toContain("What got done");
    expect(lines).toContain(",2026-09-15,Build,Ada,'=cmd");
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
