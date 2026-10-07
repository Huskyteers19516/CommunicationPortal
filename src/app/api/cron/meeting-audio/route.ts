// GET /api/cron/meeting-audio: Vercel's daily job (vercel.json, 11:00 UTC) — deletes meeting recordings past their
// 3 days (purgeExpiredMeetingAudio) and then their Cloudflare R2 objects. Every read already treats an expired
// recording as gone; this frees the space even in weeks when nobody opens Meeting recaps (whose pages do the same
// after each visit: src/server/meetings/purge.ts).
//
// Vercel calls it without a session, so the proxy lets exactly this path through (src/proxy.ts). With CRON_SECRET set
// (Vercel then sends `Authorization: Bearer <secret>`), only that is accepted. Without it, anyone may call it, a few
// times an hour at most (a rate limit): that's harmless, because all it can ever do is delete recordings that are
// already past their 3 days — what the next visit to Meeting recaps would delete anyway.
import { NextResponse } from "next/server";
import { safeEqual } from "@/server/attendance/codes";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { drainFileDeletions, getObjectStore } from "@/server/files/object-store";
import { consumeRateLimit } from "@/server/rate-limit";
import { purgeExpiredMeetingAudio } from "@/server/services/meeting-recaps";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Runs per hour while CRON_SECRET isn't set. */
const MEETING_AUDIO_CRON_RUNS_PER_HOUR = 12;

function json(status: number, body: Record<string, unknown>): Response {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = env.cronSecret;
  if (secret) {
    if (!safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) return json(401, { error: "Not authorized." });
  } else if (!(await consumeRateLimit(prisma, "cron:meeting-audio", MEETING_AUDIO_CRON_RUNS_PER_HOUR, 60 * 60 * 1000))) {
    return json(429, { error: "This already ran several times this hour. Try again later." });
  }

  const purged = await purgeExpiredMeetingAudio(prisma, new Date());
  const store = getObjectStore();
  const drained = store ? await drainFileDeletions(prisma, { store, limit: 500, budgetMs: 40_000 }) : null;
  if (drained?.error) console.error(`[meetings] daily cleanup: ${drained.failed} R2 deletes failed (${drained.error})`);
  return json(200, {
    ok: true,
    recordings: purged.recaps,
    parts: purged.parts,
    filesDeleted: drained?.deleted ?? 0,
    filesWaiting: drained?.remaining ?? 0,
  });
}
