import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Strategy → Other teams: the other teams in our league. Everyone writes "their strategy at a glance" (two people
// saving at once never silently overwrite each other), adds strategies about a team (e.g. their auto traced in the
// planner, as a .pp file), and can trace their path in the embedded planner. People with admin access add, edit,
// and remove teams.

/** The planner on this site (public/planner/). */
const PLANNER_URL = "/planner/index.html";
const FRAME = 'iframe[title="Pedro Pathing visualizer (BIOBUZZ)"]';

/** A small path the planner can open (the shape its Save writes). */
const PP = JSON.stringify({
  startPoint: { x: 79.75, y: 133.5, heading: "linear", startDeg: -90, endDeg: -90 },
  lines: [{ id: "line-1", name: "Path 1", endPoint: { x: 79.75, y: 111.5, heading: "linear", startDeg: -90, endDeg: -90 }, controlPoints: [], color: "#ffc516" }],
  version: "1.2.1",
});

const TEAM = { number: 13171, name: "Polyisoprene Mallards", city: "Tustin" };
const LABEL = `${TEAM.number} · ${TEAM.name}`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The summary's Edit button ("Write it" while there's no summary yet). */
const editSummary = (label: string) => new RegExp(`^(Edit|Write it) \\(summary for ${escape(label)}\\)$`);

test.describe("other teams", () => {
  test("a member finds a team, writes its summary, and adds a traced auto about it; no team management", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const run = uniq(info.project.name);
    await signIn(page, PEOPLE.softwareMember);

    // The tab next to Our strategies.
    await page.goto("/strategy");
    await page.getByRole("link", { name: /^Other teams/ }).click();
    await expect(page).toHaveURL(/\/strategy\/teams$/);
    await expect(page.getByRole("link", { name: /^Other teams/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: /^9040\s*STEAMpunks Alpha/ })).toBeVisible();
    // Our own number only appears in the app's brand, never in the list.
    await expect(page.getByRole("main").getByText(String(19516), { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Add a team" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Search by name (server-side), then by number.
    await page.getByLabel("Find a team").fill("steampunks");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/\/strategy\/teams\?q=steampunks$/);
    await expect(page.getByRole("status").filter({ hasText: "2 teams match" })).toBeVisible();
    await expect(page.getByRole("link", { name: /^13277/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /^9040/ })).toBeVisible();
    // Clear: every team again, with focus (and an empty box) back on the search.
    await page.getByRole("link", { name: "Clear" }).click();
    await expect(page).toHaveURL(/\/strategy\/teams$/);
    await expect(page.getByLabel("Find a team")).toBeFocused();
    await expect(page.getByLabel("Find a team")).toHaveValue("");
    // Our own number: it says we're not on the list.
    await page.getByLabel("Find a team").fill("19516");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("status").filter({ hasText: "19516 is us." })).toBeVisible();
    await page.getByLabel("Find a team").fill(String(TEAM.number));
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 team matches" })).toBeVisible();
    await page.getByRole("link", { name: new RegExp(`^${TEAM.number}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/strategy/teams/${TEAM.number}$`));
    await expect(page.getByRole("heading", { level: 1 })).toContainText(LABEL);
    // The city on its own line under the name.
    await expect(page.getByRole("main").getByText(TEAM.city, { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Members can't add, edit, or remove teams.
    await expect(page.getByRole("link", { name: `Edit team ${LABEL}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Remove team ${LABEL}` })).toHaveCount(0);
    expect((await page.request.get("/strategy/teams/new")).status()).toBe(404);
    expect((await page.request.get(`/strategy/teams/${TEAM.number}/edit`)).status()).toBe(404);

    // Write the summary: saved, back on the Edit button, "Updated by" her.
    const summary = `Fast 2-sample auto from the rear wall. ${run}`;
    await page.getByRole("button", { name: editSummary(LABEL) }).click();
    const box = page.getByLabel(`Their strategy at a glance (${LABEL})`);
    await expect(box).toBeFocused();
    await box.fill(summary);
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Save summary" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(page.getByRole("button", { name: editSummary(LABEL) })).toBeFocused();
    await expect(page.getByText(summary)).toBeVisible();
    await expect(page.getByText(/Updated by Maya Patel/)).toBeVisible();

    // Trace their path: the planner unfolds right here (and a new tab always works), with this team as the default
    // "Whose path?" for Save to team library (?team=).
    const trace = page.locator("#trace");
    const teamPlanner = `${PLANNER_URL}?team=${TEAM.number}`;
    await expect(trace.getByRole("link", { name: "Open in a new tab" })).toHaveAttribute("href", teamPlanner);
    await expect(trace.locator(FRAME)).toHaveCount(0);
    await trace.getByRole("button", { name: "Open the planner" }).click();
    await expect(trace.locator(FRAME)).toBeVisible();
    await expect(trace.locator(FRAME)).toHaveAttribute("src", teamPlanner);
    await expectNoHorizontalScroll(page);

    // Add a strategy about this team, with the traced .pp.
    const title = `E2E ${TEAM.number} auto ${run}`;
    await page.getByRole("link", { name: `Add a strategy about ${LABEL}` }).click();
    await expect(page).toHaveURL(new RegExp(`/strategy/new\\?team=${TEAM.number}$`));
    await expect(page.getByText(LABEL).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.locator("#files").setInputFiles({ name: "mallards-auto.pp", mimeType: "application/octet-stream", buffer: Buffer.from(PP) });
    await expect(page.getByText("mallards-auto.pp", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add strategy" }).click();
    await expect(page).toHaveURL(/\/strategy\/[^/?]+\?added=1$/);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    // It says which team it's about, with a way back.
    await expect(page.getByRole("link", { name: LABEL }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /^Download path/ })).toBeVisible();
    await expectNoHorizontalScroll(page);

    const [row] = await sql<{ id: string; teamId: string }>(`SELECT id, "teamId" FROM "Strategy" WHERE title = $1`, [title]);
    expect(row.teamId).toBe(`leagueteam${TEAM.number}`);

    // On the team's page, not on ours.
    await page.goto(`/strategy/teams/${TEAM.number}`);
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await page.goto("/strategy");
    await expect(page.locator("#strategies").getByRole("link", { name: title })).toHaveCount(0);

    // Another member can't change it.
    await signIn(page, PEOPLE.buildMember);
    await page.goto(`/strategy/${row.id}`);
    await expect(page.getByRole("link", { name: `Edit ${title}` })).toHaveCount(0);

    // Its author removes it, and lands back on the team's page.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto(`/strategy/${row.id}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: `Remove ${title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/strategy/teams/${TEAM.number}\\?removed=1$`));
    await expect(page.locator(":focus")).toContainText("Strategy removed.");
  });

  test("two people writing the summary at once: the second sees the first's version, then replaces it", async ({ page, browser }, info) => {
    const run = uniq(info.project.name);
    const team = { number: 21982, label: "21982 · I-kineers" };
    await signIn(page, PEOPLE.softwareMember);
    await page.goto(`/strategy/teams/${team.number}`);
    await page.getByRole("button", { name: editSummary(team.label) }).click();
    const box = page.getByLabel(`Their strategy at a glance (${team.label})`);
    await box.fill(`Maya's notes ${run}`);

    // Meanwhile Ethan saves his.
    const other = await browser.newContext();
    const ethan = await other.newPage();
    await signIn(ethan, PEOPLE.buildMember);
    await ethan.goto(`/strategy/teams/${team.number}`);
    await ethan.getByRole("button", { name: editSummary(team.label) }).click();
    await ethan.getByLabel(`Their strategy at a glance (${team.label})`).fill(`Ethan's notes ${run}`);
    await ethan.getByRole("button", { name: "Save summary" }).click();
    await expect(ethan.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await other.close();

    // Maya's save is refused: her text is kept, Ethan's version is shown next to it.
    await page.getByRole("button", { name: "Save summary" }).click();
    await expect(page.getByText(/Someone else saved this summary while you were writing/)).toBeVisible();
    await expect(page.getByText(`Ethan's notes ${run}`)).toBeVisible();
    await expect(box).toHaveValue(`Maya's notes ${run}`);
    await expectNoHorizontalScroll(page);

    // Saving again replaces it.
    await page.getByRole("button", { name: "Save summary" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(page.getByText(`Maya's notes ${run}`)).toBeVisible();
    await expect(page.getByText(`Ethan's notes ${run}`)).toHaveCount(0);
  });

  test("after a refused save, Cancel keeps their version: the editor opens again on it, with no old warning", async ({ page, browser }, info) => {
    const run = uniq(info.project.name);
    const team = { number: 23365, label: "23365 · Alpha Robotics" };
    await signIn(page, PEOPLE.softwareMember);
    await page.goto(`/strategy/teams/${team.number}`);
    await page.getByRole("button", { name: editSummary(team.label) }).click();
    const box = page.getByLabel(`Their strategy at a glance (${team.label})`);
    await box.fill(`Maya's draft ${run}`);

    const other = await browser.newContext();
    const ethan = await other.newPage();
    await signIn(ethan, PEOPLE.buildMember);
    await ethan.goto(`/strategy/teams/${team.number}`);
    await ethan.getByRole("button", { name: editSummary(team.label) }).click();
    await ethan.getByLabel(`Their strategy at a glance (${team.label})`).fill(`Ethan's version ${run}`);
    await ethan.getByRole("button", { name: "Save summary" }).click();
    await expect(ethan.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await other.close();

    await page.getByRole("button", { name: "Save summary" }).click();
    await expect(page.getByText(/Someone else saved this summary while you were writing/)).toBeVisible();
    await expect(page.getByText(/^Saved meanwhile by Ethan Chen/)).toBeVisible();

    // Maya keeps Ethan's version: Cancel, then Edit starts from it, without the old warning or her draft.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText(`Ethan's version ${run}`)).toBeVisible();
    await page.getByRole("button", { name: editSummary(team.label) }).click();
    await expect(box).toHaveValue(`Ethan's version ${run}`);
    await expect(page.getByText(/Someone else saved this summary/)).toHaveCount(0);
    await expect(page.getByText(/^Saved meanwhile/)).toHaveCount(0);

    // Fixing a typo in it saves on top of his version.
    await box.fill(`Ethan's version ${run} (typo fixed)`);
    await page.getByRole("button", { name: "Save summary" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    await expect(page.getByText(`Ethan's version ${run} (typo fixed)`)).toBeVisible();
  });

  test("an admin adds, edits, and removes a team (never our own number)", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const run = uniq(info.project.name);
    // A number nobody has (5–6 digits, different per project run).
    const number = 400000 + (Date.now() % 500000) + (info.project.name === "mobile" ? 1 : 0);
    await signIn(page, PEOPLE.admin);
    await page.goto("/strategy/teams");
    await page.getByRole("link", { name: "Add a team" }).click();
    await expect(page).toHaveURL(/\/strategy\/teams\/new$/);
    await expectNoHorizontalScroll(page);

    // Our own number is refused (and the typed values stay).
    await page.getByLabel("Team number").fill("19516");
    await page.getByLabel("Team name").fill(`E2E Bots ${run}`);
    await page.getByRole("button", { name: "Add team" }).click();
    await expect(page.locator("#number-error")).toContainText("is us, the Huskyteers");
    await expect(page.getByLabel("Team number")).toBeFocused();
    await expect(page.getByLabel("Team name")).toHaveValue(`E2E Bots ${run}`);
    // A number already on the list, too.
    await page.getByLabel("Team number").fill("9040");
    await page.getByRole("button", { name: "Add team" }).click();
    await expect(page.locator("#number-error")).toHaveText("Team 9040 is already on the list.");

    await page.getByLabel("Team number").fill(String(number));
    await page.getByLabel(/City/).fill("Anaheim");
    await page.getByRole("button", { name: "Add team" }).click();
    await expect(page).toHaveURL(new RegExp(`/strategy/teams/${number}\\?added=1$`));
    await expect(page.locator(":focus")).toContainText("Team added.");
    const label = `${number} · E2E Bots ${run}`;
    await expect(page.getByRole("heading", { level: 1 })).toContainText(label);
    await expectNoHorizontalScroll(page);

    await page.getByRole("link", { name: `Edit team ${label}` }).click();
    await page.getByLabel("Team name").fill(`E2E Bots Renamed ${run}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/strategy/teams/${number}\\?saved=1$`));
    const renamed = `${number} · E2E Bots Renamed ${run}`;
    await expect(page.getByRole("heading", { level: 1 })).toContainText(renamed);

    // Removing it says what goes with it.
    page.once("dialog", (d) => {
      expect(d.message()).toBe(`Remove ${renamed} from Other teams?`);
      void d.accept();
    });
    await page.getByRole("button", { name: `Remove team ${renamed}` }).click();
    await expect(page).toHaveURL(/\/strategy\/teams\?removed=/);
    await expect(page.locator(":focus")).toContainText(`Removed ${renamed}.`);
    expect(await sql(`SELECT id FROM "LeagueTeam" WHERE number = $1`, [number])).toHaveLength(0);
    await expectNoHorizontalScroll(page);
  });
});
