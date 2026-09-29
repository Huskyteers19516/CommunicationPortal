// Build the Pedro Pathing planner (the owner's PedroPathingBiobuzz repo, a Svelte app) and copy it into
// public/planner/, where the portal serves it at /planner/index.html (its team library then saves to our database;
// see "Strategy" in docs/CONVENTIONS.md). Run it after changing (and committing) the planner:
//   npm run planner:sync                     (planner checked out next to this repo)
//   npm run planner:sync -- ../path/to/PedroPathingBiobuzz
//   npm run planner:sync -- --skip-build     (copy its existing dist/ as it is)
//   npm run planner:sync -- --allow-dirty    (the planner has uncommitted changes: only to try something out locally)
// PLANNER_DIR=… works too. The planner is Apache-2.0: its LICENSE and NOTICE are copied next to it and must stay, as
// must THIRD-PARTY-LICENSES.txt (its build lists the bundled packages' licenses there). BUILD.txt says which planner
// commit the files were built from, so the minified build can be checked against its source.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const portalRoot = path.resolve(import.meta.dirname, "..");
const target = path.join(portalRoot, "public", "planner");

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const allowDirty = args.includes("--allow-dirty");
const dirArg = args.find((a) => !a.startsWith("--"));
const plannerDir = path.resolve(dirArg ?? process.env.PLANNER_DIR ?? path.join(portalRoot, "..", "PedroPathingBiobuzz"));
const dist = path.join(plannerDir, "dist");

function fail(message) {
  console.error(`[planner:sync] ${message}`);
  process.exit(1);
}

if (!existsSync(path.join(plannerDir, "package.json"))) {
  fail(`No planner at ${plannerDir}. Pass its folder (npm run planner:sync -- <dir>) or set PLANNER_DIR.`);
}
for (const file of ["LICENSE", "NOTICE"]) {
  if (!existsSync(path.join(plannerDir, file))) fail(`${plannerDir} has no ${file} (Apache-2.0 needs it next to the build).`);
}

/** The planner's commit, and whether its tree has uncommitted changes (null: not a git checkout). */
function plannerCommit() {
  try {
    const hash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: plannerDir, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: plannerDir, encoding: "utf8" }).trim() !== "";
    return { hash, dirty };
  } catch {
    return null;
  }
}
const commit = plannerCommit();
// What's served must be reproducible from a planner commit (commit the planner first).
if (commit?.dirty && !allowDirty) {
  fail(`${plannerDir} has uncommitted changes: commit them first (or pass --allow-dirty to try it out locally; don't commit that build).`);
}

if (!skipBuild) {
  if (!existsSync(path.join(plannerDir, "node_modules"))) fail(`Run "npm install" in ${plannerDir} first.`);
  console.log(`[planner:sync] building ${plannerDir}…`);
  execFileSync("npm", ["run", "build"], { cwd: plannerDir, stdio: "inherit", shell: process.platform === "win32" });
}

const indexHtml = path.join(dist, "index.html");
if (!existsSync(indexHtml)) fail(`No build at ${dist} (run without --skip-build).`);

// The portal serves it under /planner/: every file the page links must be relative ("./assets/…"), never from the
// site root, or it would load the portal's files instead (the planner's vite.config.ts has base "./").
const html = readFileSync(indexHtml, "utf8");
const rootLinks = [...html.matchAll(/\s(?:src|href)="(\/[^/"][^"]*)"/g)].map((m) => m[1]);
if (rootLinks.length > 0) fail(`dist/index.html links files from the site root (${rootLinks.join(", ")}); build with base "./".`);
// The portal serves it with Content-Security-Policy script-src 'self' (next.config.ts): an inline script wouldn't run.
const inlineScripts = [...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>/gi)].map((m) => m[0]);
if (inlineScripts.length > 0) fail(`dist/index.html has inline scripts (${inlineScripts.join(", ")}); move them into files.`);
if (!existsSync(path.join(dist, "THIRD-PARTY-LICENSES.txt"))) {
  fail("dist/ has no THIRD-PARTY-LICENSES.txt (the planner's build writes it: scripts/third-party-licenses.mjs).");
}

// Refuse to clean anything but public/planner.
if (path.relative(path.join(portalRoot, "public"), target) !== "planner") fail(`Unexpected target ${target}.`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
for (const file of ["LICENSE", "NOTICE"]) cpSync(path.join(plannerDir, file), path.join(target, file));
const built = commit
  ? `PedroPathingBiobuzz ${commit.hash}${commit.dirty ? " plus uncommitted changes (not reproducible from a commit)" : ""}`
  : "PedroPathingBiobuzz (not a git checkout: commit unknown)";
writeFileSync(path.join(target, "BUILD.txt"), `Pedro Pathing Visualizer · BIOBUZZ Edition, built from ${built}.\n`);

function sizeOf(dir) {
  return readdirSync(dir).reduce((sum, name) => {
    const full = path.join(dir, name);
    const stat = statSync(full);
    return sum + (stat.isDirectory() ? sizeOf(full) : stat.size);
  }, 0);
}

const mb = (sizeOf(target) / 1024 / 1024).toFixed(1);
const from = commit ? `, planner ${commit.hash.slice(0, 7)}${commit.dirty ? " + uncommitted changes" : ""}` : "";
console.log(`[planner:sync] public/planner/ updated (${mb} MB${from}). Open /planner/index.html to check it.`);
