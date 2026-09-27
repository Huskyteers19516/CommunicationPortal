// Responses for the routes that send uploaded files (Resources files and sponsor files).
import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { fileResponseHeaders } from "../resources/serve";

/** A short plain-text answer (errors), never cached or sniffed. */
export function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}

/** Not signed in: to /login, coming back to this file afterwards. */
export function redirectToLogin(request: NextRequest): NextResponse {
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

/**
 * Sends a stored file with the locked-down headers from fileResponseHeaders(): shown in the browser only
 * for safe types (text, a few images, PDF), downloaded otherwise; `?download=1` always downloads.
 * `immutable`: the bytes at this address never change (poster files), so the browser may keep them.
 */
export function sendStoredFile(
  request: NextRequest,
  file: { filename: string; contentType: string; data: Uint8Array<ArrayBuffer> },
  options: { immutable?: boolean } = {},
): Response {
  const headers = fileResponseHeaders(
    { filename: file.filename, contentType: file.contentType, byteLength: file.data.byteLength },
    { download: request.nextUrl.searchParams.get("download") === "1", immutable: options.immutable },
  );
  return new Response(file.data, { status: 200, headers });
}
