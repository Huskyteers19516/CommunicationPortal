// Shows a sponsor's logo on its page (the "Team website" section), for people who can use Sponsorships (the Business
// team and staff) — also before the sponsor is on the team website, which serves public logos itself
// (/api/public/sponsors/logos/[id]). Everyone else gets a 404, so logo ids don't leak. Headers as for posters
// (inline picture, nosniff, CSP; `immutable`: a replaced logo gets a new id). Bytes from Postgres or Cloudflare R2.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getSponsorshipLogo } from "@/server/queries/sponsorships";

export async function GET(request: NextRequest, ctx: RouteContext<"/sponsors/logos/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);

  const { id } = await ctx.params;
  const logo = await getSponsorshipLogo(user, id);
  if (!logo) return plainResponse(404, "That logo doesn't exist, or you can't see it.");
  return sendStoredFile(request, logo, { immutable: true });
}
