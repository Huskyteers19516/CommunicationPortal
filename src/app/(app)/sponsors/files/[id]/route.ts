// Sends a file attached to a sponsor (e.g. a paper application form). Only for people who can use
// Sponsorships (the Business team and staff); for everyone else it looks missing (404), so sponsor file
// ids don't leak. Headers (inline only for safe types, nosniff, CSP, no caching) come from
// fileResponseHeaders(); `?download=1` always downloads.
// The bytes come from Postgres or Cloudflare R2 (streamed through here; see src/server/files/respond.ts).
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getSponsorshipFile } from "@/server/queries/sponsorships";

export async function GET(request: NextRequest, ctx: RouteContext<"/sponsors/files/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);

  const { id } = await ctx.params;
  // Null for inactive accounts and people outside Sponsorships too: same answer as a missing file.
  const file = await getSponsorshipFile(user, id);
  if (!file) return plainResponse(404, "That file doesn't exist, or you can't see it.");
  return sendStoredFile(request, file);
}
