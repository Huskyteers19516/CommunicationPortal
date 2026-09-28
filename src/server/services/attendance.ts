// Attendance: taking attendance with a rotating QR code, "Coming?" answers, day plans, and the schedule.
// - Runners (canRunAttendance: teachers, the Business leader, the captain, mentors, owners) start today's
//   Regular or Flex attendance, which shows a QR code + 6-digit code that change every 30 seconds
//   (src/server/attendance/codes.ts). They close / reopen it, write "What we did", delete one started by mistake,
//   and change the schedule (TeamNote "attendance-settings"). "What we did" and deleting a session more than
//   ATTENDANCE_EDIT_DAYS old: only teachers, mentors, and owners (canFixOldAttendance).
// - Everyone with admin access (canFixAttendance: every leader, the captain, mentors, teachers, owners) fixes anyone
//   else's attendance at any time: add people by hand (partial credit, EC, or "No credit" — never 1 or Flex, which
//   need the scan), take them off, and change credits. Every such change is written to the change log
//   (AttendanceChange) in the same transaction; so is deleting a session. EC only by canGiveExtraCredit. Nobody adds
//   themselves by hand or changes their own credit (another admin does), so nobody gives themselves credit.
// - Everyone ACTIVE checks in by scanning (checkInWithToken) or typing the code (checkInWithCode, rate-limited),
//   only into today's open sessions; checking in twice is fine ("You're already checked in"). A check-in counts as
//   1 at Regular; at Flex it starts as 1 Flex and the member may switch to 1/2 Flex that day (setMyCredit).
//   Someone already put on the list by hand who scans in while it's open becomes a real check-in (recordCheckIn).
// - Everyone answers "Coming?" for upcoming team days: Regular Yes / Half / No, and on Flex days "Attend Flex?"
//   Yes / No, plus a short note. Past days are read-only. A day with an extra meeting (a Team calendar event of
//   the kind MEETING) is a regular day too: getAttendanceSettings(today, ctx.db) adds those days.
// - Staff (canPlanAttendance) write the plan for a day, which members see next to their answer.
// - Closing a session where people said they'd come but didn't check in posts their names to the leaders' Discord
//   channel ("attendance.no_shows").
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import type { AttendanceChangeAction, AttendanceCreditKind, AttendanceKind, CheckInMethod, RsvpAnswer } from "@/generated/prisma/enums";
import {
  adminCreditOptions,
  ATTENDANCE_EDIT_DAYS,
  ATTENDANCE_SETTINGS_KEY,
  CREDIT_OPTION_IDS,
  type CreditOption,
  type CreditOptionId,
  creditLabel,
  creditOption,
  creditOptionOf,
  defaultCreditOption,
  HAND_CREDIT_IDS,
  isExtraCreditOption,
  isFlexDay,
  isRegularDay,
  isTeamDay,
  type SavedAttendanceSettings,
  serializeAttendanceSettings,
  type Weekday,
  WEEKLY_TARGET_MAX,
  memberCreditOptions,
  WEEKLY_TARGET_MIN,
  weekdayOf,
} from "@/lib/attendance";
import { LIMITS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, daysBetween, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import { dateOnlySchema, idSchema, optionalText } from "@/lib/validation";
import { matchTypedCode, newSessionSecret, normalizeTypedCode, parseQrToken, verifyQrToken } from "../attendance/codes";
import { findNoShows } from "../attendance/no-shows";
import { parseInput } from "../action";
import type { ServiceContext } from "../context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../errors";
import { canFixAttendance, canFixOldAttendance, canGiveExtraCredit, canPlanAttendance, canRunAttendance } from "../permissions";
import { getAttendanceSettings, getSavedAttendanceSettings } from "../queries/attendance-settings";
import { consumeRateLimit, enforceRateLimit } from "../rate-limit";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Typed-code attempts per person: plenty for typos, far too few to guess (a code is 1 in a million). */
export const CODE_ATTEMPT_LIMIT = { limit: 10, windowMs: 10 * MINUTE } as const;
/** "Coming?" taps per person per hour. */
export const RSVP_WRITES_PER_HOUR = 300;
/** Runner / planner changes per person per hour (adding people by hand, notes, plans, settings, credits). */
export const ATTENDANCE_WRITES_PER_HOUR = 600;
/** Changes to your own Flex credit ("How long are you at Flex?") per person per hour. */
export const CREDIT_WRITES_PER_HOUR = 120;

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
export const ADMINS_ONLY = "Only leaders, the captain, mentors, teachers, and owners can change attendance.";
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
export const OLD_SESSION = `Only teachers, mentors, and owners can change “What we did” or delete attendance from more than ${ATTENDANCE_EDIT_DAYS} days ago.`;
export const NOTE_CHANGED = "Someone else just saved a different “What we did”. Check it below, then save again.";
export const PLAN_CHANGED = "Someone else just saved a different plan for this day. Check it below, then save again.";
export const CANT_DELETE_SESSION =
  "People checked themselves in to this one on its day, so it can't be deleted. Take people off the list instead.";
export const PICK_CREDIT = "Pick how long you were there.";
export const PICK_HAND_CREDIT = "Pick what it counts as: 1/3, 1/2, 2/3, EC, or No credit.";
const NOT_ON_LIST = "They're not on the list any more.";
export const NOT_CHECKED_IN = "You're not checked in to this one.";
export const CREDIT_PAST_DAY = "You can only change it on the day. Ask the person running attendance.";
export const FLEX_CREDIT_ONLY = "Flex attendance counts as 1/2 Flex or 1 Flex.";
export const REGULAR_CREDIT_ONLY = "Flex credit is only for Flex attendance.";
export const FLEX_FULL_CREDIT = "At Flex, full credit is 1 Flex.";
export const EC_ONLY = "Only the Business leader, teachers, mentors, and owners can give EC.";
export const BY_HAND_PARTIAL_ONLY =
  "Added by hand, it can be 1/3, 1/2, 2/3, EC, or No credit. For 1 or Flex credit, they need to scan in.";
export const REGULAR_NO_PICK = "At regular practice a check-in counts as 1. Ask an admin if it should be less.";
export const ADDED_BY_HAND = "You were added by hand, so ask an admin to change it.";
export const MARKED_NOT_HERE = "An admin marked you as not here for this one. Ask them if that's wrong.";
export const NOT_YOURSELF = "You can't add yourself by hand. Scan the code, or ask another admin to add you.";
export const OWN_CREDIT = "You can't change your own credit. Ask another admin.";
export const UNDO_TOO_LATE = "That changed since (they may have scanned in), so it wasn't undone. Check the list.";
const SCAN_AGAIN = "Your spot on the list just changed. Scan the code again.";
const WEEKLY_TARGET_RANGE = `Pick ${WEEKLY_TARGET_MIN} to ${WEEKLY_TARGET_MAX} times a week.`;

// ---------- input schemas ----------

const kindInput = z.object({ kind: z.enum(["REGULAR", "FLEX"], { error: "Pick Regular or Flex." }) });
const sessionInput = z.object({ sessionId: idSchema });
const personInput = z.object({ sessionId: idSchema, userId: idSchema });
/** `from` (Undo right after adding someone by hand): only take them off while it's still that hand entry. */
const removeInput = personInput.extend({ from: z.enum(CREDIT_OPTION_IDS, { error: "Reload the page and try again." }).optional() });
const creditOptionSchema = z.enum(CREDIT_OPTION_IDS, { error: PICK_CREDIT });
/** Adding by hand: what it counts as must be picked (1/3, 1/2, 2/3, EC, or No credit). */
const addPersonInput = personInput.extend({ option: z.enum(CREDIT_OPTION_IDS, { error: PICK_HAND_CREDIT }) });
const myCreditInput = z.object({ sessionId: idSchema, option: creditOptionSchema });
/** `from`: the option the runner's menu showed ("" = a value no option has); missing = don't check. */
const creditInput = z.object({
  sessionId: idSchema,
  userId: idSchema,
  option: creditOptionSchema,
  from: z.union([creditOptionSchema, z.literal("")], { error: "Reload the page and try again." }).optional(),
});
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
/** Missing (an older form) keeps the saved target. */
const weeklyTargetInput = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? undefined : typeof v === "string" && /^\s*\d{1,2}\s*$/.test(v) ? Number(v) : v),
  z
    .number({ error: WEEKLY_TARGET_RANGE })
    .int(WEEKLY_TARGET_RANGE)
    .min(WEEKLY_TARGET_MIN, WEEKLY_TARGET_RANGE)
    .max(WEEKLY_TARGET_MAX, WEEKLY_TARGET_RANGE)
    .optional(),
);
const settingsInput = z.object({ regularDays: weekdayList, flexDays: weekdayList, reportStart: dateOnlySchema, weeklyTarget: weeklyTargetInput });

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

/** Everyone with admin access: fixes anyone's attendance (add, remove, credits) at any time. */
function requireFixer(ctx: ServiceContext) {
  requireActive(ctx);
  if (!canFixAttendance(ctx.actor)) throw new ForbiddenError(ADMINS_ONLY);
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

/**
 * Whether this actor may change a session's "What we did" or delete it on this day (runners: the last
 * ATTENDANCE_EDIT_DAYS days; teachers, mentors, and owners any time). Who was there has no time limit.
 */
export function canEditSessionOn(actor: Parameters<typeof canFixOldAttendance>[0], date: DateOnly, today: DateOnly): boolean {
  return daysBetween(date, today) <= ATTENDANCE_EDIT_DAYS || canFixOldAttendance(actor);
}

function requireEditable(ctx: ServiceContext, date: Date) {
  if (!canEditSessionOn(ctx.actor, dbToDateOnly(date), today(ctx))) throw new ForbiddenError(OLD_SESSION);
}

/**
 * The option an admin sets on a record of this session kind and check-in method (src/lib/attendance.ts:
 * adminCreditOptions): it must fit the session (no Flex credit at Regular, full credit at Flex is 1 Flex), a record
 * added by hand never holds 1 or Flex credit, and EC is only for those who may give it.
 */
function adminOptionFor(ctx: ServiceContext, id: CreditOptionId, kind: AttendanceKind, method: CheckInMethod): CreditOption {
  const option = creditOption(id) as CreditOption;
  if (option.kind === "FLEX" && kind !== "FLEX") fail("option", REGULAR_CREDIT_ONLY);
  if (id === "1" && kind === "FLEX") fail("option", FLEX_FULL_CREDIT);
  if (method === "MANUAL" && !HAND_CREDIT_IDS.includes(id)) fail("option", BY_HAND_PARTIAL_ONLY);
  const mayGiveEc = canGiveExtraCredit(ctx.actor);
  if (isExtraCreditOption(id) && !mayGiveEc) throw new ForbiddenError(EC_ONLY);
  // What's left is exactly what the menus offer (adminCreditOptions); checked again so the two never drift apart.
  if (!adminCreditOptions({ kind, method, canGiveExtraCredit: mayGiveEc }).some((o) => o.id === id)) fail("option", PICK_HAND_CREDIT);
  return option;
}

type Tx = Parameters<Parameters<ServiceContext["db"]["$transaction"]>[0]>[0];
type Credit = { credit: number; creditKind: AttendanceCreditKind };

/** What changed, for the change log (AttendanceChange copies the session's day/kind and the person's name). */
interface ChangeInput {
  action: AttendanceChangeAction;
  session: { id: string; date: Date; kind: AttendanceKind };
  person?: { id: string; name: string };
  from?: Credit;
  to?: Credit;
}

/** One row of the change log, written in the same transaction as the change itself. */
async function logChange(tx: Tx, ctx: ServiceContext, row: ChangeInput) {
  await tx.attendanceChange.create({ data: changeData(ctx, row), select: { id: true } });
}

function changeData(ctx: ServiceContext, row: ChangeInput) {
  return {
    sessionId: row.session.id,
    sessionDate: row.session.date,
    sessionKind: row.session.kind,
    userId: row.person?.id ?? null,
    userName: row.person?.name ?? "",
    changedById: ctx.actor.id,
    action: row.action,
    fromCredit: row.from?.credit ?? null,
    fromKind: row.from?.creditKind ?? null,
    toCredit: row.to?.credit ?? null,
    toKind: row.to?.creditKind ?? null,
    createdAt: ctx.now,
  };
}

/** What a new check-in counts as: the session kind's default ("1" at Regular, "1 Flex" at Flex). */
function defaultCredit(kind: AttendanceKind) {
  const { credit, kind: creditKind } = defaultCreditOption(kind);
  return { credit, creditKind };
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

/**
 * Stop check-ins (the roster, note, and hand edits stay). Closing a closed session is fine, and so is closing one
 * from an earlier day that was left open. When it closes, the people who said they'd come but didn't check in (and
 * nobody dealt with yet; never the person who started it) are posted to the leaders' Discord channel
 * ("attendance.no_shows"); working that out never stops the close.
 */
export async function closeSession(ctx: ServiceContext, raw: unknown): Promise<{ id: string; kind: AttendanceKind; noShows: number }> {
  requireRunner(ctx);
  const { sessionId } = parseInput(sessionInput, asRecord(raw));
  const session = await ctx.db.attendanceSession.findUnique({
    where: { id: sessionId },
    select: { id: true, kind: true, date: true, openedById: true },
  });
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  const { count } = await ctx.db.attendanceSession.updateMany({ where: { id: sessionId, closedAt: null }, data: { closedAt: ctx.now } });
  let noShows = 0;
  if (count === 1) {
    try {
      const people = (await findNoShows(ctx.db, [session])).get(session.id) ?? [];
      noShows = people.length;
      if (noShows > 0) ctx.notifier.notify({ type: "attendance.no_shows", sessionId: session.id, userIds: people.map((p) => p.id) });
    } catch (e) {
      console.error("[attendance] couldn't work out who didn't come", e);
    }
  }
  return { id: session.id, kind: session.kind, noShows };
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
 * Allowed for today's session, or for one nobody checked in to themselves (only people added by hand). The change
 * log gets one SESSION_DELETED row plus a REMOVED row for everyone who was on it (same transaction; the session row
 * is locked first, so nobody checks in between reading the list and deleting it).
 */
export async function deleteSession(ctx: ServiceContext, raw: unknown): Promise<{ kind: AttendanceKind; date: DateOnly }> {
  requireRunner(ctx);
  const { sessionId } = parseInput(sessionInput, asRecord(raw));
  const found = await ctx.db.attendanceSession.findUnique({ where: { id: sessionId }, select: { date: true } });
  if (!found) throw new NotFoundError(SESSION_NOT_FOUND);
  requireEditable(ctx, found.date);
  const todayDb = dateOnlyToDb(today(ctx));
  await limitRunnerWrites(ctx);
  return ctx.db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "AttendanceSession" WHERE id = ${sessionId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError(SESSION_NOT_FOUND);
    const session = await tx.attendanceSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: {
        id: true,
        date: true,
        kind: true,
        records: { select: { method: true, credit: true, creditKind: true, user: { select: { id: true, name: true } } } },
      },
    });
    if (session.date.getTime() !== todayDb.getTime() && session.records.some((r) => r.method !== "MANUAL")) {
      throw new ConflictError(CANT_DELETE_SESSION);
    }
    await tx.attendanceChange.createMany({
      data: [
        changeData(ctx, { action: "SESSION_DELETED", session }),
        ...session.records.map((r) => changeData(ctx, { action: "REMOVED", session, person: r.user, from: r })),
      ],
    });
    await tx.attendanceSession.delete({ where: { id: sessionId }, select: { id: true } });
    return { kind: session.kind, date: dbToDateOnly(session.date) };
  });
}

/**
 * Add someone by hand (they forgot their phone, came for part of it, or said they'd come and didn't): admins, on any
 * session, open or closed, any time. What it counts as is one of HAND_CREDIT_IDS — 1/3, 1/2, 2/3, EC (only for
 * those who may give it), or No credit (on the sheet, counted as not there) — never 1 or Flex, which need the scan.
 * The person must be ACTIVE and someone else (nobody gives themselves credit). It records who set it (their own
 * picker stays locked, "X set it"). Logged (ADDED). If they scan in while it's still open, recordCheckIn turns it
 * into a real check-in.
 */
export async function addPerson(ctx: ServiceContext, raw: unknown): Promise<{ name: string; option: CreditOptionId }> {
  requireFixer(ctx);
  const { sessionId, userId, option: id } = parseInput(addPersonInput, asRecord(raw));
  const [session, person] = await Promise.all([
    ctx.db.attendanceSession.findUnique({ where: { id: sessionId }, select: { id: true, date: true, kind: true } }),
    ctx.db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, status: true } }),
  ]);
  if (!session) throw new NotFoundError(SESSION_NOT_FOUND);
  if (!person || person.status !== "ACTIVE") throw new ValidationError("Pick someone who's active on the team.");
  if (userId === ctx.actor.id) throw new ForbiddenError(NOT_YOURSELF);
  const option = adminOptionFor(ctx, id, session.kind, "MANUAL");
  await limitRunnerWrites(ctx);
  const to = { credit: option.credit, creditKind: option.kind };
  try {
    await ctx.db.$transaction(async (tx) => {
      await tx.attendanceRecord.create({
        data: {
          sessionId,
          userId,
          method: "MANUAL",
          checkedInAt: ctx.now,
          markedById: ctx.actor.id,
          ...to,
          // The same instant as checkedInAt: "set when they were added" (recordCheckIn tells it from a later change).
          creditChangedAt: ctx.now,
          creditChangedById: ctx.actor.id,
        },
        select: { id: true },
      });
      await logChange(tx, ctx, { action: "ADDED", session, person, to });
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError(`${person.name} is already on the list.`);
    if (isMissingReference(e)) throw new NotFoundError(SESSION_NOT_FOUND);
    throw e;
  }
  return { name: person.name, option: option.id };
}

/**
 * Take someone off a session's list (checked in by mistake): admins, any time. Logged (REMOVED, with the credit it
 * had). With `from` (Undo, right after a no-show quick action), only while it's still the hand entry that counts as
 * that: once they scanned in or an admin changed it, it stays (ConflictError).
 */
export async function removePerson(ctx: ServiceContext, raw: unknown): Promise<{ name: string }> {
  requireFixer(ctx);
  const { sessionId, userId, from: undo } = parseInput(removeInput, asRecord(raw));
  const record = await ctx.db.attendanceRecord.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
    select: { id: true, user: { select: { id: true, name: true } }, session: { select: { id: true, date: true, kind: true } } },
  });
  if (!record) throw new NotFoundError(NOT_ON_LIST);
  await limitRunnerWrites(ctx);
  try {
    await ctx.db.$transaction(async (tx) => {
      if (undo !== undefined) {
        const was = creditOption(undo) as CreditOption;
        const from = { credit: was.credit, creditKind: was.kind };
        const { count } = await tx.attendanceRecord.deleteMany({ where: { id: record.id, method: "MANUAL", ...from } });
        if (count === 0) throw new ConflictError(UNDO_TOO_LATE);
        await logChange(tx, ctx, { action: "REMOVED", session: record.session, person: record.user, from });
        return;
      }
      // The credit it had when it went (DELETE … RETURNING), not what was read before.
      const from = await tx.attendanceRecord.delete({ where: { id: record.id }, select: { credit: true, creditKind: true } });
      await logChange(tx, ctx, { action: "REMOVED", session: record.session, person: record.user, from });
    });
  } catch (e) {
    if (isMissingReference(e)) throw new NotFoundError(NOT_ON_LIST); // taken off meanwhile
    throw e;
  }
  return { name: record.user.name };
}

// ---------- checking in (everyone) ----------

export interface CheckInResult {
  sessionId: string;
  kind: AttendanceKind;
  already: boolean;
  /**
   * They were on the list by hand and an admin had changed that since, so the scan made it a real check-in but kept
   * the admin's credit (they can now make it 1): what it counts as and who set it.
   */
  kept?: { label: string; by: string | null };
}

type CheckInSession = { id: string; kind: AttendanceKind; date: Date; closedAt: Date | null };

/**
 * A record added by hand that nobody changed since (addPerson sets creditChangedAt to the moment it was added; an
 * admin's own add from before that rule has none).
 */
export function untouchedByHand(r: { method: CheckInMethod; checkedInAt: Date; creditChangedAt: Date | null }): boolean {
  return r.method === "MANUAL" && (r.creditChangedAt === null || r.creditChangedAt.getTime() === r.checkedInAt.getTime());
}

/**
 * Check in to an open session of today. Already on the list:
 * - scanned before: "already checked in" (or MARKED_NOT_HERE when an admin set that scan to No credit);
 * - put on the list by hand (a no-show given part credit or No credit before they got here, someone who forgot their
 *   phone) and nobody changed it since: it becomes a real check-in with the default credit (1 / 1 Flex) — unless the
 *   hand credit was already as much (1 EC) — and the change log gets a CREDIT_CHANGED row by them, so History says
 *   why the hand entry changed;
 * - by hand and an admin changed it since: No credit stays (MARKED_NOT_HERE, like a scan); part credit stays as the
 *   admin set it, but it's a scan now, so an admin can make it 1 (`kept`).
 * Every write is conditional on what was just read, so an admin's change landing first isn't undone.
 */
async function recordCheckIn(ctx: ServiceContext, session: CheckInSession, method: "QR" | "CODE"): Promise<CheckInResult> {
  if (session.closedAt !== null) throw new ConflictError(SESSION_CLOSED);
  if (dateOnlyToDb(today(ctx)).getTime() !== session.date.getTime()) throw new ConflictError(OTHER_DAY);
  const result = { sessionId: session.id, kind: session.kind };
  const fresh = defaultCredit(session.kind);
  try {
    await ctx.db.attendanceRecord.create({
      data: { sessionId: session.id, userId: ctx.actor.id, method, checkedInAt: ctx.now, ...fresh },
      select: { id: true },
    });
    return { ...result, already: false };
  } catch (e) {
    if (isMissingReference(e)) throw new NotFoundError(SESSION_NOT_FOUND);
    if (!isUniqueViolation(e)) throw e;
  }
  const mine = await ctx.db.attendanceRecord.findUnique({
    where: { sessionId_userId: { sessionId: session.id, userId: ctx.actor.id } },
    select: {
      id: true,
      method: true,
      credit: true,
      creditKind: true,
      checkedInAt: true,
      creditChangedAt: true,
      creditChangedBy: { select: { name: true } },
    },
  });
  if (!mine) throw new ConflictError(SCAN_AGAIN); // taken off between the two steps
  if (mine.method !== "MANUAL" || (!untouchedByHand(mine) && mine.credit <= 0)) {
    // An admin set their scan (or, later, their hand entry) to "No credit": scanning again doesn't undo that.
    if (mine.credit <= 0) throw new ConflictError(MARKED_NOT_HERE);
    return { ...result, already: true };
  }
  const upgrade = untouchedByHand(mine) && mine.credit < fresh.credit;
  await ctx.db.$transaction(async (tx) => {
    const { count } = await tx.attendanceRecord.updateMany({
      where: { id: mine.id, method: "MANUAL", credit: mine.credit, creditKind: mine.creditKind, creditChangedAt: mine.creditChangedAt },
      data: upgrade
        ? { method, checkedInAt: ctx.now, markedById: null, ...fresh, creditChangedAt: null, creditChangedById: null }
        : { method, checkedInAt: ctx.now, markedById: null },
    });
    if (count === 0) throw new ConflictError(SCAN_AGAIN);
    if (upgrade) {
      await logChange(tx, ctx, {
        action: "CREDIT_CHANGED",
        session,
        person: { id: ctx.actor.id, name: ctx.actor.name },
        from: mine,
        to: fresh,
      });
    }
  });
  if (upgrade) return { ...result, already: false };
  return { ...result, already: false, kept: { label: creditLabel(mine.credit, mine.creditKind), by: mine.creditChangedBy?.name ?? null } };
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
    // Already checked in? Then an old link is still good news (No credit or a hand entry doesn't count: a scan
    // would change those, so they need a fresh code).
    const mine = await ctx.db.attendanceRecord.findUnique({
      where: { sessionId_userId: { sessionId: session.id, userId: ctx.actor.id } },
      select: { credit: true, method: true },
    });
    if (mine && mine.credit > 0 && mine.method !== "MANUAL") return { sessionId: session.id, kind: session.kind, already: true };
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

// ---------- credits ----------

export interface CreditResult {
  option: CreditOptionId;
  /** Nothing changed (it already counted as that). */
  unchanged: boolean;
}

/**
 * At Flex, pick how much your own check-in counts: 1/2 Flex or 1 Flex (it starts as 1 Flex). Only your own scanned
 * (or typed-code) check-in, only on the session's day (team timezone). At Regular there's nothing to pick (a
 * check-in counts as 1; admins make it less). Once an admin changed it, it's theirs: ask them (a ConflictError naming
 * them), so nobody quietly undoes a correction. Not in the change log.
 */
export async function setMyCredit(ctx: ServiceContext, raw: unknown): Promise<CreditResult> {
  requireActive(ctx);
  const { sessionId, option: id } = parseInput(myCreditInput, asRecord(raw));
  const record = await ctx.db.attendanceRecord.findUnique({
    where: { sessionId_userId: { sessionId, userId: ctx.actor.id } },
    select: {
      id: true,
      method: true,
      credit: true,
      creditKind: true,
      creditChangedAt: true,
      creditChangedBy: { select: { name: true } },
      session: { select: { date: true, kind: true } },
    },
  });
  if (!record) throw new NotFoundError(NOT_CHECKED_IN);
  if (record.session.kind !== "FLEX") throw new ForbiddenError(REGULAR_NO_PICK);
  if (dbToDateOnly(record.session.date) !== today(ctx)) throw new ConflictError(CREDIT_PAST_DAY);
  if (!memberCreditOptions(record.session.kind).some((o) => o.id === id)) fail("option", FLEX_CREDIT_ONLY);
  const option = creditOption(id) as CreditOption;
  if (record.method === "MANUAL") throw new ConflictError(ADDED_BY_HAND);
  if (record.creditChangedAt !== null) throw new ConflictError(changedByRunner(record.creditChangedBy?.name));
  if (record.credit === option.credit && record.creditKind === option.kind) return { option: option.id, unchanged: true };
  await enforceRateLimit(ctx.db, `attendance-credit:${ctx.actor.id}`, CREDIT_WRITES_PER_HOUR, HOUR, ctx.now);
  // Conditional, so an admin's change that lands first isn't undone.
  const { count } = await ctx.db.attendanceRecord.updateMany({
    where: { id: record.id, creditChangedAt: null, method: { not: "MANUAL" } },
    data: { credit: option.credit, creditKind: option.kind },
  });
  if (count === 0) {
    const now = await ctx.db.attendanceRecord.findUnique({ where: { id: record.id }, select: { creditChangedBy: { select: { name: true } } } });
    throw now ? new ConflictError(changedByRunner(now.creditChangedBy?.name)) : new NotFoundError(NOT_CHECKED_IN);
  }
  return { option: option.id, unchanged: false };
}

function changedByRunner(name: string | undefined): string {
  return `${name ?? "An admin"} set how much this counts. Ask them if it's wrong.`;
}

/**
 * Admins change how much anyone else's check-in counts, any time (live screen, a past session's page): a scanned
 * one to any option that fits the session, or to a partial one, EC, or No credit; one added by hand only to a
 * partial one, EC, or No credit (adminCreditOptions). EC only by canGiveExtraCredit — anyone may change an EC credit
 * to something else. It records who and when ("changed by"), locks the person's own picker, and writes
 * CREDIT_CHANGED to the change log (same transaction). Never your own (OWN_CREDIT: another admin changes it), so
 * nobody raises their own credit or quietly undoes another admin's correction. With `from` (what the menu showed), a
 * change made meanwhile — the person picking theirs, another admin — is never overwritten unseen: ConflictError
 * saying what it is now.
 */
export async function setCredit(ctx: ServiceContext, raw: unknown): Promise<CreditResult & { name: string }> {
  requireFixer(ctx);
  const { sessionId, userId, option: id, from } = parseInput(creditInput, asRecord(raw));
  const record = await ctx.db.attendanceRecord.findUnique({
    where: { sessionId_userId: { sessionId, userId } },
    select: {
      id: true,
      method: true,
      credit: true,
      creditKind: true,
      creditChangedAt: true,
      creditChangedBy: { select: { name: true } },
      user: { select: { id: true, name: true } },
      session: { select: { id: true, date: true, kind: true } },
    },
  });
  if (!record) throw new NotFoundError(NOT_ON_LIST);
  if (userId === ctx.actor.id) throw new ForbiddenError(OWN_CREDIT);
  const option = adminOptionFor(ctx, id, record.session.kind, record.method);
  const name = record.user.name;
  if (record.credit === option.credit && record.creditKind === option.kind) return { name, option: option.id, unchanged: true };
  if (from !== undefined && from !== (creditOptionOf(record.credit, record.creditKind) ?? "")) {
    const by = record.creditChangedAt ? (record.creditChangedBy?.name ?? "someone") : name;
    throw new ConflictError(creditChangedMeanwhile(creditLabel(record.credit, record.creditKind), by));
  }
  await limitRunnerWrites(ctx);
  const to = { credit: option.credit, creditKind: option.kind };
  await ctx.db.$transaction(async (tx) => {
    // Conditional on what was just read, so a change in between isn't overwritten unseen (and the log's "from" is right).
    const { count } = await tx.attendanceRecord.updateMany({
      where: { id: record.id, credit: record.credit, creditKind: record.creditKind },
      data: { ...to, creditChangedAt: ctx.now, creditChangedById: ctx.actor.id },
    });
    if (count === 0) {
      const now = await tx.attendanceRecord.findUnique({ where: { id: record.id }, select: { credit: true, creditKind: true } });
      if (!now) throw new NotFoundError(NOT_ON_LIST);
      throw new ConflictError(creditChangedMeanwhile(creditLabel(now.credit, now.creditKind)));
    }
    await logChange(tx, ctx, { action: "CREDIT_CHANGED", session: record.session, person: record.user, from: record, to });
  });
  return { name, option: option.id, unchanged: false };
}

function creditChangedMeanwhile(label: string, by?: string): string {
  return `It was just changed to ${label}${by ? ` by ${by}` : ""}. Check it, then pick again if it's still wrong.`;
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
  const now = today(ctx);
  const settings = await getAttendanceSettings(now, ctx.db);
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
  const now = today(ctx);
  const ahead = daysBetween(now, date);
  if (ahead < 0) throw new ConflictError(PLAN_PAST);
  if (ahead > LIMITS.rsvpDaysAhead) fail("date", PLAN_TOO_FAR);
  const settings = await getAttendanceSettings(now, ctx.db);
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

/**
 * Regular days, Flex days, the Monday the two-week reports count from, and the weekly target (kept as saved when the
 * form doesn't send one). Extra meetings aren't part of it (they're Team calendar events), so they're never saved here.
 */
export async function updateSettings(ctx: ServiceContext, raw: unknown): Promise<SavedAttendanceSettings> {
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
  const settings: SavedAttendanceSettings = {
    regularDays: days(input.regularDays),
    flexDays: days(input.flexDays),
    reportStart: input.reportStart,
    weeklyTarget: input.weeklyTarget ?? (await getSavedAttendanceSettings(ctx.db)).weeklyTarget,
  };
  await limitRunnerWrites(ctx);
  const body = serializeAttendanceSettings(settings);
  await ctx.db.teamNote.upsert({
    where: { key: ATTENDANCE_SETTINGS_KEY },
    create: { key: ATTENDANCE_SETTINGS_KEY, body, updatedById: ctx.actor.id },
    update: { body, updatedById: ctx.actor.id },
  });
  return settings;
}
