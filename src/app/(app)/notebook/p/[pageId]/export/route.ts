// One notebook page as a Word file (.docx): see src/server/notebook/docx.ts. Every ACTIVE person can export.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { env } from "@/server/env";
import { plainResponse, redirectToLogin } from "@/server/files/respond";
import { notebookDocxResponse } from "@/server/notebook/docx";
import { getNotebookExport } from "@/server/queries/notebook";

export async function GET(request: NextRequest, ctx: RouteContext<"/notebook/p/[pageId]/export">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { pageId } = await ctx.params;
  const data = await getNotebookExport(user, { pageId });
  if (!data) return plainResponse(404, "That page doesn't exist any more.");
  return notebookDocxResponse(data, env.teamTimezone);
}
