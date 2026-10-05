// GET /api/public/sponsors: the team website's Sponsors page (Huskyteers19516.github.io/sponsors) reads this once per
// visit. Public — no sign-in, no cookies read (src/lib/public-api.ts lists it for the proxy) — and only each public
// sponsor's name, website, years, and logo address. Shape and rules: src/lib/public-sponsors.ts,
// src/server/queries/public-sponsors.ts, src/server/public-api.ts (CORS, caching).
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { createPublicAnswerCache, publicSponsorsResponse } from "@/server/public-api";

/** This server instance's copy of the answer (rebuilt at most every 10 s, whatever the query string). */
const answerCache = createPublicAnswerCache();

function answer(request: Request): Promise<Response> {
  return publicSponsorsResponse(request, {
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
