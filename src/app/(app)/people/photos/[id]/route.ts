// Sends a member's own photo (the id is the UserPhoto's) to signed-in ACTIVE people while its owner shows it in the
// portal ("Show my photo in the portal"), to its owner always, and to people who manage the owner's account; anything
// else — a replaced or removed photo, a hidden one — is a 404 (src/server/queries/user-photos.ts). A photo's address
// never shows different bytes (a new photo gets a new id), so the viewer's browser may keep it (`immutable`): avatars
// aren't downloaded again on every page. The bytes come from Postgres or Cloudflare R2 (src/server/files/respond.ts).
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getUserPhotoFile } from "@/server/queries/user-photos";

export async function GET(request: NextRequest, ctx: RouteContext<"/people/photos/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const file = await getUserPhotoFile(user, id);
  if (!file) return plainResponse(404, "That photo isn't shown any more.");
  return sendStoredFile(request, file, { immutable: true });
}
