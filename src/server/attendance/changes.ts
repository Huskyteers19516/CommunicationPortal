// The attendance change log (AttendanceChange): what admins did to people's attendance, as readable sentences,
// the /attendance/changes filters, and the CSV. Pure, so tests cover it without a database.
// Besides admins' changes it has one kind of row written by the person themselves: scanning in over a hand entry
// (CREDIT_CHANGED with changedById = userId — admins never change their own credit), shown as "scanned in".
import type { AttendanceChangeAction, AttendanceCreditKind, AttendanceKind } from "@/generated/prisma/enums";
import { ATTENDANCE_KIND_LABELS, creditLabel } from "@/lib/attendance";
import { type DateOnly, formatDateOnly, isDateOnly } from "@/lib/dates";
import { csvRow } from "./report";

/** One change as pages and the CSV show it. */
export interface AttendanceChangeRow {
  id: string;
  createdAt: Date;
  action: AttendanceChangeAction;
  /** Null once the session is deleted. */
  sessionId: string | null;
  sessionDate: DateOnly;
  sessionKind: AttendanceKind;
  /** Whose attendance (null for a deleted session, or a deleted account). */
  userId: string | null;
  /** Their name (as it is now, or as it was when their account is gone). "" for a deleted session. */
  userName: string;
  /** Who made the change (null when that account is gone). */
  changedByName: string | null;
  /** Their id (null when that account is gone; missing = unknown). The same as `userId` for "scanned in". */
  changedById?: string | null;
  fromCredit: number | null;
  fromKind: AttendanceCreditKind | null;
  toCredit: number | null;
  toKind: AttendanceCreditKind | null;
}

function credit(value: number | null, kind: AttendanceCreditKind | null): string {
  return value === null ? "nothing" : creditLabel(value, kind ?? "REGULAR");
}

/** "Regular · Tue, Sep 29" */
export function changeSessionLabel(c: Pick<AttendanceChangeRow, "sessionKind" | "sessionDate">, today?: DateOnly): string {
  return `${ATTENDANCE_KIND_LABELS[c.sessionKind]} · ${formatDateOnly(c.sessionDate, today)}`;
}

/**
 * What a row shows as (badge, "Kind of change" filter, CSV): the stored action, with two told apart — "Marked not
 * here" (ADDED as No credit) and "Scanned in" (the person scanned in over a hand entry).
 */
export type AttendanceChangeKind = AttendanceChangeAction | "NOT_HERE" | "SCANNED_IN";

export const ATTENDANCE_CHANGE_KIND_LABELS: Record<AttendanceChangeKind, string> = {
  ADDED: "Added by hand",
  NOT_HERE: "Marked not here",
  REMOVED: "Taken off",
  CREDIT_CHANGED: "Credit changed",
  SCANNED_IN: "Scanned in",
  SESSION_DELETED: "Session deleted",
};

/** The kinds the "Kind of change" menu offers, in its order. */
export const ATTENDANCE_CHANGE_KINDS: AttendanceChangeKind[] = ["ADDED", "NOT_HERE", "REMOVED", "CREDIT_CHANGED", "SCANNED_IN", "SESSION_DELETED"];

function isScannedIn(c: Pick<AttendanceChangeRow, "action" | "userId" | "changedById">): boolean {
  return c.action === "CREDIT_CHANGED" && !!c.userId && c.changedById === c.userId;
}

export function changeKindOf(c: Pick<AttendanceChangeRow, "action" | "toCredit" | "userId" | "changedById">): AttendanceChangeKind {
  if (c.action === "ADDED" && c.toCredit === 0) return "NOT_HERE";
  if (isScannedIn(c)) return "SCANNED_IN";
  return c.action;
}

/**
 * "Amara Okafor changed Ethan Chen's Regular · Tue, Sep 29 from 1 to 1/2", "… added Ethan Chen to Regular · Tue,
 * Sep 29 as 1/2 EC", "… marked Ethan Chen as not here (No credit) for …", "… took Ethan Chen off … (was 1)",
 * "… deleted Regular · Tue, Sep 29", "Ethan Chen scanned in to Regular · Tue, Sep 29: now 1 (was 1/2 by hand)".
 */
export function describeAttendanceChange(c: AttendanceChangeRow, today?: DateOnly): string {
  const who = c.changedByName ?? "Someone";
  const person = c.userName || "someone";
  const session = changeSessionLabel(c, today);
  switch (c.action) {
    case "ADDED":
      return c.toCredit === 0
        ? `${who} marked ${person} as not here (No credit) for ${session}`
        : `${who} added ${person} to ${session} as ${credit(c.toCredit, c.toKind)}`;
    case "REMOVED":
      return `${c.userId && c.changedById === c.userId ? `${who} took themselves` : `${who} took ${person}`} off ${session}${
        c.fromCredit === null ? "" : ` (was ${credit(c.fromCredit, c.fromKind)})`
      }`;
    case "CREDIT_CHANGED":
      if (isScannedIn(c)) {
        return `${person} scanned in to ${session}: now ${credit(c.toCredit, c.toKind)} (was ${credit(c.fromCredit, c.fromKind)} by hand)`;
      }
      return `${who} changed ${person}'s ${session} from ${credit(c.fromCredit, c.fromKind)} to ${credit(c.toCredit, c.toKind)}`;
    case "SESSION_DELETED":
      return `${who} deleted ${session}`;
  }
}

// ---------- filters (/attendance/changes?person=&by=&action=&from=&to=&page=) ----------

export interface AttendanceChangeFilters {
  /** Whose attendance changed (a user id). */
  person?: string;
  /** Who changed it (a user id). */
  by?: string;
  /** The kind of change as rows show it ("NOT_HERE" and "SCANNED_IN" are told apart from ADDED / CREDIT_CHANGED). */
  action?: AttendanceChangeKind;
  /** The attendance's day (the session's date), inclusive. */
  from?: DateOnly;
  to?: DateOnly;
  /** 1-based. */
  page: number;
}

export const CHANGES_PAGE_SIZE = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function one(value: string | string[] | undefined | null): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" ? v.trim() : undefined;
}

/**
 * Reads the filters from the address, dropping anything that isn't valid (unknown actions, malformed ids or
 * dates). A from/to given the wrong way round is swapped.
 */
export function parseAttendanceChangeFilters(sp: Record<string, string | string[] | undefined> | URLSearchParams): AttendanceChangeFilters {
  const get = (key: string) => one(sp instanceof URLSearchParams ? sp.get(key) : sp[key]);
  const person = get("person");
  const by = get("by");
  const action = get("action");
  let from = get("from");
  let to = get("to");
  from = from && isDateOnly(from) ? from : undefined;
  to = to && isDateOnly(to) ? to : undefined;
  if (from && to && from > to) [from, to] = [to, from];
  const pageNum = Number(get("page"));
  return {
    person: person && ID_RE.test(person) ? person : undefined,
    by: by && ID_RE.test(by) ? by : undefined,
    action: ATTENDANCE_CHANGE_KINDS.find((a) => a === action),
    from,
    to,
    page: Number.isInteger(pageNum) && pageNum > 0 ? Math.min(pageNum, 10_000) : 1,
  };
}

export function hasAttendanceChangeFilters(f: AttendanceChangeFilters): boolean {
  return !!(f.person || f.by || f.action || f.from || f.to);
}

/** The filters as a query string ("" for none), with `page` when it's past the first. */
export function attendanceChangeQuery(f: Partial<AttendanceChangeFilters>, page = 1): string {
  const sp = new URLSearchParams();
  if (f.person) sp.set("person", f.person);
  if (f.by) sp.set("by", f.by);
  if (f.action) sp.set("action", f.action);
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  if (page > 1) sp.set("page", String(page));
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

// ---------- CSV ----------

/** A credit for a CSV cell: "1/2 regular", "1/2 EC", "No credit" (a bare "1/2" would open as a date in Excel). */
function csvCredit(value: number | null, kind: AttendanceCreditKind | null): string {
  if (value === null) return "";
  const label = creditLabel(value, kind ?? "REGULAR");
  return value > 0 && (kind ?? "REGULAR") === "REGULAR" ? `${label} regular` : label;
}

/** "2026-09-29 15:04" in the team timezone. */
function stamp(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** The CSV lines for change-log rows (a header, then one per row, newest first as given). */
function changeCsvLines(rows: AttendanceChangeRow[], timeZone: string): string[] {
  return [
    csvRow(["When", "Action", "Attendance day", "Kind", "Person", "Changed by", "Before", "After", "What happened"]),
    ...rows.map((c) =>
      csvRow([
        stamp(c.createdAt, timeZone),
        ATTENDANCE_CHANGE_KIND_LABELS[changeKindOf(c)],
        c.sessionDate,
        ATTENDANCE_KIND_LABELS[c.sessionKind],
        c.userName,
        c.changedByName ?? "",
        csvCredit(c.fromCredit, c.fromKind),
        csvCredit(c.toCredit, c.toKind),
        describeAttendanceChange(c),
      ]),
    ),
  ];
}

/**
 * The change log as CSV (newest first, as given): when, what, the attendance's day and kind, whose, by whom, the
 * credit before and after, and the sentence. Every cell goes through csvCell (formulas are escaped). CRLF line ends.
 */
export function attendanceChangesCsv(rows: AttendanceChangeRow[], timeZone: string): string {
  return `${changeCsvLines(rows, timeZone).join("\r\n")}\r\n`;
}

/**
 * The two-week report CSV's "Changes by admins" block (after a blank line): its period's rows, like the page, plus a
 * line when there are more than it holds (`total`). Appended to reportCsv's output.
 */
export function reportChangesCsv(rows: AttendanceChangeRow[], total: number, timeZone: string): string {
  const lines = ["", csvRow(["Changes by admins"])];
  if (rows.length === 0) lines.push(csvRow(["No changes by admins in these two weeks."]));
  else lines.push(...changeCsvLines(rows, timeZone));
  if (total > rows.length) lines.push(csvRow([`Showing the newest ${rows.length} of ${total}. The rest are in Attendance changes.`]));
  return `${lines.join("\r\n")}\r\n`;
}
