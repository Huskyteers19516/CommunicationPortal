import { type NextRequest, NextResponse } from "next/server";

// Optimistic check only (no DB): bounce visitors without a session cookie to /login.
// Real authentication/authorization happens in layouts, pages, and services.
const SESSION_COOKIE = "hk_session";
const PUBLIC_PREFIXES = ["/login", "/register", "/forgot-password", "/reset-password"];

/** Request header telling pages where they are (read by requireActiveUser). Keep in sync with auth/session.ts. */
const PATH_HEADER = "x-hk-path";

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (isPublic) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) {
    // The cookie may turn out to be stale (signed out elsewhere, password reset): pages then still know where to
    // come back to after signing in (e.g. a scanned attendance link).
    const url = request.nextUrl.clone();
    url.searchParams.delete("_rsc");
    const headers = new Headers(request.headers);
    headers.set(PATH_HEADER, url.pathname + url.search);
    return NextResponse.next({ request: { headers } });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip static files, images, metadata files, and brand assets.
  matcher: ["/((?!_next/static|_next/image|brand/|icon\\.svg|manifest\\.webmanifest|favicon\\.ico|robots\\.txt).*)"],
};
