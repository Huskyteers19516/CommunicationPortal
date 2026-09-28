// Sends a picture from a notebook entry (the id is the NotebookImage's). Every ACTIVE person can read the notebook.
// Headers (inline image, nosniff, CSP) come from fileResponseHeaders(); `?download=1` always downloads. Pictures are
// only ever PNG, JPG, GIF, or WebP (checked by their contents on upload), and a picture's address never shows
// different bytes (a new one gets a new id; a removed one is a 404), so the browser may keep it (`immutable`).
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin, sendStoredFile } from "@/server/files/respond";
import { getNotebookImage } from "@/server/queries/notebook";

export async function GET(request: NextRequest, ctx: RouteContext<"/notebook/images/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const image = await getNotebookImage(user, id);
  if (!image) return plainResponse(404, "That picture doesn't exist any more.");
  return sendStoredFile(request, image, { immutable: true });
}
