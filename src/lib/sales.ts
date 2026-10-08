// Sales helpers (client-safe): labels, the money book's periods, cart math, and the CSV export.
import type { LedgerKind, SalePayment, SaleStatus } from "@/generated/prisma/enums";
import { addDays, type DateOnly } from "./dates";
import { formatCents, toCsv } from "./orders";

export const SALE_PAYMENTS = ["CASH", "CARD", "VENMO", "ZELLE", "OTHER"] as const satisfies readonly SalePayment[];

export const SALE_PAYMENT_LABELS: Record<SalePayment, string> = {
  CASH: "Cash",
  CARD: "Card",
  VENMO: "Venmo",
  ZELLE: "Zelle",
  OTHER: "Other",
};

export const SALE_STATUS_LABELS: Record<SaleStatus, string> = {
  OPEN: "Preparing",
  SERVED: "Served",
  VOIDED: "Voided",
};

export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = {
  INCOME: "Money in",
  EXPENSE: "Money out",
};

/** A menu item's category on the register; empty = "Other". */
export function saleCategoryLabel(category: string): string {
  return category.trim() || "Other";
}

/** "Order #12". */
export function saleNumberLabel(n: number): string {
  return `#${n}`;
}

// ── Cart (the register) ──────────────────────────────────────────────────────

/** What the register sends: a menu item by id, or a custom line (name + price). */
export type CartLineInput = { itemId: string; quantity: number } | { name: string; priceCents: number; quantity: number };

export function cartTotalCents(lines: readonly { priceCents: number; quantity: number }[]): number {
  return lines.reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
}

/** Change to give back for cash, or null when not enough was handed over (or nothing typed). */
export function changeDueCents(totalCents: number, receivedCents: number | null): number | null {
  if (receivedCents === null || receivedCents < totalCents) return null;
  return receivedCents - totalCents;
}

// ── Money book periods ───────────────────────────────────────────────────────

export type SalesPeriod = "today" | "week" | "month" | "all";
export const SALES_PERIODS: readonly SalesPeriod[] = ["today", "week", "month", "all"];
export const SALES_PERIOD_LABELS: Record<SalesPeriod, string> = {
  today: "Today",
  week: "Last 7 days",
  month: "Last 30 days",
  all: "All time",
};

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}

export function parseSalesPeriod(v: unknown): SalesPeriod {
  const s = first(v);
  return SALES_PERIODS.find((p) => p === s) ?? "today";
}

/** First day the period covers (team timezone), or null for all time. */
export function periodStart(period: SalesPeriod, today: DateOnly): DateOnly | null {
  if (period === "today") return today;
  if (period === "week") return addDays(today, -6);
  if (period === "month") return addDays(today, -29);
  return null;
}

/** "?event=<fundraiser id>" → the id; "none" = not tied to a fundraiser; anything else → undefined (everything). */
export function parseSalesEvent(v: unknown): string | undefined {
  const s = first(v);
  return typeof s === "string" && /^[a-z0-9_-]{1,64}$/i.test(s) ? s : undefined;
}

// ── Export ───────────────────────────────────────────────────────────────────

export interface MoneyBookRow {
  date: DateOnly;
  kind: "Sale" | "Money in" | "Money out";
  description: string;
  payment: string;
  /** Positive for money in, negative for money out. */
  amountCents: number;
  event: string;
  by: string;
}

export function moneyBookToCsv(rows: readonly MoneyBookRow[]): string {
  return toCsv([
    ["Date", "Type", "Description", "Payment", "Amount", "Event", "By"],
    ...rows.map((r) => [r.date, r.kind, r.description, r.payment, (r.amountCents / 100).toFixed(2), r.event, r.by]),
  ]);
}

/** "+$12.50" / "−$30.00". */
export function signedCents(cents: number): string {
  return cents < 0 ? `−${formatCents(-cents)}` : `+${formatCents(cents)}`;
}
