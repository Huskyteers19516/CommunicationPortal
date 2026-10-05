// GET /api/public/workshop: the team website's Workshop page (Huskyteers19516.github.io/workshop) reads this once per
// visit. Public — no sign-in, no cookies read (src/lib/public-api.ts lists it for the proxy) — and only approved
// projects. Shape and rules: src/lib/workshop.ts (PublicWorkshop), src/server/queries/public-workshop.ts,
// src/server/public-api.ts (CORS, caching).
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { createPublicAnswerCache, publicWorkshopResponse } from "@/server/public-api";

/** This server instance's copy of the answer (rebuilt at most every 10 s, whatever the query string). */
const answerCache = createPublicAnswerCache();

function answer(request: Request): Promise<Response> {
  return publicWorkshopResponse(request, {
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
