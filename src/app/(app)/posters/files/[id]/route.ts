// Sends a poster's picture or PDF (the id is the PosterFile's). Every ACTIVE person can see posters.
// Headers (images and PDFs inline, nosniff, CSP) come from fileResponseHeaders(); `?download=1` always downloads.
// A poster file's address never shows different bytes (a new file gets a new id; a removed one is a 404), so the
// viewer's browser may keep it for a while (`immutable`): the Posters grid isn't downloaded again on every visit.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getPosterFile } from "@/server/queries/posters";

export async function GET(request: NextRequest, ctx: RouteContext<"/posters/files/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const file = await getPosterFile(user, id);
  if (!file) return plainResponse(404, "That poster file doesn't exist any more.");
  return sendStoredFile(request, file, { immutable: true });
}
