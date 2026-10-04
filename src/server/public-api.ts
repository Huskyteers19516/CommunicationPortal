import "server-only";
// The public JSON endpoint for the team website (GET /api/public/progress — no sign-in, never reads cookies, so it
// can be cached publicly). The route handler is a thin wrapper around publicProgressResponse, which tests call.
// - GET / HEAD / OPTIONS only (Next.js answers other methods with 405).
// - CORS: `Access-Control-Allow-Origin` names the request's origin when it's the team website
//   (https://huskyteers19516.github.io) or one of PUBLIC_PROGRESS_EXTRA_ORIGINS, and the team website otherwise —
//   never another site, never `*`, never credentials. So another site's page can't read it, and a copy cached by the
//   CDN without regard to `Vary: Origin` still works for the team website.
// - `Cache-Control: public, s-maxage=15, stale-while-revalidate=45` (Vercel's CDN answers most polls), `Vary:
//   Origin`, `nosniff`. Errors: 503 JSON, `no-store`.
import { parseExtraOrigins, TEAM_SITE_ORIGIN } from "@/lib/public-progress";
import type { Db } from "./db";
import { getPublicProgress } from "./queries/public-progress";

export const PUBLIC_CACHE_CONTROL = "public, s-maxage=15, stale-while-revalidate=45";
export const PUBLIC_METHODS = "GET, HEAD, OPTIONS";
export const PUBLIC_PROGRESS_UNAVAILABLE = "Live progress isn't available right now. Try again in a minute.";

/** The team website plus PUBLIC_PROGRESS_EXTRA_ORIGINS (e.g. http://localhost:4321 for working on the site). */
export function publicAllowedOrigins(extraOrigins: string | null | undefined): string[] {
  return [TEAM_SITE_ORIGIN, ...parseExtraOrigins(extraOrigins).filter((o) => o !== TEAM_SITE_ORIGIN)];
}

/** The origin the CORS header names: the request's when it's allowed, else the team website. */
export function corsOriginFor(requestOrigin: string | null, allowed: string[]): string {
  return requestOrigin && allowed.includes(requestOrigin) ? requestOrigin : TEAM_SITE_ORIGIN;
}

function headersFor(request: Request, allowed: string[], cacheControl: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": corsOriginFor(request.headers.get("origin"), allowed),
    Vary: "Origin",
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
  });
}

export interface PublicProgressDeps {
  db: Db;
  now: Date;
  teamTimezone: string;
  /** PUBLIC_PROGRESS_EXTRA_ORIGINS as set (comma-separated). */
  extraOrigins?: string | null;
}

export async function publicProgressResponse(request: Request, deps: PublicProgressDeps): Promise<Response> {
  const allowed = publicAllowedOrigins(deps.extraOrigins);
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") {
    const headers = headersFor(request, allowed, PUBLIC_CACHE_CONTROL);
    headers.set("Access-Control-Allow-Methods", PUBLIC_METHODS);
    headers.set("Access-Control-Max-Age", "86400");
    headers.set("Allow", PUBLIC_METHODS);
    return new Response(null, { status: 204, headers });
  }
  if (method !== "GET" && method !== "HEAD") {
    const headers = headersFor(request, allowed, "no-store");
    headers.set("Allow", PUBLIC_METHODS);
    return new Response(null, { status: 405, headers });
  }

  let body: string;
  try {
    body = JSON.stringify(await getPublicProgress(deps.db, { now: deps.now, teamTimezone: deps.teamTimezone }));
  } catch (e) {
    console.error("[public-progress] couldn't build the answer", e);
    const headers = headersFor(request, allowed, "no-store");
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(method === "HEAD" ? null : JSON.stringify({ error: PUBLIC_PROGRESS_UNAVAILABLE }), { status: 503, headers });
  }
  const headers = headersFor(request, allowed, PUBLIC_CACHE_CONTROL);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}
