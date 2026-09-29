// "Download .pp" on Strategy → Paths: a saved path as a .pp file (the planner's Load opens it). Every ACTIVE
// person sees every saved path. Always a download (application/octet-stream, nosniff, sandboxing CSP, no caching),
// named after the path ("Red auto.pp").
import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { plainResponse, redirectToLogin } from "@/server/files/respond";
import { cleanFilename } from "@/server/files/upload";
import { getPlannerPath } from "@/server/queries/planner-paths";
import { fileResponseHeaders } from "@/server/resources/serve";

/**
 * "Red auto: v2" → "Red auto v2.pp": cleaned like an upload's name, without the characters Windows can't have in a
 * file name; a name already ending in .pp keeps one.
 */
function ppFilename(name: string): string {
  const base = name
    .replace(/\.pp$/i, "")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanFilename(`${base || "path"}.pp`);
}

export async function GET(request: NextRequest, ctx: RouteContext<"/strategy/paths/[id]/download">): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return redirectToLogin(request);
  if (user.status !== "ACTIVE") return plainResponse(403, "Your account isn't active yet.");

  const { id } = await ctx.params;
  const path = await getPlannerPath(user, id);
  if (!path) return plainResponse(404, "That path isn't in the team's saved paths any more.");
  const bytes = new TextEncoder().encode(path.data);
  const headers = fileResponseHeaders(
    { filename: ppFilename(path.name), contentType: "application/json", byteLength: bytes.byteLength },
    { download: true },
  );
  return new Response(bytes, { status: 200, headers });
}
