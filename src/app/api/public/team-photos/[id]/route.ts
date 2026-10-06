// GET /api/public/team-photos/<UserPhoto id>: a member's own photo for the team website's Our Team page. Public — no
// sign-in, no cookies read (src/lib/public-api.ts lets one id after this prefix through the proxy) — and only while
// it's published (its owner ACTIVE with "Show my photo on the team website" on, and the team showing photos);
// otherwise a 404. Served by publicFileResponse (src/server/public-api.ts): a query string is redirected to the bare
// address before anything is read; streamed from Cloudflare R2 or sent from Postgres with publicFileHeaders — inline,
// nosniff, sandboxed, under a neutral name, cacheable (a new photo gets a new id).
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { publicTeamPhotoResponse } from "@/server/public-api";

async function answer(request: NextRequest, ctx: RouteContext<"/api/public/team-photos/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return publicTeamPhotoResponse(request, { db: prisma, id });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/public/team-photos/[id]">): Promise<Response> {
  return answer(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext<"/api/public/team-photos/[id]">): Promise<Response> {
  return answer(request, ctx);
}
