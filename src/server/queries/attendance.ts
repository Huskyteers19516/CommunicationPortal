import "server-only";
import QRCode from "qrcode";
import type { Prisma } from "@/generated/prisma/client";
import type { AttendanceCreditKind, AttendanceKind, CheckInMethod, Role, RsvpAnswer, Subteam } from "@/generated/prisma/enums";
import {
  type AttendanceSettings,
  addCredit,
  cameWith,
  type CreditOptionId,
  creditOptionOf,
  emptyWeekCredit,
  extraMeetingsOn,
  firstReportIndex,
  isFlexDay,
  isRegularDay,
  isTeamDay,
  type ReportPeriod,
  reportPeriodByIndex,
  reportPeriodFor,
  reportPeriodsBetween,
  type SavedAttendanceSettings,
  upcomingTeamDays,
  type WeekCredit,
  weekOf,
} from "@/lib/attendance";
import { LIMITS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb, daysBetween, dbToDateOnly, todayInTimezone } from "@/lib/dates";
import type { Actor } from "../actor";
import { currentCodes, parseQrToken, verifyQrToken } from "../attendance/codes";
import type { AttendanceChangeRow } from "../attendance/changes";
import { findNoShows, type NoShow } from "../attendance/no-shows";
import { buildReport, type ReportData, saidYesFor, startOfDayInTimezone } from "../attendance/report";
import { prisma } from "../db";
import { canFixAttendance, canGiveExtraCredit, canPlanAttendance, canRunAttendance, canViewAttendanceChanges } from "../permissions";
import { canEditSessionOn, untouchedByHand } from "../services/attendance";
import { attendanceChangeRows, changeRowSelect } from "./attendance-changes";
import { type ExtraMeeting, getAttendanceSchedule, getSavedAttendanceSettings } from "./attendance-settings";

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

// ---------- credits and the weekly target ----------

/** How much a check-in counts (see CREDIT_OPTIONS in src/lib/attendance.ts). */
export interface CreditInfo {
  /** In sixths (0 = "No credit": on the sheet, counted as not there). */
  credit: number;
  creditKind: AttendanceCreditKind;
  /** The option it matches (null for a value no option has). */
  option: CreditOptionId | null;
  /** Scanned, typed the code, or added by hand (then only admins change it). */
  method: CheckInMethod;
  /** An admin changed it (then the attendee can't change it themselves). */
  changedByName: string | null;
  changedAt: Date | null;
  /**
   * Added by hand and nobody changed it since: scanning in while it's open makes it a real check-in (1 / 1 Flex).
   * A hand entry an admin changed later stays as they set it (No credit can't be scanned over).
   */
  untouchedByHand: boolean;
}

const creditSelect = {
  method: true,
  checkedInAt: true,
  credit: true,
  creditKind: true,
  creditChangedAt: true,
  creditChangedBy: { select: { name: true } },
} as const;

function creditInfo(r: {
  method: CheckInMethod;
  checkedInAt: Date;
  credit: number;
  creditKind: AttendanceCreditKind;
  creditChangedAt: Date | null;
  creditChangedBy: { name: string } | null;
}): CreditInfo {
  return {
    credit: r.credit,
    creditKind: r.creditKind,
    option: creditOptionOf(r.credit, r.creditKind),
    method: r.method,
    // Someone changed it even if their account is gone since.
    changedByName: r.creditChangedAt ? (r.creditChangedBy?.name ?? "someone") : null,
    changedAt: r.creditChangedAt,
    untouchedByHand: untouchedByHand(r),
  };
}

/** Checked in myself: a scan or the typed code that counts (not No credit, not someone adding me by hand). */
function checkedInMyself(r: { method: CheckInMethod; credit: number }): boolean {
  return r.method !== "MANUAL" && cameWith(r);
}

export interface WeekTotal {
  start: DateOnly;
  end: DateOnly;
  credit: WeekCredit;
}

/** Everyone's credits in one Monday–Sunday week (sessions dated in it, every kind), by person. */
async function weekCredits(userIds: string[], week: { start: DateOnly; end: DateOnly }): Promise<Map<string, WeekCredit>> {
  const out = new Map<string, WeekCredit>();
  if (userIds.length === 0) return out;
  const rows = await prisma.attendanceRecord.findMany({
    where: { userId: { in: userIds }, session: { date: { gte: dateOnlyToDb(week.start), lte: dateOnlyToDb(week.end) } } },
    select: { userId: true, credit: true, creditKind: true },
  });
  for (const r of rows) out.set(r.userId, addCredit(out.get(r.userId) ?? emptyWeekCredit(), r));
  return out;
}

export interface MyWeeks {
  target: number;
  thisWeek: WeekTotal;
  lastWeek: WeekTotal;
}

/**
 * My credits this week and last week (Mon–Sun, by the team-timezone day of each session) toward the weekly target.
 * Null for mentors and teachers (the target is for students).
 */
export async function getMyWeeks(actor: ActorLike, today: DateOnly, target: number): Promise<MyWeeks | null> {
  if (ADULT_ROLES.includes(actor.role)) return null;
  const thisWeek = weekOf(today);
  const lastWeek = weekOf(addDays(thisWeek.start, -7));
  const rows = await prisma.attendanceRecord.findMany({
    where: { userId: actor.id, session: { date: { gte: dateOnlyToDb(lastWeek.start), lte: dateOnlyToDb(thisWeek.end) } } },
    select: { credit: true, creditKind: true, session: { select: { date: true } } },
  });
  const now = emptyWeekCredit();
  const before = emptyWeekCredit();
  for (const r of rows) addCredit(dbToDateOnly(r.session.date) >= thisWeek.start ? now : before, r);
  return { target, thisWeek: { ...thisWeek, credit: now }, lastWeek: { ...lastWeek, credit: before } };
}

// ---------- "Coming?" (everyone) ----------

/** An extra meeting on a day (a Team calendar event of the kind MEETING), for its "Extra meeting" badge. */
export interface ExtraMeetingRef {
  id: string;
  title: string;
}

/** The extra meetings on `day`, as badges show them. */
function extraMeetingRefs(meetings: ExtraMeeting[], day: DateOnly): ExtraMeetingRef[] {
  return extraMeetingsOn(meetings, day).map((m) => ({ id: m.id, title: m.title }));
}

export interface RsvpDay {
  date: DateOnly;
  regularDay: boolean;
  flexDay: boolean;
  /** Extra meetings that day (it's a regular day because of them, or has one on top of regular practice). */
  extraMeetings: ExtraMeetingRef[];
  regular: RsvpAnswer | null;
  flex: RsvpAnswer | null;
  note: string;
  plan: string;
}

async function rsvpDays(actor: ActorLike, settings: AttendanceSettings, extraMeetings: ExtraMeeting[], days: DateOnly[]): Promise<RsvpDay[]> {
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
      extraMeetings: extraMeetingRefs(extraMeetings, date),
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
  /**
   * I checked in myself, with credit. Not when an admin put me on the list by hand or marked me "No credit": then I
   * can still scan in while it's open.
   */
  checkedIn: boolean;
  /** How much my record counts (null when I'm not on its list; credit 0 = an admin marked me as not here). */
  myCredit: CreditInfo | null;
  /** Admins only (null for everyone else): how many checked in ("No credit" left out). */
  count: number | null;
  openedByName: string | null;
}

/** Records that count as "came" (anything but No credit). */
const cameWhere = { credit: { gt: 0 } } satisfies Prisma.AttendanceRecordWhereInput;

async function todaySessions(actor: ActorLike, today: DateOnly): Promise<TodaySession[]> {
  const admin = canFixAttendance(actor);
  const rows = await prisma.attendanceSession.findMany({
    where: { date: dateOnlyToDb(today) },
    select: {
      id: true,
      kind: true,
      closedAt: true,
      openedBy: { select: { name: true } },
      _count: { select: { records: { where: cameWhere } } },
      records: { where: { userId: actor.id }, select: { id: true, ...creditSelect } },
    },
    orderBy: { kind: "asc" },
  });
  return rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    open: s.closedAt === null,
    checkedIn: s.records.some(checkedInMyself),
    myCredit: s.records[0] ? creditInfo(s.records[0]) : null,
    count: admin ? s._count.records : null,
    openedByName: admin ? (s.openedBy?.name ?? null) : null,
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
export async function getMySummary(actor: ActorLike, settings: SavedAttendanceSettings, today: DateOnly, timeZone: string): Promise<MySummary> {
  const period = reportPeriodFor(settings, today);
  const seasonStarted = settings.reportStart <= today;
  const from = seasonStarted && settings.reportStart < period.start ? settings.reportStart : period.start;
  const [sessions, me] = await Promise.all([
    prisma.attendanceSession.findMany({
      where: { date: { gte: dateOnlyToDb(from), lte: dateOnlyToDb(today) } },
      select: { date: true, kind: true, records: { where: { userId: actor.id, ...cameWhere }, select: { id: true } } },
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
  credit: number;
  creditKind: AttendanceCreditKind;
}

/** A past session on the admins' card (to fix its list, credits, or "What we did" afterwards). */
export interface RecentSession {
  id: string;
  date: DateOnly;
  kind: AttendanceKind;
  count: number;
  hasNote: boolean;
  /** Never closed (the runner forgot): closing it sends the no-show list. */
  open: boolean;
}

export interface AttendanceHome {
  settings: AttendanceSettings;
  today: DateOnly;
  canRun: boolean;
  canPlan: boolean;
  /** Admins: open any session to fix who was there and their credits. */
  canFix: boolean;
  /** Admins: the change log (/attendance/changes). */
  canViewChanges: boolean;
  days: RsvpDay[];
  sessions: TodaySession[];
  /** Admins: the last few sessions before today (empty for everyone else). */
  recentSessions: RecentSession[];
  summary: MySummary;
  /** This week and last week toward the weekly target (null for mentors and teachers). */
  weeks: MyWeeks | null;
  history: HistoryItem[];
}

const RECENT_SESSIONS = 5;

/** /attendance: my "Coming?" answers for the next team days, today's sessions, and my attendance. */
export async function getAttendanceHome(actor: ActorLike, today: DateOnly, timeZone: string): Promise<AttendanceHome> {
  const { settings, extraMeetings } = await getAttendanceSchedule(today);
  const canRun = canRunAttendance(actor);
  const canFix = canFixAttendance(actor);
  const [days, sessions, summary, weeks, history, recent] = await Promise.all([
    rsvpDays(actor, settings, extraMeetings, upcomingTeamDays(settings, today, LIMITS.rsvpDaysAhead)),
    todaySessions(actor, today),
    getMySummary(actor, settings, today, timeZone),
    getMyWeeks(actor, today, settings.weeklyTarget),
    prisma.attendanceRecord.findMany({
      where: { userId: actor.id },
      orderBy: { checkedInAt: "desc" },
      take: 10,
      select: { method: true, checkedInAt: true, credit: true, creditKind: true, session: { select: { date: true, kind: true } } },
    }),
    canFix
      ? prisma.attendanceSession.findMany({
          where: { date: { lt: dateOnlyToDb(today) } },
          orderBy: [{ date: "desc" }, { kind: "asc" }],
          take: RECENT_SESSIONS,
          select: { id: true, date: true, kind: true, note: true, closedAt: true, _count: { select: { records: { where: cameWhere } } } },
        })
      : [],
  ]);
  return {
    settings,
    today,
    canRun,
    canPlan: canPlanAttendance(actor),
    canFix,
    canViewChanges: canViewAttendanceChanges(actor),
    days,
    sessions,
    recentSessions: recent.map((r) => ({
      id: r.id,
      date: dbToDateOnly(r.date),
      kind: r.kind,
      count: r._count.records,
      hasNote: r.note.trim() !== "",
      open: r.closedAt === null,
    })),
    summary,
    weeks,
    history: history.map((h) => ({
      date: dbToDateOnly(h.session.date),
      kind: h.session.kind,
      method: h.method,
      checkedInAt: h.checkedInAt,
      credit: h.credit,
      creditKind: h.creditKind,
    })),
  };
}

export interface TodayAttendance {
  /** Today's "Coming?" answers (null when today isn't a team day). */
  day: RsvpDay | null;
  /** Today's open sessions and whether I'm on each. */
  openSessions: TodaySession[];
  checkedInKinds: AttendanceKind[];
  /** Today's sessions I'm checked in to (open or closed), with how much each counts. */
  checkedInSessions: TodaySession[];
  /** Today's sessions I'm on the list of (checked in, or marked "No credit" by an admin). */
  creditSessions: TodaySession[];
  /** This week toward the weekly target (null for mentors and teachers). */
  week: (WeekTotal & { target: number }) | null;
  /** Runners get a "Show code" link back to an open session's live screen. */
  canRun: boolean;
  /** Staff, in the first days of a new two-week period: the report for the one that just ended. */
  reportReady: ReportPeriod | null;
}

/** How many days into a new two-week period the Today card points staff to the finished report. */
export const REPORT_READY_DAYS = 3;

/** The two weeks that just ended, when today is in the first days of a new period and attendance was taken in it. */
async function finishedReport(actor: ActorLike, settings: SavedAttendanceSettings, today: DateOnly): Promise<ReportPeriod | null> {
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
  const { settings, extraMeetings } = await getAttendanceSchedule(today);
  const teamDay = isTeamDay(settings, today);
  const [days, sessions, reportReady] = await Promise.all([
    rsvpDays(actor, settings, extraMeetings, teamDay ? [today] : []),
    todaySessions(actor, today),
    finishedReport(actor, settings, today),
  ]);
  const openSessions = sessions.filter((s) => s.open);
  const checkedInSessions = sessions.filter((s) => s.checkedIn);
  const creditSessions = sessions.filter((s) => s.myCredit !== null);
  const checkedInKinds = checkedInSessions.map((s) => s.kind);
  if (!teamDay && openSessions.length === 0 && creditSessions.length === 0 && !reportReady) return null;
  const weeks = await getMyWeeks(actor, today, settings.weeklyTarget);
  return {
    day: days[0] ?? null,
    openSessions,
    checkedInKinds,
    checkedInSessions,
    creditSessions,
    week: weeks ? { ...weeks.thisWeek, target: weeks.target } : null,
    canRun: canRunAttendance(actor),
    reportReady,
  };
}

// ---------- scan landing (read-only) ----------

export interface ScanSession {
  id: string;
  kind: AttendanceKind;
  date: DateOnly;
  open: boolean;
  /** Checked in myself, with credit (not No credit, not added by hand). */
  checkedIn: boolean;
  /** How much my record counts (null when I'm not on its list). */
  myCredit: CreditInfo | null;
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
      records: { where: { userId: actor.id }, select: { id: true, ...creditSelect } },
    },
  });
  if (!s) return { status: "invalid" };
  const verdict = verifyQrToken(parsed, s.secret, options.now);
  if (verdict === "invalid") return { status: "invalid" };
  const date = dbToDateOnly(s.date);
  return {
    status: verdict,
    session: {
      id: s.id,
      kind: s.kind,
      date,
      open: s.closedAt === null,
      checkedIn: s.records.some(checkedInMyself),
      myCredit: s.records[0] ? creditInfo(s.records[0]) : null,
    },
    isToday: date === options.today,
  };
}

// ---------- a session's page (admins) ----------

export interface RosterEntry extends Person {
  method: CheckInMethod;
  checkedInAt: Date;
  markedByName: string | null;
  /** How much this check-in counts, and who changed it. */
  credit: CreditInfo;
  /** Their credits in this session's week (every session that week, this one included). */
  week: WeekCredit;
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
  /** Everyone on the list, newest first ("No credit" ones included: credit 0). */
  roster: RosterEntry[];
  /** How many are on the list with credit ("No credit" left out). */
  count: number;
  /** How many scanned in or typed the code (with credit): what the room's headcount should match. */
  scannedCount: number;
  /** How many were added by hand with credit (part credit, EC). */
  handCount: number;
  /**
   * Said they'd come (Regular: Yes / Half; Flex: Yes) and aren't on the list yet: the "not checked in" block with quick
   * actions (src/server/attendance/no-shows.ts).
   */
  noShows: NoShow[];
  /** Everyone who said they'd come, checked in or not. */
  saidYesCount: number;
  /** ACTIVE people not on the list yet (for adding by hand). */
  others: Person[];
  /** Runners: start / close / reopen, the QR code, "What we did", delete. Other admins fix people and credits. */
  canRun: boolean;
  /** "What we did": runners (older than ATTENDANCE_EDIT_DAYS: teachers, mentors, owners). */
  canEditNote: boolean;
  /** Whether it can be deleted (started by mistake): a runner, today's or nobody checked in to it themselves. */
  canDelete: boolean;
  /** EC ("1/2 EC", "1 EC") in this admin's menus. */
  canGiveExtraCredit: boolean;
  /** The change log for this session, newest first. */
  history: AttendanceChangeRow[];
  /** The week this session is in (Mon–Sun) and the weekly target, for each person's "1 2/3 / 2". */
  week: { start: DateOnly; end: DateOnly };
  weeklyTarget: number;
}

/** How many change-log rows a session's page shows. */
export const SESSION_HISTORY_MAX = 50;

/**
 * A session's page: the live screen while it's open, and where admins fix a session afterwards. Null when it
 * doesn't exist or the actor doesn't have admin access (canFixAttendance).
 */
export async function getRunnerSession(actor: ActorLike, sessionId: string, today: DateOnly): Promise<RunnerSession | null> {
  if (!canFixAttendance(actor)) return null;
  const s = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      date: true,
      kind: true,
      closedAt: true,
      openedAt: true,
      note: true,
      openedById: true,
      openedBy: { select: { name: true } },
      records: {
        orderBy: { checkedInAt: "desc" },
        select: { user: { select: personSelect }, markedBy: { select: { name: true } }, ...creditSelect },
      },
    },
  });
  if (!s) return null;
  const date = dbToDateOnly(s.date);
  const canRun = canRunAttendance(actor);
  const canEditNote = canRun && canEditSessionOn(actor, date, today);
  const selfCheckIns = s.records.filter((r) => r.method !== "MANUAL").length;
  const week = weekOf(date);
  const [saidYes, noShows, active, saved, weeks, history] = await Promise.all([
    prisma.attendanceRsvp.findMany({
      where: { date: s.date, ...(s.kind === "REGULAR" ? { regular: { in: ["YES", "HALF"] } } : { flex: "YES" }) },
      select: { userId: true, user: { select: { status: true } } },
    }),
    findNoShows(prisma, [s]),
    prisma.user.findMany({ where: { status: "ACTIVE" }, select: personSelect, orderBy: { name: "asc" }, take: 1000 }),
    getSavedAttendanceSettings(),
    weekCredits(
      s.records.map((r) => r.user.id),
      week,
    ),
    prisma.attendanceChange.findMany({
      where: { sessionId: s.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SESSION_HISTORY_MAX,
      select: changeRowSelect,
    }),
  ]);
  const here = new Set(s.records.map((r) => r.user.id));
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
    roster: s.records.map((r) => ({
      ...r.user,
      method: r.method,
      checkedInAt: r.checkedInAt,
      markedByName: r.markedBy?.name ?? null,
      credit: creditInfo(r),
      week: weeks.get(r.user.id) ?? emptyWeekCredit(),
    })),
    count: s.records.filter(cameWith).length,
    scannedCount: s.records.filter((r) => r.method !== "MANUAL" && cameWith(r)).length,
    handCount: s.records.filter((r) => r.method === "MANUAL" && cameWith(r)).length,
    noShows: noShows.get(s.id) ?? [],
    saidYesCount: saidYes.filter((r) => r.user.status === "ACTIVE" || here.has(r.userId)).length,
    others: active.filter((p) => !here.has(p.id)),
    canRun,
    canEditNote,
    canDelete: canEditNote && (date === today || selfCheckIns === 0),
    canGiveExtraCredit: canGiveExtraCredit(actor),
    history: attendanceChangeRows(history),
    week,
    weeklyTarget: saved.weeklyTarget,
  };
}

// ---------- no-shows on Today (admins) ----------

export interface TodayNoShows {
  /** Every session today, each with who said they'd come and isn't on the list (often nobody). */
  sessions: { id: string; kind: AttendanceKind; open: boolean; people: NoShow[] }[];
  /** Anyone missing at all (the Today card shows nothing otherwise). */
  anyMissing: boolean;
  canGiveExtraCredit: boolean;
}

/**
 * Today's sessions with the people who said they'd come but aren't on the list (admins only), for the Today page.
 * Null when the actor isn't an admin or there's no session today.
 */
export async function getTodayNoShows(actor: ActorLike, today: DateOnly): Promise<TodayNoShows | null> {
  if (!canFixAttendance(actor)) return null;
  const sessions = await prisma.attendanceSession.findMany({
    where: { date: dateOnlyToDb(today) },
    select: { id: true, date: true, kind: true, closedAt: true, openedById: true },
    orderBy: { kind: "asc" },
  });
  if (sessions.length === 0) return null;
  const noShows = await findNoShows(prisma, sessions);
  const list = sessions.map((s) => ({ id: s.id, kind: s.kind, open: s.closedAt === null, people: noShows.get(s.id) ?? [] }));
  return { sessions: list, anyMissing: list.some((s) => s.people.length > 0), canGiveExtraCredit: canGiveExtraCredit(actor) };
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
  /** Extra meetings that day (Team calendar). */
  extraMeetings: ExtraMeetingRef[];
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
  /** Their credits so far in the selected day's week (Mon–Sun). */
  week: WeekCredit;
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
  /** The selected day's week (Mon–Sun) and the weekly target, for each person's "1 / 2 so far". */
  week: { start: DateOnly; end: DateOnly } | null;
  weeklyTarget: number;
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * /attendance/plan: the next team days with how many are coming, and one day in detail (Regular Yes / Half /
 * No / No answer; Flex Yes / No / No answer; notes; the plan). Null when the actor can't plan.
 */
export async function getComingOverview(actor: ActorLike, today: DateOnly, wanted?: string): Promise<ComingOverview | null> {
  if (!canPlanAttendance(actor)) return null;
  const { settings, extraMeetings } = await getAttendanceSchedule(today);
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
      extraMeetings: extraMeetingRefs(extraMeetings, date),
      yes: regularDay ? mine.filter((r) => r.regular === "YES").length : 0,
      half: regularDay ? mine.filter((r) => r.regular === "HALF").length : 0,
      no: regularDay ? mine.filter((r) => r.regular === "NO").length : 0,
      flexYes: flexDay ? mine.filter((r) => r.flex === "YES").length : 0,
      answered: mine.filter((r) => (regularDay && r.regular !== null) || (flexDay && r.flex !== null)).length,
      hasPlan: !!planBy.get(date)?.plan,
    };
  });
  if (!selectedDay) return { today, days, selected: null, week: null, weeklyTarget: settings.weeklyTarget };

  const counts = days.find((d) => d.date === selectedDay) as DayCounts;
  const answers = rsvps.filter((r) => dbToDateOnly(r.date) === selectedDay);
  const answerBy = new Map(answers.map((r) => [r.user.id, r]));
  const everyone = [...members];
  for (const r of answers) if (!everyone.some((m) => m.id === r.user.id)) everyone.push(r.user); // adults who answered
  everyone.sort(byName);
  const week = weekOf(selectedDay);
  const weeks = await weekCredits(
    everyone.map((p) => p.id),
    week,
  );
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
    const person = { ...p, note: r?.note ?? "", week: weeks.get(p.id) ?? emptyWeekCredit() };
    if (counts.regularDay) {
      if (r?.regular) selected.regular[r.regular].push(person);
      else if (!isAdult(p)) selected.regular.NONE.push(person);
    }
    if (counts.flexDay) {
      if (r?.flex === "YES" || r?.flex === "NO") selected.flex[r.flex].push(person);
      else if (!isAdult(p)) selected.flex.NONE.push(person);
    }
  }
  return { today, days, selected, week, weeklyTarget: settings.weeklyTarget };
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
async function reportRange(settings: SavedAttendanceSettings, today: DateOnly): Promise<{ first: number; current: number }> {
  const current = reportPeriodFor(settings, today).index;
  const earliest = await prisma.attendanceSession.findFirst({ orderBy: { date: "asc" }, select: { date: true } });
  return { first: firstReportIndex(settings, earliest ? dbToDateOnly(earliest.date) : null, current), current };
}

/** Two-week periods from the first one to the current one (current first), with how many sessions each had. */
export async function listReports(actor: ActorLike, today: DateOnly): Promise<{ settings: SavedAttendanceSettings; periods: ReportListItem[] } | null> {
  if (!canPlanAttendance(actor)) return null;
  // Reports go by the sessions held and `reportStart`, so extra meetings aren't loaded.
  const settings = await getSavedAttendanceSettings();
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
  /** "Changes by admins" to attendance in these two weeks (by the attendance's day), newest first; null = not shown. */
  changes: { rows: AttendanceChangeRow[]; total: number } | null;
}

const REPORT_LIST_MAX = 300;
/** How many admin changes the report lists (the rest are on /attendance/changes). */
export const REPORT_CHANGES_MAX = 100;

/**
 * One two-week period: every session (run by, present vs said yes, "What we did"), each person's attendance,
 * and what got done (checklist items approved, parts made, notebook entries written) during it.
 * Null when the actor can't read reports or the period is before the first / after the current one.
 */
export async function getAttendanceReport(
  actor: ActorLike,
  index: number,
  options: { today: DateOnly; timeZone: string; /** How many admin changes to load (the CSV takes more). */ changesMax?: number },
): Promise<AttendanceReport | null> {
  if (!canPlanAttendance(actor)) return null;
  const settings = await getSavedAttendanceSettings();
  const { first, current: currentIndex } = await reportRange(settings, options.today);
  if (!Number.isSafeInteger(index) || index < first || index > currentIndex) return null;
  const period = reportPeriodByIndex(settings, index);
  const dateRange = { gte: dateOnlyToDb(period.start), lte: dateOnlyToDb(period.end) };
  const from = startOfDayInTimezone(period.start, options.timeZone);
  const until = startOfDayInTimezone(addDays(period.end, 1), options.timeZone);
  const timeRange = { gte: from, lt: until };

  const showChanges = canViewAttendanceChanges(actor);
  const [sessions, rsvps, members, approved, parts, entries, changes, changeCount] = await Promise.all([
    prisma.attendanceSession.findMany({
      where: { date: dateRange },
      select: {
        id: true,
        date: true,
        kind: true,
        note: true,
        openedBy: { select: { name: true } },
        records: { select: { userId: true, credit: true, creditKind: true, user: { select: reportPersonSelect } } },
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
    showChanges
      ? prisma.attendanceChange.findMany({
          where: { sessionDate: dateRange },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: options.changesMax ?? REPORT_CHANGES_MAX,
          select: changeRowSelect,
        })
      : [],
    showChanges ? prisma.attendanceChange.count({ where: { sessionDate: dateRange } }) : 0,
  ]);

  // The team, plus anyone else who came or answered (adults, people who left since). "No credit" isn't coming.
  type ReportPerson = (typeof members)[number];
  const people = new Map<string, ReportPerson>(members.map((m) => [m.id, m]));
  for (const s of sessions) for (const r of s.records) if (cameWith(r) && !people.has(r.user.id)) people.set(r.user.id, r.user);
  for (const r of rsvps) {
    if (people.has(r.userId)) continue;
    const said = saidYesFor("REGULAR", r) || saidYesFor("FLEX", r);
    if (said && r.user.status === "ACTIVE") people.set(r.userId, r.user);
  }
  // "Said yes" counts people still on the team, or who came (like the live screen): not accounts disabled since.
  const came = new Set(sessions.flatMap((s) => s.records.filter(cameWith).map((r) => `${r.userId}|${dbToDateOnly(s.date)}`)));
  const countedRsvps = rsvps.filter((r) => r.user.status === "ACTIVE" || came.has(`${r.userId}|${dbToDateOnly(r.date)}`));

  const data = buildReport({
    sessions: sessions.map((s) => ({
      id: s.id,
      date: dbToDateOnly(s.date),
      kind: s.kind,
      openedByName: s.openedBy?.name ?? null,
      note: s.note,
    })),
    records: sessions.flatMap((s) => s.records.map((r) => ({ sessionId: s.id, userId: r.userId, credit: r.credit, creditKind: r.creditKind }))),
    rsvps: countedRsvps.map((r) => ({ userId: r.userId, date: dbToDateOnly(r.date), regular: r.regular, flex: r.flex })),
    people: [...people.values()].map(({ id, name, subteam, createdAt }) => ({
      id,
      name,
      subteam,
      since: todayInTimezone(options.timeZone, createdAt),
    })),
    period,
    weeklyTarget: settings.weeklyTarget,
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
    changes: showChanges ? { rows: attendanceChangeRows(changes), total: changeCount } : null,
  };
}
