// GET /api/public/workshop/files/<WorkshopFile id>: a design file (STL, STEP…) of an approved Workshop project, always
// a download. Public — no sign-in, no cookies read (src/lib/public-api.ts lets one id after this prefix through the
// proxy) — and only while its project is approved; otherwise a 404. Served by publicFileResponse
// (src/server/public-api.ts), like the photos.
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { publicWorkshopFileResponse } from "@/server/public-api";

async function answer(request: NextRequest, ctx: RouteContext<"/api/public/workshop/files/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return publicWorkshopFileResponse(request, { db: prisma, id });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/public/workshop/files/[id]">): Promise<Response> {
  return answer(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext<"/api/public/workshop/files/[id]">): Promise<Response> {
  return answer(request, ctx);
}
