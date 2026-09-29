// Sends an uploaded Resources file. Same visibility as the resource itself (canViewResource):
// approved files for everyone signed in; pending / turned-down ones only for the person who shared
// them and the reviewers. Headers (inline vs download, nosniff, CSP, no caching) come from
// fileResponseHeaders(); `?download=1` always downloads.
// The bytes come from Postgres or Cloudflare R2 (streamed through here; see src/server/files/respond.ts).
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getResourceFile } from "@/server/queries/resources";

export async function GET(request: NextRequest, ctx: RouteContext<"/resources/files/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const file = await getResourceFile(user, id);
  // Missing and not-allowed look the same, so ids of other people's pending files don't leak.
  if (!file) return plainResponse(404, "That file doesn't exist, or you can't see it.");
  return sendStoredFile(request, file);
}
