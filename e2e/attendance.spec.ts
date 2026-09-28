import { expect, type Locator, type Page, test } from "@playwright/test";
import { E2E_PORT } from "../playwright.config";
import { currentCodes } from "../src/server/attendance/codes";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql } from "./helpers";

/** Tap an answer so it ends up chosen (tapping the chosen one clears it, so clear it first if needed). */
async function choose(group: Locator, name: string) {
  const button = group.getByRole("button", { name, exact: true });
  if ((await button.getAttribute("aria-pressed")) === "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  }
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toBeFocused();
}

/** The business leader starts (or goes back to) today's Regular attendance; returns its live screen's URL. */
async function openRegular(page: Page): Promise<string> {
  // On a day without regular practice (e.g. a weekend run), Start asks first.
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await page.goto("/attendance");
  const show = page.getByRole("link", { name: "Show Regular code" });
  if (await show.isVisible()) await show.click();
  else await page.getByRole("button", { name: /^(Start Regular attendance|Reopen Regular)$/ }).click();
  await expect(page).toHaveURL(/\/attendance\/sessions\/[a-z0-9]+$/);
  return page.url();
}

test.describe("attendance", () => {
  test("a business leader starts attendance; a member types the code and shows up on the roster", async ({ page, browser }, info) => {
    const member = info.project.name === "mobile" ? { email: PEOPLE.softwareMember, name: "Maya Patel" } : { email: PEOPLE.buildMember, name: "Ethan Chen" };

    await signIn(page, PEOPLE.businessLeader);
    const sessionUrl = await openRegular(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Regular attendance");
    await expect(page.getByRole("img", { name: "QR code for checking in" })).toBeVisible();
    const codeText = (await page.getByTestId("attendance-code").textContent()) ?? "";
    const code = codeText.replace(/\s/g, "");
    expect(code).toMatch(/^\d{6}$/);
    await expectNoHorizontalScroll(page);

    // The member, on a phone-sized screen in their own browser, types the code.
    const phone = await browser.newContext({ baseURL: `http://localhost:${E2E_PORT}`, viewport: { width: 375, height: 812 } });
    const memberPage = await phone.newPage();
    await signIn(memberPage, member.email);
    await memberPage.goto("/attendance");
    await expectNoHorizontalScroll(memberPage);
    await memberPage.getByRole("button", { name: "Enter code" }).click();
    const input = memberPage.getByLabel("Code on the screen");
    await expect(input).toBeFocused();

    // A wrong code keeps what was typed and says so.
    const wrong = code === "000000" ? "111111" : "000000";
    await input.fill(wrong);
    await memberPage.getByRole("button", { name: "Check in" }).click();
    await expect(memberPage.getByText("That code didn't work. Check the screen and try again.")).toBeVisible();
    await expect(input).toHaveValue(wrong);
    await expect(input).toBeFocused();

    await input.fill(code);
    await memberPage.getByRole("button", { name: "Check in" }).click();
    // The buttons make way for "You're checked in ✓", which takes focus.
    const done = memberPage.getByRole("status").filter({ hasText: /You're (already )?checked in/ }).first();
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
    await expect(memberPage.getByRole("button", { name: "Enter code" })).toHaveCount(0);
    await expectNoHorizontalScroll(memberPage);

    // The live screen refreshes on its own and lists them.
    await expect(page.getByRole("list", { name: "Checked in" })).toContainText(member.name, { timeout: 25_000 });

    // Members can't open the runner's screen or the planner.
    const res = await memberPage.goto(sessionUrl);
    expect(res?.status()).toBe(404);
    await memberPage.goto("/attendance/plan");
    await expect(memberPage).toHaveURL(/\/attendance$/);
    await phone.close();
  });

  test("scanning the QR code on a phone checks a member in (not \"already\"), with focus on the result", async ({ page, browser }, info) => {
    // Someone no other test checks in (a different one per project, since both run against the same database).
    const email = info.project.name === "mobile" ? "grace.liu@example.com" : "isabella.rossi@example.com";
    await signIn(page, PEOPLE.businessLeader);
    const sessionUrl = await openRegular(page);
    const id = sessionUrl.split("/").pop() ?? "";
    const [row] = await sql<{ secret: string }>(`SELECT secret FROM "AttendanceSession" WHERE id = $1`, [id]);
    // The same link the QR code on the screen holds right now.
    const scanPath = `/attendance/scan/${currentCodes(row.secret, id, new Date()).token}`;

    const phone = await browser.newContext({ baseURL: `http://localhost:${E2E_PORT}`, viewport: { width: 375, height: 812 } });
    const memberPage = await phone.newPage();
    await signIn(memberPage, email);
    await memberPage.goto(scanPath);
    const result = memberPage.getByRole("status").filter({ hasText: "You're checked in for Regular ✓" });
    await expect(result).toBeVisible();
    await expect(memberPage.locator(":focus")).toContainText("You're checked in for Regular ✓");
    await expect(memberPage.getByText("You're already checked in ✓")).toHaveCount(0);
    await expectNoHorizontalScroll(memberPage);

    // Opening the link again says so, without checking in twice.
    await memberPage.reload();
    await expect(memberPage.getByRole("status").filter({ hasText: "You're already checked in ✓" })).toBeVisible();
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "AttendanceRecord" r JOIN "User" u ON u.id = r."userId" WHERE r."sessionId" = $1 AND u.email = $2`,
      [id, email],
    );
    expect(n).toBe(1);
    await phone.close();
  });

  test("a failed schedule save keeps the picked days", async ({ page }) => {
    await signIn(page, PEOPLE.businessLeader);
    await page.goto("/attendance/settings");
    const regular = page.getByRole("group", { name: /Regular practice/ });
    const wednesday = regular.getByRole("checkbox", { name: "Wednesday" });
    const wasChecked = await wednesday.isChecked();
    await wednesday.setChecked(!wasChecked);
    // A Tuesday isn't allowed, so nothing is saved.
    await page.getByLabel("Reports start").fill("2026-09-29");
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByText(/Pick a Monday/).first()).toBeVisible();
    await expect(page.getByLabel("Reports start")).toBeFocused();
    await expect(wednesday).toBeChecked({ checked: !wasChecked });
  });

  test("a member answers Coming? with Yes / Half / No, and Attend Flex? on a Tuesday or Thursday", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, info.project.name === "mobile" ? PEOPLE.businessMember : PEOPLE.softwareMember);
    await page.goto("/attendance");

    // The next Flex day in the list (Tuesdays and Thursdays).
    const day = page
      .getByRole("list", { name: "Upcoming team days" })
      .getByRole("article")
      .filter({ has: page.getByRole("group", { name: "Attend Flex?" }) })
      .first();
    await expect(day).toBeVisible();
    await expect(day.getByText("Flex day")).toBeVisible();
    const coming = day.getByRole("group", { name: "Coming?" });
    const status = day.getByRole("status");

    await choose(coming, "Yes");
    await expect(status).toHaveText("Saved: Yes.");
    await choose(coming, "Half");
    await expect(status).toHaveText("Saved: Half.");
    await choose(coming, "No");
    await expect(status).toHaveText("Saved: No.");
    await choose(day.getByRole("group", { name: "Attend Flex?" }), "Yes");
    await expect(status).toHaveText("Saved: Flex Yes.");
    // Flex has no "Half".
    await expect(day.getByRole("group", { name: "Attend Flex?" }).getByRole("button", { name: "Half" })).toHaveCount(0);

    // A short note.
    await day.getByRole("button", { name: /^(Add|Edit) (a )?note for/ }).click();
    await day.getByRole("textbox").fill("Leaving at 5");
    await day.getByRole("button", { name: "Save note" }).click();
    await expect(status).toHaveText("Note saved.");
    await expect(day.getByText("Leaving at 5")).toBeVisible();
    await expect(day.getByRole("button", { name: /^Edit note for/ })).toBeFocused();
    await expectNoHorizontalScroll(page);

    // Saved for real.
    await page.reload();
    const again = page
      .getByRole("list", { name: "Upcoming team days" })
      .getByRole("article")
      .filter({ has: page.getByRole("group", { name: "Attend Flex?" }) })
      .first();
    await expect(again.getByRole("group", { name: "Coming?" }).getByRole("button", { name: "No", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(again.getByRole("group", { name: "Attend Flex?" }).getByRole("button", { name: "Yes", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("the in-app scanner explains when there's no camera, and offers the code instead", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // Someone no other test checks in (the first test checks in Ethan on desktop and Maya on mobile).
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/attendance");
    await page.getByRole("button", { name: "Scan QR code" }).click();
    const problem = page.getByRole("alert").filter({ hasText: /camera/i });
    await expect(problem).toBeVisible();
    await expect(problem).toContainText(/type the code/i);
    await page.getByRole("button", { name: "Type the code instead" }).click();
    await expect(page.getByLabel("Code on the screen")).toBeFocused();
    await expectNoHorizontalScroll(page);
  });

  test("staff see who's coming and the two-week reports", async ({ page }) => {
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/attendance/plan");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Who's coming");
    await expect(page.getByRole("navigation", { name: "Pick a day" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto("/attendance/reports");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Two-week reports");
    await page.locator('a[href^="/attendance/reports/"]').first().click();
    await expect(page.getByRole("heading", { name: "When attendance was taken" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", /\/csv$/);
    await expectNoHorizontalScroll(page);
  });
});
