// Sends an uploaded Resources file. Same visibility as the resource itself (canViewResource):
// approved files for everyone signed in; pending / turned-down ones only for the person who shared
// them and the reviewers. Headers (inline vs download, nosniff, CSP, no caching) come from
// fileResponseHeaders(); `?download=1` always downloads.
import { type NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { getResourceFile } from "@/server/queries/resources";
import { fileResponseHeaders } from "@/server/resources/serve";

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/resources/files/[id]">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  if (user.status !== "ACTIVE") return plain(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const file = await getResourceFile(user, id);
  // Missing and not-allowed look the same, so ids of other people's pending files don't leak.
  if (!file) return plain(404, "That file doesn't exist, or you can't see it.");

  const headers = fileResponseHeaders(
    { filename: file.filename, contentType: file.contentType, byteLength: file.data.byteLength },
    { download: request.nextUrl.searchParams.get("download") === "1" },
  );
  return new Response(file.data, { status: 200, headers });
}
