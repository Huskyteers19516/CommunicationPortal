// Responses for the Team calendar's .ics downloads (src/app/(app)/calendar/export.ics and [id]/event.ics).
import "server-only";
import type { NextRequest } from "next/server";
import type { Actor } from "../actor";
import { getCurrentUser } from "../auth/session";
import { plainResponse, redirectToLogin } from "../files/respond";

/**
 * The signed-in ACTIVE user, or the response to send instead: not signed in → to /login (coming back here
 * afterwards), not active → 403. Same as the file routes.
 */
export async function icsViewer(request: NextRequest): Promise<{ user: Actor } | { response: Response }> {
  const user = await getCurrentUser();
  if (!user) return { response: redirectToLogin(request) };
  if (user.status !== "ACTIVE") return { response: plainResponse(403, "Your account isn't active yet.") };
  return { user };
}

/** An .ics file as a download (never cached, never sniffed). `filename` must be plain ASCII. */
export function icsResponse(body: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
