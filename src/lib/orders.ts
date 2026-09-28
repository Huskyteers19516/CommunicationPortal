// Order list helpers (client-safe): the filters, the cost field (dollars and cents), labels, and the CSV export.
import type { PurchaseStatus, Subteam } from "@/generated/prisma/enums";
import { PURCHASE_STATUS_LABELS, SUBTEAM_LABELS, SUBTEAMS } from "./constants";

/** Still to do: waiting for approval, to buy, or on the way. */
export const OPEN_PURCHASE_STATUSES = ["REQUESTED", "APPROVED", "ORDERED"] as const satisfies readonly PurchaseStatus[];

export function isOpenPurchaseStatus(status: PurchaseStatus): boolean {
  return (OPEN_PURCHASE_STATUSES as readonly PurchaseStatus[]).includes(status);
}

// ── Filters ────────────────────────────────────────────────────────────────────

export type OrderFilter = "open" | "done" | "na" | "all";
export const ORDER_FILTER_KEYS: readonly OrderFilter[] = ["open", "done", "na", "all"];
export const DEFAULT_ORDER_FILTER: OrderFilter = "open";

export const ORDER_FILTERS: Record<OrderFilter, { label: string; statuses: readonly PurchaseStatus[] | null }> = {
  open: { label: "Open", statuses: OPEN_PURCHASE_STATUSES },
  done: { label: "Done", statuses: ["DONE"] },
  na: { label: PURCHASE_STATUS_LABELS.NOT_NEEDED, statuses: ["NOT_NEEDED"] },
  all: { label: "All", statuses: null },
};

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

/** "?filter=done" → "done"; anything else → `fallback` (Open). */
export function parseOrderFilter(v: unknown, fallback: OrderFilter = DEFAULT_ORDER_FILTER): OrderFilter {
  const s = first(v);
  return ORDER_FILTER_KEYS.find((k) => k === s) ?? fallback;
}

/** The filter tab an item with this status shows under (other than All). */
export function filterForStatus(status: PurchaseStatus): OrderFilter {
  if (status === "DONE") return "done";
  if (status === "NOT_NEEDED") return "na";
  return "open";
}

/** "For" filter: one subteam, or "team" = items for the whole team (no subteam). */
export type OrderFor = Subteam | "team";

/** "?for=BUILD" → "BUILD"; "?for=team" → "team"; anything else → undefined (every item). */
export function parseOrderFor(v: unknown): OrderFor | undefined {
  const s = first(v);
  if (s === "team") return "team";
  return SUBTEAMS.find((t) => t === s);
}

export function orderForLabel(value: OrderFor): string {
  return value === "team" ? "Whole team" : SUBTEAM_LABELS[value];
}

export interface OrderQuery {
  filter: OrderFilter;
  for?: OrderFor;
  mine?: boolean;
}

/** Search params for these filters ("open" and "every subteam" are left out: they're the defaults). */
export function orderSearchParams(q: OrderQuery, extra: Record<string, string> = {}): URLSearchParams {
  const sp = new URLSearchParams();
  if (q.filter !== DEFAULT_ORDER_FILTER) sp.set("filter", q.filter);
  if (q.for) sp.set("for", q.for);
  if (q.mine) sp.set("mine", "1");
  for (const [k, v] of Object.entries(extra)) sp.set(k, v);
  return sp;
}

export function ordersHref(q: OrderQuery, extra?: Record<string, string>): string {
  const qs = orderSearchParams(q, extra).toString();
  return qs ? `/orders?${qs}` : "/orders";
}

/** The spreadsheet export of what's shown (the filter is always written out: the export's own default is All). */
export function ordersExportHref(q: OrderQuery): string {
  const sp = orderSearchParams(q);
  sp.set("filter", q.filter);
  return `/orders/export?${sp.toString()}`;
}

/**
 * The export's file name says what's in it: "order-list-2026-09-24.csv" for everything,
 * "order-list-software-open-mine-2026-09-24.csv" for a filtered list.
 */
export function ordersExportFilename(q: OrderQuery, day: string): string {
  const parts = [
    "order-list",
    q.for === "team" ? "whole-team" : q.for?.toLowerCase(),
    q.filter === "all" ? null : q.filter,
    q.mine ? "mine" : null,
    day,
  ];
  return `${parts.filter(Boolean).join("-")}.csv`;
}

// ── Cost (dollars and cents) ──────────────────────────────────────────────────

/** Most one line may cost ($100,000). */
export const PURCHASE_COST_MAX_CENTS = 100_000 * 100;

export type CentsResult = { ok: true; value: number | null } | { ok: false; message: string };

export const COST_FORMAT_MESSAGE = "Enter the price in dollars, like 12.99 or $1,200.";
export const COST_NEGATIVE_MESSAGE = "The price can't be negative.";

/** Spreadsheet ways of saying "no price yet". */
const EMPTY_AMOUNTS = new Set(["", "-", "–", "—", "n/a", "na", "none", "tbd", "?"]);

/**
 * What people type for a price, in cents — the same formats as parseDollars in money.ts ("$1,299.99", "12",
 * "1.5k", "250 USD") but keeping the cents: "$12.99" → 1299. Empty (or "-", "n/a", "tbd"…) → null.
 * Negative, not a number, or over PURCHASE_COST_MAX_CENTS → a message for people.
 */
export function parseCents(input: string): CentsResult {
  const raw = input.trim().toLowerCase();
  if (EMPTY_AMOUNTS.has(raw)) return { ok: true, value: null };
  let s = raw.replace(/\s+/g, "").replace(/^usd|usd$/g, "").replace(/\$/g, "");
  if (s.startsWith("-") || s.startsWith("−") || /^\(.*\)$/.test(s)) return { ok: false, message: COST_NEGATIVE_MESSAGE };
  let multiplier = 1;
  if (/\dk$/.test(s)) {
    multiplier = 1_000;
    s = s.slice(0, -1);
  }
  // Commas only as thousands separators ("1,000", "12,500.50").
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return { ok: false, message: COST_FORMAT_MESSAGE };
  const value = Math.round(Number(s.replace(/,/g, "")) * multiplier * 100);
  if (!Number.isSafeInteger(value)) return { ok: false, message: COST_FORMAT_MESSAGE };
  if (value > PURCHASE_COST_MAX_CENTS) {
    return { ok: false, message: `Prices can be up to ${formatCents(PURCHASE_COST_MAX_CENTS)}.` };
  }
  return { ok: true, value };
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 1299 → "$12.99"; 130000 → "$1,300.00". */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/** For the cost box: 1299 → "12.99", 1300 → "13", null → "". */
export function centsToInput(cents: number | null): string {
  if (cents === null) return "";
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** For the spreadsheet: 1299 → "12.99" (a plain number, so SUM works), null → "". */
function centsToSheet(cents: number | null): string {
  return cents === null ? "" : (cents / 100).toFixed(2);
}

// ── Display ───────────────────────────────────────────────────────────────────

/** "https://www.andymark.com/products/x" → "andymark.com". "" for anything that isn't a link. */
export function linkHost(link: string): string {
  if (!link) return "";
  try {
    return new URL(link).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/** "Sep 24" (adds the year when it isn't this year), in the team timezone. */
export function formatAddedDay(iso: string, timeZone: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  const sameYear = year(date) === year(now);
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(date);
}

// ── Summary ───────────────────────────────────────────────────────────────────

/** One row per status: how many items, how many have a price, and what those add up to (cents). */
export interface OrderStatusGroup {
  status: PurchaseStatus;
  count: number;
  priced: number;
  sumCents: number;
}

export interface OrderSummary {
  counts: Record<PurchaseStatus, number>;
  /** Requested + Approved + Ordered. */
  open: number;
  /** Requested: waiting for a leader to approve it. */
  toApprove: number;
  /** Approved: OK'd, not bought yet. */
  toOrder: number;
  /** What the open items with a price add up to, in cents. */
  openTotalCents: number;
  /** Open items without a price (left out of the total). */
  openUnpriced: number;
  /** What the Done items with a price add up to, in cents. */
  doneTotalCents: number;
  /** Done items without a price. */
  doneUnpriced: number;
}

export function summarizeOrders(groups: readonly OrderStatusGroup[]): OrderSummary {
  const counts: Record<PurchaseStatus, number> = { REQUESTED: 0, APPROVED: 0, ORDERED: 0, DONE: 0, NOT_NEEDED: 0 };
  let openTotalCents = 0;
  let openUnpriced = 0;
  let doneTotalCents = 0;
  let doneUnpriced = 0;
  for (const g of groups) {
    counts[g.status] += g.count;
    if (g.status === "DONE") {
      doneTotalCents += g.sumCents;
      doneUnpriced += g.count - g.priced;
    }
    if (!isOpenPurchaseStatus(g.status)) continue;
    openTotalCents += g.sumCents;
    openUnpriced += g.count - g.priced;
  }
  return {
    counts,
    open: counts.REQUESTED + counts.APPROVED + counts.ORDERED,
    toApprove: counts.REQUESTED,
    toOrder: counts.APPROVED,
    openTotalCents,
    openUnpriced,
    doneTotalCents,
    doneUnpriced,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** "Estimated total $312.49 (1 item without a price)"; "No prices yet" when none of them has one. */
function totalText(label: string, count: number, cents: number, unpriced: number): string | null {
  if (count === 0) return null;
  if (unpriced >= count) return "No prices yet";
  return `${label} ${formatCents(cents)}${unpriced > 0 ? ` (${plural(unpriced, "item")} without a price)` : ""}`;
}

/**
 * The line above the list, for the tab it's on and the For / Mine filters:
 * "Build · Yours: 3 open items · 1 waiting for approval · 1 to order · Estimated total $312.49 (1 item without a price)",
 * "6 items done · Total $1,204.50", "2 items marked N/A".
 */
export function orderSummaryText(s: OrderSummary, q: OrderQuery): string {
  const scope = [q.for && orderForLabel(q.for), q.mine && "Yours"].filter(Boolean).join(" · ");
  const { DONE: done, NOT_NEEDED: na } = s.counts;
  let parts: (string | false | null)[];
  if (q.filter === "done") {
    parts = [done === 0 ? "Nothing done yet" : `${plural(done, "item")} done`, totalText("Total", done, s.doneTotalCents, s.doneUnpriced)];
  } else if (q.filter === "na") {
    parts = [na === 0 ? "Nothing marked N/A" : `${plural(na, "item")} marked N/A`];
  } else {
    parts = [
      s.open === 0 ? "Nothing open right now" : plural(s.open, "open item"),
      s.toApprove > 0 && `${s.toApprove.toLocaleString("en-US")} waiting for approval`,
      s.toOrder > 0 && `${s.toOrder.toLocaleString("en-US")} to order`,
      totalText("Estimated total", s.open, s.openTotalCents, s.openUnpriced),
    ];
  }
  return `${scope ? `${scope}: ` : ""}${parts.filter(Boolean).join(" · ")}`;
}

/** How many items each filter tab shows. */
export function filterCounts(counts: Record<PurchaseStatus, number>): Record<OrderFilter, number> {
  const open = counts.REQUESTED + counts.APPROVED + counts.ORDERED;
  return { open, done: counts.DONE, na: counts.NOT_NEEDED, all: open + counts.DONE + counts.NOT_NEEDED };
}

// ── CSV export ────────────────────────────────────────────────────────────────

/**
 * One CSV cell. Text a spreadsheet would run as a formula (starting with = + - @, or a tab / carriage return
 * before one) gets a leading ' so it shows as plain text; cells with commas, quotes, or line breaks are quoted.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text: a byte-order mark (so Excel reads it as UTF-8), CRLF line ends. */
export function toCsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** What the export needs from an item. */
export interface OrderCsvItem {
  description: string;
  notes: string;
  link: string;
  vendor: string;
  quantity: number | null;
  costCents: number | null;
  subteam: Subteam | null;
  status: PurchaseStatus;
  orderer: { name: string } | null;
  createdBy: { name: string } | null;
  /** ISO timestamps. */
  createdAt: string;
  statusChangedAt: string | null;
  statusChangedBy: string | null;
}

export const ORDER_CSV_HEADER = [
  "Orderer",
  "Status",
  "Description",
  "Notes",
  "Link",
  "Vendor",
  "Qty",
  "Cost ($)",
  "For",
  "Added",
  "Added by",
  "Status changed",
  "Status changed by",
] as const;

/** Dates in the sheet: "2026-09-24" (team timezone), which every spreadsheet reads as a date. */
function sheetDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** The order list as a spreadsheet (same first columns as the old "Purchase List" sheet: Orderer, Status, Description, Notes). */
export function ordersToCsv(items: readonly OrderCsvItem[], timeZone: string): string {
  return toCsv([
    ORDER_CSV_HEADER,
    ...items.map((i) => [
      i.orderer?.name ?? "",
      PURCHASE_STATUS_LABELS[i.status],
      i.description,
      i.notes,
      i.link,
      i.vendor,
      i.quantity,
      centsToSheet(i.costCents),
      i.subteam ? SUBTEAM_LABELS[i.subteam] : "Whole team",
      sheetDay(i.createdAt, timeZone),
      i.createdBy?.name ?? "",
      i.statusChangedAt ? sheetDay(i.statusChangedAt, timeZone) : "",
      i.statusChangedBy ?? "",
    ]),
  ]);
}
