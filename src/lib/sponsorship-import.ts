// Importing the Business team's sponsorship spreadsheet (client-safe, pure).
//
// People select rows in Google Sheets (or Excel) and paste them: that arrives tab-separated, with cells
// that contain line breaks or quotes wrapped in "…". CSV text works too. The browser runs this for the
// live preview; the server runs it again on submit and never trusts the preview.
//
// Reading is linear in the size of the paste and bounded: at most SPONSORSHIP_IMPORT_MAX_COLUMNS columns
// and SPONSORSHIP_IMPORT_MAX_PASTED_ROWS rows are read. Each row is checked with the server's own field
// validation (sponsorshipFields), so the preview and the server agree on what can be saved.
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { SPONSORSHIP_STAGE_LABELS, SPONSORSHIP_STAGES } from "./constants";
import { addDays, type DateOnly, isDateOnly } from "./dates";
import { formatDollars, parseDollars } from "./money";
import {
  isValidEmail,
  normalizeWebsite,
  type SponsorshipFieldName,
  type SponsorshipFields,
  sponsorshipFields,
} from "./sponsorship-fields";
import {
  formatShortDate,
  looksLikeEmail,
  looksLikeWebsite,
  matchOwner,
  type OwnerOption,
  sponsorNameKey,
  websiteHost,
  withHttps,
} from "./sponsorships";

/** Most sponsors one import can add (plus update). */
export const SPONSORSHIP_IMPORT_MAX_ROWS = 200;
/** Most rows read from one paste (a whole sheet pasted again, most of it already here, still fits). */
export const SPONSORSHIP_IMPORT_MAX_PASTED_ROWS = 1000;
/** Columns after this many are ignored. */
export const SPONSORSHIP_IMPORT_MAX_COLUMNS = 40;
/** Longest paste accepted (about 300 characters a row at the pasted-row limit). */
export const SPONSORSHIP_IMPORT_TEXT_MAX = 300_000;

export type ImportField =
  | "name"
  | "website"
  | "contactName"
  | "contactEmail"
  | "asking"
  | "amountReceived"
  | "stage"
  | "owner"
  | "submittedOn"
  | "acceptedOn"
  | "closesOn"
  | "notes";

/** What each column is read as, for the preview's column list ("DATE ANNOUNCED → Accepted on"). */
export const IMPORT_FIELD_LABELS: Record<ImportField, string> = {
  name: "Sponsor",
  website: "Website",
  contactName: "Contact",
  contactEmail: "Email",
  asking: "Asking for",
  amountReceived: "Received",
  stage: "Stage",
  owner: "Person",
  submittedOn: "Submitted on",
  acceptedOn: "Accepted on",
  closesOn: "Closes on",
  notes: "Notes",
};

type DateField = "submittedOn" | "acceptedOn" | "closesOn";

/** How notes and warnings name the date columns ("Submitted: soon-ish", "the submitted date"). */
const DATE_LABELS: Record<DateField, string> = { submittedOn: "Submitted", acceptedOn: "Accepted", closesOn: "Closes" };

/**
 * Without a header row, columns are read in the order of the Business team's sheet:
 * AMOUNT RECEIVED, COMPLETION STAGE, BRAND/COMPANY, Email, DATE ANNOUNCED, DATE COMPLETED, PERSON.
 */
export const DEFAULT_IMPORT_COLUMNS: readonly ImportField[] = [
  "amountReceived",
  "stage",
  "name",
  "contactEmail",
  "acceptedOn",
  "submittedOn",
  "owner",
];

/** Lower case, no accents or apostrophes, words separated by single spaces ("Haven't  touched" → "havent touched"). */
function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── Headers ───────────────────────────────────────────────────────────────────

/** First match wins, so the more specific rules come first ("Date completed" before "Company", "Contact email" before "Contact"). */
const HEADER_RULES: ReadonlyArray<readonly [ImportField, RegExp]> = [
  ["submittedOn", /\b(submitted|completed|sent)\b/],
  ["acceptedOn", /\b(accepted|announced|approved|heard back|awarded)\b/],
  ["closesOn", /\b(closes?|closing|deadline|due)\b/],
  ["stage", /\b(stage|status|progress)\b/],
  ["contactEmail", /\b(e ?mails?)\b/],
  ["website", /\b(website|web site|site|link|url|homepage)\b/],
  ["contactName", /\b(contact|poc)\b/],
  ["asking", /\b(ask|asking|asked|hoping|hope|request|requested|requesting|goal)\b/],
  ["amountReceived", /\b(amount|received|money|raised|donated|donation|funds)\b/],
  ["notes", /\b(notes?|comments?|details)\b/],
  ["owner", /\b(person|owner|who|assigned|assignee|lead|member|handled)\b/],
  ["name", /\b(company|companies|brand|name|sponsors?|organi[sz]ation|org|business|grant|donor)\b/],
];

/** Which field a header cell names ("BRAND/COMPANY" → name), or null for columns we don't keep. */
export function headerField(cell: string): ImportField | null {
  const key = normalize(cell);
  if (!key) return null;
  for (const [field, re] of HEADER_RULES) if (re.test(key)) return field;
  return null;
}

/** Cells that are clearly data, never a column name. */
function looksLikeData(cell: string, today: DateOnly): boolean {
  const c = cell.trim();
  if (!c) return false;
  if (looksLikeEmail(c) || /^[$(-]?\s*\$?\d/.test(c)) return true;
  return /\d/.test(c) && parseLooseDate(c, today) !== null;
}

/** Column names that are safe to recognize even alone (a one-column paste of sponsor names). */
const NAME_ONLY_HEADERS = new Set([
  "company",
  "companies",
  "brand",
  "brand company",
  "name",
  "names",
  "sponsor",
  "sponsors",
  "sponsor name",
  "company name",
  "organization",
  "organisation",
]);

/**
 * A header row: nothing in it looks like data, and at least two cells name known columns. A cell that
 * is just a stage ("Submitted", "Accepted") doesn't count on its own, since data rows have those too.
 */
function isHeaderRow(cells: string[], today: DateOnly): boolean {
  const filled = cells.filter((c) => c.trim());
  if (filled.length === 0 || filled.some((c) => looksLikeData(c, today))) return false;
  if (filled.length === 1) return NAME_ONLY_HEADERS.has(normalize(filled[0]));
  const strong = filled.filter((c) => headerField(c) !== null && !STAGE_WORDS.has(normalize(c))).length;
  return strong >= 2;
}

/** Header cells → the field each column fills. A field is taken by its first column; repeats are ignored. */
function columnsFromHeader(cells: string[]): (ImportField | null)[] {
  const seen = new Set<ImportField>();
  return cells.map((cell) => {
    const field = headerField(cell);
    if (!field || seen.has(field)) return null;
    seen.add(field);
    return field;
  });
}

/** How many cells read as values of the Business sheet's columns (an amount, a stage, an email, a date). */
function defaultColumnsRecognized(cells: string[], today: DateOnly): number {
  let recognized = 0;
  DEFAULT_IMPORT_COLUMNS.forEach((field, i) => {
    const c = cells[i]?.trim();
    if (!c) return;
    switch (field) {
      case "amountReceived": {
        const amount = parseDollars(c);
        if (amount.ok && amount.value !== null) recognized++;
        break;
      }
      case "stage":
        if (parseStageText(c) !== null) recognized++;
        break;
      case "contactEmail":
        if (looksLikeEmail(c)) recognized++;
        break;
      case "acceptedOn":
      case "submittedOn":
        if (parseLooseDate(c, today) !== null) recognized++;
        break;
    }
  });
  return recognized;
}

// ── Cells ─────────────────────────────────────────────────────────────────────

interface SheetRecord {
  /** 1-based position among the pasted rows (blank rows count), like the spreadsheet rows selected. */
  row: number;
  /** Trimmed, at most SPONSORSHIP_IMPORT_MAX_COLUMNS. */
  cells: string[];
}

interface SheetRead {
  /** Rows with something in them, at most `maxRecords`. */
  records: SheetRecord[];
  /** There were more rows than `maxRecords` (the rest weren't read). */
  moreRows: boolean;
  /** Most cells any row had (columns past the limit included). */
  widest: number;
}

/**
 * Tabs when the paste has them (Google Sheets and Excel copy that way). Commas only when the first row
 * reads as two or more known columns (a CSV header, or values in the Business sheet's order), so a list
 * of names like "Acme, Inc." stays one name per line. "\t" with no tabs in the text = one cell per line.
 */
function detectDelimiter(src: string, today: DateOnly): "\t" | "," {
  const head = src.slice(0, 20_000).split("\n", 20);
  if (head.some((line) => line.includes("\t"))) return "\t";
  const first = head.find((line) => line.trim() !== "");
  if (!first?.includes(",")) return "\t";
  const cells = (splitRecords(first, ",", true, 1) ?? splitRecords(first, ",", false, 1))?.records[0]?.cells ?? [];
  return isHeaderRow(cells, today) || defaultColumnsRecognized(cells, today) >= 2 ? "," : "\t";
}

/**
 * Tab- or comma-separated text → rows of cells. A cell that starts with a quote runs to the closing quote
 * (so it may hold tabs, commas, and line breaks; "" is a quote). A quote that never closes is read as
 * plain text instead (someone typed a stray quote), so it can't swallow the rest of the paste.
 * Blank rows are skipped (but counted), cells past SPONSORSHIP_IMPORT_MAX_COLUMNS are dropped, and
 * reading stops after `maxRecords` rows.
 */
function splitRecords(text: string, delimiter: string, quotes: boolean, maxRecords: number): SheetRead | null {
  const records: SheetRecord[] = [];
  let cells: string[] = [];
  let cellCount = 0;
  let filled = false;
  let widest = 0;
  let row = 0;
  let cell = "";
  let inQuotes = false;
  let cellStart = true;
  let quoteStart = 0;
  const endCell = () => {
    if (cellCount < SPONSORSHIP_IMPORT_MAX_COLUMNS) {
      const value = cell.trim();
      cells.push(value);
      if (value) filled = true;
    }
    cellCount++;
    cell = "";
    cellStart = true;
  };
  /** False once there are more rows than we read. */
  const endRow = (): boolean => {
    endCell();
    row++;
    widest = Math.max(widest, cellCount);
    if (filled) records.push({ row, cells });
    cells = [];
    cellCount = 0;
    filled = false;
    return records.length <= maxRecords;
  };
  const stopped = (): SheetRead => ({ records: records.slice(0, maxRecords), moreRows: true, widest });
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
          const next = text[i + 1];
          // `"Best" Robotics`: the quotes were part of the text, not around the cell.
          if (next !== undefined && next !== delimiter && next !== "\n") cell = text.slice(quoteStart, i + 1);
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (quotes && ch === '"' && cellStart) {
      inQuotes = true;
      cellStart = false;
      quoteStart = i;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\n") {
      if (!endRow()) return stopped();
    } else {
      cell += ch;
      cellStart = false;
    }
  }
  if (inQuotes) return null;
  if ((cell !== "" || cellCount > 0) && !endRow()) return stopped();
  return { records, moreRows: false, widest };
}

function readSheet(text: string, today: DateOnly): SheetRead {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const delimiter = detectDelimiter(src, today);
  // One more than the row limit: the first row may be the header.
  const max = SPONSORSHIP_IMPORT_MAX_PASTED_ROWS + 1;
  return splitRecords(src, delimiter, true, max) ?? splitRecords(src, delimiter, false, max) ?? { records: [], moreRows: false, widest: 0 };
}

// ── Values ────────────────────────────────────────────────────────────────────

// Maps (not object literals), so cells like "constructor" or "__proto__" are just unknown words.
const STAGE_WORDS = new Map<string, SponsorshipStage>([
  ["", "NOT_STARTED"],
  ["havent touched", "NOT_STARTED"],
  ["havent started", "NOT_STARTED"],
  ["not started", "NOT_STARTED"],
  ["not touched", "NOT_STARTED"],
  ["untouched", "NOT_STARTED"],
  ["to do", "NOT_STARTED"],
  ["todo", "NOT_STARTED"],
  ["do soon", "DO_SOON"],
  ["soon", "DO_SOON"],
  ["up next", "DO_SOON"],
  ["next", "DO_SOON"],
  ["work in progress", "IN_PROGRESS"],
  ["in progress", "IN_PROGRESS"],
  ["needs work", "IN_PROGRESS"],
  ["wip", "IN_PROGRESS"],
  ["working", "IN_PROGRESS"],
  ["working on it", "IN_PROGRESS"],
  ["started", "IN_PROGRESS"],
  ["submitted", "SUBMITTED"],
  ["sent", "SUBMITTED"],
  ["applied", "SUBMITTED"],
  ["waiting", "SUBMITTED"],
  ["pending", "SUBMITTED"],
  ["accepted", "ACCEPTED"],
  ["approved", "ACCEPTED"],
  ["yes", "ACCEPTED"],
  ["won", "ACCEPTED"],
  ["awarded", "ACCEPTED"],
  ["declined", "DECLINED"],
  ["rejected", "DECLINED"],
  ["no", "DECLINED"],
  ["denied", "DECLINED"],
  ["not accepted", "DECLINED"],
  ["turned down", "DECLINED"],
  ["finished", "FINISHED"],
  ["done", "FINISHED"],
  ["received", "FINISHED"],
  ["complete", "FINISHED"],
  ["completed", "FINISHED"],
  ["paid", "FINISHED"],
]);

/** For longer text like "Submitted 10/2" or "Declined (try in spring)". Most decisive words first. */
const STAGE_KEYWORDS: ReadonlyArray<readonly [RegExp, SponsorshipStage]> = [
  [/\b(declin|reject|denied|turned down|not accepted)/, "DECLINED"],
  [/\bnot (started|touched|yet)\b|\bhavent\b/, "NOT_STARTED"],
  [/\b(finish|done|received|complete|paid)/, "FINISHED"],
  [/\b(accept|approv|award)/, "ACCEPTED"],
  [/\b(submit|sent|applied)/, "SUBMITTED"],
  [/\b(progress|needs work|wip|working|draft)/, "IN_PROGRESS"],
  [/\bsoon\b/, "DO_SOON"],
];

/** "Haven't touched" / "Work in Progress" / "Submitted" / "Accepted"… (case and spacing don't matter). Unknown → null. */
export function parseStageText(value: string): SponsorshipStage | null {
  const key = normalize(value);
  const exact = STAGE_WORDS.get(key);
  if (exact) return exact;
  for (const [re, stage] of STAGE_KEYWORDS) if (re.test(key)) return stage;
  return null;
}

const MONTHS = new Map<string, number>([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3], ["apr", 4], ["april", 4],
  ["may", 5], ["jun", 6], ["june", 6], ["jul", 7], ["july", 7], ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9],
  ["september", 9], ["oct", 10], ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);

function ymd(year: number, month: number, day: number): DateOnly | null {
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isDateOnly(value) ? value : null;
}

/**
 * A date written without a year ("10/12", "Oct 12") is the first such day on or after about six months
 * before `today`. A sponsorship sheet holds recent history (submitted, heard back) and upcoming deadlines,
 * so in late September "Oct 12" is this October, "Apr 3" is the April just past, and "Mar 1" is next March.
 */
function withGuessedYear(month: number, day: number, today: DateOnly): DateOnly | null {
  const from = addDays(today, -183);
  const startYear = Number(from.slice(0, 4));
  for (let year = startYear; year <= startYear + 8; year++) {
    const candidate = ymd(year, month, day);
    if (candidate && candidate >= from) return candidate;
  }
  return null;
}

/**
 * Dates as people type them in a sheet: 2026-10-12, 10/12/2026, 10/12/26, 10/12, "October 12", "Oct 12, 2026",
 * "12 Oct", "Mon, Oct 12". Day-first dates (12/10/2026) aren't supported: US sheets are month-first. Null if unreadable.
 */
export function parseLooseDate(value: string, today: DateOnly): DateOnly | null {
  if (value.length > 60) return null;
  const s = value
    .trim()
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ \d{1,2}:\d{2}(:\d{2})?( ?[ap]\.?m\.?)?$/, "") // "10/12/2026 0:00:00"
    .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.? /, "")
    .trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (m) {
    if (!m[3]) return withGuessedYear(+m[1], +m[2], today);
    return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  }
  m = s.match(/^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/);
  let month = m ? MONTHS.get(m[1]) : undefined;
  if (m && month) return m[3] ? ymd(+m[3], month, +m[2]) : withGuessedYear(month, +m[2], today);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]+)\.?(?: (\d{4}))?$/);
  month = m ? MONTHS.get(m[2]) : undefined;
  if (m && month) return m[3] ? ymd(+m[3], month, +m[1]) : withGuessedYear(month, +m[1], today);
  return null;
}

// ── Rows ──────────────────────────────────────────────────────────────────────

export interface ImportedSponsorship {
  /** Row number in the paste (1 = first row, header included), for messages. */
  row: number;
  name: string;
  website: string;
  contactName: string;
  contactEmail: string;
  asking: string;
  amountReceived: number | null;
  stage: SponsorshipStage;
  /** The stage cell had a stage in it (empty or unreadable → Haven't started, but that's not "from the sheet"). */
  stageGiven: boolean;
  /** The person's name as written in the sheet ("" = none). */
  ownerName: string;
  submittedOn: DateOnly | null;
  acceptedOn: DateOnly | null;
  closesOn: DateOnly | null;
  notes: string;
  /** Things we changed, couldn't read, or that look off (still imported). */
  warnings: string[];
}

export interface SheetParseResult {
  hasHeader: boolean;
  /** The header row's cells as pasted ([] without a header row). */
  headers: string[];
  /** What each pasted column is read as (null = ignored). */
  columns: (ImportField | null)[];
  /** Rows with a sponsor name, in order. */
  rows: ImportedSponsorship[];
  /** Rows that have something in them but no sponsor name (not imported). */
  unnamedRows: number[];
  /** More than SPONSORSHIP_IMPORT_MAX_PASTED_ROWS rows were pasted (only that many were read). */
  tooManyRows: boolean;
  /** Some rows have more than SPONSORSHIP_IMPORT_MAX_COLUMNS columns (the rest are ignored). */
  extraColumns: boolean;
}

function addNote(notes: string, line: string): string {
  return notes ? `${notes}\n${line}` : line;
}

/** A website cell → its https:// form when it's a link the server accepts, else null. */
function websiteFrom(value: string): string | null {
  return looksLikeWebsite(value) && normalizeWebsite(value) ? withHttps(value) : null;
}

function buildRow(record: SheetRecord, index: ReadonlyMap<ImportField, number>, today: DateOnly): ImportedSponsorship {
  const get = (field: ImportField): string => {
    const i = index.get(field);
    return i === undefined ? "" : (record.cells[i] ?? "");
  };
  const warnings: string[] = [];
  let notes = get("notes");
  const note = (line: string) => {
    notes = addNote(notes, line);
  };
  const short = (d: DateOnly) => formatShortDate(d, today);

  let name = get("name");
  let website = "";
  let contactEmail = "";

  // Website column (sometimes holds an email instead).
  const rawSite = get("website");
  if (rawSite) {
    const asEmail = rawSite.replace(/^mailto:/i, "");
    const site = websiteFrom(rawSite);
    if (site) website = site;
    else if (looksLikeEmail(asEmail) && isValidEmail(asEmail)) contactEmail = asEmail.toLowerCase();
    else {
      warnings.push(`Website “${rawSite}” isn't a web address, so it went into the notes.`);
      note(`Website: ${rawSite}`);
    }
  }

  // Email column: the first address is the contact; a link here is their website ("website or email").
  const rawEmail = get("contactEmail");
  if (rawEmail) {
    const candidates = rawEmail
      .replace(/mailto:/gi, "")
      .split(/[\s,;]+/)
      .filter((e) => looksLikeEmail(e));
    const valid = candidates.filter((e) => isValidEmail(e));
    const site = websiteFrom(rawEmail);
    if (valid.length > 0) {
      contactEmail ||= valid[0].toLowerCase();
      const others = candidates.filter((e) => e !== valid[0]);
      if (others.length > 0) note(`Other emails: ${others.join(", ")}`);
    } else if (candidates.length === 0 && site) {
      website ||= site;
    } else {
      warnings.push(
        candidates.length > 0
          ? `Email “${rawEmail}” isn't a valid email address, so it went into the notes.`
          : `Email “${rawEmail}” isn't an email address, so it went into the notes.`,
      );
      note(`Email: ${rawEmail}`);
    }
  }

  // A link pasted as the company ("https://polymaker.com") → website, named after its host.
  if (name && /^(https?:\/\/|www\.)/i.test(name)) {
    const url = websiteFrom(name);
    if (url) {
      website ||= url;
      name = websiteHost(url) || name;
    }
  }

  const rawStage = get("stage");
  let stage = parseStageText(rawStage);
  const stageGiven = rawStage !== "" && stage !== null;
  if (!stage) {
    stage = "NOT_STARTED";
    warnings.push(`Didn't recognize the stage “${rawStage}”, so it's set to ${SPONSORSHIP_STAGE_LABELS.NOT_STARTED}.`);
    note(`Stage: ${rawStage}`);
  }

  const rawAmount = get("amountReceived");
  const amount = parseDollars(rawAmount);
  let amountReceived: number | null = null;
  if (amount.ok) amountReceived = amount.value;
  else {
    warnings.push(`Received “${rawAmount}” isn't a dollar amount, so it went into the notes.`);
    note(`Received: ${rawAmount}`);
  }

  const date = (field: DateField): DateOnly | null => {
    const raw = get(field);
    if (!raw) return null;
    const parsed = parseLooseDate(raw, today);
    if (!parsed) {
      warnings.push(`Couldn't read the ${DATE_LABELS[field].toLowerCase()} date “${raw}”, so it went into the notes.`);
      note(`${DATE_LABELS[field]}: ${raw}`);
    }
    return parsed;
  };
  const submittedOn = date("submittedOn");
  const acceptedOn = date("acceptedOn");
  const closesOn = date("closesOn");

  // Dates that don't fit together (e.g. a column that means something else in this sheet).
  if (acceptedOn && SPONSORSHIP_STAGES.indexOf(stage) < SPONSORSHIP_STAGES.indexOf("ACCEPTED")) {
    warnings.push(`Has an accepted date (${short(acceptedOn)}) but the stage is ${SPONSORSHIP_STAGE_LABELS[stage]} — check which is right.`);
  }
  if (acceptedOn && submittedOn && acceptedOn < submittedOn) {
    warnings.push(`The accepted date (${short(acceptedOn)}) is before the submitted date (${short(submittedOn)}) — check the dates.`);
  }
  for (const [field, value] of [
    ["submittedOn", submittedOn],
    ["acceptedOn", acceptedOn],
  ] as const) {
    if (value && value > today) warnings.push(`The ${DATE_LABELS[field].toLowerCase()} date (${short(value)}) is in the future — check it.`);
  }

  return {
    row: record.row,
    name,
    website,
    contactName: get("contactName"),
    contactEmail,
    asking: get("asking"),
    amountReceived,
    stage,
    stageGiven,
    ownerName: get("owner"),
    submittedOn,
    acceptedOn,
    closesOn,
    notes,
    warnings,
  };
}

/**
 * Rows pasted from a spreadsheet → sponsorships to import, with warnings for anything that had to be
 * changed. The first row is read as column names when it looks like them; otherwise columns follow the
 * Business team's sheet (DEFAULT_IMPORT_COLUMNS), and a single column is read as sponsor names.
 * Blank rows are skipped.
 */
export function parseSponsorshipSheet(text: string, { today }: { today: DateOnly }): SheetParseResult {
  const { records, moreRows, widest } = readSheet(text, today);
  const extraColumns = widest > SPONSORSHIP_IMPORT_MAX_COLUMNS;
  if (records.length === 0) {
    return { hasHeader: false, headers: [], columns: [...DEFAULT_IMPORT_COLUMNS], rows: [], unnamedRows: [], tooManyRows: false, extraColumns };
  }

  const hasHeader = isHeaderRow(records[0].cells, today);
  let data = hasHeader ? records.slice(1) : records;
  const tooManyRows = moreRows || data.length > SPONSORSHIP_IMPORT_MAX_PASTED_ROWS;
  if (tooManyRows) data = data.slice(0, SPONSORSHIP_IMPORT_MAX_PASTED_ROWS);
  const columns: (ImportField | null)[] = hasHeader
    ? columnsFromHeader(records[0].cells)
    : data.every((r) => r.cells.length === 1)
      ? ["name"]
      : [...DEFAULT_IMPORT_COLUMNS];
  // Where each field is, worked out once (a field is read from its first column).
  const index = new Map<ImportField, number>();
  columns.forEach((field, i) => {
    if (field && !index.has(field)) index.set(field, i);
  });

  const rows: ImportedSponsorship[] = [];
  const unnamedRows: number[] = [];
  for (const record of data) {
    const row = buildRow(record, index, today);
    if (row.name) rows.push(row);
    else unnamedRows.push(record.row);
  }
  return { hasHeader, headers: hasHeader ? records[0].cells : [], columns, rows, unnamedRows, tooManyRows, extraColumns };
}

// ── The import plan (shared by the preview and the server) ──────────────────

/** A sponsor already in the tracker, as the import compares it with the sheet. */
export interface ExistingSponsor {
  id: string;
  name: string;
  stage: SponsorshipStage;
  amountReceived: number | null;
  submittedOn: DateOnly | null;
  acceptedOn: DateOnly | null;
  closesOn: DateOnly | null;
  contactName: string;
  contactEmail: string;
  website: string;
}

/** What "Update sponsors that are already here" copies from the sheet (only cells that aren't empty). */
export const IMPORT_UPDATE_FIELDS = [
  "stage",
  "amountReceived",
  "submittedOn",
  "acceptedOn",
  "closesOn",
  "contactName",
  "contactEmail",
  "website",
] as const;
export type ImportUpdateField = (typeof IMPORT_UPDATE_FIELDS)[number];
export type ImportValue = string | number | null;

export interface PreparedSponsorship extends ImportedSponsorship {
  /** The matched person, or null (a name that didn't match is in `warnings` and the notes). */
  owner: OwnerOption | null;
  /** The row as the server saves it, or null when a field fails validation (see fieldErrors). */
  fields: SponsorshipFields | null;
  /** The server's validation messages, by field. */
  fieldErrors: Partial<Record<SponsorshipFieldName, string>>;
}

/** A paste read and checked, before it's compared with the sponsors already here. */
export interface PreparedImport extends Omit<SheetParseResult, "rows"> {
  rows: PreparedSponsorship[];
}

/**
 * Read the paste, match people by name (unmatched names go into the notes), and check every row with
 * the server's validation. Doesn't depend on what's already here, so the server does this before it
 * takes the import lock.
 */
export function prepareSponsorshipImport(text: string, opts: { today: DateOnly; owners: readonly OwnerOption[] }): PreparedImport {
  const parsed = parseSponsorshipSheet(text, { today: opts.today });
  const rows = parsed.rows.map((r): PreparedSponsorship => {
    let owner: OwnerOption | null = null;
    const warnings = [...r.warnings];
    let notes = r.notes;
    if (r.ownerName) {
      const match = matchOwner(r.ownerName, opts.owners);
      if (match.kind === "match") {
        owner = match.owner;
        if (match.by === "first") warnings.push(`Matched “${r.ownerName}” to ${match.owner.name} by first name — check it.`);
      } else {
        warnings.push(
          match.kind === "ambiguous"
            ? `More than one person matches “${r.ownerName}”, so no one is picked. The name went into the notes.`
            : `“${r.ownerName}” isn't anyone who can use this page, so no one is picked. The name went into the notes.`,
        );
        notes = addNote(notes, `Person: ${r.ownerName}`);
      }
    }
    const result = sponsorshipFields.safeParse({
      name: r.name,
      website: r.website,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      asking: r.asking,
      amountReceived: r.amountReceived,
      stage: r.stage,
      ownerId: owner?.id,
      submittedOn: r.submittedOn ?? undefined,
      acceptedOn: r.acceptedOn ?? undefined,
      closesOn: r.closesOn ?? undefined,
      notes,
    });
    const fieldErrors: PreparedSponsorship["fieldErrors"] = {};
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = String(issue.path[0] ?? "name") as SponsorshipFieldName;
        fieldErrors[field] ??= issue.message;
      }
    }
    return { ...r, owner, warnings, notes, fields: result.success ? result.data : null, fieldErrors };
  });
  return { ...parsed, rows };
}

/** The row's value for a field it can update (null = the cell was empty, so it never erases anything). */
export function sheetValue(row: ImportedSponsorship, field: ImportUpdateField): ImportValue {
  switch (field) {
    case "stage":
      return row.stageGiven ? row.stage : null;
    case "website":
      return row.website ? (normalizeWebsite(row.website) ?? row.website) : null;
    case "contactName":
    case "contactEmail":
      return row[field] || null;
    default:
      return row[field];
  }
}

export function existingValue(sponsor: ExistingSponsor, field: ImportUpdateField): ImportValue {
  const value = sponsor[field];
  return value === "" ? null : value;
}

/** "Accepted", "$1,000", "Submitted Sep 20", "no amount"… for "Sheet: … — here: …". */
export function describeImportValue(field: ImportUpdateField, value: ImportValue, today: DateOnly): string {
  if (value === null) {
    const none: Record<ImportUpdateField, string> = {
      stage: "no stage",
      amountReceived: "no amount",
      submittedOn: "no submitted date",
      acceptedOn: "no accepted date",
      closesOn: "no deadline",
      contactName: "no contact",
      contactEmail: "no email",
      website: "no website",
    };
    return none[field];
  }
  switch (field) {
    case "stage":
      return SPONSORSHIP_STAGE_LABELS[value as SponsorshipStage];
    case "amountReceived":
      return formatDollars(value as number);
    case "submittedOn":
    case "acceptedOn":
    case "closesOn":
      return `${DATE_LABELS[field]} ${formatShortDate(value as DateOnly, today)}`;
    case "website":
      return websiteHost(value as string) || String(value);
    default:
      return String(value);
  }
}

/** Fields where the sheet has something (not empty) that's different from what's here. */
function changesFrom(row: ImportedSponsorship, sponsor: ExistingSponsor): ImportUpdateField[] {
  return IMPORT_UPDATE_FIELDS.filter((field) => {
    const value = sheetValue(row, field);
    if (value === null) return false;
    const here = existingValue(sponsor, field);
    return field === "contactEmail" ? String(value).toLowerCase() !== String(here ?? "").toLowerCase() : value !== here;
  });
}

export interface PlannedSponsorship extends PreparedSponsorship {
  /** Not added: a sponsor with this name is already here (or it's earlier in the paste). */
  duplicate: boolean;
  /** How many sponsors here have this name (any case and spacing). */
  sameNameHere: number;
  /** The one sponsor here with this name (null when there's none, or more than one). */
  existing: ExistingSponsor | null;
  /** The name is earlier in the paste. */
  repeated: boolean;
  /** Where the sheet differs from `existing` (empty cells never count). */
  changes: ImportUpdateField[];
  /** `existing` gets `changes` from the sheet ("Update sponsors that are already here"). */
  update: boolean;
  /** Problems that stop the whole import until they're fixed in the sheet. */
  errors: string[];
}

export interface SponsorshipImportPlan extends Omit<PreparedImport, "rows"> {
  rows: PlannedSponsorship[];
  /** More to add and update than SPONSORSHIP_IMPORT_MAX_ROWS: nothing can be imported. */
  tooMany: boolean;
  toAdd: number;
  toUpdate: number;
  /** Rows skipped (already here, or repeated in the paste) and not updated. */
  duplicates: number;
  /** Skipped rows whose sponsor here has different info in the sheet (what "update" would copy). */
  outdated: number;
  /** Rows to add or update that have errors. */
  rowsWithErrors: number;
}

/**
 * Compare a prepared paste with the sponsors already here. With `skipDuplicates`, names already here (or
 * repeated in the paste) aren't added; with `updateExisting` too, a sponsor that's here once gets what's
 * different in the sheet (cells that aren't empty). Errors count only for what would be saved.
 */
export function matchSponsorshipImport(
  prepared: PreparedImport,
  opts: { existing: readonly ExistingSponsor[]; skipDuplicates: boolean; updateExisting?: boolean },
): SponsorshipImportPlan {
  const here = new Map<string, ExistingSponsor[]>();
  for (const s of opts.existing) {
    const key = sponsorNameKey(s.name);
    const list = here.get(key);
    if (list) list.push(s);
    else here.set(key, [s]);
  }
  const seen = new Set<string>();
  const rows = prepared.rows.map((r): PlannedSponsorship => {
    const key = sponsorNameKey(r.name);
    const matches = here.get(key) ?? [];
    const repeated = seen.has(key);
    seen.add(key);
    const existing = matches.length === 1 ? matches[0] : null;
    const duplicate = opts.skipDuplicates && (repeated || matches.length > 0);
    const changes = existing && !repeated ? changesFrom(r, existing) : [];
    const update = duplicate && !!opts.updateExisting && !repeated && existing !== null && changes.length > 0;
    const errors = !duplicate
      ? Object.values(r.fieldErrors)
      : update
        ? changes.flatMap((field) => {
            const error = r.fieldErrors[field];
            return error ? [error] : [];
          })
        : [];
    return { ...r, duplicate, sameNameHere: matches.length, existing, repeated, changes, update, errors };
  });

  const toAdd = rows.filter((r) => !r.duplicate).length;
  const toUpdate = rows.filter((r) => r.update).length;
  const skipped = rows.filter((r) => r.duplicate && !r.update);
  return {
    ...prepared,
    rows,
    tooMany: prepared.tooManyRows || toAdd + toUpdate > SPONSORSHIP_IMPORT_MAX_ROWS,
    toAdd,
    toUpdate,
    duplicates: skipped.length,
    outdated: skipped.filter((r) => r.changes.length > 0).length,
    rowsWithErrors: rows.filter((r) => r.errors.length > 0).length,
  };
}

/** prepareSponsorshipImport + matchSponsorshipImport in one go. */
export function planSponsorshipImport(
  text: string,
  opts: {
    today: DateOnly;
    owners: readonly OwnerOption[];
    existing: readonly ExistingSponsor[];
    skipDuplicates: boolean;
    updateExisting?: boolean;
  },
): SponsorshipImportPlan {
  return matchSponsorshipImport(prepareSponsorshipImport(text, opts), opts);
}
