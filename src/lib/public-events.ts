// The team website's Events page (huskyteers19516.github.io/events), from GET /api/public/events
// (src/app/api/public/events/route.ts, built by src/server/queries/public-events.ts). Client-safe: which kinds of
// Team calendar events are published, the calendar's "On the team website" marker, and the JSON's types.
//
// Published: league meets, the ILT, scrimmages, competitions, and outreach — unless "Hide from the team website" is
// on. Never team meetings (Extra meeting), team events, deadlines, or "other". Never notes, who added or edited an
// event, or where it came from (sourceKey).
import type { CalendarEventKind } from "@/generated/prisma/enums";
import { CALENDAR_EVENT_KIND_LABELS } from "./constants";
import type { DateOnly } from "./dates";

/** The kinds the team website lists (in the calendar's order). */
export const PUBLIC_EVENT_KINDS: readonly CalendarEventKind[] = ["MEET", "ILT", "SCRIMMAGE", "COMPETITION", "OUTREACH"];

/** Most events one answer has: the latest ones by first day (a season has a few dozen). */
export const PUBLIC_EVENTS_MAX = 300;

export function isPublicEventKind(kind: CalendarEventKind): boolean {
  return PUBLIC_EVENT_KINDS.includes(kind);
}

/** "League meets, the ILT, scrimmages, competitions, and outreach" (for the form's hint). */
export const PUBLIC_EVENT_KINDS_SENTENCE = "league meets, the ILT, scrimmages, competitions, and outreach";

/**
 * What the calendar says about an event and the team website: "public" (listed on the Events page), "hidden" (a
 * public kind with "Hide from the team website" on), or null (a kind that's never published, the Events page is
 * turned off, or it ended before the season the website starts at).
 */
export type PublicEventStatus = "public" | "hidden" | null;

export function publicEventStatus(
  event: { kind: CalendarEventKind; hideFromWebsite: boolean; startsOn: DateOnly; endsOn: DateOnly | null },
  website: { showEvents: boolean; since: DateOnly },
): PublicEventStatus {
  if (!website.showEvents || !isPublicEventKind(event.kind)) return null;
  const lastDay = event.endsOn && event.endsOn > event.startsOn ? event.endsOn : event.startsOn;
  if (lastDay < website.since) return null;
  return event.hideFromWebsite ? "hidden" : "public";
}

// ── The JSON (GET /api/public/events) ─────────────────────────────────────────

export interface PublicEvent {
  /** The calendar event's id (stable, so the website can tell events apart between refreshes). */
  id: string;
  title: string;
  kind: CalendarEventKind;
  /** The calendar's label for the kind ("League meet", "Outreach"…). */
  kindLabel: string;
  /** First day (team timezone). */
  startsOn: DateOnly;
  /** Last day (inclusive), or null for a one-day event. */
  endsOn: DateOnly | null;
  /** "HH:MM" (24 h, team timezone), or null = all day / not known yet. */
  startTime: string | null;
  /** "HH:MM", only with a start time. On a multi-day event: the last day's end. */
  endTime: string | null;
  /** Venue and/or address ("" = not set). */
  location: string;
  /** An http(s) link (FTC Events page, a sign-up form…), or null. */
  link: string | null;
}

export interface PublicEvents {
  enabled: true;
  updatedAt: string;
  /** The IANA timezone the days and times are in (the team's: America/Los_Angeles). */
  timezone: string;
  /** By first day, then start time (all-day first), then title. */
  events: PublicEvent[];
}

export type PublicEventsAnswer = PublicEvents | { enabled: false };

export function publicEventKindLabel(kind: CalendarEventKind): string {
  return CALENDAR_EVENT_KIND_LABELS[kind];
}
