import { type NextRequest, NextResponse } from "next/server";
import { isPublicApiPath } from "@/lib/public-api";

// Optimistic check only (no DB): bounce visitors without a session cookie to /login.
// Real authentication/authorization happens in layouts, pages, and services.
const SESSION_COOKIE = "hk_session";
const PUBLIC_PREFIXES = ["/login", "/register", "/forgot-password", "/reset-password"];

// Public, read-only endpoints for the team website (src/app/api/public/**) answer without a session: the exact
// paths in PUBLIC_API_PATHS, plus one id after a prefix in PUBLIC_API_FILE_PREFIXES (the id routes: sponsor logos,
// approved Workshop projects' photos and design files, members' published photos, one listed person's progress) —
// isPublicApiPath in src/lib/public-api.ts. Only data meant for the open internet; each route filters to it itself,
// see src/server/public-api.ts. Anything else under /api/public/ still needs a session cookie here, so a new route
// there isn't public until it's listed.

/**
 * Vercel's daily job that deletes meeting recordings past their 3 days (vercel.json). Vercel calls it without a
 * session; the route checks CRON_SECRET (or rate-limits itself) — see src/app/api/cron/meeting-audio/route.ts.
 */
const MEETING_AUDIO_CRON_PATH = "/api/cron/meeting-audio";

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
  // Public JSON and images for the team website (/api/public/progress, …): no session needed, and the routes never
  // read one. Compared as sent (never decoded), so an escaped "/" or ".." can't reach another route.
  if (isPublicApiPath(pathname)) return NextResponse.next();
  // The daily cron job, exactly this path (compared as sent).
  if (pathname === MEETING_AUDIO_CRON_PATH) return NextResponse.next();
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
  // Skip static files, images, metadata files, brand assets, and the meeting recorder's speech-to-text files
  // (public/asr/: the worker and its library load without cookies, like brand/).
  matcher: ["/((?!_next/static|_next/image|brand/|asr/|icon\\.svg|manifest\\.webmanifest|favicon\\.ico|robots\\.txt).*)"],
};
