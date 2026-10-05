// GET /api/public/sponsors/logos/<SponsorshipLogo id>: a sponsor's logo for the team website's Sponsors page. Public
// — no sign-in, no cookies read (src/lib/public-api.ts lets one id after this prefix through the proxy) — and only
// while that sponsor is on the team website (Accepted or Finished, "Thank them on the team website" on, sponsors not
// turned off); otherwise a 404. Served by publicFileResponse (src/server/public-api.ts): a query string is redirected
// to the bare address before anything is read; streamed from Cloudflare R2 or sent from Postgres with
// publicFileHeaders — inline, nosniff, sandboxed, under a neutral name, cacheable (a replaced logo gets a new id).
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { publicSponsorLogoResponse } from "@/server/public-api";

async function answer(request: NextRequest, ctx: RouteContext<"/api/public/sponsors/logos/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return publicSponsorLogoResponse(request, { db: prisma, id });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/public/sponsors/logos/[id]">): Promise<Response> {
  return answer(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext<"/api/public/sponsors/logos/[id]">): Promise<Response> {
  return answer(request, ctx);
}
