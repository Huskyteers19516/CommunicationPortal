import type { NextConfig } from "next";

/**
 * The planner (public/planner/, the team's Svelte app) runs on this site's origin with the signed-in person's
 * session, so it gets a Content-Security-Policy: its own scripts only (no inline ones: the planner keeps its early
 * theme code in theme.js, and `npm run planner:sync` refuses a build with inline scripts), no eval, and requests only
 * to this site and the Pedro Pathing path optimizer. Styles may be inline (Svelte transitions and style attributes),
 * pictures and the GIF export use data:/blob: URLs, and GIF export runs a worker. Only our own pages may frame it.
 */
const PLANNER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://fpa.pedropathing.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // File uploads (Resources, sponsor files): up to LIMITS.resourceFileMaxBytes (4 MB) plus the form's multipart overhead.
      // Vercel rejects requests over 4.5 MB anyway, so don't raise the file limit past ~4 MB.
      bodySizeLimit: "5mb",
    },
  },
  async redirects() {
    return [
      // The Pedro Pathing planner (public/planner/, a static build) lives at /planner/index.html: its build links its
      // files relative to the page ("./assets/…"), so "/planner" (where Next.js sends "/planner/") can't show it.
      // The query (?path=<id>) is passed on.
      { source: "/planner", destination: "/planner/index.html", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Camera: our own pages only (the in-app QR scanner on Attendance). Never embedded sites.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
        ],
      },
      {
        // The planner is shown in a frame on our own Strategy pages (and only there): these replace the DENY and the
        // camera permission above (the last matching rule wins; the planner needs no camera).
        source: "/planner/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: PLANNER_CSP },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // The planner's Apache-2.0 notices: shown as text, not downloaded (they have no extension to go by).
        source: "/planner/:file(LICENSE|NOTICE)",
        headers: [{ key: "Content-Type", value: "text/plain; charset=utf-8" }],
      },
    ];
  },
};

export default nextConfig;
