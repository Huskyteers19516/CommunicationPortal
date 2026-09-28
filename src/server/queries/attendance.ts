import "server-only";
import QRCode from "qrcode";
import type { Prisma } from "@/generated/prisma/client";
import type { AttendanceKind, CheckInMethod, Role, RsvpAnswer, Subteam } from "@/generated/prisma/enums";
import {
  type AttendanceSettings,
  firstReportIndex,
  isFlexDay,
  isRegularDay,
  isTeamDay,
  type ReportPeriod,
  reportPeriodByIndex,
  reportPeriodFor,
  reportPeriodsBetween,
  upcomingTeamDays,
} from "@/lib/attendance";
import { LIMITS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, daysBetween, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import type { Actor } from "../actor";
import { currentCodes, parseQrToken, verifyQrToken } from "../attendance/codes";
import { buildReport, type ReportData, saidYesFor, startOfDayInTimezone } from "../attendance/report";
import { prisma } from "../db";
import { canPlanAttendance, canRunAttendance } from "../permissions";
import { canEditSessionOn } from "../services/attendance";
import { getAttendanceSettings } from "./attendance-settings";
import { getMeetingUpdatesBetween, type MeetingUpdateSummary } from "./meeting-updates";

type ActorLike = Pick<Actor, "id" | "role" | "subteam" | "isAdmin" | "status">;

/** Adults aren't asked "Coming?" and aren't listed as "No answer" (they still show up when they answer or come). */
const ADULT_ROLES: Role[] = ["MENTOR", "TEACHER"];
const teamMembersWhere = { status: "ACTIVE", role: { notIn: ADULT_ROLES } } satisfies Prisma.UserWhereInput;
const personSelect = { id: true, name: true, subteam: true, role: true } as const;
const reportPersonSelect = { ...personSelect, createdAt: true } as const;

export interface Person {
  id: string;
  name: string;
  subteam: Subteam | null;
  role: Role;
}

// ---------- "Coming?" (everyone) ----------

export interface RsvpDay {
  date: DateOnly;
  regularDay: boolean;
  flexDay: boolean;
  regular: RsvpAnswer | null;
  flex: RsvpAnswer | null;
  note: string;
  plan: string;
}

async function rsvpDays(actor: ActorLike, settings: AttendanceSettings, days: DateOnly[]): Promise<RsvpDay[]> {
  if (days.length === 0) return [];
  const dates = days.map(dateOnlyToDb);
  const [rsvps, plans] = await Promise.all([
    prisma.attendanceRsvp.findMany({
      where: { userId: actor.id, date: { in: dates } },
      select: { date: true, regular: true, flex: true, note: true },
    }),
    prisma.attendancePlan.findMany({ where: { date: { in: dates } }, select: { date: true, plan: true } }),
  ]);
  const rsvpBy = new Map(rsvps.map((r) => [dbToDateOnly(r.date), r]));
  const planBy = new Map(plans.map((p) => [dbToDateOnly(p.date), p.plan]));
  return days.map((date) => {
    const r = rsvpBy.get(date);
    return {
      date,
      regularDay: isRegularDay(settings, date),
      flexDay: isFlexDay(settings, date),
      regular: r?.regular ?? null,
      flex: r?.flex ?? null,
      note: r?.note ?? "",
      plan: planBy.get(date) ?? "",
    };
  });
}

export interface TodaySession {
  id: string;
  kind: AttendanceKind;
  open: boolean;
  checkedIn: boolean;
  /** Runners only (null for everyone else). */
  count: number | null;
  openedByName: string | null;
}

async function todaySessions(actor: ActorLike, today: DateOnly): Promise<TodaySession[]> {
  const runner = canRunAttendance(actor);
  const rows = await prisma.attendanceSession.findMany({
    where: { date: dateOnlyToDb(today) },
    select: {
      id: true,
      kind: true,
      closedAt: true,
      openedBy: { select: { name: true } },
      _count: { select: { records: true } },
      records: { where: { userId: actor.id }, select: { id: true } },
    },
    orderBy: { kind: "asc" },
  });
  return rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    open: s.closedAt === null,
    checkedIn: s.records.length > 0,
    count: runner ? s._count.records : null,
    openedByName: runner ? (s.openedBy?.name ?? null) : null,
  }));
}

export interface Tally {
  attended: number;
  held: number;
}

export interface MySummary {
  period: ReportPeriod;
  thisPeriod: { regular: Tally; flex: Tally };
  season: { start: DateOnly; regular: Tally; flex: Tally } | null;
}

/**
 * My attendance this two-week period and this season (since the first report period), up to today. Sessions
 * from before I joined (my account's creation day, team timezone) don't count, unless I came.
 */
export async function getMySummary(actor: ActorLike, settings: AttendanceSettings, today: DateOnly, timeZone: string): Promise<MySummary> {
  const period = reportPeriodFor(settings, today);
  const seasonStarted = settings.reportStart <= today;
  const from = seasonStarted && settings.reportStart < period.start ? settings.reportStart : period.start;
  const [sessions, me] = await Promise.all([
    prisma.attendanceSession.findMany({
      where: { date: { gte: dateOnlyToDb(from), lte: dateOnlyToDb(today) } },
      select: { date: true, kind: true, records: { where: { userId: actor.id }, select: { id: true } } },
    }),
    prisma.user.findUnique({ where: { id: actor.id }, select: { createdAt: true } }),
  ]);
  const joined = me ? todayInTimezone(timeZone, me.createdAt) : null;
  const empty = () => ({ regular: { attended: 0, held: 0 }, flex: { attended: 0, held: 0 } });
  const thisPeriod = empty();
  const season = empty();
  for (const s of sessions) {
    const day = dbToDateOnly(s.date);
    const key = s.kind === "REGULAR" ? "regular" : "flex";
    const came = s.records.length > 0 ? 1 : 0;
    if (!came && joined && day < joined) continue;
    if (day >= period.start) {
      thisPeriod[key].held++;
      thisPeriod[key].attended += came;
    }
    if (seasonStarted && day >= settings.reportStart) {
      season[key].held++;
      season[key].attended += came;
    }
  }
  return { period, thisPeriod, season: seasonStarted ? { start: settings.reportStart, ...season } : null };
}

export interface HistoryItem {
  date: DateOnly;
  kind: AttendanceKind;
  method: CheckInMethod;
  checkedInAt: Date;
}

/** A past session on the runner's card (to fix its list or "What we did" afterwards). */
export interface RecentSession {
  id: string;
  date: DateOnly;
  kind: AttendanceKind;
  count: number;
  hasNote: boolean;
}

export interface AttendanceHome {
  settings: AttendanceSettings;
  today: DateOnly;
  canRun: boolean;
  canPlan: boolean;
  days: RsvpDay[];
  sessions: TodaySession[];
  /** Runners: the last few sessions before today (empty for everyone else). */
  recentSessions: RecentSession[];
  summary: MySummary;
  history: HistoryItem[];
}

const RECENT_SESSIONS = 5;

/** /attendance: my "Coming?" answers for the next team days, today's sessions, and my attendance. */
export async function getAttendanceHome(actor: ActorLike, today: DateOnly, timeZone: string): Promise<AttendanceHome> {
  const settings = await getAttendanceSettings();
  const canRun = canRunAttendance(actor);
  const [days, sessions, summary, history, recent] = await Promise.all([
    rsvpDays(actor, settings, upcomingTeamDays(settings, today, LIMITS.rsvpDaysAhead)),
    todaySessions(actor, today),
    getMySummary(actor, settings, today, timeZone),
    prisma.attendanceRecord.findMany({
      where: { userId: actor.id },
      orderBy: { checkedInAt: "desc" },
      take: 10,
      select: { method: true, checkedInAt: true, session: { select: { date: true, kind: true } } },
    }),
    canRun
      ? prisma.attendanceSession.findMany({
          where: { date: { lt: dateOnlyToDb(today) } },
          orderBy: [{ date: "desc" }, { kind: "asc" }],
          take: RECENT_SESSIONS,
          select: { id: true, date: true, kind: true, note: true, _count: { select: { records: true } } },
        })
      : [],
  ]);
  return {
    settings,
    today,
    canRun,
    canPlan: canPlanAttendance(actor),
    days,
    sessions,
    recentSessions: recent.map((r) => ({ id: r.id, date: dbToDateOnly(r.date), kind: r.kind, count: r._count.records, hasNote: r.note.trim() !== "" })),
    summary,
    history: history.map((h) => ({ date: dbToDateOnly(h.session.date), kind: h.session.kind, method: h.method, checkedInAt: h.checkedInAt })),
  };
}

export interface TodayAttendance {
  /** Today's "Coming?" answers (null when today isn't a team day). */
  day: RsvpDay | null;
  /** Today's open sessions and whether I'm on each. */
  openSessions: TodaySession[];
  checkedInKinds: AttendanceKind[];
  /** Runners get a "Show code" link back to an open session's live screen. */
  canRun: boolean;
  /** Staff, in the first days of a new two-week period: the report for the one that just ended. */
  reportReady: ReportPeriod | null;
}

/** How many days into a new two-week period the Today card points staff to the finished report. */
export const REPORT_READY_DAYS = 3;

/** The two weeks that just ended, when today is in the first days of a new period and attendance was taken in it. */
async function finishedReport(actor: ActorLike, settings: AttendanceSettings, today: DateOnly): Promise<ReportPeriod | null> {
  if (!canPlanAttendance(actor)) return null;
  const current = reportPeriodFor(settings, today);
  if (daysBetween(current.start, today) >= REPORT_READY_DAYS) return null;
  const previous = reportPeriodByIndex(settings, current.index - 1);
  const held = await prisma.attendanceSession.count({
    where: { date: { gte: dateOnlyToDb(previous.start), lte: dateOnlyToDb(previous.end) } },
  });
  return held > 0 ? previous : null;
}

/** The Today page's small card. Null when there's nothing to show (not a team day, nothing open, no new report). */
export async function getTodayAttendance(actor: ActorLike, today: DateOnly): Promise<TodayAttendance | null> {
  const settings = await getAttendanceSettings();
  const teamDay = isTeamDay(settings, today);
  const [days, sessions, reportReady] = await Promise.all([
    rsvpDays(actor, settings, teamDay ? [today] : []),
    todaySessions(actor, today),
    finishedReport(actor, settings, today),
  ]);
  const openSessions = sessions.filter((s) => s.open);
  const checkedInKinds = sessions.filter((s) => s.checkedIn).map((s) => s.kind);
  if (!teamDay && openSessions.length === 0 && checkedInKinds.length === 0 && !reportReady) return null;
  return { day: days[0] ?? null, openSessions, checkedInKinds, canRun: canRunAttendance(actor), reportReady };
}

// ---------- scan landing (read-only) ----------

export interface ScanSession {
  id: string;
  kind: AttendanceKind;
  date: DateOnly;
  open: boolean;
  checkedIn: boolean;
}

export type ScanLanding =
  | { status: "invalid" }
  | { status: "expired" | "ok"; session: ScanSession; isToday: boolean };

/**
 * What a scanned link points at, checked without writing anything (the page may be prefetched or reloaded):
 * the token's signature and age, the session, and whether I'm already on it. The secret stays here.
 */
export async function getScanLanding(actor: ActorLike, token: string, options: { now: Date; today: DateOnly }): Promise<ScanLanding> {
  const parsed = parseQrToken(token);
  if (!parsed) return { status: "invalid" };
  const s = await prisma.attendanceSession.findUnique({
    where: { id: parsed.sessionId },
    select: {
      id: true,
      kind: true,
      date: true,
      closedAt: true,
      secret: true,
      records: { where: { userId: actor.id }, select: { id: true } },
    },
  });
  if (!s) return { status: "invalid" };
  const verdict = verifyQrToken(parsed, s.secret, options.now);
  if (verdict === "invalid") return { status: "invalid" };
  const date = dbToDateOnly(s.date);
  return {
    status: verdict,
    session: { id: s.id, kind: s.kind, date, open: s.closedAt === null, checkedIn: s.records.length > 0 },
    isToday: date === options.today,
  };
}

// ---------- running a session (runners) ----------

export interface RosterEntry extends Person {
  method: CheckInMethod;
  checkedInAt: Date;
  markedByName: string | null;
}

export interface ExpectedPerson extends Person {
  answer: RsvpAnswer;
  note: string;
}

export interface RunnerSession {
  id: string;
  date: DateOnly;
  kind: AttendanceKind;
  open: boolean;
  isToday: boolean;
  openedByName: string | null;
  openedAt: Date;
  closedAt: Date | null;
  note: string;
  roster: RosterEntry[];
  /** Said they'd come (Regular: Yes/Half; Flex: Yes) and aren't checked in yet. */
  expected: ExpectedPerson[];
  /** Everyone who said they'd come, checked in or not. */
  saidYesCount: number;
  /** ACTIVE people not on the list yet (for adding by hand). */
  others: Person[];
  /** Whether this actor may change it (sessions older than ATTENDANCE_EDIT_DAYS: teachers, mentors, owners only). */
  canEdit: boolean;
  /** Whether it can be deleted (started by mistake): today's, or nobody checked in to it themselves. */
  canDelete: boolean;
}

/** A session's live screen. Null when it doesn't exist or the actor can't run attendance. */
export async function getRunnerSession(actor: ActorLike, sessionId: string, today: DateOnly): Promise<RunnerSession | null> {
  if (!canRunAttendance(actor)) return null;
  const s = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      date: true,
      kind: true,
      closedAt: true,
      openedAt: true,
      note: true,
      openedBy: { select: { name: true } },
      records: {
        orderBy: { checkedInAt: "desc" },
        select: { method: true, checkedInAt: true, user: { select: personSelect }, markedBy: { select: { name: true } } },
      },
    },
  });
  if (!s) return null;
  const date = dbToDateOnly(s.date);
  const canEdit = canEditSessionOn(actor, date, today);
  const selfCheckIns = s.records.filter((r) => r.method !== "MANUAL").length;
  const [rsvps, active] = await Promise.all([
    prisma.attendanceRsvp.findMany({
      where: { date: s.date, ...(s.kind === "REGULAR" ? { regular: { in: ["YES", "HALF"] } } : { flex: "YES" }) },
      select: { regular: true, flex: true, note: true, user: { select: { ...personSelect, status: true } } },
    }),
    prisma.user.findMany({ where: { status: "ACTIVE" }, select: personSelect, orderBy: { name: "asc" }, take: 1000 }),
  ]);
  const here = new Set(s.records.map((r) => r.user.id));
  const expected = rsvps
    .filter((r) => r.user.status === "ACTIVE" && !here.has(r.user.id))
    .map((r) => ({
      id: r.user.id,
      name: r.user.name,
      subteam: r.user.subteam,
      role: r.user.role,
      answer: (s.kind === "REGULAR" ? r.regular : r.flex) as RsvpAnswer,
      note: r.note,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    id: s.id,
    date,
    kind: s.kind,
    open: s.closedAt === null,
    isToday: date === today,
    openedByName: s.openedBy?.name ?? null,
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    note: s.note,
    roster: s.records.map((r) => ({ ...r.user, method: r.method, checkedInAt: r.checkedInAt, markedByName: r.markedBy?.name ?? null })),
    expected,
    saidYesCount: rsvps.filter((r) => r.user.status === "ACTIVE" || here.has(r.user.id)).length,
    others: active.filter((p) => !here.has(p.id)),
    canEdit,
    canDelete: canEdit && (date === today || selfCheckIns === 0),
  };
}

export type LiveCode =
  /** `expiresInMs`: until the next code (the browser's clock may be off, so it waits this long, not until expiresAt). */
  | { ok: true; svg: string; code: string; url: string; expiresAt: string; expiresInMs: number }
  | { ok: false; message: string; closed?: boolean };

/**
 * The QR code (as SVG) and 6-digit code to show right now for an open session of today. Runners only; the
 * session's secret is used here and never leaves the server.
 */
export async function getLiveCode(
  actor: ActorLike,
  sessionId: string,
  options: { now: Date; today: DateOnly; appUrl: string },
): Promise<LiveCode> {
  if (!canRunAttendance(actor) || actor.status !== "ACTIVE") return { ok: false, message: "You can't show this code." };
  const s = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    select: { id: true, date: true, closedAt: true, secret: true },
  });
  if (!s) return { ok: false, message: "That attendance session no longer exists.", closed: true };
  if (s.closedAt !== null) return { ok: false, message: "Attendance is closed.", closed: true };
  if (dbToDateOnly(s.date) !== options.today) return { ok: false, message: "This session was for another day.", closed: true };
  const { token, code, expiresAt } = currentCodes(s.secret, s.id, options.now);
  const url = `${options.appUrl.replace(/\/+$/, "")}/attendance/scan/${token}`;
  const svg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  return { ok: true, svg, code, url, expiresAt: expiresAt.toISOString(), expiresInMs: Math.max(0, expiresAt.getTime() - options.now.getTime()) };
}

// ---------- who's coming (staff) ----------

export interface DayCounts {
  date: DateOnly;
  regularDay: boolean;
  flexDay: boolean;
  yes: number;
  half: number;
  no: number;
  flexYes: number;
  /** People who answered anything for the day (0 = "No answers yet", not "nobody's coming"). */
  answered: number;
  hasPlan: boolean;
}

export interface ComingPerson extends Person {
  note: string;
}

export interface ComingDay extends DayCounts {
  plan: string;
  planUpdatedByName: string | null;
  regular: { YES: ComingPerson[]; HALF: ComingPerson[]; NO: ComingPerson[]; NONE: ComingPerson[] };
  flex: { YES: ComingPerson[]; NO: ComingPerson[]; NONE: ComingPerson[] };
}

export interface ComingOverview {
  today: DateOnly;
  days: DayCounts[];
  selected: ComingDay | null;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * /attendance/plan: the next team days with how many are coming, and one day in detail (Regular Yes / Half /
 * No / No answer; Flex Yes / No / No answer; notes; the plan). Null when the actor can't plan.
 */
export async function getComingOverview(actor: ActorLike, today: DateOnly, wanted?: string): Promise<ComingOverview | null> {
  if (!canPlanAttendance(actor)) return null;
  const settings = await getAttendanceSettings();
  const dayList = upcomingTeamDays(settings, today, LIMITS.rsvpDaysAhead);
  const dates = dayList.map(dateOnlyToDb);
  const selectedDay = wanted && dayList.includes(wanted) ? wanted : (dayList[0] ?? null);
  const [rsvps, plans, members] = await Promise.all([
    prisma.attendanceRsvp.findMany({
      where: { date: { in: dates }, user: { status: "ACTIVE" } },
      select: { date: true, regular: true, flex: true, note: true, user: { select: personSelect } },
    }),
    prisma.attendancePlan.findMany({
      where: { date: { in: dates } },
      select: { date: true, plan: true, updatedBy: { select: { name: true } } },
    }),
    selectedDay ? prisma.user.findMany({ where: teamMembersWhere, select: personSelect, orderBy: { name: "asc" }, take: 1000 }) : [],
  ]);
  const planBy = new Map(plans.map((p) => [dbToDateOnly(p.date), p]));
  const days: DayCounts[] = dayList.map((date) => {
    const mine = rsvps.filter((r) => dbToDateOnly(r.date) === date);
    const regularDay = isRegularDay(settings, date);
    const flexDay = isFlexDay(settings, date);
    return {
      date,
      regularDay,
      flexDay,
      yes: regularDay ? mine.filter((r) => r.regular === "YES").length : 0,
      half: regularDay ? mine.filter((r) => r.regular === "HALF").length : 0,
      no: regularDay ? mine.filter((r) => r.regular === "NO").length : 0,
      flexYes: flexDay ? mine.filter((r) => r.flex === "YES").length : 0,
      answered: mine.filter((r) => (regularDay && r.regular !== null) || (flexDay && r.flex !== null)).length,
      hasPlan: !!planBy.get(date)?.plan,
    };
  });
  if (!selectedDay) return { today, days, selected: null };

  const counts = days.find((d) => d.date === selectedDay) as DayCounts;
  const answers = rsvps.filter((r) => dbToDateOnly(r.date) === selectedDay);
  const answerBy = new Map(answers.map((r) => [r.user.id, r]));
  const everyone = [...members];
  for (const r of answers) if (!everyone.some((m) => m.id === r.user.id)) everyone.push(r.user); // adults who answered
  everyone.sort(byName);
  const selected: ComingDay = {
    ...counts,
    plan: planBy.get(selectedDay)?.plan ?? "",
    planUpdatedByName: planBy.get(selectedDay)?.updatedBy?.name ?? null,
    regular: { YES: [], HALF: [], NO: [], NONE: [] },
    flex: { YES: [], NO: [], NONE: [] },
  };
  const isAdult = (p: Person) => ADULT_ROLES.includes(p.role);
  for (const p of everyone) {
    const r = answerBy.get(p.id);
    const person = { ...p, note: r?.note ?? "" };
    if (counts.regularDay) {
      if (r?.regular) selected.regular[r.regular].push(person);
      else if (!isAdult(p)) selected.regular.NONE.push(person);
    }
    if (counts.flexDay) {
      if (r?.flex === "YES" || r?.flex === "NO") selected.flex[r.flex].push(person);
      else if (!isAdult(p)) selected.flex.NONE.push(person);
    }
  }
  return { today, days, selected };
}

// ---------- reports (staff) ----------

export interface ReportListItem extends ReportPeriod {
  current: boolean;
  regular: number;
  flex: number;
}

/**
 * Which periods reports exist for: from the first one (settings.reportStart, or earlier when attendance was taken
 * before it, e.g. after "Reports start" moved to a new season) to the current one.
 */
async function reportRange(settings: AttendanceSettings, today: DateOnly): Promise<{ first: number; current: number }> {
  const current = reportPeriodFor(settings, today).index;
  const earliest = await prisma.attendanceSession.findFirst({ orderBy: { date: "asc" }, select: { date: true } });
  return { first: firstReportIndex(settings, earliest ? dbToDateOnly(earliest.date) : null, current), current };
}

/** Two-week periods from the first one to the current one (current first), with how many sessions each had. */
export async function listReports(actor: ActorLike, today: DateOnly): Promise<{ settings: AttendanceSettings; periods: ReportListItem[] } | null> {
  if (!canPlanAttendance(actor)) return null;
  const settings = await getAttendanceSettings();
  const range = await reportRange(settings, today);
  const periods = reportPeriodsBetween(settings, range.first, range.current);
  if (periods.length === 0) return { settings, periods: [] };
  const sessions = await prisma.attendanceSession.findMany({
    where: { date: { gte: dateOnlyToDb(periods[periods.length - 1].start), lte: dateOnlyToDb(periods[0].end) } },
    select: { date: true, kind: true },
  });
  const currentIndex = range.current;
  return {
    settings,
    periods: periods.map((p) => {
      const inPeriod = sessions.filter((s) => {
        const d = dbToDateOnly(s.date);
        return d >= p.start && d <= p.end;
      });
      return {
        ...p,
        current: p.index === currentIndex,
        regular: inPeriod.filter((s) => s.kind === "REGULAR").length,
        flex: inPeriod.filter((s) => s.kind === "FLEX").length,
      };
    }),
  };
}

export interface DoneTask {
  id: string;
  title: string;
  subteam: Subteam | null;
  people: string[];
}

export interface DonePart {
  id: string;
  name: string;
  quantity: number;
  madeBy: string | null;
  doneAt: Date;
}

export interface NotebookItem {
  id: string;
  title: string;
  notebook: string;
  page: string;
  author: string | null;
  createdAt: Date;
}

export interface AttendanceReport {
  period: ReportPeriod;
  current: boolean;
  /** Is there a newer (up to the current) / an older (from the first) period? */
  hasNewer: boolean;
  hasOlder: boolean;
  data: ReportData;
  tasks: DoneTask[];
  parts: DonePart[];
  notebook: NotebookItem[];
  /** Each subteam's meeting updates in the period (Meeting updates), by day. */
  meetingUpdates: MeetingUpdateSummary[];
}

const REPORT_LIST_MAX = 300;

/**
 * One two-week period: every session (run by, present vs said yes, "What we did"), each person's attendance,
 * and what got done (meeting updates, checklist items approved, parts made, notebook entries written) during it.
 * Null when the actor can't read reports or the period is before the first / after the current one.
 */
export async function getAttendanceReport(
  actor: ActorLike,
  index: number,
  options: { today: DateOnly; timeZone: string },
): Promise<AttendanceReport | null> {
  if (!canPlanAttendance(actor)) return null;
  const settings = await getAttendanceSettings();
  const { first, current: currentIndex } = await reportRange(settings, options.today);
  if (!Number.isSafeInteger(index) || index < first || index > currentIndex) return null;
  const period = reportPeriodByIndex(settings, index);
  const dateRange = { gte: dateOnlyToDb(period.start), lte: dateOnlyToDb(period.end) };
  const from = startOfDayInTimezone(period.start, options.timeZone);
  const until = startOfDayInTimezone(addDays(period.end, 1), options.timeZone);
  const timeRange = { gte: from, lt: until };

  const [sessions, rsvps, members, approved, parts, entries, meetingUpdates] = await Promise.all([
    prisma.attendanceSession.findMany({
      where: { date: dateRange },
      select: {
        id: true,
        date: true,
        kind: true,
        note: true,
        openedBy: { select: { name: true } },
        records: { select: { userId: true, user: { select: reportPersonSelect } } },
      },
    }),
    prisma.attendanceRsvp.findMany({
      where: { date: dateRange },
      select: { userId: true, date: true, regular: true, flex: true, user: { select: { ...reportPersonSelect, status: true } } },
    }),
    // The team as it is now, minus people who joined after these two weeks.
    prisma.user.findMany({ where: { ...teamMembersWhere, createdAt: { lt: until } }, select: reportPersonSelect, take: 1000 }),
    prisma.taskAssignment.findMany({
      where: { status: "APPROVED", reviewedAt: timeRange },
      select: { user: { select: { name: true } }, task: { select: { id: true, title: true, subteam: true } } },
      orderBy: [{ reviewedAt: "asc" }],
      take: 2000,
    }),
    prisma.part.findMany({
      where: { status: "DONE", doneAt: timeRange },
      select: { id: true, name: true, quantity: true, doneAt: true, claimedBy: { select: { name: true } } },
      orderBy: { doneAt: "asc" },
      take: REPORT_LIST_MAX,
    }),
    prisma.notebookEntry.findMany({
      where: { createdAt: timeRange },
      select: {
        id: true,
        title: true,
        createdAt: true,
        author: { select: { name: true } },
        page: { select: { title: true, notebook: { select: { title: true } } } },
      },
      orderBy: { createdAt: "asc" },
      take: REPORT_LIST_MAX,
    }),
    getMeetingUpdatesBetween(period.start, period.end),
  ]);

  // The team, plus anyone else who came or answered (adults, people who left since).
  type ReportPerson = (typeof members)[number];
  const people = new Map<string, ReportPerson>(members.map((m) => [m.id, m]));
  for (const s of sessions) for (const r of s.records) if (!people.has(r.user.id)) people.set(r.user.id, r.user);
  for (const r of rsvps) {
    if (people.has(r.userId)) continue;
    const said = saidYesFor("REGULAR", r) || saidYesFor("FLEX", r);
    if (said && r.user.status === "ACTIVE") people.set(r.userId, r.user);
  }
  // "Said yes" counts people still on the team, or who came (like the live screen): not accounts disabled since.
  const came = new Set(sessions.flatMap((s) => s.records.map((r) => `${r.userId}|${dbToDateOnly(s.date)}`)));
  const countedRsvps = rsvps.filter((r) => r.user.status === "ACTIVE" || came.has(`${r.userId}|${dbToDateOnly(r.date)}`));

  const data = buildReport({
    sessions: sessions.map((s) => ({
      id: s.id,
      date: dbToDateOnly(s.date),
      kind: s.kind,
      openedByName: s.openedBy?.name ?? null,
      note: s.note,
    })),
    records: sessions.flatMap((s) => s.records.map((r) => ({ sessionId: s.id, userId: r.userId }))),
    rsvps: countedRsvps.map((r) => ({ userId: r.userId, date: dbToDateOnly(r.date), regular: r.regular, flex: r.flex })),
    people: [...people.values()].map(({ id, name, subteam, createdAt }) => ({
      id,
      name,
      subteam,
      since: todayInTimezone(options.timeZone, createdAt),
    })),
  });

  const tasks = new Map<string, DoneTask>();
  for (const a of approved) {
    const t = tasks.get(a.task.id) ?? { id: a.task.id, title: a.task.title, subteam: a.task.subteam, people: [] };
    t.people.push(a.user.name);
    tasks.set(a.task.id, t);
  }

  return {
    period,
    current: index === currentIndex,
    hasNewer: index < currentIndex,
    hasOlder: index > first,
    data,
    tasks: [...tasks.values()].slice(0, REPORT_LIST_MAX),
    parts: parts.map((p) => ({ id: p.id, name: p.name, quantity: p.quantity, madeBy: p.claimedBy?.name ?? null, doneAt: p.doneAt as Date })),
    notebook: entries.map((e) => ({
      id: e.id,
      title: e.title,
      notebook: e.page.notebook.title,
      page: e.page.title,
      author: e.author?.name ?? null,
      createdAt: e.createdAt,
    })),
    meetingUpdates,
  };
}
