// The public JSON (and public images) the team website (huskyteers19516.github.io) reads from this site without
// signing in: src/app/api/public/**. Client-safe, because the proxy (src/proxy.ts) and tests use it too.
//
// Nothing under /api/public/ is public just because of where it lives: the proxy lets through exactly
//   - the paths in PUBLIC_API_PATHS, and
//   - one id segment (PUBLIC_API_ID_RE: letters, digits, "_" and "-", up to 64) right after a prefix in
//     PUBLIC_API_FILE_PREFIXES (the id routes: public images and files — sponsor logos, Workshop photos and files,
//     members' photos — and one person's progress) — never a deeper
//     path, a "%" escape, a dot, or an empty id.
// Everything else under /api/public/ still gets the JSON 401 without a session cookie. tests/public-progress.test.ts
// fails for a route under src/app/api/public that isn't listed (a static route must be in PUBLIC_API_PATHS, an [id]
// route's parent path + "/" in PUBLIC_API_FILE_PREFIXES), doesn't go through src/server/public-api.ts, or reads the
// session. See "Public API for the team website" in docs/CONVENTIONS.md.

/** GET /api/public/progress: live task progress (src/app/api/public/progress/route.ts). */
export const PUBLIC_PROGRESS_PATH = "/api/public/progress";
/**
 * GET /api/public/progress/people/<person id>: one listed person's progress and what they finished (the [id] route
 * below it). The id is the opaque `people[].id` of the progress JSON, never an account id.
 */
export const PUBLIC_PROGRESS_PEOPLE_PREFIX = "/api/public/progress/people/";
/** GET /api/public/sponsors: the sponsors the team thanks (src/app/api/public/sponsors/route.ts). */
export const PUBLIC_SPONSORS_PATH = "/api/public/sponsors";
/** GET /api/public/events: meets, the ILT, scrimmages, competitions, and outreach (src/app/api/public/events/route.ts). */
export const PUBLIC_EVENTS_PATH = "/api/public/events";
/** GET /api/public/sponsors/logos/<SponsorshipLogo id>: a public sponsor's logo (the [id] route below it). */
export const PUBLIC_SPONSOR_LOGOS_PREFIX = "/api/public/sponsors/logos/";
/** GET /api/public/workshop: approved Workshop projects (src/app/api/public/workshop/route.ts). */
export const PUBLIC_WORKSHOP_PATH = "/api/public/workshop";
/** GET /api/public/workshop/photos/<WorkshopPhoto id>: a photo of an approved Workshop project. */
export const PUBLIC_WORKSHOP_PHOTOS_PREFIX = "/api/public/workshop/photos/";
/** GET /api/public/workshop/files/<WorkshopFile id>: a design file of an approved Workshop project (a download). */
export const PUBLIC_WORKSHOP_FILES_PREFIX = "/api/public/workshop/files/";

/**
 * GET /api/public/team-photos: the photos members put on the team website themselves (Settings → My photo), by full
 * name, for the Our Team page (src/app/api/public/team-photos/route.ts).
 */
export const PUBLIC_TEAM_PHOTOS_PATH = "/api/public/team-photos";
/** GET /api/public/team-photos/<UserPhoto id>: one member's published photo (the [id] route below it). */
export const PUBLIC_TEAM_PHOTOS_PREFIX = "/api/public/team-photos/";

/** Every static endpoint that answers without a session, by exact path. */
export const PUBLIC_API_PATHS: readonly string[] = [
  PUBLIC_PROGRESS_PATH,
  PUBLIC_SPONSORS_PATH,
  PUBLIC_EVENTS_PATH,
  PUBLIC_WORKSHOP_PATH,
  PUBLIC_TEAM_PHOTOS_PATH,
];

/**
 * The id routes: prefixes (each ending with "/") followed by exactly one id segment (PUBLIC_API_ID_RE) — public images
 * and files, and one person's progress (JSON). The name is older than the person route; it means "prefix + one id".
 */
export const PUBLIC_API_FILE_PREFIXES: readonly string[] = [
  PUBLIC_SPONSOR_LOGOS_PREFIX,
  PUBLIC_WORKSHOP_PHOTOS_PREFIX,
  PUBLIC_WORKSHOP_FILES_PREFIX,
  PUBLIC_PROGRESS_PEOPLE_PREFIX,
  PUBLIC_TEAM_PHOTOS_PREFIX,
];

/**
 * An id in an id route's address: what our ids (cuid, the progress JSON's person ids) look like, nothing that could
 * change the path.
 */
export const PUBLIC_API_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whether the proxy lets this path through without a session: an exact PUBLIC_API_PATHS entry, or an id route — a
 * PUBLIC_API_FILE_PREFIXES prefix followed by exactly one segment matching PUBLIC_API_ID_RE (no further "/", no "%"
 * escapes, no dots). `pathname` is compared as sent (never decoded), so "%2f" or ".." can't sneak through.
 */
export function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.includes(pathname)) return true;
  for (const prefix of PUBLIC_API_FILE_PREFIXES) {
    if (pathname.startsWith(prefix) && PUBLIC_API_ID_RE.test(pathname.slice(prefix.length))) return true;
  }
  return false;
}
