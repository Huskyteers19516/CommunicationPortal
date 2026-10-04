// GET /api/public/progress: the team website's live progress page (Huskyteers19516.github.io/progress) polls this.
// Public — no sign-in, no cookies read (the proxy lets /api/public/* through) — and only aggregate numbers. Shape and
// rules: src/lib/public-progress.ts, src/server/queries/public-progress.ts, src/server/public-api.ts (CORS, caching).
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { publicProgressResponse } from "@/server/public-api";

function answer(request: Request): Promise<Response> {
  return publicProgressResponse(request, {
    db: prisma,
    now: new Date(),
    teamTimezone: env.teamTimezone,
    extraOrigins: env.publicProgressExtraOrigins,
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
