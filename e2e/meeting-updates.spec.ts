import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Meeting updates: after each meeting every subteam writes what it did, clearly marked with who wrote it.
// Ethan (Build member) and Maya (Software member) write today's; Marcus (Build leader) fixes and removes Ethan's.

/** "YYYY-MM-DD" in the team timezone, `days` from today. */
function teamDay(days = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date(Date.now() + days * 24 * 60 * 60 * 1000));
}

/** Today's meeting on the feed. */
const todaySection = (page: Page) => page.getByRole("region", { name: /\bToday$/ });

test.describe("meeting updates", () => {
  test("each subteam writes its own update, marked with who wrote it; the Build leader edits and removes Build's", async ({ page }, info) => {
    const tag = uniq(info.project.name);
    const buildText = `E2E Build: drivetrain assembled ${tag}`;
    const buildNext = `E2E mount the intake ${tag}`;
    const buildBlocker = `E2E out of M3 screws ${tag}`;
    const softwareText = `E2E Software: auto path tuned ${tag}`;

    // --- A Build member writes today's update. A mistake keeps what was typed and focuses the field.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/updates");
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Write an update" }).first().click();
    await expect(page).toHaveURL(/\/updates\/new$/);
    await expect(page.getByLabel("Meeting date")).toHaveValue(teamDay());
    // Only their own subteam: shown as text, nothing to pick.
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Build", { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByLabel("Meeting date").fill(teamDay(1));
    await page.getByLabel(/^Next time/).fill(buildNext);
    await page.getByLabel(/^Problems or help needed/).fill(buildBlocker);
    await page.getByRole("button", { name: "Post update" }).click();
    await expect(page.locator("#meetingDate-error")).toHaveText("The meeting date can't be in the future.");
    await expect(page.locator("#body-error")).toHaveText("Write what the subteam did.");
    await expect(page.getByLabel("Meeting date")).toBeFocused();
    await expect(page.getByLabel(/^Next time/)).toHaveValue(buildNext);
    await expect(page.getByLabel(/^Problems or help needed/)).toHaveValue(buildBlocker);
    await expectNoHorizontalScroll(page);

    await page.getByLabel("Meeting date").fill(teamDay());
    await page.getByRole("button", { name: "Post update" }).click();
    await expect(page.locator("#body-error")).toHaveText("Write what the subteam did.");
    await expect(page.getByLabel("What we did")).toBeFocused();
    await expect(page.locator("#meetingDate-error")).toHaveCount(0);

    await page.getByLabel("What we did").fill(buildText);
    await page.getByRole("button", { name: "Post update" }).click();
    await expect(page).toHaveURL(/\/updates\?added=[^#]+#update-/);
    let buildUpdate = todaySection(page).getByRole("group", { name: "Build" }).getByRole("article").filter({ hasText: buildText });
    await expect(buildUpdate).toBeFocused();
    await expect(buildUpdate.getByRole("status")).toHaveText("Posted. Thanks for writing it up!");
    // Focus lands on the update, so the message is read with it.
    await expect(buildUpdate).toHaveAccessibleDescription("Posted. Thanks for writing it up!");
    await expect(buildUpdate).toContainText("Written by Ethan Chen (you) ·");
    await expect(buildUpdate).toContainText("Build member");
    await expect(buildUpdate.getByText(buildNext)).toBeVisible();
    await expect(buildUpdate.getByText(buildBlocker)).toBeVisible();
    await expect(buildUpdate.getByRole("link", { name: "Edit Build update by Ethan Chen" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    // Nobody writes Business's today: an empty card side by side, one short line when stacked.
    const sideBySide = (page.viewportSize()?.width ?? 0) >= 1280;
    if (sideBySide) await expect(todaySection(page).getByRole("group", { name: "Business" })).toContainText("No update yet");
    else await expect(todaySection(page).getByText(/^No (Software or )?Business update yet$/)).toBeVisible();
    const buildId = (await buildUpdate.getAttribute("id"))!.replace(/^update-/, "");
    const [row] = await sql<{ subteam: string; author: string; nextSteps: string; blockers: string }>(
      `SELECT m.subteam, u.email AS author, m."nextSteps", m.blockers FROM "MeetingUpdate" m JOIN "User" u ON u.id = m."authorId" WHERE m.id = $1`,
      [buildId],
    );
    expect(row).toEqual({ subteam: "BUILD", author: PEOPLE.buildMember, nextSteps: buildNext, blockers: buildBlocker });

    // --- A Software member writes theirs: it lands in the Software column of the same day.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/updates/new");
    await expect(page.getByRole("radio")).toHaveCount(0);
    await page.getByLabel("What we did").fill(softwareText);
    await page.getByRole("button", { name: "Post update" }).click();
    await expect(page).toHaveURL(/\/updates\?added=/);
    const today = todaySection(page);
    const softwareColumn = today.getByRole("group", { name: "Software" });
    const buildColumn = today.getByRole("group", { name: "Build" });
    const softwareUpdate = softwareColumn.getByRole("article").filter({ hasText: softwareText });
    await expect(softwareUpdate).toContainText("Written by Maya Patel (you) ·");
    buildUpdate = buildColumn.getByRole("article").filter({ hasText: buildText });
    await expect(buildUpdate).toContainText("Written by Ethan Chen ·");
    // Three subteams side by side when the feed is wide enough (1280 px with the sidebar), stacked on phones (Software first).
    const [sw, build] = [await softwareColumn.boundingBox(), await buildColumn.boundingBox()];
    if (sideBySide) expect(Math.abs(sw!.y - build!.y)).toBeLessThan(2);
    else expect(build!.y).toBeGreaterThan(sw!.y + sw!.height - 1);
    await expectNoHorizontalScroll(page);

    // She can't change the Build update — not on the feed, not by its URL.
    await expect(buildUpdate.getByRole("link", { name: /^Edit/ })).toHaveCount(0);
    await expect(buildUpdate.getByRole("button", { name: /^Remove/ })).toHaveCount(0);
    await expect(softwareUpdate.getByRole("link", { name: "Edit Software update by Maya Patel" })).toBeVisible();
    const res = await page.goto(`/updates/${buildId}/edit`);
    expect(res?.status()).toBe(404);

    // Filters: a subteam chip, and "Mine".
    await page.goto("/updates");
    await page.getByRole("navigation", { name: "Filter by subteam" }).getByRole("link", { name: "Build", exact: true }).click();
    await expect(page).toHaveURL(/\/updates\?subteam=BUILD$/);
    await expect(page.getByRole("link", { name: "Build", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("link", { name: "All", exact: true })).not.toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("article").filter({ hasText: buildText })).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: softwareText })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Mine" }).click();
    await expect(page).toHaveURL(/\/updates\?subteam=BUILD&who=mine$/);
    await expect(page.getByText("You haven't written any Build updates")).toBeVisible();
    await page.getByRole("navigation", { name: "Filter by subteam" }).getByRole("link", { name: "All", exact: true }).click();
    await expect(page).toHaveURL(/\/updates\?who=mine$/);
    await expect(page.getByRole("link", { name: "Mine" })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("article").filter({ hasText: softwareText })).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: buildText })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // --- The Build leader fixes Ethan's update: the byline says who edited it.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/updates");
    buildUpdate = todaySection(page).getByRole("group", { name: "Build" }).getByRole("article").filter({ hasText: buildText });
    // Build's leader doesn't edit Software's.
    await expect(
      todaySection(page).getByRole("group", { name: "Software" }).getByRole("article").filter({ hasText: softwareText }).getByRole("link", { name: /^Edit/ }),
    ).toHaveCount(0);
    await buildUpdate.getByRole("link", { name: "Edit Build update by Ethan Chen" }).click();
    await expect(page).toHaveURL(new RegExp(`/updates/${buildId}/edit$`));
    await expect(page.getByLabel("What we did")).toHaveValue(buildText);
    await expect(page.getByRole("radio")).toHaveCount(0);
    // Cancel goes back to this update on the feed.
    await expect(page.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", `/updates?focus=${buildId}#update-${buildId}`);
    await expectNoHorizontalScroll(page);
    await page.getByLabel("What we did").fill(`${buildText} and tested`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/updates\?saved=/);
    buildUpdate = todaySection(page).getByRole("group", { name: "Build" }).getByRole("article").filter({ hasText: `${buildText} and tested` });
    await expect(buildUpdate).toBeFocused();
    await expect(buildUpdate.getByRole("status")).toHaveText("Changes saved.");
    await expect(buildUpdate).toContainText("Written by Ethan Chen ·");
    await expect(buildUpdate).toContainText(/Edited by Marcus Johnson · (just now|\d+ min ago)/);
    const [edited] = await sql<{ editor: string; author: string }>(
      `SELECT e.email AS editor, a.email AS author FROM "MeetingUpdate" m
         JOIN "User" e ON e.id = m."lastEditedById" JOIN "User" a ON a.id = m."authorId" WHERE m.id = $1`,
      [buildId],
    );
    expect(edited).toEqual({ editor: PEOPLE.buildLeader, author: PEOPLE.buildMember });

    // --- ...and removes it (after confirming).
    page.once("dialog", (d) => void d.accept());
    await buildUpdate.getByRole("button", { name: "Remove Build update by Ethan Chen" }).click();
    await expect(page).toHaveURL(new RegExp(`/updates\\?removed=BUILD&date=${teamDay()}$`));
    await expect(page.getByRole("status").filter({ hasText: /^Removed the Build update from \w{3}, \w{3} \d{1,2}\.$/ })).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: buildText })).toHaveCount(0);
    await expect(page.getByRole("article").filter({ hasText: softwareText })).toBeVisible();
    expect(await sql(`SELECT id FROM "MeetingUpdate" WHERE id = $1`, [buildId])).toEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test("every meeting updates page fits a 375 px phone without sideways scrolling", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const text = `E2E captain's long-word check ${"Supercalifragilistic".repeat(4)} ${uniq(info.project.name)}`;

    // The captain writes for any subteam: the subteams are radio cards.
    await signIn(page, PEOPLE.admin);
    await page.goto("/updates/new?subteam=BUSINESS");
    await expect(page.getByRole("group", { name: "Subteam" }).getByRole("radio")).toHaveCount(3);
    await expect(page.getByRole("radio", { name: /Business/ })).toBeChecked();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Post update" }).click();
    await expect(page.getByLabel("What we did")).toBeFocused();
    await expect(page.getByRole("radio", { name: /Business/ })).toBeChecked();
    await page.getByLabel("What we did").fill(text);
    await page.getByLabel(/^Problems or help needed/).fill(`https://example.com/${"x".repeat(80)}`);
    await page.getByRole("button", { name: "Post update" }).click();
    await expect(page).toHaveURL(/\/updates\?added=/);
    const update = todaySection(page).getByRole("group", { name: "Business" }).getByRole("article").filter({ hasText: text });
    await expect(update).toContainText("Written by Jordan Lee (you) ·");
    await expectNoHorizontalScroll(page);

    for (const path of ["/updates", "/updates?subteam=SOFTWARE", "/updates?who=mine", "/updates?page=2", "/updates/new"]) {
      await page.goto(path);
      await expectNoHorizontalScroll(page);
    }
    await page.goto("/updates?subteam=BUSINESS");
    await page.getByRole("article").filter({ hasText: text }).getByRole("link", { name: /^Edit/ }).click();
    await expect(page).toHaveURL(/\/updates\/[^/]+\/edit$/);
    await expectNoHorizontalScroll(page);
    // The captain edits their own update: it says "Edited", without repeating the name.
    await page.getByLabel("What we did").fill(`${text} (fixed)`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/updates\?saved=/);
    const fixed = page.getByRole("article").filter({ hasText: `${text} (fixed)` });
    await expect(fixed).toBeFocused();
    await expect(fixed).toContainText(/Edited · (just now|\d+ min ago)/);
    await expect(fixed).not.toContainText("Edited by");
    await expectNoHorizontalScroll(page);
    await fixed.getByRole("link", { name: /^Edit/ }).click();
    await expect(page).toHaveURL(/\/updates\/[^/]+\/edit$/);

    // Clean up.
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: /^Remove this Business update/ }).click();
    await expect(page).toHaveURL(/\/updates\?removed=BUSINESS&date=\d{4}-\d{2}-\d{2}$/);
    await expectNoHorizontalScroll(page);
  });
});
