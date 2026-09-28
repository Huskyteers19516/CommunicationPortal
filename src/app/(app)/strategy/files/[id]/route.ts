// Sends a file on a strategy (the id is the StrategyFile's). Every ACTIVE person can see strategies.
// Headers come from strategyFileHeaders(): pictures and PDFs inline, everything else downloaded, nosniff, CSP,
// no caching. A .pp path is always a download (open it in the planner with Load); `?download=1` always downloads.
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin } from "@/server/files/respond";
import { getStrategyFile, strategyFileHeaders } from "@/server/queries/strategy";

export async function GET(request: NextRequest, ctx: RouteContext<"/strategy/files/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const file = await getStrategyFile(user, id);
  if (!file) return plainResponse(404, "That strategy file doesn't exist any more.");
  const headers = strategyFileHeaders(
    { filename: file.filename, contentType: file.contentType, byteLength: file.data.byteLength },
    { download: request.nextUrl.searchParams.get("download") === "1" },
  );
  return new Response(file.data, { status: 200, headers });
}
