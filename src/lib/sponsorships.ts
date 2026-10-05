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

/**
 * The filter chips on the Sponsorships page (`closing`: only asks whose deadline is in the next
 * SPONSORSHIP_CLOSING_DAYS; `logoNeeded`: Accepted / Finished sponsors thanked on the team website without a logo).
 */
export const SPONSORSHIP_FILTERS = {
  all: { label: "All", stages: null, closing: false, logoNeeded: false },
  todo: { label: "To do", stages: OPEN_SPONSORSHIP_STAGES, closing: false, logoNeeded: false },
  closing: { label: "Closing soon", stages: OPEN_SPONSORSHIP_STAGES, closing: true, logoNeeded: false },
  submitted: { label: "Submitted", stages: ["SUBMITTED"], closing: false, logoNeeded: false },
  accepted: { label: "Accepted", stages: ["ACCEPTED"], closing: false, logoNeeded: false },
  finished: { label: "Finished", stages: ["FINISHED"], closing: false, logoNeeded: false },
  declined: { label: "Declined", stages: ["DECLINED"], closing: false, logoNeeded: false },
  logo: { label: "Logo needed", stages: ["ACCEPTED", "FINISHED"], closing: false, logoNeeded: true },
} as const satisfies Record<string, { label: string; stages: readonly SponsorshipStage[] | null; closing: boolean; logoNeeded: boolean }>;

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

// ── Removing several at once ──────────────────────────────────────────────────

/** Most sponsors one "Remove selected" takes at once (like the import's 200). The list's Select mode stays under it. */
export const SPONSORSHIP_BULK_REMOVE_MAX = 200;

/**
 * "Select all" in the list's Select mode: ticks the sponsors shown that the viewer can remove, but no more
 * than `max` in all (what's already ticked stays; the rest fill up in the list's order).
 */
export function selectUpTo(removableIds: readonly string[], picked: ReadonlySet<string>, max = SPONSORSHIP_BULK_REMOVE_MAX): Set<string> {
  const next = new Set(picked);
  let count = removableIds.filter((id) => next.has(id)).length;
  for (const id of removableIds) {
    if (count >= max) break;
    if (next.has(id)) continue;
    next.add(id);
    count++;
  }
  return next;
}

/** What "Remove selected" did (deleteSponsorships). Names are in the order they were picked. */
export interface BulkRemoveResult {
  removed: string[];
  /** Picked, but the person can't remove them (someone else added them). They're kept. */
  notAllowed: string[];
  /** Picked ids that don't exist any more (only counted, never named). */
  missing: number;
}

/** How many names a message or question lists before "and N more". */
const NAMES_SHOWN = 5;

/** “A” · “A” and “B” · “A”, “B” and “C” · “A”, “B”, “C”, “D”, “E” and 3 more */
export function listSponsorNames(names: readonly string[], max = NAMES_SHOWN): string {
  const quoted = names.slice(0, max).map((n) => `“${n}”`);
  const more = names.length - quoted.length;
  if (more > 0) return `${quoted.join(", ")} and ${more} more`;
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** The question before removing the selected sponsors (`fileCount`: files attached to them, as the list knows it). */
export function bulkRemoveQuestion(names: readonly string[], fileCount: number): string {
  const what =
    names.length === 1 ? `Remove ${listSponsorNames(names)} from Sponsorships?` : `Remove ${names.length} sponsors? ${listSponsorNames(names)}.`;
  const files =
    fileCount > 0 ? `${fileCount === 1 ? "1 attached file is" : `${fileCount} attached files are`} removed too.` : "Any attached files are removed too.";
  return `${what} ${files} This can't be undone.`;
}

/** "Removed 12 sponsors." plus who to ask about the ones the person can't remove, and any already gone. */
export function bulkRemoveMessage({ removed, notAllowed, missing }: BulkRemoveResult): string {
  const parts: string[] = [];
  if (removed.length > 0) parts.push(`Removed ${removed.length} ${removed.length === 1 ? "sponsor" : "sponsors"}.`);
  if (notAllowed.length > 0) parts.push(`You can't remove ${listSponsorNames(notAllowed)} — ask the Business leader.`);
  if (missing > 0) {
    parts.push(
      removed.length + notAllowed.length > 0
        ? `${missing} ${missing === 1 ? "was" : "were"} already removed.`
        : missing === 1
          ? "That sponsor was already removed."
          : "Those sponsors were already removed.",
    );
  }
  return parts.join(" ");
}

// ── Info for applications ─────────────────────────────────────────────────────

export const PASSWORD_WARNING =
  "This note looks like it has a password in it. Everyone who can open Sponsorships can read it — remove it and change that password.";

/**
 * password / passcode / passwd anywhere (any case; not "passwordless"), or, as their own word, "pwd" / "pswd",
 * or "pw:" / "p/w:" / "pass:" (a label with ":" or "=") — but not "passport", "bypass:", or "pass" in a
 * sentence. Letters in any alphabet count as part of a word ("éPwd" isn't a word of its own). Without
 * lookbehind, which older iPhones (Safari before 16.4) can't parse.
 */
const PASSWORD_HINT = /pass(?:word(?!less)|code|wd)|(?:^|[^\p{L}\p{N}])(?:ps?wd(?!\p{L})|(?:pw|p\/w|pass)\s*[:=])/iu;

/** Whether a shared note looks like it has a password in it (the card warns; saving isn't blocked). */
export function mentionsPassword(text: string): boolean {
  return PASSWORD_HINT.test(text);
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
