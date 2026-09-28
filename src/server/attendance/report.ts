// Two-week attendance report math and CSV (pure, so tests cover it without a database).
import type { AttendanceKind, RsvpAnswer, Subteam } from "@/generated/prisma/enums";
import { ATTENDANCE_KIND_LABELS } from "@/lib/attendance";
import { SUBTEAM_LABELS } from "@/lib/constants";
import { type DateOnly, dateOnlyToDb } from "@/lib/dates";

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
  records: { sessionId: string; userId: string }[];
  rsvps: { userId: string; date: DateOnly; regular: RsvpAnswer | null; flex: RsvpAnswer | null }[];
  /** Everyone the per-person table lists (the team, plus anyone else who came). */
  people: ReportPersonInput[];
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
  /** Sessions they said they'd come to but didn't check in. */
  saidYesMissed: number;
  /** Sessions they came to without having answered "Coming?" for it. */
  cameUnanswered: number;
}

export interface ReportData {
  sessions: ReportSessionRow[];
  people: ReportPersonRow[];
  held: { regular: number; flex: number };
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
  const present = new Set(input.records.map((r) => `${r.sessionId}|${r.userId}`));
  const sessions = [...input.sessions].sort((a, b) => (a.date === b.date ? a.kind.localeCompare(b.kind) : a.date < b.date ? -1 : 1));

  const sessionRows: ReportSessionRow[] = sessions.map((s) => ({
    ...s,
    present: input.records.filter((r) => r.sessionId === s.id).length,
    saidYes: input.rsvps.filter((r) => r.date === s.date && saidYesFor(s.kind, r)).length,
  }));
  const held = {
    regular: sessions.filter((s) => s.kind === "REGULAR").length,
    flex: sessions.filter((s) => s.kind === "FLEX").length,
  };

  const people: ReportPersonRow[] = input.people.map(({ since, ...p }) => {
    const row: ReportPersonRow = {
      ...p,
      regular: { attended: 0, held: 0 },
      flex: { attended: 0, held: 0 },
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
  return { sessions: sessionRows, people, held };
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
  meetingUpdates: { meetingDate: DateOnly; subteam: Subteam; authorName: string | null; body: string }[];
  tasks: { title: string; subteam: Subteam | null; people: string[] }[];
  parts: { name: string; quantity: number; madeBy: string | null }[];
  notebook: { title: string; notebook: string; page: string; author: string | null }[];
}

/**
 * The report as CSV: the per-person table, a blank line, the sessions, and (when given) what got done.
 * CRLF line ends (Excel).
 */
export function reportCsv(report: ReportData, period: { start: DateOnly; end: DateOnly }, done?: ReportDoneCsv): string {
  const lines = [
    csvRow([`Attendance ${period.start} to ${period.end}`]),
    "",
    csvRow([
      "Name",
      "Subteam",
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
      csvRow(["Meeting update", "Date", "Subteam", "Written by", "What we did"]),
      ...done.meetingUpdates.map((u) => csvRow(["", u.meetingDate, SUBTEAM_LABELS[u.subteam], u.authorName ?? "", u.body])),
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
