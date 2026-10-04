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
/** The public JSON endpoint (this site). */
export const PUBLIC_PROGRESS_PATH = "/api/public/progress";

/** Used when neither the settings nor the attendance schedule say where the season starts. */
export const PUBLIC_PROGRESS_DEFAULT_SINCE: DateOnly = "2026-08-31";

/** Most entries in `recent`. */
export const PUBLIC_RECENT_MAX = 15;
/** Weeks in `weekly` (Monday to Sunday, team timezone, the current one last). */
export const PUBLIC_WEEKS = 8;

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
  /** Off: `recent[].title` is null. */
  showTaskTitles: boolean;
  /** Count tasks due on or after this day. Null = the attendance reports' start (`reportStart`). */
  since: DateOnly | null;
}

export const DEFAULT_PUBLIC_PROGRESS_SETTINGS: PublicProgressSettings = {
  enabled: true,
  nameStyle: "full",
  showTaskTitles: true,
  since: null,
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
  };
}

export function serializePublicProgressSettings(settings: PublicProgressSettings): string {
  const { enabled, nameStyle, showTaskTitles, since } = settings;
  return JSON.stringify({ enabled, nameStyle, showTaskTitles, since });
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
  /** Everyone counted in this subteam (people hidden from the list included). */
  people: number;
}

export interface PublicPerson extends PublicCounts {
  /** Opaque and stable (an HMAC of the account id with a secret salt): never the account id. */
  id: string;
  name: string;
  subteam: Subteam | null;
  role: string;
  lastDoneAt: string | null;
}

export interface PublicRecent {
  /** The task's title, or null when the owner turned task titles off. */
  title: string | null;
  /** The person's subteam. */
  subteam: Subteam | null;
  /** The person's name as the page shows names, or null (names hidden, or they left themselves off). */
  who: string | null;
  at: string;
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
    /** Everyone counted (people hidden from the list included). */
    people: number;
  };
  subteams: PublicSubteam[];
  people: PublicPerson[];
  recent: PublicRecent[];
  weekly: { weekStart: DateOnly; itemsDone: number }[];
}

export type PublicProgressAnswer = PublicProgress | { enabled: false };
