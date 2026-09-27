// Fundraising helpers shared by the server and the browser (client-safe).
import type { FundraiserStatus } from "@/generated/prisma/enums";
import { addDays, type DateOnly, formatDateOnly, isDateOnly } from "./dates";

/** Statuses where people can still sign up to help (dates permitting). */
export const OPEN_FUNDRAISER_STATUSES: readonly FundraiserStatus[] = ["PLANNING", "UPCOMING", "ACTIVE"];

/**
 * How far back / ahead a fundraiser date (or the season start) may be. Catches year typos: a desktop date
 * field turns a two-digit year into 0026, which would close sign-ups straight away.
 */
export const FUNDRAISER_DATE_MAX_PAST_DAYS = 5 * 365;
export const FUNDRAISER_DATE_MAX_FUTURE_DAYS = 2 * 365;
export const FUNDRAISER_DATE_TOO_EARLY = "That date is more than 5 years ago. Check the year.";
export const FUNDRAISER_DATE_TOO_LATE = "That date is more than 2 years away. Check the year.";

/** The earliest and latest date a fundraiser form accepts (the date fields' min/max). */
export function fundraiserDateBounds(today: DateOnly): { min: DateOnly; max: DateOnly } {
  return { min: addDays(today, -FUNDRAISER_DATE_MAX_PAST_DAYS), max: addDays(today, FUNDRAISER_DATE_MAX_FUTURE_DAYS) };
}

/** Null when `date` is within the bounds, else what to fix. */
export function fundraiserDateProblem(date: DateOnly, today: DateOnly): string | null {
  const { min, max } = fundraiserDateBounds(today);
  if (date < min) return FUNDRAISER_DATE_TOO_EARLY;
  if (date > max) return FUNDRAISER_DATE_TOO_LATE;
  return null;
}

export interface FundraiserTiming {
  status: FundraiserStatus;
  startsOn: DateOnly | null;
  endsOn: DateOnly | null;
}

/** The last day it runs: the end date, or the start date for a one-day fundraiser. Null = no dates yet. */
export function fundraiserLastDay(f: Pick<FundraiserTiming, "startsOn" | "endsOn">): DateOnly | null {
  return f.endsOn ?? f.startsOn;
}

/**
 * Why nobody can sign up (or leave) any more, or null while it's open: cancelled, marked done, or its last
 * day (team timezone) has passed.
 */
export function fundraiserClosedReason(f: FundraiserTiming, today: DateOnly): string | null {
  if (f.status === "CANCELLED") return "This fundraiser was cancelled.";
  if (f.status === "DONE") return "This fundraiser is over.";
  const last = fundraiserLastDay(f);
  if (last !== null && last < today) return "This fundraiser is over.";
  return null;
}

/** "Sat, Oct 3", "Sat, Oct 3 – Sun, Oct 4", "Until Fri, Oct 30", or null without dates. */
export function fundraiserDatesLabel(f: Pick<FundraiserTiming, "startsOn" | "endsOn">, today: DateOnly): string | null {
  const { startsOn, endsOn } = f;
  if (startsOn && endsOn && startsOn !== endsOn) return `${formatDateOnly(startsOn, today)} – ${formatDateOnly(endsOn, today)}`;
  if (startsOn) return formatDateOnly(startsOn, today);
  if (endsOn) return `Until ${formatDateOnly(endsOn, today)}`;
  return null;
}

/** "2 of 4 spots taken · 2 left", "3 helping · no limit", "Nobody yet · 4 spots". */
export function helperSpotsLabel(count: number, limit: number | null, open: boolean): string {
  if (limit === null) {
    const helping = count === 0 ? "Nobody yet" : `${count} helping`;
    return open ? `${helping} · no limit` : helping;
  }
  const taken = `${count} of ${limit} ${limit === 1 ? "spot" : "spots"} taken`;
  if (!open) return taken;
  const left = Math.max(0, limit - count);
  return `${taken} · ${left === 0 ? "full" : `${left} left`}`;
}

/** "2 of 4 spots taken · 2 left" while it's open; "3 people helped" once it's over; "2 signed up" if cancelled. */
export function helpersLine(f: {
  status: FundraiserStatus;
  closedReason: string | null;
  volunteerCount: number;
  volunteerLimit: number | null;
}): string {
  const n = f.volunteerCount;
  if (!f.closedReason) return helperSpotsLabel(n, f.volunteerLimit, true);
  if (f.status === "CANCELLED") return n === 0 ? "Nobody signed up" : `${n} signed up`;
  return n === 0 ? "No helpers signed up" : `${n} ${n === 1 ? "person" : "people"} helped`;
}

/** Whole percent of the goal reached (0 without a goal; can go past 100). */
export function goalPercent(raised: number, goal: number | null): number {
  if (!goal || goal <= 0) return 0;
  // Integer math: (29 / 100) * 100 is 28.999… in floating point. Amounts are capped far below 2^53 / 100.
  return Math.floor((raised * 100) / goal);
}

/** The season goal as stored in its TeamNote ("5000"), or null when it isn't set. */
export function parseSeasonGoal(body: string | null | undefined): number | null {
  const s = (body ?? "").trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** The season start as stored in its TeamNote ("2026-09-01"), or null when it isn't set (totals are all-time). */
export function parseSeasonStart(body: string | null | undefined): DateOnly | null {
  const s = (body ?? "").trim();
  return isDateOnly(s) ? s : null;
}

/**
 * What the season-start box suggests when none is set: Sep 1, when the FTC season kicks off (last year's
 * Sep 1 until this year's comes around).
 */
export function suggestedSeasonStart(today: DateOnly): DateOnly {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return `${String(month >= 9 ? year : year - 1).padStart(4, "0")}-09-01`;
}
