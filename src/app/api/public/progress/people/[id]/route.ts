// GET /api/public/progress/people/<person id>: one listed person's progress for the team website's Our Team page (a
// person's card opens it). <person id> is the opaque `people[].id` of GET /api/public/progress, never an account id.
// Public — no sign-in, no cookies read (src/lib/public-api.ts lets one id after this prefix through the proxy) — and
// only what the progress JSON already shows about them plus what they finished; anyone it doesn't list is one JSON
// 404. Shape and rules: src/lib/public-progress.ts (PublicPersonProgress), src/server/queries/public-progress.ts
// (getPublicPersonProgress), src/server/public-api.ts (CORS, caching).
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import {
  createPublicAnswerCacheMap,
  createPublicValueCache,
  PUBLIC_PERSON_CACHE_MAX,
  publicPersonProgressResponse,
} from "@/server/public-api";
import type { PublicPeopleDirectory } from "@/server/queries/public-progress";

/** This server instance's answers, per listed id (each rebuilt at most every 10 s, whatever the query string). */
const answerCache = createPublicAnswerCacheMap(PUBLIC_PERSON_CACHE_MAX);
/** Who can be found right now (rebuilt at most every 10 s): any other id is a 404 without touching the database. */
const directoryCache = createPublicValueCache<PublicPeopleDirectory | null>();

async function answer(request: Request, ctx: RouteContext<"/api/public/progress/people/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return publicPersonProgressResponse(request, {
    db: prisma,
    now: new Date(),
    teamTimezone: env.teamTimezone,
    extraOrigins: env.publicProgressExtraOrigins,
    cache: answerCache,
    directory: directoryCache,
    id,
  });
}

export async function GET(request: Request, ctx: RouteContext<"/api/public/progress/people/[id]">): Promise<Response> {
  return answer(request, ctx);
}

export async function HEAD(request: Request, ctx: RouteContext<"/api/public/progress/people/[id]">): Promise<Response> {
  return answer(request, ctx);
}

export async function OPTIONS(request: Request, ctx: RouteContext<"/api/public/progress/people/[id]">): Promise<Response> {
  return answer(request, ctx);
}
