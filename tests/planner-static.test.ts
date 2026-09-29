// The planner served by this site (public/planner/, a static build of the PedroPathingBiobuzz app; see "Strategy" in
// docs/CONVENTIONS.md): the headers next.config.ts sends with it, and what `npm run planner:sync` must have copied.
// No database.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

const PLANNER_DIR = path.resolve(import.meta.dirname, "..", "public", "planner");

async function headerRules() {
  const rules = await nextConfig.headers!();
  return (source: string) => {
    const rule = rules.find((r) => r.source === source);
    expect(rule, source).toBeDefined();
    return Object.fromEntries(rule!.headers.map((h) => [h.key.toLowerCase(), h.value]));
  };
}

/** The CSP's directives by name ("script-src" → ["'self'"]). */
function directives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values]),
  );
}

describe("the planner's headers (next.config.ts)", () => {
  it("run it with a Content-Security-Policy: its own scripts only, no eval, requests to us and the path optimizer", async () => {
    const rule = await headerRules();
    const planner = rule("/planner/:path*");
    expect(planner["x-frame-options"]).toBe("SAMEORIGIN");
    const csp = directives(planner["content-security-policy"]);
    expect(csp["script-src"]).toEqual(["'self'"]);
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["connect-src"]).toEqual(["'self'", "https://fpa.pedropathing.com"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
    expect(csp["base-uri"]).toEqual(["'self'"]);
    expect(csp["form-action"]).toEqual(["'self'"]);
    expect(csp["frame-ancestors"]).toEqual(["'self'"]);
    expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(csp["worker-src"]).toEqual(["'self'", "blob:"]);
    expect(planner["content-security-policy"]).not.toMatch(/unsafe-eval|\*/);
    // No camera for the planner (our own pages keep camera=(self) for the attendance scanner).
    expect(planner["permissions-policy"]).toMatch(/camera=\(\)/);
    expect(rule("/(.*)")["permissions-policy"]).toMatch(/camera=\(self\)/);
  });

  it("show its LICENSE and NOTICE as text, not as a download", async () => {
    const rule = await headerRules();
    expect(rule("/planner/:file(LICENSE|NOTICE)")["content-type"]).toBe("text/plain; charset=utf-8");
  });
});

describe("the planner's files (public/planner/, from npm run planner:sync)", () => {
  const html = readFileSync(path.join(PLANNER_DIR, "index.html"), "utf8");

  it("has no inline scripts (the CSP would block them) and links its files relative to the page", () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, tag).toMatch(/\ssrc="\.\/[^"]+"/);
    expect([...html.matchAll(/\s(?:src|href)="(\/[^/"][^"]*)"/g)].map((m) => m[1])).toEqual([]);
    expect(existsSync(path.join(PLANNER_DIR, "theme.js"))).toBe(true);
  });

  it("keeps the Apache-2.0 LICENSE and NOTICE, the bundled packages' licenses, and which commit it was built from", () => {
    expect(readFileSync(path.join(PLANNER_DIR, "LICENSE"), "utf8")).toMatch(/Apache License\s+Version 2\.0/);
    expect(readFileSync(path.join(PLANNER_DIR, "NOTICE"), "utf8")).toMatch(/Pedro Pathing Visualizer/);
    const third = readFileSync(path.join(PLANNER_DIR, "THIRD-PARTY-LICENSES.txt"), "utf8");
    for (const pkg of ["d3-array", "svelte", "lodash", "two.js", "gif.js", "html2canvas", "highlight.js", "prettier", "chevrotain"]) {
      expect(third, pkg).toMatch(new RegExp(`^ {2}${pkg.replace(".", "\\.")} `, "m"));
    }
    expect(readFileSync(path.join(PLANNER_DIR, "BUILD.txt"), "utf8")).toMatch(/^Pedro Pathing Visualizer · BIOBUZZ Edition, built from PedroPathingBiobuzz /);
  });
});
