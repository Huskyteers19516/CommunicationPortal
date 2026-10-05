// GET /api/public/workshop/photos/<WorkshopPhoto id>: a photo of an approved Workshop project for the team website's
// Workshop page. Public — no sign-in, no cookies read (src/lib/public-api.ts lets one id after this prefix through the
// proxy) — and only while its project is approved; otherwise a 404. Served by publicFileResponse
// (src/server/public-api.ts): a query string is redirected to the bare address before anything is read; streamed from
// Cloudflare R2 or sent from Postgres with publicFileHeaders — inline, nosniff, sandboxed, under a neutral name.
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { publicWorkshopPhotoResponse } from "@/server/public-api";

async function answer(request: NextRequest, ctx: RouteContext<"/api/public/workshop/photos/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return publicWorkshopPhotoResponse(request, { db: prisma, id });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/public/workshop/photos/[id]">): Promise<Response> {
  return answer(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext<"/api/public/workshop/photos/[id]">): Promise<Response> {
  return answer(request, ctx);
}
