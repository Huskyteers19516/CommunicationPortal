import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Members can share resources, but a leader (or anyone with admin access) approves them first.

test.describe("member resources need approval", () => {
  test("a member shares a link; other members only see it after a leader approves it", async ({ page }, info) => {
    const title = `E2E gear calculator ${uniq(info.project.name)}`;
    const url = `https://gears.example.com/${uniq(info.project.name)}`;

    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/resources");
    await page.getByRole("link", { name: "Share a resource" }).first().click();
    await expect(page).toHaveURL(/\/resources\/new$/);
    await expect(page.getByText("A leader or admin approves it first")).toBeVisible();
    await expect(page.getByText("Pin to the top")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Link", { exact: true }).fill(url);
    await page.getByRole("button", { name: "Send for approval" }).click();
    await expect(page).toHaveURL(/\/resources$/);

    const mine = page.locator("#mine");
    const item = mine.getByRole("listitem").filter({ hasText: title });
    await expect(item).toBeVisible();
    await expect(item.getByText("Waiting for approval")).toBeVisible();
    await expectNoHorizontalScroll(page);

    const [row] = await sql<{ id: string; status: string }>(`SELECT id, status FROM "Resource" WHERE title = $1`, [title]);
    expect(row.status).toBe("PENDING");

    // Another member can't see it, not even by its address.
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/resources");
    await expect(page.getByText(title)).toHaveCount(0);
    expect((await page.goto(`/resources/${row.id}`))?.status()).toBe(404);

    // A leader approves it from the Resources page.
    await signIn(page, PEOPLE.softwareLeader);
    await page.goto("/resources#pending");
    const pending = page.locator("#pending");
    await expect(pending.getByRole("heading", { name: /Waiting for approval/ })).toBeVisible();
    const card = pending.getByRole("listitem").filter({ hasText: title });
    await expect(card.getByText(url)).toBeVisible();
    await card.getByRole("button", { name: `Approve ${title}`, exact: true }).click();
    // The card goes, and a confirmation names what was approved.
    await expect(pending.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
    await expect(pending.getByRole("status")).toContainText(`Approved “${title}” — the team can see it now.`);
    await expectNoHorizontalScroll(page);

    // Now the whole team sees it.
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/resources");
    const link = page.getByRole("link", { name: new RegExp(title) });
    await expect(link).toHaveAttribute("href", url);
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("a leader turns a share down with a note; the member sees why", async ({ page }, info) => {
    const title = `E2E private album ${uniq(info.project.name)}`;
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/resources/new");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Link", { exact: true }).fill("https://photos.example.com/private");
    await page.getByRole("button", { name: "Send for approval" }).click();
    await expect(page).toHaveURL(/\/resources$/);

    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/resources");
    const pending = page.locator("#pending");
    const card = pending.getByRole("listitem").filter({ hasText: title });
    await card.getByRole("button", { name: `Send back ${title}`, exact: true }).click();
    await card.getByLabel(/Note for Ethan/).fill("That album is private. Share it with the team first.");
    await card.getByRole("button", { name: `Send back ${title} to Ethan`, exact: true }).click();
    await expect(pending.getByRole("listitem").filter({ hasText: title })).toHaveCount(0);
    await expect(pending.getByRole("status")).toContainText(`Sent “${title}” back to Ethan. They'll see your note.`);

    await signIn(page, PEOPLE.buildMember);
    await page.goto("/resources");
    const mine = page.locator("#mine").getByRole("listitem").filter({ hasText: title });
    await expect(mine.getByText("Sent back", { exact: true })).toBeVisible();
    await expect(mine.getByText("That album is private. Share it with the team first.")).toBeVisible();
    await expect(mine.getByRole("link", { name: `Edit ${title}` })).toBeVisible();
  });

  test("a member uploads code; after approval the team reads it on its page", async ({ page }, info) => {
    const title = `E2E TeleOp ${uniq(info.project.name)}`;
    const code = [
      "package org.firstinspires.ftc.teamcode;",
      "",
      "public class E2ETeleOp extends LinearOpMode {",
      "    // <script>alert('stays text')</script>",
      `    private static final String VERY_LONG_LINE = "${"x".repeat(300)}";`,
      "}",
      "",
    ].join("\n");

    await signIn(page, PEOPLE.buildMember);
    await page.goto("/resources/new");
    await page.getByLabel("Title").fill(title);
    await page.getByRole("radio", { name: /^File/ }).check();
    await expect(page.getByLabel("Link", { exact: true })).toBeHidden();
    await page.getByLabel("File", { exact: true }).setInputFiles({
      name: "E2ETeleOp.java",
      mimeType: "text/x-java",
      buffer: Buffer.from(code, "utf8"),
    });
    await page.getByLabel("Type", { exact: true }).selectOption("CODE");
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Send for approval" }).click();
    await expect(page).toHaveURL(/\/resources$/);
    await expect(page.locator("#mine").getByText(title)).toBeVisible();

    const [row] = await sql<{ id: string }>(`SELECT id FROM "Resource" WHERE title = $1`, [title]);

    // Not served to other members while it waits.
    await signIn(page, PEOPLE.softwareMember);
    expect((await page.request.get(`/resources/files/${row.id}`)).status()).toBe(404);

    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/resources#pending");
    const card = page.locator("#pending").getByRole("listitem").filter({ hasText: title });
    await expect(card.getByText("E2ETeleOp.java")).toBeVisible();

    // Review it on its own page: the decision comes after the code, and says what happened.
    await card.getByRole("link", { name: `View ${title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/resources/${row.id}$`));
    const codeBox = page.getByRole("region", { name: "Contents of E2ETeleOp.java" });
    const review = page.getByRole("region", { name: "Waiting for approval" });
    await expect(review).toBeVisible();
    expect((await review.boundingBox())!.y).toBeGreaterThan((await codeBox.boundingBox())!.y);
    await expectNoHorizontalScroll(page);
    await review.getByRole("button", { name: `Approve ${title}`, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `Approved “${title}” — the team can see it now.` })).toBeVisible();
    await expect(review).toHaveCount(0);

    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/resources");
    await page.getByRole("link", { name: `View ${title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/resources/${row.id}$`));
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const preview = page.getByRole("region", { name: "Contents of E2ETeleOp.java" });
    await expect(preview).toContainText("public class E2ETeleOp extends LinearOpMode {");
    await expect(preview).toContainText("// <script>alert('stays text')</script>");
    // The long line scrolls inside the preview, never the page.
    await expectNoHorizontalScroll(page);
    await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute("href", `/resources/files/${row.id}?download=1`);

    // The file itself is served as plain text with locked-down headers.
    const res = await page.request.get(`/resources/files/${row.id}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-security-policy"]).toMatch(/^sandbox;/);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.text()).toBe(code);
    const download = await page.request.get(`/resources/files/${row.id}?download=1`);
    expect(download.headers()["content-disposition"]).toMatch(/^attachment; filename="E2ETeleOp\.java"/);
  });

  test("files bigger than the limit are stopped before uploading", async ({ page }) => {
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/resources/new");
    await page.getByRole("radio", { name: /^File/ }).check();
    await page.getByLabel("File", { exact: true }).setInputFiles({
      name: "robot.step",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(4 * 1024 * 1024 + 1),
    });
    await expect(page.getByText(/Files can be up to 4 MB/)).toBeVisible();
  });
});
