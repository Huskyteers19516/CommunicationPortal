// Two-week attendance report math and CSV (pure, so tests cover it without a database).
import type { AttendanceCreditKind, AttendanceKind, RsvpAnswer, Subteam } from "@/generated/prisma/enums";
import {
  addCredit,
  ATTENDANCE_KIND_LABELS,
  CREDIT_SIXTHS,
  DEFAULT_ATTENDANCE_SETTINGS,
  emptyWeekCredit,
  metWeeklyTarget,
  sixthsToDecimal,
  type WeekCredit,
} from "@/lib/attendance";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { addDays, type DateOnly, dateOnlyToDb } from "@/lib/dates";

// ---------- time ----------

/** Offset of `timeZone` from UTC at `instant`, in ms (e.g. -7 h for Pacific daylight time). */
function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The moment a calendar day starts in `timeZone` (midnight there), for filtering timestamps by team day. */
export function startOfDayInTimezone(day: DateOnly, timeZone: string): Date {
  const midnightUtc = dateOnlyToDb(day).getTime();
  let t = midnightUtc - timezoneOffsetMs(new Date(midnightUtc), timeZone);
  // Once more with the offset at that moment (daylight-saving changes).
  t = midnightUtc - timezoneOffsetMs(new Date(t), timeZone);
  return new Date(t);
}

// ---------- report ----------

export interface ReportSessionInput {
  id: string;
  date: DateOnly;
  kind: AttendanceKind;
  openedByName: string | null;
  note: string;
}

export interface ReportPersonInput {
  id: string;
  name: string;
  subteam: Subteam | null;
  /**
   * The day they joined (their account's creation, team timezone). Sessions before it don't count as held for
   * them (unless they came). Missing = count every session.
   */
  since?: DateOnly;
}

export interface ReportInput {
  sessions: ReportSessionInput[];
  /**
   * Check-ins, with how much each counts (in sixths; missing = 1 regular). Credit 0 ("No credit": an admin put them
   * on the sheet as not there) counts as not coming.
   */
  records: { sessionId: string; userId: string; credit?: number; creditKind?: AttendanceCreditKind }[];
  rsvps: { userId: string; date: DateOnly; regular: RsvpAnswer | null; flex: RsvpAnswer | null }[];
  /** Everyone the per-person table lists (the team, plus anyone else who came). */
  people: ReportPersonInput[];
  /**
   * The two weeks (a period starts on a Monday, so each is Mon–Sun): each person's credits per week. Missing = no
   * weekly columns.
   */
  period?: { start: DateOnly; end: DateOnly };
  /** Times a week each person should come (settings.weeklyTarget). */
  weeklyTarget?: number;
}

export interface ReportSessionRow extends ReportSessionInput {
  present: number;
  /** People who said they'd come (Regular: Yes or Half; Flex: Yes). */
  saidYes: number;
}

export interface Tally {
  attended: number;
  held: number;
}

export interface ReportPersonRow extends ReportPersonInput {
  regular: Tally;
  flex: Tally;
  /** Credits in week 1 and week 2 of the period (empty without a period). */
  weeks: WeekCredit[];
  /** Sessions they said they'd come to but didn't check in. */
  saidYesMissed: number;
  /** Sessions they came to without having answered "Coming?" for it. */
  cameUnanswered: number;
}

export interface ReportWeek {
  start: DateOnly;
  end: DateOnly;
}

export interface ReportData {
  sessions: ReportSessionRow[];
  people: ReportPersonRow[];
  held: { regular: number; flex: number };
  /** Week 1 and week 2 of the period (empty without a period). */
  weeks: ReportWeek[];
  weeklyTarget: number;
}

/** A 14-day period's two Monday–Sunday weeks. */
export function periodWeeks(period: { start: DateOnly; end: DateOnly }): ReportWeek[] {
  return [
    { start: period.start, end: addDays(period.start, 6) },
    { start: addDays(period.start, 7), end: period.end },
  ];
}

/** Did this answer say "I'm coming" for a session of this kind? */
export function saidYesFor(kind: AttendanceKind, rsvp: { regular: RsvpAnswer | null; flex: RsvpAnswer | null } | undefined): boolean {
  if (!rsvp) return false;
  return kind === "REGULAR" ? rsvp.regular === "YES" || rsvp.regular === "HALF" : rsvp.flex === "YES";
}

function answered(kind: AttendanceKind, rsvp: { regular: RsvpAnswer | null; flex: RsvpAnswer | null } | undefined): boolean {
  if (!rsvp) return false;
  return (kind === "REGULAR" ? rsvp.regular : rsvp.flex) !== null;
}

export function buildReport(input: ReportInput): ReportData {
  const rsvpByKey = new Map(input.rsvps.map((r) => [`${r.userId}|${r.date}`, r]));
  // "No credit" (0) is on the sheet but didn't come.
  const came = input.records.filter((r) => (r.credit ?? CREDIT_SIXTHS) > 0);
  const present = new Set(came.map((r) => `${r.sessionId}|${r.userId}`));
  const sessions = [...input.sessions].sort((a, b) => (a.date === b.date ? a.kind.localeCompare(b.kind) : a.date < b.date ? -1 : 1));

  const sessionRows: ReportSessionRow[] = sessions.map((s) => ({
    ...s,
    present: came.filter((r) => r.sessionId === s.id).length,
    saidYes: input.rsvps.filter((r) => r.date === s.date && saidYesFor(s.kind, r)).length,
  }));
  const held = {
    regular: sessions.filter((s) => s.kind === "REGULAR").length,
    flex: sessions.filter((s) => s.kind === "FLEX").length,
  };
  const weeks = input.period ? periodWeeks(input.period) : [];
  const dateOf = new Map(sessions.map((s) => [s.id, s.date]));
  const credits = new Map<string, WeekCredit[]>();
  for (const r of came) {
    const date = dateOf.get(r.sessionId);
    const w = date === undefined ? -1 : weeks.findIndex((x) => date >= x.start && date <= x.end);
    if (w < 0) continue;
    const mine = credits.get(r.userId) ?? weeks.map(() => emptyWeekCredit());
    addCredit(mine[w], { credit: r.credit ?? 6, creditKind: r.creditKind ?? "REGULAR" });
    credits.set(r.userId, mine);
  }

  const people: ReportPersonRow[] = input.people.map(({ since, ...p }) => {
    const row: ReportPersonRow = {
      ...p,
      regular: { attended: 0, held: 0 },
      flex: { attended: 0, held: 0 },
      weeks: credits.get(p.id) ?? weeks.map(() => emptyWeekCredit()),
      saidYesMissed: 0,
      cameUnanswered: 0,
    };
    for (const s of sessions) {
      const rsvp = rsvpByKey.get(`${p.id}|${s.date}`);
      const came = present.has(`${s.id}|${p.id}`);
      if (!came && since !== undefined && s.date < since) continue; // before they joined
      const tally = s.kind === "REGULAR" ? row.regular : row.flex;
      tally.held++;
      if (came) {
        tally.attended++;
        if (!answered(s.kind, rsvp)) row.cameUnanswered++;
      } else if (saidYesFor(s.kind, rsvp)) {
        row.saidYesMissed++;
      }
    }
    return row;
  });
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { sessions: sessionRows, people, held, weeks, weeklyTarget: input.weeklyTarget ?? DEFAULT_ATTENDANCE_SETTINGS.weeklyTarget };
}

// ---------- CSV ----------

/**
 * One CSV cell: quoted when it holds a comma, semicolon (the list separator in some Excel locales), quote, or
 * line break; a cell a spreadsheet would run as a formula (starting with = + - @, tab, or carriage return) gets
 * a leading ' so it stays text.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

/** "What got done" in the period, for the CSV (the same lists the report page shows). */
export interface ReportDoneCsv {
  tasks: { title: string; subteam: Subteam | null; people: string[] }[];
  parts: { name: string; quantity: number; madeBy: string | null }[];
  notebook: { title: string; notebook: string; page: string; author: string | null }[];
}

/**
 * The report as CSV: the per-person table (with each week's credits toward the weekly target when the report has
 * weeks), a blank line, the sessions, and (when given) what got done. CRLF line ends (Excel).
 */
export function reportCsv(report: ReportData, period: { start: DateOnly; end: DateOnly }, done?: ReportDoneCsv): string {
  // Credits as decimals (1/2 = 0.5, 2/3 = 0.67): a "1/2" cell would open as a date in Excel.
  const weekHeads = report.weeks.flatMap((w, i) => [
    `Week ${i + 1} (${w.start} to ${w.end})`,
    `Week ${i + 1} regular`,
    `Week ${i + 1} EC`,
    `Week ${i + 1} Flex`,
    `Week ${i + 1} met the target (${report.weeklyTarget})`,
  ]);
  const weekCells = (weeks: WeekCredit[]) =>
    weeks.flatMap((w) => [
      sixthsToDecimal(w.total),
      sixthsToDecimal(w.regular),
      sixthsToDecimal(w.extra),
      sixthsToDecimal(w.flex),
      metWeeklyTarget(w.total, report.weeklyTarget) ? "Yes" : "No",
    ]);
  const lines = [
    csvRow([`Attendance ${period.start} to ${period.end}`]),
    ...(report.weeks.length > 0 ? [csvRow([`Weekly target: ${report.weeklyTarget} (regular + EC + Flex)`])] : []),
    "",
    csvRow([
      "Name",
      "Subteam",
      ...weekHeads,
      "Regular attended",
      "Regular held",
      "Flex attended",
      "Flex held",
      "Said yes but didn't come",
      "Came without answering",
    ]),
    ...report.people.map((p) =>
      csvRow([
        p.name,
        p.subteam ? SUBTEAM_LABELS[p.subteam] : "",
        ...weekCells(p.weeks),
        p.regular.attended,
        p.regular.held,
        p.flex.attended,
        p.flex.held,
        p.saidYesMissed,
        p.cameUnanswered,
      ]),
    ),
    "",
    csvRow(["Date", "Kind", "Run by", "Came", "Said yes", "What we did"]),
    ...report.sessions.map((s) =>
      csvRow([s.date, ATTENDANCE_KIND_LABELS[s.kind], s.openedByName ?? "", s.present, s.saidYes, s.note]),
    ),
  ];
  if (done) {
    const subteam = (s: Subteam | null) => (s ? SUBTEAM_LABELS[s] : "Whole team");
    lines.push(
      "",
      csvRow(["What got done"]),
      csvRow(["Task approved", "Title", "Subteam", "People"]),
      ...done.tasks.map((t) => csvRow(["", t.title, subteam(t.subteam), t.people.join(", ")])),
      csvRow(["Part made", "Name", "Quantity", "Made by"]),
      ...done.parts.map((p) => csvRow(["", p.name, p.quantity, p.madeBy ?? ""])),
      csvRow(["Notebook entry", "Title", "Notebook", "Page", "Written by"]),
      ...done.notebook.map((e) => csvRow(["", e.title, e.notebook, e.page, e.author ?? ""])),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
