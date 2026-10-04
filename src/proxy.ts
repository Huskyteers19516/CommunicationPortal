import { type NextRequest, NextResponse } from "next/server";

// Optimistic check only (no DB): bounce visitors without a session cookie to /login.
// Real authentication/authorization happens in layouts, pages, and services.
const SESSION_COOKIE = "hk_session";
const PUBLIC_PREFIXES = ["/login", "/register", "/forgot-password", "/reset-password"];

/**
 * Public, read-only endpoints for the team website (src/app/api/public/**). They answer without a session — only
 * aggregate, non-sensitive data, see src/server/public-api.ts.
 */
const PUBLIC_API_PREFIX = "/api/public/";

/** Request header telling pages where they are (read by requireActiveUser). Keep in sync with auth/session.ts. */
const PATH_HEADER = "x-hk-path";

/**
 * The Pedro Pathing planner's page (public/planner/, see src/lib/planner-paths.ts). Its other files (scripts,
 * styles, fonts, icons, field pictures, its service worker and manifest — the same as on GitHub Pages) load without
 * signing in: browsers fetch some of them without cookies. Its team library is the API below, which checks.
 */
const PLANNER_PAGE = "/planner/index.html";

/**
 * The planner's page however the address spells it (%-escapes, capitals, doubled or trailing slashes). Sending
 * signed-out visitors to sign in first is only a convenience (a shared "Open in planner" link comes back after
 * signing in): the page is static and public on GitHub Pages anyway, and every /api/planner/* route checks the
 * session itself.
 */
function isPlannerPage(pathname: string): boolean {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // A malformed escape: compare it as sent.
  }
  return path.toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "") === PLANNER_PAGE;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (isPublic) return NextResponse.next();
  if (pathname.startsWith("/planner/") && !isPlannerPage(pathname)) return NextResponse.next();
  // Public JSON for the team website (/api/public/progress): no session needed, and the route never reads one.
  if (pathname.startsWith(PUBLIC_API_PREFIX)) return NextResponse.next();
  // The planner's JSON API answers for itself (a JSON 401, never the sign-in page's HTML).
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
    return NextResponse.json(
      { error: "Sign in to the Huskyteers Portal to use the team's saved paths." },
      { status: 401, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
    );
  }
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
