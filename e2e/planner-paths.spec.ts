import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { E2E_PORT } from "../playwright.config";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Strategy → Paths: the team library of paths saved from the planner. The planner is served by this site
// (/planner/index.html, embedded on the Strategy pages) and saves through /api/planner/* with the session cookie;
// the Paths tab (and each Other-team page) lists them: Open in planner (a new tab), Download .pp, and — for whoever
// saved it and people with admin access — Edit and Remove.

const PLANNER_URL = "/planner/index.html";
const FRAME = 'iframe[title="Pedro Pathing visualizer (BIOBUZZ)"]';
/** What the planner sends with every change (Playwright's requests have no Origin / Sec-Fetch-Site). */
const PLANNER_HEADERS = { "Content-Type": "application/json", "X-Planner": "1" };

/** A small path the planner can open (the shape its Save writes). */
const PP = JSON.stringify(
  {
    startPoint: { x: 61.75, y: 8, heading: "linear", startDeg: 90, endDeg: 90 },
    lines: [{ id: "line-1", name: "Path 1", endPoint: { x: 61.75, y: 30, heading: "linear", startDeg: 90, endDeg: 90 }, controlPoints: [], color: "#ffc516" }],
    shapes: [],
    version: "1.2.1",
  },
  null,
  2,
);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("saved paths", () => {
  test("a member finds the demo paths, opens one in the planner, and downloads its .pp; the planner is ours", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.softwareMember);

    // The planner on the Strategy page is this site's own page (same origin).
    await page.goto("/strategy");
    await page.getByRole("button", { name: "Show it here" }).click();
    await expect(page.locator(FRAME)).toHaveAttribute("src", PLANNER_URL);
    await expect(page.getByRole("link", { name: "Open in a new tab" })).toHaveAttribute("href", PLANNER_URL);
    await expectNoHorizontalScroll(page);

    // The planner's hint points to the library; the third tab opens it.
    await expect(page.locator("#planner").getByRole("link", { name: "Paths", exact: true })).toHaveAttribute("href", "/strategy/paths");
    const tab = page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: /^Paths/ });
    await tab.click();
    await expect(page).toHaveURL(/\/strategy\/paths$/);
    await expect(page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: /^Paths/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Saved paths" })).toBeVisible();
    await expectNoHorizontalScroll(page);

    const ours = page.getByRole("article", { name: "Red audience auto: preload + park" });
    await expect(ours.getByText("Ours", { exact: true })).toBeVisible();
    await expect(ours).toContainText("Aiden Nguyen · updated by Priya Raman");
    const theirs = page.getByRole("article", { name: "9040 rear-side auto (traced)" });
    await expect(theirs.getByRole("link", { name: "9040 · STEAMpunks Alpha" })).toHaveAttribute("href", "/strategy/teams/9040");

    // Open in planner: a new tab, straight to the path.
    const open = ours.getByRole("link", { name: /^Open in planner/ });
    await expect(open).toHaveAttribute("href", `${PLANNER_URL}?path=demo-path-red-audience`);
    await expect(open).toHaveAttribute("target", "_blank");

    // Download .pp: the saved path, byte for byte, named after it.
    const downloading = page.waitForEvent("download");
    await ours.getByRole("link", { name: /^Download \.pp/ }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("Red audience auto preload + park.pp");
    const [saved] = await sql<{ data: string }>(`SELECT data FROM "PlannerPath" WHERE id = 'demo-path-red-audience'`);
    expect(await readFile((await download.path())!, "utf8")).toBe(saved.data);

    // Someone else's path: no Edit or Remove, and its edit page is a 404. Her own: both.
    await expect(ours.getByRole("link", { name: /^Edit/ })).toHaveCount(0);
    await expect(ours.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
    expect((await page.request.get("/strategy/paths/demo-path-red-audience/edit")).status()).toBe(404);
    const mine = page.getByRole("article", { name: "Park only (backup auto)" });
    await expect(mine).toContainText("You · saved");
    await expect(mine.getByRole("link", { name: "Edit Park only (backup auto)" })).toBeVisible();
    await expect(mine.getByRole("button", { name: "Remove Park only (backup auto)" })).toBeVisible();

    // Whose paths: picked from the menu, it applies right away; search the names and notes.
    await page.getByLabel("Whose paths").selectOption("9040");
    await expect(page).toHaveURL(/\/strategy\/paths\?(q=&)?team=9040$/);
    await expect(page.getByRole("article", { name: "9040 rear-side auto (traced)" })).toBeVisible();
    await expect(page.getByRole("article", { name: "Red audience auto: preload + park" })).toHaveCount(0);
    await page.goto("/strategy/paths");
    await page.getByLabel("Search saved paths by name or notes").fill("backup");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=backup/);
    await expect(page.getByRole("status").filter({ hasText: /matching “backup”/ })).toBeVisible();
    await expect(page.getByRole("article", { name: "Park only (backup auto)" })).toBeVisible();
    await expect(page.getByRole("article", { name: "Red audience auto: preload + park" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/strategy\/paths$/);

    // The team's own page lists its saved paths too.
    await page.goto("/strategy/teams/9040");
    const section = page.locator("#paths");
    await expect(section.getByRole("heading", { name: "Saved paths for STEAMpunks Alpha" })).toBeVisible();
    await expect(section.getByRole("article", { name: "9040 rear-side auto (traced)" })).toBeVisible();
    await expect(section.getByRole("link", { name: /^Open in planner/ })).toHaveAttribute("href", `${PLANNER_URL}?path=demo-path-9040-rear`);
    await expectNoHorizontalScroll(page);
  });

  test("the planner's API saves to the library; a leader renames it and removes it", async ({ page, playwright }, info) => {
    const name = `E2E path ${uniq(info.project.name)}`;

    // Signed out: a JSON 401, never the sign-in page.
    const anon = await playwright.request.newContext({ baseURL: `http://localhost:${E2E_PORT}` });
    const out = await anon.get("/api/planner/session", { maxRedirects: 0 });
    expect(out.status()).toBe(401);
    expect(out.headers()["content-type"]).toMatch(/^application\/json/);
    expect(typeof (await out.json()).error).toBe("string");
    await anon.dispose();

    await signIn(page, PEOPLE.softwareMember);
    const session = await page.request.get("/api/planner/session");
    expect(session.status()).toBe(200);
    expect(session.headers()["cache-control"]).toBe("no-store");
    expect((await session.json()).user).toEqual({ name: "Maya Patel", canManageAll: false });
    // A change without the planner's header is refused.
    const forged = await page.request.post("/api/planner/paths", { headers: { "Content-Type": "application/json" }, data: { name, data: PP } });
    expect(forged.status()).toBe(403);
    const created = await page.request.post("/api/planner/paths", {
      headers: PLANNER_HEADERS,
      data: { name, notes: "Saved from the planner", teamNumber: 9040, data: PP },
    });
    expect(created.status()).toBe(201);
    const { id, version } = (await created.json()) as { id: string; version: string };
    const opened = await page.request.get(`/api/planner/paths/${id}`);
    expect(await opened.json()).toMatchObject({ id, name, data: PP, version, canEdit: true, team: { number: 9040, name: "STEAMpunks Alpha" } });

    // A leader (admin access) changes anyone's path: rename it and make it one of ours.
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(`/strategy/paths?q=${encodeURIComponent(name)}`);
    const card = page.getByRole("article", { name });
    await expect(card).toContainText("Maya Patel · saved");
    await card.getByRole("link", { name: `Edit ${name}` }).click();
    await expect(page).toHaveURL(new RegExp(`/strategy/paths/${escape(id)}/edit$`));
    await expect(page.getByLabel("Whose path")).toHaveValue("9040");
    await expectNoHorizontalScroll(page);
    const renamed = `${name} (checked)`;
    await page.getByLabel("Name", { exact: true }).fill(renamed);
    await page.getByLabel("Whose path").selectOption("");
    await page.getByLabel(/^Notes/).fill("Checked by Marcus");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/strategy\/paths\?saved=1$/);
    await expect(page.locator(":focus")).toContainText("Changes saved.");
    const [row] = await sql<{ name: string; notes: string; teamId: string | null }>(`SELECT name, notes, "teamId" FROM "PlannerPath" WHERE id = $1`, [id]);
    expect(row).toEqual({ name: renamed, notes: "Checked by Marcus", teamId: null });

    // The planner's copy is now out of date: saving it is refused (409), naming who changed it.
    await signIn(page, PEOPLE.softwareMember);
    const stale = await page.request.put(`/api/planner/paths/${id}`, { headers: PLANNER_HEADERS, data: { data: PP, version } });
    expect(stale.status()).toBe(409);
    const conflict = (await stale.json()) as { current: { version: string; updatedByName: string } };
    expect(conflict.current.updatedByName).toBe("Marcus Johnson");
    // Overwrite (the data only, based on the current version): Marcus's rename, notes, and team stay, and the answer
    // says so, so the planner shows them instead of its old name.
    const overwritten = await page.request.put(`/api/planner/paths/${id}`, {
      headers: PLANNER_HEADERS,
      data: { data: PP, version: conflict.current.version },
    });
    expect(overwritten.status()).toBe(200);
    expect(await overwritten.json()).toMatchObject({ name: renamed, notes: "Checked by Marcus", team: null });

    // Remove (after a confirmation): back to the list, which says so.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(`/strategy/paths?q=${encodeURIComponent(renamed)}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("article", { name: renamed }).getByRole("button", { name: `Remove ${renamed}` }).click();
    await expect(page).toHaveURL(/\/strategy\/paths\?q=.*&removed=1$/);
    await expect(page.locator(":focus")).toContainText("Path removed.");
    await expect(page.getByRole("article", { name: renamed })).toHaveCount(0);
    expect(await sql(`SELECT id FROM "PlannerPath" WHERE id = $1`, [id])).toHaveLength(0);
    expect((await page.request.get(`/api/planner/paths/${id}`)).status()).toBe(404);
  });

  test("no sideways scrolling at 375 px: the tab, its filters, an edit form, a team's paths", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.softwareMember);
    for (const path of [
      "/strategy/paths",
      "/strategy/paths?team=ours",
      "/strategy/paths?team=9040",
      "/strategy/paths?q=nothing-matches-this",
      "/strategy/paths/demo-path-park/edit",
      "/strategy/teams/9040",
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expectNoHorizontalScroll(page);
    }
  });
});
