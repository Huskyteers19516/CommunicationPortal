// One event as an .ics file ("Add to my calendar" on its page), for any ACTIVE person; 404 for unknown ids.
import type { NextRequest } from "next/server";
import { buildIcs, icsFilename } from "@/lib/calendar";
import { icsResponse, icsViewer } from "@/server/calendar/respond";
import { env } from "@/server/env";
import { plainResponse } from "@/server/files/respond";
import { getCalendarEventForExport } from "@/server/queries/calendar";

export async function GET(request: NextRequest, ctx: RouteContext<"/calendar/[id]/event.ics">): Promise<Response> {
  const viewer = await icsViewer(request);
  if ("response" in viewer) return viewer.response;

  const { id } = await ctx.params;
  const event = await getCalendarEventForExport(id);
  if (!event) return plainResponse(404, "That event isn't on the calendar any more.");
  const body = buildIcs([event], { teamTimezone: env.teamTimezone, now: new Date(), calendarName: "Huskyteers team calendar" });
  return icsResponse(body, icsFilename(event.title));
}
