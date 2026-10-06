// The public progress page on the team website (Huskyteers19516.github.io/progress) reads live numbers from
// GET /api/public/progress (src/app/api/public/progress/route.ts, built by src/server/queries/public-progress.ts).
// Client-safe: the settings' shape and parsing, how names and positions are shown, and the JSON's types.
import type { Role, Subteam } from "@/generated/prisma/enums";
import { type DateOnly, isDateOnly } from "./dates";

/** TeamNote holding the settings (JSON, see parsePublicProgressSettings). */
export const PUBLIC_PROGRESS_KEY = "public-progress";
/**
 * TeamNote holding the random salt the opaque person ids are made with (created on the first request; never shown
 * anywhere). Changing or deleting it gives everyone new ids.
 */
export const PUBLIC_PROGRESS_ID_SALT_KEY = "public-progress-id-salt";

/** The team website: the only origin the endpoint's CORS header ever names (plus PUBLIC_PROGRESS_EXTRA_ORIGINS). */
export const TEAM_SITE_ORIGIN = "https://huskyteers19516.github.io";
/** The progress page on the team website. */
export const TEAM_SITE_PROGRESS_URL = `${TEAM_SITE_ORIGIN}/progress`;
/**
 * The public JSON endpoint (this site), and every endpoint that answers without a session — kept in
 * src/lib/public-api.ts (with PUBLIC_API_FILE_PREFIXES and isPublicApiPath, which the proxy uses) and re-exported
 * here so older imports keep working.
 */
export { PUBLIC_API_PATHS, PUBLIC_PROGRESS_PATH } from "./public-api";

/** Used when neither the settings nor the attendance schedule say where the season starts. */
export const PUBLIC_PROGRESS_DEFAULT_SINCE: DateOnly = "2026-08-31";

/** Most entries in `recent`. */
export const PUBLIC_RECENT_MAX = 15;
/** Most entries in one person's `done` (GET /api/public/progress/people/<id>). */
export const PUBLIC_PERSON_DONE_MAX = 25;
/**
 * What a person's id (`people[].id`, publicPersonId) looks like: 16 base64url characters. Anything else is answered
 * "not found" by the person endpoint without reading the database.
 */
export const PUBLIC_PERSON_ID_RE = /^[A-Za-z0-9_-]{16}$/;
/** Most weeks in `weekly` (Monday to Sunday, team timezone, the current one last; fewer when `since` is later). */
export const PUBLIC_WEEKS = 8;
/**
 * People who left themselves off the list count in the totals only when at least this many in the same group (a
 * subteam, or everyone without one) did: otherwise the group's total minus the listed people would be exactly their
 * numbers. Below it they're left out of every number.
 */
export const PUBLIC_HIDDEN_MIN_GROUP = 2;

export const NAME_STYLES = ["full", "first-initial", "initials", "hidden"] as const;
export type NameStyle = (typeof NAME_STYLES)[number];

export const NAME_STYLE_LABELS: Record<NameStyle, string> = {
  full: "Full names (Ethan Chen)",
  "first-initial": "First name and initial (Ethan C.)",
  initials: "Initials (E.C.)",
  hidden: "No names: team and subteam totals only",
};

export interface PublicProgressSettings {
  /** Off: the endpoint answers {"enabled": false} and the page says progress is private. */
  enabled: boolean;
  nameStyle: NameStyle;
  /** Off: `recent[].title` is null. Titles are free text written for the team: they go to the open internet. */
  showTaskTitles: boolean;
  /**
   * Count tasks due on or after this day. Null = the attendance reports' start (`reportStart`). The Events page
   * (GET /api/public/events) starts there too.
   */
  since: DateOnly | null;
  /**
   * Off: GET /api/public/sponsors answers {"enabled": false} and no logo is served. Independent of `enabled`. Off
   * until someone with admin access turns it on (after the Business team has checked the list), so sponsors added
   * before the website showed them — imported from a spreadsheet, say — never go public on their own.
   */
  showSponsors: boolean;
  /** Off: GET /api/public/events answers {"enabled": false}. Independent of `enabled`. Off until turned on, like sponsors. */
  showEvents: boolean;
  /**
   * Off: GET /api/public/progress/people/<id> (each listed person's profile on the website's Our Team page: their weeks
   * and the last PUBLIC_PERSON_DONE_MAX items they finished, with titles while `showTaskTitles` is on) is the same 404
   * for everyone. Needs `enabled` (and names shown) too. Off until someone with admin access turns it on, so nobody's
   * task-by-task history goes public on its own.
   */
  showPersonPages: boolean;
  /**
   * Off: GET /api/public/team-photos answers {"enabled": false} and no member's photo is served, so the Our Team page
   * shows its own pictures (or initials) only. On by default: each person decides about their own photo (Settings → My
   * photo, "Show my photo on the team website"); this is the team-wide switch on top of that.
   */
  showPhotos: boolean;
}

export const DEFAULT_PUBLIC_PROGRESS_SETTINGS: PublicProgressSettings = {
  enabled: true,
  nameStyle: "full",
  showTaskTitles: true,
  since: null,
  // Off until an admin turns them on (Admin → Team website): existing sponsors and events aren't published on their own.
  showSponsors: false,
  showEvents: false,
  showPersonPages: false,
  // On: each member chooses for their own photo (on by default, with a switch in Settings that says the site is public).
  showPhotos: true,
};

/** The saved settings with defaults for anything missing or unexpected (never throws). */
export function parsePublicProgressSettings(body: string | null | undefined): PublicProgressSettings {
  let raw: unknown = null;
  try {
    raw = body ? JSON.parse(body) : null;
  } catch {
    raw = null;
  }
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_PUBLIC_PROGRESS_SETTINGS;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
    nameStyle: NAME_STYLES.includes(r.nameStyle as NameStyle) ? (r.nameStyle as NameStyle) : d.nameStyle,
    showTaskTitles: typeof r.showTaskTitles === "boolean" ? r.showTaskTitles : d.showTaskTitles,
    since: typeof r.since === "string" && isDateOnly(r.since) ? r.since : d.since,
    showSponsors: typeof r.showSponsors === "boolean" ? r.showSponsors : d.showSponsors,
    showEvents: typeof r.showEvents === "boolean" ? r.showEvents : d.showEvents,
    showPersonPages: typeof r.showPersonPages === "boolean" ? r.showPersonPages : d.showPersonPages,
    showPhotos: typeof r.showPhotos === "boolean" ? r.showPhotos : d.showPhotos,
  };
}

export function serializePublicProgressSettings(settings: PublicProgressSettings): string {
  const { enabled, nameStyle, showTaskTitles, since, showSponsors, showEvents, showPersonPages, showPhotos } = settings;
  return JSON.stringify({ enabled, nameStyle, showTaskTitles, since, showSponsors, showEvents, showPersonPages, showPhotos });
}

/** The first character (a whole one: an emoji or accented letter isn't cut in half), upper-cased. */
function initial(word: string): string {
  return (Array.from(word)[0] ?? "").toUpperCase();
}

/**
 * A person's name as the public page shows it: "Ethan Chen" (full), "Ethan C." (first-initial), "E.C." (initials),
 * or null (hidden). Extra spaces are dropped; a one-word name stays one word ("Ethan" / "E.").
 */
export function publicName(name: string, style: NameStyle): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (style === "hidden" || words.length === 0) return null;
  if (style === "full") return words.join(" ");
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : null;
  if (style === "first-initial") return last ? `${first} ${initial(last)}.` : first;
  return last ? `${initial(first)}.${initial(last)}.` : `${initial(first)}.`;
}

/** Subteam names as the team website writes them ("Build Lead", "Build Team"). */
const SITE_SUBTEAM: Record<Subteam, string> = { SOFTWARE: "Software", BUILD: "Build", BUSINESS: "Business" };

/** A position in the team website's words: "Captain", "Build Lead", "Software Team" (members), "Mentor". */
export function publicRoleLabel(role: Role, subteam: Subteam | null): string {
  switch (role) {
    case "CAPTAIN":
      return "Captain";
    case "SOFTWARE_LEADER":
      return "Software Lead";
    case "BUILD_LEADER":
      return "Build Lead";
    case "BUSINESS_LEADER":
      return "Business Lead";
    case "MENTOR":
      return "Mentor";
    case "TEACHER":
      return "Teacher";
    default:
      return subteam ? `${SITE_SUBTEAM[subteam]} Team` : "Team Member";
  }
}

/** Approved share of done + open as a whole percentage, 0 when there's nothing to count. */
export function publicCompletion(done: number, open: number): number {
  const total = done + open;
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

/**
 * PUBLIC_PROGRESS_EXTRA_ORIGINS ("http://localhost:4321, https://preview.example.org") → origins. Anything that
 * isn't an http(s) origin (a "*", a path, credentials) is left out.
 */
export function parseExtraOrigins(value: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (value ?? "").split(",")) {
    const raw = part.trim();
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) continue;
    if (!out.includes(url.origin)) out.push(url.origin);
  }
  return out;
}

// ── The JSON (GET /api/public/progress) ─────────────────────────────────────────

export interface PublicCounts {
  /** Approved checklist items (also the ones counted when a leader marked the whole task finished). */
  itemsDone: number;
  /** To do, checked off and waiting for review, or sent back — on tasks that aren't marked finished. */
  itemsOpen: number;
  /** Of `itemsOpen`: checked off and waiting for a leader's review. */
  itemsSubmitted: number;
  /** itemsDone / (itemsDone + itemsOpen), whole percent; 0 when both are 0. */
  completion: number;
  /** Items approved on the last 7 days (today and the 6 before it, team timezone). */
  doneLast7Days: number;
}

export interface PublicSubteam extends PublicCounts {
  key: Subteam;
  name: string;
  /** Tasks with an open item of someone in this subteam. */
  tasksActive: number;
  /** Everyone counted in this subteam (people hidden from the list included when they're counted). */
  people: number;
}

export interface PublicPerson extends PublicCounts {
  /** Opaque and stable (an HMAC of the account id with a secret salt): never the account id. */
  id: string;
  name: string;
  subteam: Subteam | null;
  role: string;
  /** Their newest approval, to the minute. */
  lastDoneAt: string | null;
}

export interface PublicRecent {
  /** The task's title, or null when the owner turned task titles off. */
  title: string | null;
  /** The person's subteam. */
  subteam: Subteam | null;
  /** The person's name as the page shows names, or null when names are hidden. (People who left themselves off the
   * list aren't in `recent` at all.) */
  who: string | null;
  /** When it was approved, to the minute. */
  at: string;
}

/** Items approved in one Monday–Sunday week (team timezone). */
export interface PublicWeek {
  weekStart: DateOnly;
  itemsDone: number;
}

export interface PublicProgress {
  enabled: true;
  team: { name: string; number: number };
  since: DateOnly;
  updatedAt: string;
  totals: PublicCounts & {
    /** Tasks with counted items that are marked finished or have every counted item approved. */
    tasksFinished: number;
    /** Tasks with at least one open counted item (and not marked finished). */
    tasksActive: number;
    /** Everyone counted (people hidden from the list included when they're counted). */
    people: number;
  };
  subteams: PublicSubteam[];
  people: PublicPerson[];
  recent: PublicRecent[];
  weekly: PublicWeek[];
}

export type PublicProgressAnswer = PublicProgress | { enabled: false };

// ── One person (GET /api/public/progress/people/<id>) ────────────────────────────

/** One checklist item the person finished (approved), newest first in `done`. */
export interface PublicPersonDone {
  /** The task's title, or null when the owner turned task titles off. */
  title: string | null;
  /** The task's subteam (null for a team-wide task). The person's own subteam is `person.subteam`. */
  subteam: Subteam | null;
  /** When it was approved (for whole-task credit: when the task was marked finished), to the minute. */
  at: string;
  /** Counted because a leader marked the whole task finished (not checked off and approved one by one). */
  withTask: boolean;
}

/**
 * One listed person's page. The endpoint answers a JSON 404 `{ error }` instead — the same one whatever the reason —
 * while the progress page or the profiles (`showPersonPages`) are off, names are hidden, or the id isn't a listed
 * person's (unknown, left themselves off the list, a mentor or teacher, not an active account).
 */
export interface PublicPersonProgress {
  enabled: true;
  updatedAt: string;
  since: DateOnly;
  /** Exactly their entry in the progress JSON's `people`. */
  person: PublicPerson;
  /** Their approvals per week: the same weeks as the progress JSON's `weekly`. */
  weekly: PublicWeek[];
  /** Their newest PUBLIC_PERSON_DONE_MAX approvals (tasks due on or after `since`), whole-task credit included. */
  done: PublicPersonDone[];
}
