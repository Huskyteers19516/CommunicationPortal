// Sends one part of a meeting recap's recording (the id is the MeetingAudioPart's) to any ACTIVE person, while the
// recording is kept: once it's past its 3 days or was deleted, a 404 (even before its parts are purged). The player
// fetches the parts in order and joins them into one file in the browser, so each response stays ≤ 3 MiB (Vercel's
// limit). Always an application/octet-stream download, never cached (meetingAudioHeaders). Bytes from Postgres or
// Cloudflare R2 (streamed through here; see src/server/files/respond.ts).
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getMeetingAudioPartFile, meetingAudioHeaders } from "@/server/queries/meeting-recaps";

export async function GET(request: NextRequest, ctx: RouteContext<"/meetings/audio/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const part = await getMeetingAudioPartFile(user, id);
  if (!part) return plainResponse(404, "That recording was deleted (recordings are kept for 3 days).");
  return sendStoredFile(request, part, { headers: meetingAudioHeaders });
}
