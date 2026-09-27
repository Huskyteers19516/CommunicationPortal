import { expect, test } from "@playwright/test";
import { E2E_PORT } from "../playwright.config";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

/** "YYYY-MM-DD", `days` from now (a week out is "upcoming" in any timezone). */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test.describe("fundraising", () => {
  test("business adds a fundraiser with 2 spots; two members fill it; a third can't; the amount raised shows", async ({
    page,
    browser,
  }, info) => {
    const name = `E2E bake sale ${uniq(info.project.name)}`;

    // A business member adds it. A bad spots number keeps what was typed and focuses the field.
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/fundraising");
    await page.getByRole("link", { name: "Add fundraiser" }).first().click();
    await expect(page).toHaveURL(/\/fundraising\/new$/);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("radio", { name: /Sale/ }).check();
    await page.getByLabel("Status", { exact: true }).selectOption("UPCOMING");
    await page.getByLabel("Starts").fill(daysFromNow(7));
    await page.getByLabel("Location").fill("School front lobby");
    await page.getByLabel(/^Goal/).fill("$500");
    await page.getByLabel(/^Helper spots/).fill("0");
    await page.getByRole("button", { name: "Add fundraiser" }).click();
    await expect(page.locator("#volunteerLimit-error")).toHaveText("Enter a number from 1 to 200, or leave it empty for no limit.");
    await expect(page.getByLabel(/^Helper spots/)).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
    await expect(page.getByRole("radio", { name: /Sale/ })).toBeChecked();
    await expectNoHorizontalScroll(page);
    await page.getByLabel(/^Helper spots/).fill("2");
    await page.getByRole("button", { name: "Add fundraiser" }).click();
    await expect(page).toHaveURL(/\/fundraising\/[a-z0-9]+\?added=1$/);
    await expect(page.getByText("Added. The whole team can see it now.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
    const fundraiserUrl = page.url().replace(/\?.*$/, "");
    const [row] = await sql<{ status: string; kind: string; goalAmount: number; volunteerLimit: number; creator: string }>(
      `SELECT f.status, f.kind, f."goalAmount", f."volunteerLimit", u.email AS creator
         FROM "Fundraiser" f JOIN "User" u ON u.id = f."createdById" WHERE f.name = $1`,
      [name],
    );
    expect(row).toEqual({ status: "UPCOMING", kind: "SALE", goalAmount: 500, volunteerLimit: 2, creator: PEOPLE.businessMember });

    // A third person opens the page now, while there are still spots (their own browser).
    const third = await browser.newContext({ baseURL: `http://localhost:${E2E_PORT}`, viewport: page.viewportSize() });
    const thirdPage = await third.newPage();
    await signIn(thirdPage, PEOPLE.softwareLeader);
    await thirdPage.goto("/fundraising");
    await expect(thirdPage.getByRole("button", { name: `I'll help with ${name}` })).toBeVisible();

    // A software member signs up from the list: "Leave" takes focus, and they see themselves on it.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/fundraising");
    let card = page.getByRole("article", { name });
    await expect(card.getByText("0 of 2 spots taken · 2 left")).toBeVisible();
    await card.getByRole("button", { name: `I'll help with ${name}` }).click();
    await expect(card.getByRole("button", { name: `Leave ${name}` })).toBeFocused();
    await expect(card.getByRole("status")).toHaveText("Thanks for helping! You're on the list.");
    await expect(card.getByText("1 of 2 spots taken · 1 left")).toBeVisible();
    await expect(card.getByText("You're helping")).toBeVisible();
    await expect(card.getByRole("list", { name: "Helpers" })).toContainText("You");
    await expectNoHorizontalScroll(page);
    await page.goto(fundraiserUrl);
    await expect(page.locator("#helpers")).toContainText("Maya Patel (you)");

    // A build member takes the last spot.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/fundraising");
    card = page.getByRole("article", { name });
    await card.getByRole("button", { name: `I'll help with ${name}` }).click();
    await expect(card.getByText("2 of 2 spots taken · full")).toBeVisible();

    // The third person's page is out of date: the server says it's full and the button goes away.
    let thirdCard = thirdPage.getByRole("article", { name });
    await thirdCard.getByRole("button", { name: `I'll help with ${name}` }).click();
    await expect(thirdCard.getByRole("alert")).toHaveText("All 2 spots are taken.");
    await expect(thirdCard.getByRole("alert")).toBeFocused();
    await expect(thirdCard.getByRole("button", { name: /I'll help/ })).toHaveCount(0);
    // After a reload there's still no way in.
    await thirdPage.reload();
    thirdCard = thirdPage.getByRole("article", { name });
    await expect(thirdCard.getByText("2 of 2 spots taken · full")).toBeVisible();
    await expect(thirdCard.getByRole("button", { name: /I'll help/ })).toHaveCount(0);
    await third.close();
    const helpers = await sql<{ email: string }>(
      `SELECT u.email FROM "FundraiserVolunteer" v JOIN "User" u ON u.id = v."userId" JOIN "Fundraiser" f ON f.id = v."fundraiserId"
        WHERE f.name = $1 ORDER BY v."createdAt"`,
      [name],
    );
    expect(helpers.map((h) => h.email)).toEqual([PEOPLE.softwareMember, PEOPLE.buildMember]);

    // The business member updates the amount raised; the progress shows it here and on the list.
    await signIn(page, PEOPLE.businessMember);
    await page.goto(fundraiserUrl);
    await page.getByLabel(/Amount raised so far/).fill("$275");
    await page.getByRole("button", { name: "Update amount" }).click();
    await expect(page.getByRole("status").filter({ hasText: "raised so far" })).toHaveText("Saved — $275 raised so far.");
    await expect(page.getByRole("button", { name: "Update amount" })).toBeFocused();
    const bar = page.getByRole("progressbar", { name: `Raised for ${name}` });
    await expect(bar).toHaveAttribute("aria-valuenow", "275");
    await expect(bar).toHaveAttribute("aria-valuetext", "$275 of $500 (55%)");
    // Sent with Enter from the field (which is replaced with the new amount): focus lands on the button, not <body>.
    const amount = page.getByLabel(/Amount raised so far/);
    await amount.fill("$290");
    await amount.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: "raised so far" })).toHaveText("Saved — $290 raised so far.");
    await expect(page.getByRole("button", { name: "Update amount" })).toBeFocused();
    await expect(amount).toHaveValue("290");
    // 290 / 500 is 58% (not 57% from floating-point rounding).
    await expect(bar).toHaveAttribute("aria-valuetext", "$290 of $500 (58%)");
    await expectNoHorizontalScroll(page);
    await page.goto("/fundraising");
    card = page.getByRole("article", { name });
    await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "290");
    await expect(card.getByText("58%")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("a fundraiser whose dates passed gets its own group; a year typo is caught; marking it done moves it", async ({ page }, info) => {
    const name = `E2E past ${uniq(info.project.name)}`;
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "Fundraiser" (id, name, status, "startsOn", "createdAt", "updatedAt")
       VALUES ('e2e_' || md5(random()::text), $1, 'UPCOMING', $2::date, now(), now()) RETURNING id`,
      [name, daysFromNow(-10)],
    );

    // Members see it under "Dates passed" (not "upcoming"), with a matching badge and no way to sign up.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/fundraising");
    let card = page.getByRole("region", { name: /^Dates passed/ }).getByRole("article", { name });
    await expect(card.getByText("Dates passed", { exact: true })).toBeVisible();
    await expect(card.getByText("Its dates have passed, so sign-ups are closed.")).toBeVisible();
    await expect(card.getByRole("button", { name: /I'll help/ })).toHaveCount(0);
    await expect(card.getByRole("link", { name: /Update status/ })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /^Happening now & upcoming/ }).getByRole("article", { name })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // The Business team gets a way to fix it.
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/fundraising");
    card = page.getByRole("region", { name: /^Dates passed/ }).getByRole("article", { name });
    await card.getByRole("link", { name: `Update status of ${name}` }).click();
    await expect(page).toHaveURL(new RegExp(`/fundraising/${id}\\?edit=1#status$`));
    await expect(page.getByLabel("Starts")).toHaveAttribute("min", /^\d{4}-\d{2}-\d{2}$/);
    await expect(page.getByLabel("Starts")).toHaveAttribute("max", /^\d{4}-\d{2}-\d{2}$/);

    // A two-digit year typed into a desktop date field becomes 0026: refused on that field, with focus there.
    await page.getByLabel("Starts").fill("0026-10-03");
    await page.getByLabel("Status", { exact: true }).selectOption("DONE");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator("#startsOn-error")).toHaveText("That date is more than 5 years ago. Check the year.");
    await expect(page.getByLabel("Starts")).toBeFocused();
    await expect(page.getByLabel("Status", { exact: true })).toHaveValue("DONE");
    await expectNoHorizontalScroll(page);

    await page.getByLabel("Starts").fill(daysFromNow(-10));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/fundraising/${id}\\?saved=1$`));
    await page.goto("/fundraising");
    await expect(page.getByRole("region", { name: /^Done/ }).getByRole("article", { name })).toBeVisible();
    await expect(page.getByRole("region", { name: /^Dates passed/ }).getByRole("article", { name })).toHaveCount(0);
  });

  test("the fundraising pages have no sideways scrolling for each role", async ({ page }) => {
    const [fundraiser] = await sql<{ id: string }>(`SELECT id FROM "Fundraiser" WHERE status = 'ACTIVE' ORDER BY "createdAt" LIMIT 1`);
    const pages: Record<string, string[]> = {
      [PEOPLE.softwareMember]: ["/fundraising", "/fundraising/new", `/fundraising/${fundraiser.id}`],
      [PEOPLE.businessMember]: ["/fundraising", "/fundraising/new", `/fundraising/${fundraiser.id}`, `/fundraising/${fundraiser.id}?edit=1`],
    };
    for (const [email, paths] of Object.entries(pages)) {
      await signIn(page, email);
      for (const path of paths) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBe(200);
        await expectNoHorizontalScroll(page);
      }
    }
    // Members see the fundraiser, not the edit form.
    await signIn(page, PEOPLE.buildMember);
    await page.goto(`/fundraising/${fundraiser.id}?edit=1`);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
    const res = await page.goto("/fundraising/does-not-exist");
    expect(res?.status()).toBe(404);
  });
});
