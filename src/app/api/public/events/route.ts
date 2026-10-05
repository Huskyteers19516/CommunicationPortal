// GET /api/public/events: the team website's Events page (Huskyteers19516.github.io/events) reads this on load and
// every few minutes. Public — no sign-in, no cookies read (src/lib/public-api.ts lists it for the proxy) — and only
// the Team calendar's meets, ILT, scrimmages, competitions, and outreach that aren't hidden from the website (never
// team meetings, notes, or who added them). Shape and rules: src/lib/public-events.ts,
// src/server/queries/public-events.ts, src/server/public-api.ts (CORS, caching).
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { createPublicAnswerCache, publicEventsResponse } from "@/server/public-api";

/** This server instance's copy of the answer (rebuilt at most every 10 s, whatever the query string). */
const answerCache = createPublicAnswerCache();

function answer(request: Request): Promise<Response> {
  return publicEventsResponse(request, {
    db: prisma,
    now: new Date(),
    teamTimezone: env.teamTimezone,
    extraOrigins: env.publicProgressExtraOrigins,
    cache: answerCache,
  });
}

export async function GET(request: Request): Promise<Response> {
  return answer(request);
}

export async function HEAD(request: Request): Promise<Response> {
  return answer(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return answer(request);
}
