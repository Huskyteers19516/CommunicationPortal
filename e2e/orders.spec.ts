import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, openNavIfNeeded, PEOPLE, signIn, sql, uniq } from "./helpers";

// Order list (/orders): anyone adds what the team needs to buy; a leader approves it (never their own request,
// unless all-scope); the person ordering it (or the Business subteam) marks it Ordered and Done.

/** Put an item straight in the database, added by (and ordered by) `email`. */
async function insertItem(description: string, email: string, status = "REQUESTED", notes = ""): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO "PurchaseItem" (id, description, notes, status, "ordererId", "createdById", "createdAt", "updatedAt")
     VALUES ('e2e_' || md5(random()::text), $1, $2, $3::"PurchaseStatus", (SELECT id FROM "User" WHERE email = $4), (SELECT id FROM "User" WHERE email = $4), now(), now())
     RETURNING id`,
    [description, notes, status, email],
  );
  return row.id;
}

/** The status line under an item's status menu. */
function statusLine(page: Page, description: string) {
  return page.getByRole("combobox", { name: `Status for ${description}` }).locator("xpath=../..").getByRole("status");
}

test.describe("order list", () => {
  test("a member adds an item; the Business leader approves it; the orderer marks it Ordered, then Done", async ({ page }, info) => {
    const description = `E2E drive motors ${uniq(info.project.name)}`;

    // A build member adds something from the menu. A bad price keeps what was typed and focuses the field.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await openNavIfNeeded(page);
    await page.getByRole("link", { name: "Order list" }).first().click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole("heading", { level: 1, name: "Order list" })).toBeVisible();
    await page.getByRole("link", { name: "Add item" }).first().click();
    await expect(page).toHaveURL(/\/orders\/new$/);
    await expectNoHorizontalScroll(page);
    await page.getByLabel("Description").fill(description);
    await page.getByLabel("Link").fill("shop.example.com/e2e-motors");
    await page.getByLabel("Quantity").fill("2");
    await page.getByLabel("Cost ($)").fill("-3");
    await page.getByLabel("Notes").fill("SKU e2e-42 (2)");
    // Members order what they add (a manager could pick someone else).
    await expect(page.getByLabel("Orderer")).toHaveCount(0);
    await page.getByRole("button", { name: "Add to the list" }).click();
    await expect(page.locator("#cost-error")).toHaveText("The price can't be negative.");
    await expect(page.getByLabel("Cost ($)")).toBeFocused();
    await expect(page.getByLabel("Description")).toHaveValue(description);
    await page.getByLabel("Cost ($)").fill("$79.98");
    await page.getByRole("button", { name: "Add to the list" }).click();

    // Back on the list: highlighted and focused. Members can't approve, so there's no status menu.
    await expect(page).toHaveURL(/\/orders\?added=/);
    await expect(page.getByRole("link", { name: `Edit ${description}` })).toBeFocused();
    await expect(page.getByText("Added just now.").filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: `Status for ${description}` })).toHaveCount(0);
    // The product page opens from the description (table) or its own link (phone cards, whose title opens the item).
    await expect(page.locator('a[href="https://shop.example.com/e2e-motors"]').filter({ visible: true })).toHaveCount(1);
    const [added] = await sql<{ status: string; cost: number; quantity: number; orderer: string }>(
      `SELECT p.status::text AS status, p."costCents" AS cost, p.quantity, u.email AS orderer
       FROM "PurchaseItem" p JOIN "User" u ON u.id = p."ordererId" WHERE p.description = $1`,
      [description],
    );
    expect(added).toEqual({ status: "REQUESTED", cost: 7998, quantity: 2, orderer: PEOPLE.buildMember });

    // The Business leader hears about it on Today and approves it right in the list, like the sheet's dropdown.
    // The list keeps its order.
    await signIn(page, PEOPLE.businessLeader);
    await page.goto("/today");
    await page.getByRole("link", { name: /^\d+ items? to approve on the order list$/ }).click();
    await expect(page).toHaveURL(/\/orders$/);
    const order = () => page.locator("[data-status-select]").filter({ visible: true }).evaluateAll((els) => els.map((e) => e.getAttribute("data-status-select")));
    const status = page.getByRole("combobox", { name: `Status for ${description}` });
    await expect(status).toHaveValue("REQUESTED");
    const before = await order();
    await status.focus();
    await status.selectOption("APPROVED");
    await expect(statusLine(page, description)).toHaveText("Saved.");
    await expect(status).toBeFocused();
    await expect(status).toHaveValue("APPROVED");
    expect(await order()).toEqual(before);
    await expectNoHorizontalScroll(page);

    // The orderer sees it on Today (no emails for approvals) and moves it one step at a time: Ordered, then Done.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await page.getByRole("link", { name: "1 approved item for you to order" }).click();
    await expect(page).toHaveURL(/\/orders\?mine=1$/);
    await expect(page.getByRole("link", { name: "Mine" })).toHaveAttribute("aria-current", "true");
    const mine = page.getByRole("combobox", { name: `Status for ${description}` });
    await expect(mine).toHaveValue("APPROVED");
    expect(await mine.locator("option").allTextContents()).toEqual(["Approved", "Ordered"]);
    await mine.focus();
    await mine.selectOption("ORDERED");
    await expect(statusLine(page, description)).toHaveText("Saved.");
    await expect(mine.locator("option")).toHaveText(["Approved", "Ordered", "Done"]);
    await mine.selectOption("DONE");
    // Done leaves the Open list: the page says where it went.
    await expect(page.getByRole("status").filter({ hasText: "moved to Done" })).toHaveText(`“${description}” moved to Done.`);
    await expect(mine).toHaveCount(0);
    const [done] = await sql<{ status: string; changedBy: string }>(
      `SELECT p.status::text AS status, u.email AS "changedBy"
       FROM "PurchaseItem" p JOIN "User" u ON u.id = p."statusChangedById" WHERE p.description = $1`,
      [description],
    );
    expect(done).toEqual({ status: "DONE", changedBy: PEOPLE.buildMember });

    // Its page says who changed the status last; it can't be edited any more by a member.
    await page.goto("/orders?filter=done");
    await page.getByRole("link", { name: `Details for ${description}` }).click();
    await expect(page.getByText(/^Status changed by Ethan Chen · /)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test("a member can't approve items or change someone else's", async ({ page }, info) => {
    const description = `E2E someone else's ${uniq(info.project.name)}`;
    const id = await insertItem(description, PEOPLE.buildMember);
    // Business members buy approved items; approving is for leaders.
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/orders");
    await expect(page.getByRole("link", { name: `Details for ${description}` })).toBeVisible();
    await expect(page.getByRole("combobox", { name: `Status for ${description}` })).toHaveCount(0);

    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/orders");
    await expect(page.getByRole("combobox", { name: `Status for ${description}` })).toHaveCount(0);
    await page.getByRole("link", { name: `Details for ${description}` }).click();
    await expect(page).toHaveURL(new RegExp(`/orders/${id}$`));
    await expect(page.getByText("Waiting for a leader to approve it.")).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove ${description}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: `Status for ${description}` })).toHaveCount(0);
  });

  test("whoever added an item changes and removes it while it's still Requested", async ({ page }, info) => {
    const description = `E2E remove me ${uniq(info.project.name)}`;
    const id = await insertItem(description, PEOPLE.softwareMember);
    await signIn(page, PEOPLE.softwareMember);
    await page.goto(`/orders/${id}`);
    await page.getByLabel("Notes").fill("Two of them, please");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/orders\?saved=/);
    await expect(page.getByText("Changes saved.").filter({ visible: true })).toBeVisible();

    await page.goto(`/orders/${id}`);
    let question = "";
    page.once("dialog", (dialog) => {
      question = dialog.message();
      void dialog.accept();
    });
    await page.getByRole("button", { name: `Remove ${description}` }).click();
    // Back on the tab it was on; the link never carries the description.
    await expect(page).toHaveURL(/\/orders\?removed=1$/);
    expect(question).toBe(`Remove “${description}” from the order list? This can't be undone.`);
    await expect(page.getByRole("status").filter({ hasText: "Item removed." })).toBeVisible();
    expect(await sql(`SELECT id FROM "PurchaseItem" WHERE id = $1`, [id])).toEqual([]);
  });

  test("Export to spreadsheet downloads what's shown, with formulas turned into plain text", async ({ page }, info) => {
    const id = uniq(info.project.name);
    const sneaky = `=HYPERLINK("http://evil.example","E2E ${id}")`;
    await insertItem(sneaky, PEOPLE.businessMember, "REQUESTED", "a, b");
    await signIn(page, PEOPLE.businessLeader);
    await page.goto("/orders");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Export to spreadsheet" }).click()]);
    // The name says which part of the list it is (the Open tab here).
    expect(download.suggestedFilename()).toMatch(/^order-list-open-\d{4}-\d{2}-\d{2}\.csv$/);
    const text = await readFile(await download.path(), "utf8");
    expect(text.startsWith("﻿Orderer,Status,Description,Notes,Link,Vendor,Qty,Cost ($),For,Added")).toBe(true);
    // (Orderer first: Ava, whose name another spec may have changed.)
    expect(text).toContain(`,Requested,"'=HYPERLINK(""http://evil.example"",""E2E ${id}"")","a, b",`);
    // Open items only (what the page showed): the seed's done flywheels aren't in it.
    expect(text).toContain("Dirty Soda Fundraiser Supplies");
    expect(text).not.toContain("Flywheels for the outtake");

    // Signed out: to the sign-in page, not the file.
    await page.context().clearCookies();
    const res = await page.request.get("/orders/export", { maxRedirects: 0 });
    expect(res.status()).toBe(307);
  });

  test("no sideways scrolling on a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.businessMember);
    const [item] = await sql<{ id: string }>(`SELECT id FROM "PurchaseItem" WHERE description = 'Dirty Soda Fundraiser Supplies'`);
    for (const path of ["/orders", "/orders?filter=all", "/orders?filter=done&for=BUILD", "/orders?mine=1", "/orders/new", `/orders/${item.id}`]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expectNoHorizontalScroll(page);
    }
  });
});
