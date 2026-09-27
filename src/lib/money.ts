// Dollar amounts (client-safe): reading what people type or paste, and showing it.
import { LIMITS } from "./constants";

export type DollarsResult = { ok: true; value: number | null } | { ok: false; message: string };

/** Spreadsheet ways of saying "nothing yet". */
const EMPTY_AMOUNTS = new Set(["", "-", "–", "—", "n/a", "na", "none", "tbd", "?"]);

export const AMOUNT_FORMAT_MESSAGE = "Enter the amount in dollars, like 1,000 or $1,000.";
export const AMOUNT_NEGATIVE_MESSAGE = "The amount can't be negative.";

/**
 * "$1,000", "1000", "1,000.00", "$1.5k", "250 USD" → whole dollars (rounded to the nearest dollar).
 * Empty (or "-", "n/a"…) → null. Negative, not a number, or over LIMITS.sponsorAmountMax → a message for people.
 */
export function parseDollars(input: string): DollarsResult {
  const raw = input.trim().toLowerCase();
  if (EMPTY_AMOUNTS.has(raw)) return { ok: true, value: null };
  let s = raw.replace(/\s+/g, "").replace(/^usd|usd$/g, "").replace(/\$/g, "");
  if (s.startsWith("-") || s.startsWith("−") || /^\(.*\)$/.test(s)) return { ok: false, message: AMOUNT_NEGATIVE_MESSAGE };
  let multiplier = 1;
  if (/\d[km]$/.test(s)) {
    multiplier = s.endsWith("k") ? 1_000 : 1_000_000;
    s = s.slice(0, -1);
  }
  // Commas only as thousands separators ("1,000", "12,500.50").
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return { ok: false, message: AMOUNT_FORMAT_MESSAGE };
  const value = Math.round(Number(s.replace(/,/g, "")) * multiplier);
  if (!Number.isSafeInteger(value)) return { ok: false, message: AMOUNT_FORMAT_MESSAGE };
  if (value > LIMITS.sponsorAmountMax) {
    return { ok: false, message: `Amounts can be up to ${formatDollars(LIMITS.sponsorAmountMax)}.` };
  }
  return { ok: true, value };
}

const dollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumSignificantDigits: 3,
});

/** 1250 → "$1,250". */
export function formatDollars(value: number): string {
  return dollars.format(value);
}

/** Short enough for a stat card on a phone: "$9,500", but "$12.5K" / "$1.25M" from $10,000 up. */
export function formatDollarsCompact(value: number): string {
  return value < 10_000 ? dollars.format(value) : compactDollars.format(value);
}
