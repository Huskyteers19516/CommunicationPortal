import "server-only";
// The team website's Events page (GET /api/public/events, no sign-in): the Team calendar's league meets, the ILT,
// scrimmages, competitions, and outreach that aren't hidden from the website, from where the season starts (the
// public settings' `since`, else the attendance reports' start) on. Never team meetings (Extra meeting), team events,
// deadlines, or "other"; never notes, who added or edited an event, or its sourceKey. See "Public API for the team
// website" in docs/CONVENTIONS.md.
import type { Prisma } from "@/generated/prisma/client";
import { dateOnlyToDb, dbToDateOnly } from "@/lib/dates";
import {
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENTS_MAX,
  type PublicEvent,
  type PublicEventsAnswer,
  publicEventKindLabel,
} from "@/lib/public-events";
import { parseHttpUrl } from "@/lib/urls";
import { type Db, prisma } from "../db";
import { getPublicProgressConfig, type PublicProgressConfig } from "./public-progress";

/** The events the website may list from `since` on (whether the owner turned events off is checked separately). */
export function publicEventsWhere(since: string): Prisma.CalendarEventWhereInput {
  const d = dateOnlyToDb(since);
  return {
    kind: { in: [...PUBLIC_EVENT_KINDS] },
    hideFromWebsite: false,
    // Its last day is on or after `since` (a tournament that started the day before still counts).
    OR: [{ endsOn: { gte: d } }, { endsOn: null, startsOn: { gte: d } }],
  };
}

/** The website's settings for events: whether they're shown and the day they start from (the calendar's marker). */
export async function getPublicEventsWebsite(db: Db = prisma): Promise<{ showEvents: boolean; since: string }> {
  const config: PublicProgressConfig = await getPublicProgressConfig(db);
  return { showEvents: config.settings.showEvents, since: config.since };
}

/**
 * Everything the Events page shows, or {enabled: false} while events are turned off. At most PUBLIC_EVENTS_MAX: the
 * latest ones by first day (so what's coming up is never cut), listed by first day, then start time (all day first),
 * then title.
 */
export async function getPublicEvents(db: Db, options: { now: Date; teamTimezone: string }): Promise<PublicEventsAnswer> {
  const { settings, since } = await getPublicProgressConfig(db);
  if (!settings.showEvents) return { enabled: false };

  const rows = await db.calendarEvent.findMany({
    where: publicEventsWhere(since),
    // Never notes, creators, editors, or sourceKey.
    select: { id: true, title: true, kind: true, startsOn: true, endsOn: true, startTime: true, endTime: true, location: true, link: true },
    // Newest first, so the cap drops the oldest; turned around below.
    orderBy: [{ startsOn: "desc" }, { startTime: { sort: "desc", nulls: "last" } }, { title: "desc" }, { id: "desc" }],
    take: PUBLIC_EVENTS_MAX,
  });
  rows.reverse();

  const events: PublicEvent[] = rows.map((r) => {
    const startsOn = dbToDateOnly(r.startsOn);
    const endsOn = r.endsOn ? dbToDateOnly(r.endsOn) : null;
    return {
      id: r.id,
      title: r.title,
      kind: r.kind,
      kindLabel: publicEventKindLabel(r.kind),
      startsOn,
      endsOn: endsOn && endsOn > startsOn ? endsOn : null,
      startTime: r.startTime,
      endTime: r.startTime ? r.endTime : null,
      location: r.location,
      // Rows can be written outside the app: only ever link to http(s).
      link: r.link ? parseHttpUrl(r.link) : null,
    };
  });
  return { enabled: true, updatedAt: options.now.toISOString(), timezone: options.teamTimezone, events };
}
