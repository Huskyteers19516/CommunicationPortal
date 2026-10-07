import "server-only";
// Recordings on Meeting recaps are kept 3 days. Every read already treats one past its 3 days as gone; this deletes
// what's left of them after the response (the meeting pages and actions call it): one cheap query when nothing is
// due, else purgeExpiredMeetingAudio, then the R2 objects that queued (like scheduleFileCleanup). Vercel's daily cron
// (src/app/api/cron/meeting-audio/route.ts) does the same, for weeks when nobody opens the pages.
import { after } from "next/server";
import { prisma } from "../db";
import { drainFileDeletions, getObjectStore } from "../files/object-store";
import { hasExpiredMeetingAudio, purgeExpiredMeetingAudio } from "../services/meeting-recaps";

/** Deletes expired recordings after the response. Never throws, never delays the page. */
export function scheduleMeetingAudioPurge(): void {
  const run = async () => {
    try {
      const now = new Date();
      if (!(await hasExpiredMeetingAudio(prisma, now))) return;
      const { parts } = await purgeExpiredMeetingAudio(prisma, now);
      const store = getObjectStore();
      if (!store || parts === 0) return;
      const result = await drainFileDeletions(prisma, { store, limit: 100 });
      if (result.error) console.error(`[meetings] cleanup after deleting old recordings: ${result.failed} failed (${result.error})`);
    } catch (e) {
      console.error("[meetings] couldn't delete expired recordings (the next visit or the daily job tries again)", e);
    }
  };
  try {
    after(run);
  } catch {
    // Outside a request (scripts): run it now, still without failing the caller.
    void run();
  }
}
