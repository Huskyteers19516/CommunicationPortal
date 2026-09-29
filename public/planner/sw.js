// Modified for the BIOBUZZ Edition (FTC 2026-2027); based on Pedro-Pathing/Visualizer f54357e.
/*
 * Service worker for Pedro Pathing Visualizer · BIOBUZZ Edition.
 *
 * Paths are relative to this script, so the app works at any sub-path
 * (e.g. https://<user>.github.io/PedroPathingBiobuzz/). Registered from
 * src/main.ts in production builds only.
 *
 * - App shell (navigations, assets/index.js, assets/index.css) and the BIOBUZZ
 *   field art (fields/biobuzz.svg, generated from the same geometry as the
 *   obstacles in index.js): network first, revalidated with the server so the
 *   browser's HTTP cache (GitHub Pages sends max-age=600) cannot hide a new
 *   deploy; cache when offline.
 * - Everything else same-origin (robot, fonts, icons, other field maps): stale
 *   while revalidate.
 * - Non-GET and cross-origin requests (e.g. the path optimizer) are not touched,
 *   and neither is anything outside this worker's scope (e.g. an API next to
 *   the app on the same site; the Huskyteers Portal, which serves the planner
 *   at /planner/, does not register this worker at all — see src/main.ts).
 *
 * Cache Storage is shared by every app on the origin (all *.github.io project
 * pages of one account), so this worker only ever deletes its own caches.
 *
 * Bump VERSION when the precache list or the caching strategy changes.
 */
const VERSION = "v3";
const CACHE_PREFIX = "pp-biobuzz-";
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;

const PRECACHE = [
  "./",
  "./favicon.ico",
  "./manifest.webmanifest",
  "./theme.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./robot.png",
  "./gif.worker.js",
  "./fields/biobuzz.svg",
  "./assets/index.js",
  "./assets/index.css",
  "./fonts/Poppins-ExtraLight.ttf",
  "./fonts/Poppins-Light.ttf",
  "./fonts/Poppins-Regular.ttf",
  "./fonts/Poppins-SemiBold.ttf",
];

// Served network first. The field art must match the geometry in index.js.
const SHELL_ASSET = /\/(assets\/index\.(js|css)|fields\/biobuzz\.svg)$/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Cache what we can; one missing file must not abort the install.
      await Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((error) => {
            console.warn(`[sw] precache skipped ${url}:`, error);
          }),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          // Only our own old versions; other apps' caches are not ours to delete.
          .filter((name) => name !== CACHE_NAME && name.startsWith(CACHE_PREFIX))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

async function putInCache(request, response) {
  if (!response || !response.ok || response.type === "opaque") return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch (error) {
    console.warn("[sw] cache put failed:", error);
  }
}

async function networkFirst(request) {
  try {
    // "no-cache" revalidates with the server (a cheap 304 when unchanged)
    // instead of trusting the HTTP cache. Navigations are passed through as
    // they are: Chrome rejects a Request init for mode "navigate".
    const response = await fetch(
      request.mode === "navigate" ? request : new Request(request, { cache: "no-cache" }),
    );
    putInCache(request, response.clone());
    return response;
  } catch (error) {
    const cache = await caches.open(CACHE_NAME);
    const cached =
      (await cache.match(request, { ignoreSearch: true })) ||
      (request.mode === "navigate" ? await cache.match("./") : undefined);
    return cached || Response.error();
  }
}

async function staleWhileRevalidate(event) {
  const { request } = event;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      putInCache(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  if (cached) {
    // Refresh in the background; keep the worker alive until it finishes.
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Only the app's own files (e.g. not the portal's /api/ next to /planner/).
  if (!request.url.startsWith(self.registration.scope)) return;

  if (request.mode === "navigate" || SHELL_ASSET.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(event));
});
