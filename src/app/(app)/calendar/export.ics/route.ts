// "Add to my calendar": every event from about a year ago onward as one .ics file, for any ACTIVE person.
// Importing it again updates the events already imported (each has a stable UID).
import type { NextRequest } from "next/server";
import { buildIcs } from "@/lib/calendar";
import { addDays, todayInTimezone } from "@/lib/dates";
import { icsResponse, icsViewer } from "@/server/calendar/respond";
import { env } from "@/server/env";
import { getCalendarEventsForExport } from "@/server/queries/calendar";

export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await icsViewer(request);
  if ("response" in viewer) return viewer.response;

  const now = new Date();
  const since = addDays(todayInTimezone(env.teamTimezone, now), -365);
  const events = await getCalendarEventsForExport(since);
  const body = buildIcs(events, { teamTimezone: env.teamTimezone, now, calendarName: "Huskyteers team calendar" });
  return icsResponse(body, "huskyteers-calendar.ics");
}
