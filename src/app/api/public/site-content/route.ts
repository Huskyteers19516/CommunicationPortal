// GET /api/public/site-content: the team website reads this once per page view to show the text, links, and pictures
// admins changed in Website Coding (Admin → Website Coding). Public — no sign-in, no cookies read
// (src/lib/public-api.ts lists it for the proxy) — and only the saved values themselves, never who changed them.
// Shape: src/lib/public-site-content.ts; built by src/server/queries/site-content.ts; CORS and caching:
// src/server/public-api.ts.
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { createPublicAnswerCache, publicSiteContentResponse } from "@/server/public-api";

/** This server instance's copy of the answer (rebuilt at most every 10 s, whatever the query string). */
const answerCache = createPublicAnswerCache();

function answer(request: Request): Promise<Response> {
  return publicSiteContentResponse(request, {
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
