// GET /api/public/site-images/<SiteImage id>: a picture admins put on the team website in Website Coding. Public — no
// sign-in, no cookies read (src/lib/public-api.ts lets one id after this prefix through the proxy) — and only while
// some slot shows it; otherwise a 404 (earlier pictures kept for Undo stay private). Served by publicFileResponse
// (src/server/public-api.ts): a query string is redirected to the bare address before anything is read; streamed from
// Cloudflare R2 or sent from Postgres — inline, nosniff, sandboxed, under a neutral name, cacheable (a new picture gets
// a new id).
import type { NextRequest } from "next/server";
import { prisma } from "@/server/db";
import { publicSiteImageResponse } from "@/server/public-api";

async function answer(request: NextRequest, ctx: RouteContext<"/api/public/site-images/[id]">): Promise<Response> {
  const { id } = await ctx.params;
  return publicSiteImageResponse(request, { db: prisma, id });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/public/site-images/[id]">): Promise<Response> {
  return answer(request, ctx);
}

export async function HEAD(request: NextRequest, ctx: RouteContext<"/api/public/site-images/[id]">): Promise<Response> {
  return answer(request, ctx);
}
