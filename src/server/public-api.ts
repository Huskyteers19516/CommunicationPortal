import "server-only";
// The public JSON and images for the team website (src/app/api/public/** — no sign-in, never reads cookies, so it
// can be cached publicly). Which paths answer without a session: src/lib/public-api.ts (the proxy's allowlist). The
// route handlers are thin wrappers around the functions here, which tests call. See "Public API for the team
// website" in docs/CONVENTIONS.md.
//
// JSON (publicJsonResponse — progress, one person's progress, sponsors, events, Workshop, members' photos):
// - GET / HEAD / OPTIONS only (Next.js answers other methods with 405).
// - CORS: `Access-Control-Allow-Origin` names the request's origin when it's the team website
//   (https://huskyteers19516.github.io) or one of PUBLIC_PROGRESS_EXTRA_ORIGINS, and the team website otherwise —
//   never another site, never `*`, never credentials. So another site's page can't read it, and a copy cached by the
//   CDN without regard to `Vary: Origin` still works for the team website.
// - `Cache-Control: public, s-maxage=15, stale-while-revalidate=45` (Vercel's CDN answers most requests), `Vary:
//   Origin`, `nosniff`. Errors: 503 JSON `{ error }`, `no-store`.
// - The CDN keys its copies by the whole URL, so `?anything=<random>` always reaches the server: the built answer is
//   also kept in memory for PUBLIC_ANSWER_TTL_MS (cachedPublicAnswer), shared by every request on the instance (one
//   build at a time; a failed build isn't kept). So the database work never depends on what's in the query string.
//   An id route's JSON (one person's progress) keeps one such answer per id, in a bounded map
//   (cachedPublicAnswerByKey: the least recently asked id is dropped first), and only for ids worth keeping: the person
//   route first looks the id up in a directory of the listed people built at most every PUBLIC_ANSWER_TTL_MS
//   (cachedPublicValue), so a made-up id reads nothing and keeps nothing.
// - "Not here" (only endpoints that pass `notFoundMessage`): the build answers `null` → a JSON 404 `{ error }`,
//   `no-store`, with the same CORS headers — the same answer whatever the reason.
//
// Files (publicFileResponse + publicFileHeaders — sponsor logos, Workshop photos and design files, members' photos):
// no CORS needed (an <img> can show a cross-origin picture), but `Cross-Origin-Resource-Policy: cross-origin` so the
// team website may embed it; nosniff, a sandboxing CSP, shown inline only for pictures, under a neutral name (Workshop
// design files: their cleaned uploaded name), publicly cacheable. A query string is redirected to the bare address
// before anything is read (one CDN copy per file: `?cb=<random>` can't make the server re-read a file).
import type { NextRequest } from "next/server";
import { PUBLIC_API_ID_RE } from "@/lib/public-api";
import { PUBLIC_PERSON_ID_RE, parseExtraOrigins, TEAM_SITE_ORIGIN } from "@/lib/public-progress";
import { publicSponsorLogoFilename } from "@/lib/public-sponsors";
import type { Db } from "./db";
import type { ObjectStore } from "./files/object-store";
import { plainResponse, sendStoredFile, type StoredFileRow } from "./files/respond";
import { getPublicEvents } from "./queries/public-events";
import {
  getPublicPeopleDirectory,
  getPublicPersonProgressFor,
  getPublicProgress,
  type PublicPeopleDirectory,
} from "./queries/public-progress";
import { getPublicSponsorLogo, getPublicSponsors } from "./queries/public-sponsors";
import { getPublicTeamPhoto, getPublicTeamPhotos, publicTeamPhotoFilename } from "./queries/public-team-photos";
import { getPublicWorkshop, getPublicWorkshopFile, getPublicWorkshopPhoto, publicWorkshopPhotoFilename } from "./queries/public-workshop";
import { contentDisposition } from "./resources/serve";

export const PUBLIC_CACHE_CONTROL = "public, s-maxage=15, stale-while-revalidate=45";
export const PUBLIC_METHODS = "GET, HEAD, OPTIONS";
export const PUBLIC_PROGRESS_UNAVAILABLE = "Live progress isn't available right now. Try again in a minute.";
export const PUBLIC_SPONSORS_UNAVAILABLE = "The sponsors list isn't available right now. Try again in a minute.";
export const PUBLIC_EVENTS_UNAVAILABLE = "The events list isn't available right now. Try again in a minute.";
export const PUBLIC_WORKSHOP_UNAVAILABLE = "The Workshop isn't available right now. Try again in a minute.";
/** The person endpoint's only 404: the same whether the page is off, names are hidden, or the id isn't listed. */
export const PUBLIC_PERSON_NOT_FOUND = "That person isn't on the team website.";
/** How long one server instance reuses a built answer. */
export const PUBLIC_ANSWER_TTL_MS = 10_000;

/** The answer kept in memory: one per route per server instance, or one per test. */
export interface PublicAnswerCache {
  entry: { builtAt: number; expiresAt: number; body: Promise<string> } | null;
}

export function createPublicAnswerCache(): PublicAnswerCache {
  return { entry: null };
}

/**
 * Any built value kept in memory the same way (PublicAnswerCache is the one for JSON text): e.g. the person route's
 * directory of listed people (getPublicPeopleDirectory), so ids that aren't listed are answered without the database.
 */
export interface PublicValueCache<T> {
  entry: { builtAt: number; expiresAt: number; body: Promise<T> } | null;
}

export function createPublicValueCache<T>(): PublicValueCache<T> {
  return { entry: null };
}

/**
 * Answers kept in memory per key (an id route's ids): one PublicAnswerCache each, at most `max` keys — the least
 * recently asked one is dropped first — so made-up ids can't grow it without bound. One per route per server instance.
 */
export interface PublicAnswerCacheMap {
  readonly max: number;
  /** In order of last use (oldest first). */
  readonly entries: Map<string, PublicAnswerCache>;
}

/**
 * How many people's answers the person route keeps (the team is ~40). Only listed people's ids reach it (anyone else is
 * answered from the directory), so made-up ids can't push them out.
 */
export const PUBLIC_PERSON_CACHE_MAX = 100;

export function createPublicAnswerCacheMap(max: number): PublicAnswerCacheMap {
  if (!Number.isInteger(max) || max < 1) throw new RangeError(`A public answer cache holds at least one key (got ${max}).`);
  return { max, entries: new Map() };
}

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

/**
 * The answer's JSON: the cached one while it's fresh (or still being built), else a new build kept for
 * PUBLIC_ANSWER_TTL_MS. Without a cache, builds every time. A failed build isn't kept (the next request tries again).
 */
export function cachedPublicAnswer(cache: PublicAnswerCache | undefined, now: Date, build: () => Promise<string>): Promise<string> {
  return cachedPublicValue(cache, now, build);
}

/** cachedPublicAnswer for any value (PublicValueCache): the same freshness, sharing, and failure rules. */
export function cachedPublicValue<T>(cache: PublicValueCache<T> | undefined, now: Date, build: () => Promise<T>): Promise<T> {
  if (!cache) return build();
  const at = now.getTime();
  const hit = cache.entry;
  if (hit && at >= hit.builtAt && at < hit.expiresAt) return hit.body;
  const entry = { builtAt: at, expiresAt: at + PUBLIC_ANSWER_TTL_MS, body: build() };
  cache.entry = entry;
  entry.body.catch(() => {
    if (cache.entry === entry) cache.entry = null;
  });
  return entry.body;
}

/**
 * cachedPublicAnswer for one key of `map` (the key becomes the most recently used; past `max` keys, the least
 * recently used is dropped — an in-flight build still answers whoever is waiting on it). Without a map, builds every
 * time.
 */
export function cachedPublicAnswerByKey(
  map: PublicAnswerCacheMap | undefined,
  key: string,
  now: Date,
  build: () => Promise<string>,
): Promise<string> {
  if (!map) return build();
  const cache = map.entries.get(key) ?? createPublicAnswerCache();
  map.entries.delete(key);
  map.entries.set(key, cache);
  while (map.entries.size > map.max) {
    const oldest = map.entries.keys().next();
    if (oldest.done) break;
    map.entries.delete(oldest.value);
  }
  return cachedPublicAnswer(cache, now, build);
}

/** What a build answers for "not here" (JSON `null`) when the endpoint has a `notFoundMessage`. */
const NOT_FOUND_BODY = "null";

export interface PublicJsonOptions {
  /** PUBLIC_PROGRESS_EXTRA_ORIGINS as set (comma-separated). */
  extraOrigins?: string | null;
  now: Date;
  /** The route's instance-wide cache (cachedPublicAnswer). None: build every time. */
  cache?: PublicAnswerCache;
  /** Builds the answer's JSON text (only data that may go to the open internet). */
  build: () => Promise<string>;
  /** The 503's `{ error }` when the build fails. */
  unavailableMessage: string;
  /**
   * Only for endpoints with a "not here" answer (one person's progress): a build answering `null` (the JSON text
   * "null") is a 404 `{ error: notFoundMessage }`, `no-store`. Without it, every build is a 200.
   */
  notFoundMessage?: string;
  /** Names the endpoint in the server log ("public-sponsors"). */
  logTag: string;
  /** More headers for the 200 answer (members' photos: PUBLIC_NO_INDEX_HEADERS). */
  extraHeaders?: Record<string, string>;
}

/**
 * Asks search engines not to index an answer or show it in image search: members' photos (mostly minors) — Google
 * renders the Our Team page's script and would otherwise index the photos at their portal addresses, and taking one
 * out of a search index takes far longer than the few minutes a member is promised.
 */
export const PUBLIC_NO_INDEX_HEADERS: Readonly<Record<string, string>> = { "X-Robots-Tag": "noindex, noimageindex" };

/**
 * A public JSON endpoint: GET / HEAD with the answer (cached as above), OPTIONS as the CORS preflight (204), anything
 * else 405; CORS for the team website only; a failed build is a 503 `{ error }` that isn't cached.
 */
export async function publicJsonResponse(request: Request, options: PublicJsonOptions): Promise<Response> {
  const allowed = publicAllowedOrigins(options.extraOrigins);
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
    body = await cachedPublicAnswer(options.cache, options.now, options.build);
  } catch (e) {
    console.error(`[${options.logTag}] couldn't build the answer`, e);
    const headers = headersFor(request, allowed, "no-store");
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(method === "HEAD" ? null : JSON.stringify({ error: options.unavailableMessage }), { status: 503, headers });
  }
  if (options.notFoundMessage !== undefined && body === NOT_FOUND_BODY) {
    const headers = headersFor(request, allowed, "no-store");
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(method === "HEAD" ? null : JSON.stringify({ error: options.notFoundMessage }), { status: 404, headers });
  }
  const headers = headersFor(request, allowed, PUBLIC_CACHE_CONTROL);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) headers.set(name, value);
  return new Response(method === "HEAD" ? null : body, { status: 200, headers });
}

/** What the JSON routes pass in (the progress, sponsors, and events routes all take the same). */
export interface PublicProgressDeps {
  db: Db;
  now: Date;
  teamTimezone: string;
  /** PUBLIC_PROGRESS_EXTRA_ORIGINS as set (comma-separated). */
  extraOrigins?: string | null;
  /** Reuse a built answer for PUBLIC_ANSWER_TTL_MS (the route passes its instance-wide one). None: build every time. */
  cache?: PublicAnswerCache;
}

/** GET /api/public/progress (src/server/queries/public-progress.ts). */
export function publicProgressResponse(request: Request, deps: PublicProgressDeps): Promise<Response> {
  return publicJsonResponse(request, {
    extraOrigins: deps.extraOrigins,
    now: deps.now,
    cache: deps.cache,
    build: () => getPublicProgress(deps.db, { now: deps.now, teamTimezone: deps.teamTimezone }).then((answer) => JSON.stringify(answer)),
    unavailableMessage: PUBLIC_PROGRESS_UNAVAILABLE,
    logTag: "public-progress",
  });
}

/**
 * What the person route passes in: the JSON routes' deps, the id from the address, and the route's caches — the
 * directory of listed people and the answers per listed id.
 */
export interface PublicPersonDeps extends Omit<PublicProgressDeps, "cache"> {
  /** The `[id]` from the address: the progress JSON's `people[].id`. */
  id: string;
  /** Reuse a built answer per id for PUBLIC_ANSWER_TTL_MS (the route passes its instance-wide map). None: build every time. */
  cache?: PublicAnswerCacheMap;
  /**
   * Reuse the directory of listed people (getPublicPeopleDirectory) for PUBLIC_ANSWER_TTL_MS (the route passes its
   * instance-wide one). None: read it for every request.
   */
  directory?: PublicValueCache<PublicPeopleDirectory | null>;
}

/**
 * GET /api/public/progress/people/[id]: one listed person's progress and what they finished
 * (getPublicPersonProgressFor), with the progress JSON's CORS and caching. Anyone it doesn't list — and the page or the
 * profiles off, or names hidden — is the one JSON 404 `{ error: PUBLIC_PERSON_NOT_FOUND }` (`no-store`). An id that
 * can't be a person's id is that 404 without touching anything; any other id is looked up in the directory (built at
 * most every PUBLIC_ANSWER_TTL_MS: two reads), so one that isn't listed costs no query and never enters the per-id
 * cache — only listed people's answers are kept there.
 */
export function publicPersonProgressResponse(request: Request, deps: PublicPersonDeps): Promise<Response> {
  const options = { now: deps.now, teamTimezone: deps.teamTimezone, id: deps.id };
  const build = async (): Promise<string> => {
    if (!PUBLIC_PERSON_ID_RE.test(deps.id)) return NOT_FOUND_BODY;
    const directory = await cachedPublicValue(deps.directory, deps.now, () => getPublicPeopleDirectory(deps.db));
    // One code path for every "not listed" reason, so the 404s can't be told apart.
    if (!directory?.byId.has(deps.id)) return NOT_FOUND_BODY;
    return cachedPublicAnswerByKey(deps.cache, deps.id, deps.now, () =>
      getPublicPersonProgressFor(deps.db, directory, options).then((answer) => JSON.stringify(answer)),
    );
  };
  return publicJsonResponse(request, {
    extraOrigins: deps.extraOrigins,
    now: deps.now,
    // Kept per id here (publicJsonResponse's own cache holds one answer per route).
    build,
    unavailableMessage: PUBLIC_PROGRESS_UNAVAILABLE,
    notFoundMessage: PUBLIC_PERSON_NOT_FOUND,
    logTag: "public-progress-person",
  });
}

/** GET /api/public/sponsors (src/server/queries/public-sponsors.ts). */
export function publicSponsorsResponse(request: Request, deps: PublicProgressDeps): Promise<Response> {
  return publicJsonResponse(request, {
    extraOrigins: deps.extraOrigins,
    now: deps.now,
    cache: deps.cache,
    build: () => getPublicSponsors(deps.db, { now: deps.now, teamTimezone: deps.teamTimezone }).then((answer) => JSON.stringify(answer)),
    unavailableMessage: PUBLIC_SPONSORS_UNAVAILABLE,
    logTag: "public-sponsors",
  });
}

/** GET /api/public/events (src/server/queries/public-events.ts). */
export function publicEventsResponse(request: Request, deps: PublicProgressDeps): Promise<Response> {
  return publicJsonResponse(request, {
    extraOrigins: deps.extraOrigins,
    now: deps.now,
    cache: deps.cache,
    build: () => getPublicEvents(deps.db, { now: deps.now, teamTimezone: deps.teamTimezone }).then((answer) => JSON.stringify(answer)),
    unavailableMessage: PUBLIC_EVENTS_UNAVAILABLE,
    logTag: "public-events",
  });
}

// ── Public files (sponsor logos, …) ──────────────────────────────────────────

/** Locked down: no scripts, no plugins, no forms, a unique origin. */
export const PUBLIC_FILE_CSP = "default-src 'none'; sandbox";
/**
 * Files whose address never shows different bytes (a replaced logo is a new row, so a new address): browsers keep
 * them a day without asking again; Vercel's CDN 5 minutes, so one taken off the website stops being served from the
 * CDN within minutes (the server already says 404). Every address has exactly one CDN copy (publicFileResponse sends
 * any query string elsewhere), so the server reads each file about once per 5 minutes per CDN region.
 */
export const PUBLIC_FILE_IMMUTABLE_CACHE = "public, max-age=86400, s-maxage=300, immutable";
/** Files that can change at the same address: a minute. */
export const PUBLIC_FILE_CACHE = "public, max-age=60, s-maxage=60";
/** The redirect from a public file's address with a query string to the bare one (it never changes). */
export const PUBLIC_FILE_REDIRECT_CACHE = "public, max-age=3600, s-maxage=86400";
/** The only types a public file is shown inline as. Anything else is always a download (application/octet-stream). */
export const PUBLIC_INLINE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export interface PublicFileHeaderOptions {
  /** The stored type (set by the server from the file's contents, never the browser's word). */
  contentType: string;
  /**
   * For Content-Disposition (cleaned: an ASCII fallback plus the UTF-8 name). A neutral public name
   * ("rev-robotics-logo.png"), never the name it was uploaded with — that can hold someone's name or folders. (The one
   * exception: Workshop design files keep their cleaned name, which reviewers approve and the public JSON lists.)
   */
  filename: string;
  /** Show it in the browser (only for PUBLIC_INLINE_TYPES; anything else downloads). */
  inline: boolean;
  /** The bytes at this address never change: long, `immutable` caching. */
  immutable: boolean;
}

/**
 * Headers for a public image or file (the caller adds Content-Length): nosniff; CSP "default-src 'none'; sandbox";
 * Content-Disposition inline (pictures only) or attachment, with a safe filename; Content-Type the stored picture
 * type when inline, else application/octet-stream; `Cross-Origin-Resource-Policy: cross-origin` (the team website
 * embeds it); public caching (PUBLIC_FILE_IMMUTABLE_CACHE / PUBLIC_FILE_CACHE).
 */
export function publicFileHeaders(options: PublicFileHeaderOptions): Headers {
  const type = options.contentType.toLowerCase().split(";")[0].trim();
  const inline = options.inline && PUBLIC_INLINE_TYPES.has(type);
  return new Headers({
    "Content-Type": inline ? type : "application/octet-stream",
    "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", options.filename),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": PUBLIC_FILE_CSP,
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": options.immutable ? PUBLIC_FILE_IMMUTABLE_CACHE : PUBLIC_FILE_CACHE,
  });
}

export const PUBLIC_LOGO_NOT_FOUND = "That logo isn't on the team website.";
export const PUBLIC_FILE_UNAVAILABLE = "This file couldn't be loaded just now. Try again in a minute.";

export interface PublicFileOptions<Row extends StoredFileRow> {
  /** The id from the address (checked against PUBLIC_API_ID_RE before anything is read). */
  id: string;
  /** The row with its bytes — only while it's public right now (one read, the check in its WHERE); else null. */
  load: (id: string) => Promise<Row | null>;
  /**
   * The name it's served under (publicFileHeaders' `filename`): a neutral one, never the uploaded name — except Workshop
   * design files, whose cleaned name reviewers approve and the JSON lists.
   */
  filename: (row: Row) => string;
  /** Show pictures in the browser (anything else downloads). */
  inline: boolean;
  /** The address never shows different bytes (a replacement gets a new id). */
  immutable: boolean;
  /** The plain 404's text. */
  notFoundMessage: string;
  /** Names the endpoint in the server log ("public-sponsor-logo"). */
  logTag: string;
  /** For tests; defaults to the R2_* settings. */
  store?: ObjectStore | null;
  /** More headers for the file's answer (members' photos: PUBLIC_NO_INDEX_HEADERS). */
  extraHeaders?: Record<string, string>;
}

/** A plain-text answer without a body for HEAD (and the GET body's stream let go). */
async function withoutBodyForHead(method: string, response: Response): Promise<Response> {
  if (method !== "HEAD") return response;
  await response.body?.cancel().catch(() => {});
  return new Response(null, { status: response.status, headers: response.headers });
}

/**
 * GET / HEAD of a public file (src/app/api/public/<prefix>/[id]: sponsor logos, Workshop photos and design files;
 * follow it for any new one):
 * 1. An id that isn't PUBLIC_API_ID_RE → plain 404.
 * 2. **A query string** (`?anything`) → a cacheable 308 to the bare address, before the database or R2 is touched. The
 *    CDN keys its copies by the whole URL, so `?cb=1`, `?cb=2`, … would each read the whole file again; this way each
 *    file has exactly one CDN copy, and the files themselves never look at the query (no `?download=1`).
 * 3. `load(id)`: null (not public right now, or no such file) → plain 404, `private, no-store` (never cached, so it
 *    can come back); a database failure → plain 503 PUBLIC_FILE_UNAVAILABLE.
 * 4. Otherwise sendStoredFile (from Postgres, or streamed from Cloudflare R2) with publicFileHeaders under
 *    `filename(row)`. A file that's missing from R2 is the plain 404; R2 not set up or not answering is the plain 503
 *    PUBLIC_FILE_UNAVAILABLE — never the signed-in pages' messages about R2's settings.
 * HEAD sends the same status and headers without the body.
 */
export async function publicFileResponse<Row extends StoredFileRow>(request: NextRequest, options: PublicFileOptions<Row>): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = request.nextUrl.pathname;
  if (!PUBLIC_API_ID_RE.test(options.id) || !path.startsWith("/api/public/")) {
    return withoutBodyForHead(method, plainResponse(404, options.notFoundMessage));
  }
  if (request.nextUrl.search !== "") {
    return new Response(null, {
      status: 308,
      // Relative, on this site: the path the proxy let through (a prefix and one plain id), without the query.
      headers: { Location: path, "Cache-Control": PUBLIC_FILE_REDIRECT_CACHE, "X-Content-Type-Options": "nosniff" },
    });
  }

  let row: Row | null;
  try {
    row = await options.load(options.id);
  } catch (e) {
    console.error(`[${options.logTag}] couldn't load the file`, e);
    return withoutBodyForHead(method, plainResponse(503, PUBLIC_FILE_UNAVAILABLE));
  }
  if (!row) return withoutBodyForHead(method, plainResponse(404, options.notFoundMessage));

  const file = row;
  let response = await sendStoredFile(request, file, {
    store: options.store,
    headers: (served) => ({
      ...Object.fromEntries(
        publicFileHeaders({ contentType: served.contentType, filename: options.filename(file), inline: options.inline, immutable: options.immutable }),
      ),
      "Content-Length": String(served.byteLength),
      ...options.extraHeaders,
    }),
  });
  if (response.status !== 200) {
    // sendStoredFile's own messages are for the team (R2 settings): a guest only hears it's gone or unavailable.
    await response.body?.cancel().catch(() => {});
    console.error(`[${options.logTag}] couldn't send a public file (${response.status})`);
    response = response.status === 404 ? plainResponse(404, options.notFoundMessage) : plainResponse(503, PUBLIC_FILE_UNAVAILABLE);
  }
  return withoutBodyForHead(method, response);
}

/**
 * GET / HEAD /api/public/sponsors/logos/[id]: a sponsor's logo, only while that sponsor is on the team website
 * (else a 404 that isn't cached), as publicFileResponse serves public files: inline, immutable (a replaced logo gets
 * a new id), named "<public name>-logo.<ext>" (publicSponsorLogoFilename). `store` is for tests (default: the R2_*
 * settings).
 */
export function publicSponsorLogoResponse(request: NextRequest, deps: { db: Db; id: string; store?: ObjectStore | null }): Promise<Response> {
  return publicFileResponse(request, {
    id: deps.id,
    load: (id) => getPublicSponsorLogo(deps.db, id),
    filename: (logo) => publicSponsorLogoFilename(logo.publicName, logo.contentType),
    inline: true,
    immutable: true,
    notFoundMessage: PUBLIC_LOGO_NOT_FOUND,
    logTag: "public-sponsor-logo",
    store: deps.store,
  });
}

/** GET /api/public/workshop: the approved Workshop projects (src/server/queries/public-workshop.ts). */
export function publicWorkshopResponse(request: Request, deps: PublicProgressDeps): Promise<Response> {
  return publicJsonResponse(request, {
    extraOrigins: deps.extraOrigins,
    now: deps.now,
    cache: deps.cache,
    build: () => getPublicWorkshop(deps.db, { now: deps.now }).then((answer) => JSON.stringify(answer)),
    unavailableMessage: PUBLIC_WORKSHOP_UNAVAILABLE,
    logTag: "public-workshop",
  });
}

export const PUBLIC_WORKSHOP_NOT_FOUND = "That file isn't on the team website.";

/**
 * GET / HEAD /api/public/workshop/photos/[id]: a photo of an approved Workshop project, as publicFileResponse serves
 * public files: inline (PNG, JPG, or WebP — the type it was stored with after checking its bytes, metadata taken out),
 * immutable (a new photo gets a new id), under a neutral name (publicWorkshopPhotoFilename). Anything not approved is
 * a 404 that isn't cached.
 */
export function publicWorkshopPhotoResponse(request: NextRequest, deps: { db: Db; id: string; store?: ObjectStore | null }): Promise<Response> {
  return publicFileResponse(request, {
    id: deps.id,
    load: (id) => getPublicWorkshopPhoto(deps.db, id),
    filename: publicWorkshopPhotoFilename,
    inline: true,
    immutable: true,
    notFoundMessage: PUBLIC_WORKSHOP_NOT_FOUND,
    logTag: "public-workshop-photo",
    store: deps.store,
  });
}

/**
 * GET / HEAD /api/public/workshop/files/[id]: a design file (STL, STEP…) of an approved Workshop project, always a
 * download, under the name it was uploaded with (cleaned; reviewers saw it before approving, and the JSON lists it).
 */
export function publicWorkshopFileResponse(request: NextRequest, deps: { db: Db; id: string; store?: ObjectStore | null }): Promise<Response> {
  return publicFileResponse(request, {
    id: deps.id,
    load: (id) => getPublicWorkshopFile(deps.db, id),
    filename: (file) => file.filename,
    inline: false,
    immutable: true,
    notFoundMessage: PUBLIC_WORKSHOP_NOT_FOUND,
    logTag: "public-workshop-file",
    store: deps.store,
  });
}

// ── Members' photos (the Our Team page) ──────────────────────────────────────

export const PUBLIC_TEAM_PHOTOS_UNAVAILABLE = "The team's photos aren't available right now. Try again in a minute.";
export const PUBLIC_TEAM_PHOTO_NOT_FOUND = "That photo isn't on the team website.";

/**
 * GET /api/public/team-photos: the members' photos for the Our Team page, each under a key made from the person's
 * name (never the name — src/server/queries/public-team-photos.ts), or `{ enabled: false }` while the team doesn't show
 * photos. Same CORS and caching as the other public JSON, and not for search engines (PUBLIC_NO_INDEX_HEADERS).
 */
export function publicTeamPhotosResponse(request: Request, deps: PublicProgressDeps): Promise<Response> {
  return publicJsonResponse(request, {
    extraOrigins: deps.extraOrigins,
    now: deps.now,
    cache: deps.cache,
    build: () => getPublicTeamPhotos(deps.db, { now: deps.now }).then((answer) => JSON.stringify(answer)),
    unavailableMessage: PUBLIC_TEAM_PHOTOS_UNAVAILABLE,
    logTag: "public-team-photos",
    extraHeaders: PUBLIC_NO_INDEX_HEADERS,
  });
}

/**
 * GET / HEAD /api/public/team-photos/[id]: one member's photo, only while it's published (its owner ACTIVE with "Show
 * my photo on the team website" on, not held off it, and the team showing photos) — else a 404 that isn't cached — as
 * publicFileResponse serves public files: inline (PNG, JPG, or WebP, metadata taken out), immutable (a new photo gets a
 * new id), under the neutral name "team-photo.<ext>", and not for search engines (PUBLIC_NO_INDEX_HEADERS).
 */
export function publicTeamPhotoResponse(request: NextRequest, deps: { db: Db; id: string; store?: ObjectStore | null }): Promise<Response> {
  return publicFileResponse(request, {
    id: deps.id,
    load: (id) => getPublicTeamPhoto(deps.db, id),
    filename: publicTeamPhotoFilename,
    inline: true,
    immutable: true,
    notFoundMessage: PUBLIC_TEAM_PHOTO_NOT_FOUND,
    logTag: "public-team-photo",
    store: deps.store,
    extraHeaders: PUBLIC_NO_INDEX_HEADERS,
  });
}
