import "server-only";
// Admin → Approvals → Team website: what the Sponsors and Events pages would show right now — counts only — so whoever
// turns them on (they're off until then) knows what goes public. The pages' data: queries/public-sponsors.ts and
// queries/public-events.ts.
import { PUBLIC_EVENTS_MAX } from "@/lib/public-events";
import type { Actor } from "../actor";
import { type Db, prisma } from "../db";
import { canManagePublicProgress } from "../permissions";
import { publicEventsWhere } from "./public-events";
import { getPublicProgressConfig } from "./public-progress";
import { listPublicSponsors } from "./public-sponsors";

export interface TeamWebsitePreview {
  /** Entries on the Sponsors page (sponsors with the same public name are one). */
  sponsors: number;
  /** Of them: shown without a logo. */
  sponsorsWithoutLogo: number;
  /** Events on the Events page (at most PUBLIC_EVENTS_MAX). */
  events: number;
}

/** What the Sponsors and Events pages would list, whether or not they're on. Null for everyone without admin access. */
export async function getTeamWebsitePreview(actor: Actor, teamTimezone: string, db: Db = prisma): Promise<TeamWebsitePreview | null> {
  if (actor.status !== "ACTIVE" || !canManagePublicProgress(actor)) return null;
  const { since } = await getPublicProgressConfig(db);
  const sponsors = await listPublicSponsors(db, teamTimezone);
  const events = await db.calendarEvent.count({ where: publicEventsWhere(since) });
  return {
    sponsors: sponsors.length,
    sponsorsWithoutLogo: sponsors.filter((s) => !s.logo).length,
    events: Math.min(events, PUBLIC_EVENTS_MAX),
  };
}
