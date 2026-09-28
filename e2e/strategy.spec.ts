import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Strategy: the team's Pedro Pathing planner (the owner's BIOBUZZ visualizer on GitHub Pages) embedded in a
// frame, and the team's strategies below it. Everyone adds strategies; whoever added one (and admin access) can
// change it; admin access pins. .pp path files always download, ready for the planner's Load button.

const PLANNER_URL = "https://martinmax0711.github.io/PedroPathingBiobuzz/";
const FRAME = 'iframe[title="Pedro Pathing visualizer (BIOBUZZ)"]';

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

test.describe("strategy", () => {
  test("the planner is embedded with the right address; below big screens it's folded away until asked for", async ({ page }, info) => {
    await signIn(page, PEOPLE.softwareMember);
    const res = await page.goto("/strategy");
    expect(res?.status()).toBe(200);
    // Nothing on our page stops the frame from loading (no frame-src / child-src policy).
    expect(res?.headers()["content-security-policy"] ?? "").not.toMatch(/frame-src|child-src|default-src/);

    const newTab = page.getByRole("link", { name: "Open in a new tab" });
    await expect(newTab).toHaveAttribute("href", PLANNER_URL);
    await expect(newTab).toHaveAttribute("target", "_blank");

    const show = page.getByRole("button", { name: "Show it here" });
    if (await show.isVisible()) {
      // Phones, tablets, and small laptops: a note, and the frame only after "Show it here".
      await expect(page.getByText(/^Works best (on a computer|in full screen or a new tab)\.$/).filter({ visible: true })).toBeVisible();
      await expect(page.locator(FRAME)).toHaveCount(0);
      await expect(show).toHaveAttribute("aria-expanded", "false");
      await show.click();
      await expect(page.getByRole("button", { name: "Hide it" })).toHaveAttribute("aria-expanded", "true");
    }
    const frame = page.locator(FRAME);
    await expect(frame).toBeVisible();
    await expect(frame).toHaveAttribute("src", PLANNER_URL);
    await expect(frame).toHaveAttribute("loading", "lazy");
    await expect(frame).toHaveAttribute("allowfullscreen", "");
    const sandbox = (await frame.getAttribute("sandbox")) ?? "";
    for (const flag of ["allow-scripts", "allow-same-origin", "allow-downloads", "allow-popups", "allow-forms", "allow-modals"]) {
      expect(sandbox.split(/\s+/), flag).toContain(flag);
    }
    // Never lets the planner navigate our page.
    expect(sandbox).not.toMatch(/allow-top-navigation/);
    await expectNoHorizontalScroll(page);

    // At 375 px wide: the note, the fold, no Full screen (iPhones can't), and no sideways scrolling.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(page.getByText("Works best on a computer.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Full screen" })).toBeHidden();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Show it here" }).click();
    await expect(page.locator(FRAME)).toBeVisible();
    await expectNoHorizontalScroll(page);

    if (info.project.name === "desktop") {
      // A big screen: the planner is there right away, wider than the page's column (it needs about twice its
      // height), still without sideways scrolling; keyboard users can skip past it to the list.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload();
      await expect(page.getByRole("button", { name: "Show it here" })).toBeHidden();
      await expect(page.locator(FRAME)).toBeVisible();
      const box = (await page.locator(FRAME).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(1100);
      expect(box.width / box.height).toBeGreaterThanOrEqual(1.9);
      await expectNoHorizontalScroll(page);
      await expect(page.getByRole("link", { name: "Skip the planner" })).toHaveAttribute("href", "#strategies");
    }
  });

  test("a member adds an auto with a .pp path, it downloads; others can't change it; an admin pins it", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const title = `E2E red auto ${uniq(info.project.name)}`;

    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/strategy");
    await page.getByRole("link", { name: "Add a strategy" }).first().click();
    await expect(page).toHaveURL(/\/strategy\/new$/);
    await expectNoHorizontalScroll(page);

    // A .pp file the planner can't open is refused right away (never sent).
    const picker = page.locator("#files");
    const filesError = page.locator("#files-error");
    await picker.setInputFiles({ name: "broken.pp", mimeType: "application/octet-stream", buffer: Buffer.from("{ not json") });
    await expect(filesError).toHaveText(/^“broken\.pp” isn't a path file the planner can open/);
    await expect(picker).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("broken.pp", { exact: true })).toHaveCount(0);

    await picker.setInputFiles({ name: "e2e-auto.pp", mimeType: "application/octet-stream", buffer: Buffer.from(PP) });
    await expect(page.getByText("e2e-auto.pp", { exact: true })).toBeVisible();
    await expect(filesError).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Saving without a title: focus goes to it, and the picked file is kept.
    await page.getByRole("button", { name: "Add strategy" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
    await expect(page.getByText("e2e-auto.pp", { exact: true })).toBeVisible();

    await page.getByLabel("Title", { exact: true }).fill(title);
    await expect(page.getByLabel("Kind")).toHaveValue("AUTO");
    await page.getByLabel(/Description/).fill("Start by the HIVE, score the preload, park.");
    await page.getByRole("button", { name: "Add strategy" }).click();
    await expect(page).toHaveURL(/\/strategy\/[^/?]+\?added=1$/);
    await expect(page.locator(":focus")).toContainText("Strategy added.");
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("Autonomous", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/→ Load \(the ↑ arrow at the top\) → pick this file/)).toBeVisible();
    await expect(page.getByRole("link", { name: `Edit ${title}` })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // "Download path" saves the .pp file, byte for byte.
    const downloading = page.waitForEvent("download");
    await page.getByRole("link", { name: /^Download path/ }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("e2e-auto.pp");
    expect(await readFile((await download.path())!, "utf8")).toBe(PP);

    const [row] = await sql<{ id: string; fileId: string; contentType: string }>(
      `SELECT s.id, f.id AS "fileId", f."contentType" FROM "Strategy" s JOIN "StrategyFile" f ON f."strategyId" = s.id WHERE s.title = $1`,
      [title],
    );
    expect(row.contentType).toBe("application/json");
    // Always a download, even without ?download=1; never sniffed.
    const res = await page.request.get(`/strategy/files/${row.fileId}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="e2e-auto\.pp"/);
    expect(res.headers()["content-type"]).toBe("application/octet-stream");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");

    // On the list, with its path.
    await page.goto("/strategy?who=mine");
    const card = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: title }) });
    await expect(card).toContainText("1 path");
    await expectNoHorizontalScroll(page);

    // Another member sees it, but can't change or pin it.
    await signIn(page, PEOPLE.buildMember);
    await page.goto(`/strategy/${row.id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("link", { name: `Edit ${title}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Remove ${title}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`^Pin ${escape(title)}`) })).toHaveCount(0);
    expect((await page.goto(`/strategy/${row.id}/edit`))?.status()).toBe(404);
    expect((await page.request.get(`/strategy/files/${row.fileId}`)).status()).toBe(200);

    // An admin pins it: the button changes in place (focus stays), and it's listed first.
    await signIn(page, PEOPLE.admin);
    await page.goto(`/strategy/${row.id}`);
    await page.getByRole("button", { name: `Pin ${title} to the top` }).click();
    const unpin = page.getByRole("button", { name: `Unpin ${title}` });
    await expect(unpin).toBeVisible();
    await expect(unpin).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Pinned." })).toBeVisible();
    await expect(page.getByText("Pinned", { exact: true })).toBeVisible();
    await page.goto("/strategy");
    await expect(page.locator("#strategies").getByRole("listitem").first()).toContainText(title);

    // Clean up: the admin removes it (and its file).
    await page.goto(`/strategy/${row.id}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: `Remove ${title}` }).click();
    await expect(page).toHaveURL(/\/strategy\?removed=1$/);
    await expect(page.locator(":focus")).toContainText("Strategy removed.");
    expect((await page.request.get(`/strategy/files/${row.fileId}`)).status()).toBe(404);
  });
});
