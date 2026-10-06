// GET /api/public/team-photos: the team website's Our Team page reads this once per visit to put members' own photos
// on their cards (matched by full name). Public — no sign-in, no cookies read (src/lib/public-api.ts lists it for the
// proxy) — and only each published photo's owner's full name and the photo's address. Shape and rules:
// src/lib/user-photos.ts, src/server/queries/public-team-photos.ts, src/server/public-api.ts (CORS, caching).
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { createPublicAnswerCache, publicTeamPhotosResponse } from "@/server/public-api";

/** This server instance's copy of the answer (rebuilt at most every 10 s, whatever the query string). */
const answerCache = createPublicAnswerCache();

function answer(request: Request): Promise<Response> {
  return publicTeamPhotosResponse(request, {
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
