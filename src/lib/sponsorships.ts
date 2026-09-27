// Sponsorships helpers shared by the server and the browser (client-safe).
import type { SponsorshipStage } from "@/generated/prisma/enums";
import { LIMITS } from "./constants";
import { type DateOnly, dateOnlyToDb } from "./dates";

/** Stages where the ask still needs work from us, so its deadline still matters. */
export const OPEN_SPONSORSHIP_STAGES: readonly SponsorshipStage[] = ["NOT_STARTED", "DO_SOON", "IN_PROGRESS"];

export function isOpenStage(stage: SponsorshipStage): boolean {
  return OPEN_SPONSORSHIP_STAGES.includes(stage);
}

/** "Closing soon" = still to do, with a deadline between today and this many days from now. */
export const SPONSORSHIP_CLOSING_DAYS = 14;

/** The filter chips on the Sponsorships page (`closing`: only asks whose deadline is in the next SPONSORSHIP_CLOSING_DAYS). */
export const SPONSORSHIP_FILTERS = {
  all: { label: "All", stages: null, closing: false },
  todo: { label: "To do", stages: OPEN_SPONSORSHIP_STAGES, closing: false },
  closing: { label: "Closing soon", stages: OPEN_SPONSORSHIP_STAGES, closing: true },
  submitted: { label: "Submitted", stages: ["SUBMITTED"], closing: false },
  accepted: { label: "Accepted", stages: ["ACCEPTED"], closing: false },
  finished: { label: "Finished", stages: ["FINISHED"], closing: false },
  declined: { label: "Declined", stages: ["DECLINED"], closing: false },
} as const satisfies Record<string, { label: string; stages: readonly SponsorshipStage[] | null; closing: boolean }>;

export type SponsorshipFilter = keyof typeof SPONSORSHIP_FILTERS;
export const SPONSORSHIP_FILTER_KEYS = Object.keys(SPONSORSHIP_FILTERS) as SponsorshipFilter[];

/** "?filter=todo" → "todo"; anything else (including "constructor" and other Object keys) → "all". */
export function parseSponsorshipFilter(value: unknown): SponsorshipFilter {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === "string" && Object.hasOwn(SPONSORSHIP_FILTERS, v) ? (v as SponsorshipFilter) : "all";
}

/** How names compare for "already here": ignores case and spacing. */
export function sponsorNameKey(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * "polymaker.com/sponsors" → "https://polymaker.com/sponsors" (people often leave off the https://).
 * Anything that isn't a bare domain comes back unchanged, to be checked by the caller.
 */
export function withHttps(value: string): string {
  const v = value.trim();
  if (!v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  return /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]\S*)?$/i.test(v) ? `https://${v}` : v;
}

/** A plain http(s) address that can be linked to (the server re-checks with parseHttpUrl). */
export function looksLikeWebsite(value: string): boolean {
  const v = withHttps(value);
  if (!v || v.length > LIMITS.resourceUrlMax) return false;
  try {
    const url = new URL(v);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.hostname.includes(".");
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/;

export function looksLikeEmail(value: string): boolean {
  const v = value.trim();
  return v.length <= LIMITS.emailMax && EMAIL_RE.test(v);
}

/** "example.com" / "www.polymaker.com" for showing a website compactly. */
export function websiteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** "Oct 12" (adds the year when it isn't `today`'s year): short enough for a table cell. */
export function formatShortDate(value: DateOnly, today?: DateOnly): string {
  const sameYear = today ? today.slice(0, 4) === value.slice(0, 4) : true;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(dateOnlyToDb(value));
}

// ── People ────────────────────────────────────────────────────────────────────

export interface OwnerOption {
  id: string;
  name: string;
}

/** How a name matched: the full name, a first name alone, or a first name + last initial ("Ava T."). */
export type OwnerMatchBy = "full" | "first" | "initial";

export type OwnerMatch = { kind: "match"; owner: OwnerOption; by: OwnerMatchBy } | { kind: "none" } | { kind: "ambiguous" };

function personKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A name typed in a spreadsheet ("Ava", "ava thompson", "Ava T.") → one of `options`, ignoring case and accents.
 * Full name first, then a first name (or first name + last initial) that only one person has.
 */
export function matchOwner(name: string, options: readonly OwnerOption[]): OwnerMatch {
  const key = personKey(name);
  if (!key) return { kind: "none" };
  const pick = (found: OwnerOption[], by: OwnerMatchBy): OwnerMatch | null =>
    found.length === 1 ? { kind: "match", owner: found[0], by } : found.length > 1 ? { kind: "ambiguous" } : null;

  const full = pick(
    options.filter((o) => personKey(o.name) === key),
    "full",
  );
  if (full) return full;
  const [first, ...rest] = key.split(" ");
  if (rest.length === 0) {
    return (
      pick(
        options.filter((o) => personKey(o.name).split(" ")[0] === first),
        "first",
      ) ?? { kind: "none" }
    );
  }
  if (rest.length === 1 && rest[0].length === 1) {
    const initial = rest[0];
    return (
      pick(
        options.filter((o) => {
          const parts = personKey(o.name).split(" ");
          return parts[0] === first && parts.length > 1 && parts[parts.length - 1].startsWith(initial);
        }),
        "initial",
      ) ?? { kind: "none" }
    );
  }
  return { kind: "none" };
}
