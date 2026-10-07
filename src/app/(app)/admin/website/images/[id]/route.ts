// Shows a Website Coding picture in Admin → Website Coding — also earlier ones kept for Undo, which the public route
// (/api/public/site-images/[id]) doesn't serve — to people who can edit the website. Everyone else gets a 404, so
// picture ids don't leak. Headers as for other pictures (inline, nosniff, CSP; `immutable`: a new picture gets a new
// id). Bytes from Postgres or Cloudflare R2.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getSiteImageFile } from "@/server/queries/site-content";

export async function GET(request: NextRequest, ctx: RouteContext<"/admin/website/images/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);

  const { id } = await ctx.params;
  const image = await getSiteImageFile(user, id);
  if (!image) return plainResponse(404, "That picture doesn't exist, or you can't see it.");
  return sendStoredFile(request, image, { immutable: true });
}
