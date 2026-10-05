// Sends a Workshop design file (the id is the WorkshopFile's) to signed-in people who can see its project. CAD and
// printing files are always downloads (fileResponseHeaders); PDFs may open in the browser like other uploads.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getWorkshopDownloadFile } from "@/server/queries/workshop";

export async function GET(request: NextRequest, ctx: RouteContext<"/workshop/files/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const file = await getWorkshopDownloadFile(user, id);
  if (!file) return plainResponse(404, "That file doesn't exist any more.");
  return sendStoredFile(request, file);
}
