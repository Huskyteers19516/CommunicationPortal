import "server-only";
// After an action that deletes file rows (a resource, a sponsor, a poster, a notebook and everything in it, a
// strategy, a league team…), the database has queued their Cloudflare R2 objects in FileDeletion (triggers, also for
// cascades). This deletes them from R2 after the response is sent, so the person never waits and never sees an error
// from it; whatever fails stays queued for the next time (or the owner's "Clean up" on Admin → Approvals).
import { after } from "next/server";
import { prisma } from "../db";
import { drainFileDeletions, getObjectStore } from "./object-store";

/** Deletes queued R2 objects after the response. Does nothing when R2 isn't set up. Never throws. */
export function scheduleFileCleanup(): void {
  const store = getObjectStore();
  if (!store) return;
  const run = async () => {
    const result = await drainFileDeletions(prisma, { store, limit: 100 });
    if (result.error) console.error(`[files] cleanup after a delete: ${result.failed} failed (${result.error})`);
  };
  try {
    after(run);
  } catch {
    // Outside a request (scripts): run it now, still without failing the caller.
    void run();
  }
}
