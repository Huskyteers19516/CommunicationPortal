// Sends a Workshop photo (the id is the WorkshopPhoto's) to signed-in people who can see its project: everyone for
// approved projects, the people who can change it (and reviewers) for drafts. A photo's address never shows different
// bytes (a new photo gets a new id), so the viewer's browser may keep it (`immutable`). Approved photos are public on
// /api/public/workshop/photos/<id> too.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getWorkshopPhotoFile } from "@/server/queries/workshop";

export async function GET(request: NextRequest, ctx: RouteContext<"/workshop/photos/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const file = await getWorkshopPhotoFile(user, id);
  if (!file) return plainResponse(404, "That photo doesn't exist any more.");
  return sendStoredFile(request, file, { immutable: true });
}
