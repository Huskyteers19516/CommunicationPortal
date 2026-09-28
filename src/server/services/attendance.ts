// Attendance: taking attendance with a rotating QR code, "Coming?" answers, day plans, and the schedule.
// - Runners (canRunAttendance: teachers, the Business leader, the captain, mentors, owners) start today's
//   Regular or Flex attendance, which shows a QR code + 6-digit code that change every 30 seconds
//   (src/server/attendance/codes.ts). They add/remove people by hand, write "What we did", close it, delete one
//   started by mistake, and change the schedule (TeamNote "attendance-settings"). Sessions more than
//   ATTENDANCE_EDIT_DAYS old can only be changed by teachers, mentors, and owners (canFixOldAttendance).
// - Everyone ACTIVE checks in by scanning (checkInWithToken) or typing the code (checkInWithCode, rate-limited),
//   only into today's open sessions; checking in twice is fine ("You're already checked in").
// - Everyone answers "Coming?" for upcoming team days: Regular Yes / Half / No, and on Flex days "Attend Flex?"
//   Yes / No, plus a short note. Past days are read-only.
// - Staff (canPlanAttendance) write the plan for a day, which members see next to their answer.
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { AttendanceKind, RsvpAnswer } from "@/generated/prisma/enums";
import {
  ATTENDANCE_EDIT_DAYS,
  ATTENDANCE_SETTINGS_KEY,
  type AttendanceSettings,
  isFlexDay,
  isRegularDay,
  isTeamDay,
  type Weekday,
  weekdayOf,
} from "@/lib/attendance";
import { LIMITS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, daysBetween, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { dateOnlySchema, idSchema, optionalText } from "@/lib/validation";
import { matchTypedCode, newSessionSecret, normalizeTypedCode, parseQrToken, verifyQrToken } from "../attendance/codes";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canFixOldAttendance, canPlanAttendance, canRunAttendance } from "../permissions";
import { getAttendanceSettings } from "../queries/attendance-settings";
import { consumeRateLimit, enforceRateLimit } from "../rate-limit";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Typed-code attempts per person: plenty for typos, far too few to guess (a code is 1 in a million). */
export const CODE_ATTEMPT_LIMIT = { limit: 10, windowMs: 10 * MINUTE } as const;
/** "Coming?" taps per person per hour. */
export const RSVP_WRITES_PER_HOUR = 300;
/** Runner / planner changes per person per hour (adding people by hand, notes, plans, settings). */
export const ATTENDANCE_WRITES_PER_HOUR = 600;

export const SESSION_NOT_FOUND = "That attendance session no longer exists.";
export const ALREADY_CHECKED_IN = "You're already checked in.";
export const QR_EXPIRED = "This code expired. Scan the code on the screen again.";
export const QR_INVALID = "That QR code didn't work. Scan the code on the screen again.";
export const CODE_WRONG = "That code didn't work. Check the screen and try again.";
export const CODE_FORMAT = "Enter the 6-digit code on the screen.";
export const NOTHING_OPEN = "Attendance isn't open right now. Ask the person running it.";
export const SESSION_CLOSED = "Attendance for this one is closed. Ask the person running it to add you.";
export const OTHER_DAY = "That code is from another day. Scan the code on the screen again.";
const INACTIVE = "Your account isn't active.";
const RUNNERS_ONLY = "Only teachers, mentors, the captain, and the Business leader can run attendance.";
const PLANNERS_ONLY = "Only leaders, the captain, mentors, and teachers can plan the day.";
const NO_PRACTICE = "There's no practice that day.";
const NO_REGULAR = "There's no regular practice that day.";
const NO_FLEX = "There's no Flex that day.";
const PAST_DAY = "That day has passed, so answers can't change now.";
const TOO_FAR = `You can answer up to ${LIMITS.rsvpDaysAhead} days ahead.`;
const PLAN_PAST = "That day has passed. Plans for past days can't change.";
const PLAN_TOO_FAR = `You can plan up to ${LIMITS.rsvpDaysAhead} days ahead.`;
const REPORT_START_MONDAY = "Pick a Monday — each two-week report starts on a Monday.";
const REPORT_START_RANGE = "Pick a date within the last 5 years or the next year.";
const PICK_A_DAY = "Pick at least one day.";
export const OLD_SESSION = `Only teachers, mentors, and owners can change attendance from more than ${ATTENDANCE_EDIT_DAYS} days ago.`;
export const NOTE_CHANGED = "Someone else just saved a different “What we did”. Check it below, then save again.";
export const PLAN_CHANGED = "Someone else just saved a different plan for this day. Check it below, then save again.";
export const CANT_DELETE_SESSION =
  "People checked themselves in to this one on its day, so it can't be deleted. Take people off the list instead.";

// ---------- input schemas ----------

const kindInput = z.object({ kind: z.enum(["REGULAR", "FLEX"], { error: "Pick Regular or Flex." }) });
const sessionInput = z.object({ sessionId: idSchema });
const personInput = z.object({ sessionId: idSchema, userId: idSchema });
const tokenInput = z.object({ token: z.string({ error: QR_INVALID }).trim().min(1, QR_INVALID).max(200, QR_INVALID) });
const codeInput = z.object({
  code: z
    .string({ error: CODE_FORMAT })
    .max(40, CODE_FORMAT)
    .transform((v, ctx) => {
      const code = normalizeTypedCode(v);
      if (!code) {
        ctx.addIssue({ code: "custom", message: CODE_FORMAT });
        return z.NEVER;
      }
      return code;
    }),
});
/**
 * The saved text the edit started from (the form sends it back): if the saved text changed meanwhile (another
 * runner, another tab), the save is refused instead of silently replacing it. Missing = don't check.
 */
const baseText = z.string({ error: "Reload the page and try again." }).max(10_000, "Reload the page and try again.").optional();
const noteInput = z.object({ sessionId: idSchema, note: optionalText("What we did", LIMITS.attendanceNoteMax), base: baseText });

/** "" clears the answer; missing leaves it as it is. */
const regularAnswer = z.enum(["", "YES", "HALF", "NO"], { error: "Pick Yes, Half, or No." }).optional();
const flexAnswer = z.enum(["", "YES", "NO"], { error: "Flex is Yes or No." }).optional();
const rsvpInput = z.object({
  date: dateOnlySchema,
  regular: regularAnswer,
  flex: flexAnswer,
  /** "" clears the note; missing leaves it. */
  note: z
    .string({ error: "Write the note as text." })
    .trim()
    .max(LIMITS.rsvpNoteMax, `Note must be at most ${LIMITS.rsvpNoteMax} characters.`)
    .optional(),
});
const planInput = z.object({ date: dateOnlySchema, plan: optionalText("Plan", LIMITS.attendancePlanMax), base: baseText });

const weekdayList = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? [] : Array.isArray(v) ? v : [v]),
  z
    .array(
      z.preprocess(
        (v) => (typeof v === "string" && /^[0-6]$/.test(v.trim()) ? Number(v.trim()) : v),
        z.number({ error: "Pick days of the week." }).int().min(0, "Pick days of the week.").max(6, "Pick days of the week."),
      ),
    )
    .max(7),
);
const settingsInput = z.object({ regularDays: weekdayList, flexDays: weekdayList, reportStart: dateOnlySchema });

// ---------- helpers ----------

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function requireActive(ctx: ServiceContext) {
  if (ctx.actor.status !== "ACTIVE") throw new ForbiddenError(INACTIVE);
}

function requireRunner(ctx: ServiceContext) {
  requireActive(ctx);
  if (!canRunAttendance(ctx.actor)) throw new ForbiddenError(RUNNERS_ONLY);
}

function requirePlanner(ctx: ServiceContext) {
  requireActive(ctx);
  if (!canPlanAttendance(ctx.actor)) throw new ForbiddenError(PLANNERS_ONLY);
}

function today(ctx: ServiceContext): DateOnly {
  return todayInTimezone(ctx.config.teamTimezone, ctx.now);
}

async function limitRunnerWrites(ctx: ServiceContext) {
  await enforceRateLimit(ctx.db, `attendance:${ctx.actor.id}`, ATTENDANCE_WRITES_PER_HOUR, HOUR, ctx.now);
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

function isMissingReference(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2003" || e.code === "P2025");
}

/** Run an upsert again once if a concurrent insert of the same unique key won the race. */
async function retryOnUnique<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isUniqueViolation(e)) return fn();
    throw e;
  }
}

function fail(field: string, message: string): never {
  throw new ValidationError(message, { [field]: message });
}

/** Same text, ignoring how line breaks were sent (forms send CRLF) and outer spaces. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, "\n").trim();
  return norm(a) === norm(b);
}

/** Whether this actor may fix a session of this day (hand edits, "What we did", delete). */
export function canEditSessionOn(actor: Parameters<typeof canFixOldAttendance>[0], date: DateOnly, today: DateOnly): boolean {
  return daysBetween(date, today) <= ATTENDANCE_EDIT_DAYS || canFixOldAttendance(actor);
}

function requireEditable(ctx: ServiceContext, date: Date) {
  if (!canEditSessionOn(ctx.actor, dbToDateOnly(date), today(ctx))) throw new ForbiddenError(OLD_SESSION);
}

// ---------- running attendance ----------

/**
 * Start today's Regular or Flex attendance (team timezone). A new session gets a fresh random secret; a
 * closed one from earlier today is reopened with a fresh secret (old codes stop working); an open one is
 * left as it is.
 */
export async function openSession(ctx: ServiceContext, raw: unknown): Promise<{ id: string; reopened: boolean; created: boolean }> {
  requireRunner(ctx);
  const { kind } = parseInput(kindInput, asRecord(raw));
  const date = dateOnlyToDb(today(ctx));
  await limitRunnerWrites(ctx);
  return retryOnUnique(async () => {
    const existing = await ctx.db.attendanceSession.findUnique({
      where: { date_kind: { date, kind } },
      select: { id: true, closedAt: true },
    });
    if (existing && existing.closedAt === null) return { id: existing.id, reopened: false, created: false };
    if (existing) {
      await ctx.db.attendanceSession.update({
        where: { id: existing.id },
        data: { closedAt: null, secret: newSessionSecret() },
        select: { id: true },
      });
      return { id: existing.id, reopened: true, created: false };
    }
    const { id } = await ctx.db.attendanceSession.create({
      data: { date, kind, secret: newSessionSecret(), openedById: ctx.actor.id, openedAt: ctx.now },
      select: { id: true },
    });
    return { id, reopened: false, created: true };
  });
}

/** Stop check-ins (the roster, note, and hand edits stay). Closing a closed session is fine. */
export async function closeSession(ctx: ServiceContext, raw: unknown): Promise<{ id: string; kind: AttendanceKind }> {
  requireRunner(ctx);
  const { sessionId } = parseInput(sessionInput, asRecord(raw));
  const session = await ctx.db.attendanceSession.findUnique({ where: { id: sessionId }, select: { id: true, kind: true } });
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  await ctx.db.attendanceSession.updateMany({ where: { id: sessionId, closedAt: null }, data: { closedAt: ctx.now } });
  return session;
}

/**
 * "What we did" (goes into the two-week report). Empty clears it. With `base` (the text the form started from),
 * a note someone else saved meanwhile is never overwritten silently (ConflictError instead).
 */
export async function setSessionNote(ctx: ServiceContext, raw: unknown): Promise<void> {
  requireRunner(ctx);
  const { sessionId, note, base } = parseInput(noteInput, asRecord(raw));
  const session = await ctx.db.attendanceSession.findUnique({ where: { id: sessionId }, select: { date: true, note: true } });
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  requireEditable(ctx, session.date);
  const next = note ?? "";
  if (sameText(next, session.note)) return; // nothing to change (maybe someone saved the same)
  if (base !== undefined && !sameText(base, session.note)) throw new ConflictError(NOTE_CHANGED);
  await limitRunnerWrites(ctx);
  // Conditional on the text just read, so a save in between isn't lost either.
  const { count } = await ctx.db.attendanceSession.updateMany({ where: { id: sessionId, note: session.note }, data: { note: next } });
  if (count === 0) {
    const exists = await ctx.db.attendanceSession.count({ where: { id: sessionId } });
    throw exists ? new ConflictError(NOTE_CHANGED) : new NotFoundError(SESSION_NOT_FOUND);
  }
}

/**
 * Delete a session started by mistake (its check-ins go with it), so it doesn't count as "held" in the reports.
 * Allowed for today's session, or for one nobody checked in to themselves (only people added by hand).
 */
export async function deleteSession(ctx: ServiceContext, raw: unknown): Promise<{ kind: AttendanceKind; date: DateOnly }> {
  requireRunner(ctx);
  const { sessionId } = parseInput(sessionInput, asRecord(raw));
  const session = await ctx.db.attendanceSession.findUnique({ where: { id: sessionId }, select: { kind: true, date: true } });
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  requireEditable(ctx, session.date);
  const todayDb = dateOnlyToDb(today(ctx));
  await limitRunnerWrites(ctx);
  const { count } = await ctx.db.attendanceSession.deleteMany({
    where: {
      id: sessionId,
      OR: [{ date: todayDb }, { records: { none: { method: { in: ["QR", "CODE"] } } } }],
    },
  });
  if (count === 0) {
    const exists = await ctx.db.attendanceSession.count({ where: { id: sessionId } });
    throw exists ? new ConflictError(CANT_DELETE_SESSION) : new NotFoundError(SESSION_NOT_FOUND);
  }
  return { kind: session.kind, date: dbToDateOnly(session.date) };
}

/**
 * Add someone by hand (they forgot their phone, or came late after it closed). Works on any session, open or
 * closed, so the list can be fixed afterwards. The person must be ACTIVE.
 */
export async function addPerson(ctx: ServiceContext, raw: unknown): Promise<{ name: string }> {
  requireRunner(ctx);
  const { sessionId, userId } = parseInput(personInput, asRecord(raw));
  const [session, person] = await Promise.all([
    ctx.db.attendanceSession.findUnique({ where: { id: sessionId }, select: { id: true, date: true } }),
    ctx.db.user.findUnique({ where: { id: userId }, select: { name: true, status: true } }),
  ]);
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  requireEditable(ctx, session.date);
  if (!person || person.status !== "ACTIVE") throw new ValidationError("Pick someone who's active on the team.");
  await limitRunnerWrites(ctx);
  try {
    await ctx.db.attendanceRecord.create({
      data: { sessionId, userId, method: "MANUAL", checkedInAt: ctx.now, markedById: ctx.actor.id },
      select: { id: true },
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError(`${person.name} is already checked in.`);
    if (isMissingReference(e)) throw new NotFoundError(SESSION_NOT_FOUND);
    throw e;
  }
  return { name: person.name };
}

/** Take someone off a session's list (checked in by mistake). */
export async function removePerson(ctx: ServiceContext, raw: unknown): Promise<{ name: string }> {
  requireRunner(ctx);
  const { sessionId, userId } = parseInput(personInput, asRecord(raw));
  const record = await ctx.db.attendanceRecord.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
    select: { id: true, user: { select: { name: true } }, session: { select: { date: true } } },
  });
  if (!record) throw new NotFoundError("They're not on the list any more.");
  requireEditable(ctx, record.session.date);
  await limitRunnerWrites(ctx);
  await ctx.db.attendanceRecord.deleteMany({ where: { id: record.id } });
  return { name: record.user.name };
}

// ---------- checking in (everyone) ----------

export interface CheckInResult {
  sessionId: string;
  kind: AttendanceKind;
  already: boolean;
}

type CheckInSession = { id: string; kind: AttendanceKind; date: Date; closedAt: Date | null };

async function recordCheckIn(ctx: ServiceContext, session: CheckInSession, method: "QR" | "CODE"): Promise<CheckInResult> {
  if (session.closedAt !== null) throw new ConflictError(SESSION_CLOSED);
  if (dateOnlyToDb(today(ctx)).getTime() !== session.date.getTime()) throw new ConflictError(OTHER_DAY);
  try {
    await ctx.db.attendanceRecord.create({
      data: { sessionId: session.id, userId: ctx.actor.id, method, checkedInAt: ctx.now },
      select: { id: true },
    });
    return { sessionId: session.id, kind: session.kind, already: false };
  } catch (e) {
    if (isUniqueViolation(e)) return { sessionId: session.id, kind: session.kind, already: true };
    if (isMissingReference(e)) throw new NotFoundError(SESSION_NOT_FOUND);
    throw e;
  }
}

const checkInSelect = { id: true, kind: true, date: true, closedAt: true, secret: true } as const;

/** Scanned the QR code (the scan page submits this once). */
export async function checkInWithToken(ctx: ServiceContext, raw: unknown): Promise<CheckInResult> {
  requireActive(ctx);
  const { token } = parseInput(tokenInput, asRecord(raw));
  const parsed = parseQrToken(token);
  if (!parsed) throw new ValidationError(QR_INVALID);
  const session = await ctx.db.attendanceSession.findUnique({ where: { id: parsed.sessionId }, select: checkInSelect });
  const verdict = session ? verifyQrToken(parsed, session.secret, ctx.now) : "invalid";
  if (!session || verdict === "invalid") throw new ValidationError(QR_INVALID);
  if (verdict === "expired") {
    // Already on the list? Then an old link is still good news.
    const mine = await ctx.db.attendanceRecord.findUnique({
      where: { sessionId_userId: { sessionId: session.id, userId: ctx.actor.id } },
      select: { id: true },
    });
    if (mine) return { sessionId: session.id, kind: session.kind, already: true };
    throw new ConflictError(QR_EXPIRED);
  }
  return recordCheckIn(ctx, session, "QR");
}

/** Typed the 6-digit code shown with the QR code. Matched against today's open sessions; attempts are limited. */
export async function checkInWithCode(ctx: ServiceContext, raw: unknown): Promise<CheckInResult> {
  requireActive(ctx);
  const { code } = parseInput(codeInput, asRecord(raw));
  const { limit, windowMs } = CODE_ATTEMPT_LIMIT;
  if (!(await consumeRateLimit(ctx.db, `attendance-code:${ctx.actor.id}`, limit, windowMs, ctx.now))) {
    throw new RateLimitError("Too many tries. Wait a few minutes, or ask the person running attendance to add you.");
  }
  const open = await ctx.db.attendanceSession.findMany({
    where: { date: dateOnlyToDb(today(ctx)), closedAt: null },
    select: checkInSelect,
    orderBy: { kind: "asc" },
  });
  if (open.length === 0) throw new ConflictError(NOTHING_OPEN);
  const matched = matchTypedCode(code, open, ctx.now);
  const session = open.find((s) => s.id === matched);
  if (!session) fail("code", CODE_WRONG);
  return recordCheckIn(ctx, session, "CODE");
}

// ---------- "Coming?" (everyone, own answers only) ----------

export interface RsvpResult {
  date: DateOnly;
  regular: RsvpAnswer | null;
  flex: RsvpAnswer | null;
  note: string;
}

/**
 * Answer "Coming?" for a team day from today up to LIMITS.rsvpDaysAhead days ahead. Only the fields sent
 * change: `regular` (Yes / Half / No, regular days only), `flex` (Yes / No, Flex days only), `note`; "" clears
 * one (clearing works on any day, e.g. after the schedule changed). Nothing left → the answer is removed.
 */
export async function setRsvp(ctx: ServiceContext, raw: unknown): Promise<RsvpResult> {
  requireActive(ctx);
  const input = parseInput(rsvpInput, asRecord(raw));
  const settings = await getAttendanceSettings(ctx.db);
  const now = today(ctx);
  const ahead = daysBetween(now, input.date);
  if (ahead < 0) throw new ConflictError(PAST_DAY);
  if (ahead > LIMITS.rsvpDaysAhead) fail("date", TOO_FAR);
  const regular = input.regular === undefined ? undefined : input.regular === "" ? null : input.regular;
  const flex = input.flex === undefined ? undefined : input.flex === "" ? null : input.flex;
  const setsSomething = regular != null || flex != null || !!input.note;
  if (setsSomething && !isTeamDay(settings, input.date)) fail("date", NO_PRACTICE);
  if (regular != null && !isRegularDay(settings, input.date)) fail("regular", NO_REGULAR);
  if (flex != null && !isFlexDay(settings, input.date)) fail("flex", NO_FLEX);

  await enforceRateLimit(ctx.db, `attendance-rsvp:${ctx.actor.id}`, RSVP_WRITES_PER_HOUR, HOUR, ctx.now);
  const data: { regular?: RsvpAnswer | null; flex?: RsvpAnswer | null; note?: string } = {};
  if (regular !== undefined) data.regular = regular;
  if (flex !== undefined) data.flex = flex;
  if (input.note !== undefined) data.note = input.note;
  const key = { userId: ctx.actor.id, date: dateOnlyToDb(input.date) };
  const row = await retryOnUnique(() =>
    ctx.db.attendanceRsvp.upsert({
      where: { userId_date: key },
      create: { ...key, regular: data.regular ?? null, flex: data.flex ?? null, note: data.note ?? "" },
      update: data,
      select: { id: true, regular: true, flex: true, note: true },
    }),
  );
  if (row.regular === null && row.flex === null && row.note === "") {
    // Conditional, so an answer saved meanwhile (another tab) isn't lost.
    await ctx.db.attendanceRsvp.deleteMany({ where: { id: row.id, regular: null, flex: null, note: "" } });
  }
  return { date: input.date, regular: row.regular, flex: row.flex, note: row.note };
}

// ---------- planning (staff) ----------

/**
 * The plan for a team day (members see it when they answer). Empty removes it. Today and later only. With `base`
 * (the plan the form started from), a plan someone else saved meanwhile is never overwritten silently.
 */
export async function setDayPlan(ctx: ServiceContext, raw: unknown): Promise<{ date: DateOnly; plan: string }> {
  requirePlanner(ctx);
  const { date, plan, base } = parseInput(planInput, asRecord(raw));
  const ahead = daysBetween(today(ctx), date);
  if (ahead < 0) throw new ConflictError(PLAN_PAST);
  if (ahead > LIMITS.rsvpDaysAhead) fail("date", PLAN_TOO_FAR);
  const settings = await getAttendanceSettings(ctx.db);
  if (plan && !isTeamDay(settings, date)) fail("date", NO_PRACTICE);
  const key = dateOnlyToDb(date);
  const next = plan ?? "";
  const current = await ctx.db.attendancePlan.findUnique({ where: { date: key }, select: { plan: true } });
  const saved = current?.plan ?? "";
  if (sameText(next, saved)) return { date, plan: saved };
  if (base !== undefined && !sameText(base, saved)) throw new ConflictError(PLAN_CHANGED);
  await limitRunnerWrites(ctx);
  // Every write is conditional on what was just read, so a plan saved in between is never lost.
  if (!next) {
    const { count } = await ctx.db.attendancePlan.deleteMany({ where: { date: key, plan: saved } });
    if (count === 0) throw new ConflictError(PLAN_CHANGED);
    return { date, plan: "" };
  }
  if (!current) {
    try {
      await ctx.db.attendancePlan.create({ data: { date: key, plan: next, updatedById: ctx.actor.id }, select: { date: true } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictError(PLAN_CHANGED);
      throw e;
    }
    return { date, plan: next };
  }
  const { count } = await ctx.db.attendancePlan.updateMany({
    where: { date: key, plan: saved },
    data: { plan: next, updatedById: ctx.actor.id },
  });
  if (count === 0) throw new ConflictError(PLAN_CHANGED);
  return { date, plan: next };
}

// ---------- schedule (runners) ----------

/** Regular days, Flex days, and the Monday the two-week reports count from. */
export async function updateSettings(ctx: ServiceContext, raw: unknown): Promise<AttendanceSettings> {
  requireRunner(ctx);
  const input = parseInput(settingsInput, asRecord(raw));
  const errors: Record<string, string> = {};
  if (input.regularDays.length === 0 && input.flexDays.length === 0) errors.regularDays = PICK_A_DAY;
  const now = today(ctx);
  if (input.reportStart < addDays(now, -5 * 366) || input.reportStart > addDays(now, 366)) errors.reportStart = REPORT_START_RANGE;
  else if (weekdayOf(input.reportStart) !== 1) errors.reportStart = REPORT_START_MONDAY;
  const messages = Object.values(errors);
  if (messages.length > 0) throw new ValidationError(messages.length === 1 ? messages[0] : "Please fix the highlighted fields.", errors);

  const days = (list: number[]) => [...new Set(list)].sort((a, b) => a - b) as Weekday[];
  const settings: AttendanceSettings = {
    regularDays: days(input.regularDays),
    flexDays: days(input.flexDays),
    reportStart: input.reportStart,
  };
  await limitRunnerWrites(ctx);
  const body = JSON.stringify(settings);
  await ctx.db.teamNote.upsert({
    where: { key: ATTENDANCE_SETTINGS_KEY },
    create: { key: ATTENDANCE_SETTINGS_KEY, body, updatedById: ctx.actor.id },
    update: { body, updatedById: ctx.actor.id },
  });
  return settings;
}
