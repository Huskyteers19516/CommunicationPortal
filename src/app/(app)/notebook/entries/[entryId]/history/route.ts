// An entry's earlier versions, for its History (loaded when History is opened, so a page of long entries that were
// changed many times stays small). Every ACTIVE person can read them, like the entries themselves.
import type { NextRequest } from "next/server";
import type { NotebookHistoryJson } from "@/lib/notebook";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse } from "@/server/files/respond";
import { getNotebookEntryHistory } from "@/server/queries/notebook";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ entryId: string }> }): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return plainResponse(401, "Sign in again to see the history.");
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { entryId } = await ctx.params;
  const history = await getNotebookEntryHistory(user, entryId);
  if (!history) return plainResponse(404, "That entry no longer exists.");
  const body: NotebookHistoryJson = {
    title: history.title,
    body: history.body,
    versions: history.versions.map((v) => ({ ...v, editedAt: v.editedAt.toISOString() })),
    historyCount: history.historyCount,
    canClear: history.canClear,
  };
  return Response.json(body, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
