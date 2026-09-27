import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

test.describe("parts queue", () => {
  test("a build member adds a part; the build leader moves it to the top; another member grabs it and marks it done", async ({
    page,
  }, info) => {
    const name = `E2E intake bracket ${uniq(info.project.name)}`;

    // A build member asks for a part. A link the server refuses keeps what was typed and focuses the field.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/parts");
    await page.getByRole("link", { name: "Add a part" }).first().click();
    await expect(page).toHaveURL(/\/parts\/new$/);
    await page.getByLabel("Part name").fill(name);
    await page.getByRole("radio", { name: /Laser cut/ }).check();
    await page.getByLabel("Quantity").fill("3");
    await page.getByLabel("Material").fill("1/8 in polycarbonate");
    await page.getByLabel("File link").fill("ftp://cad.example.com/e2e-bracket.dxf");
    await page.getByLabel(/^For\b/).fill("intake"); // typed, any case — it links to the Build "Intake" category
    await page.getByRole("button", { name: "Add to the queue" }).click();
    await expect(page.locator("#fileUrl-error")).toHaveText("Enter a web link to the file, like drive.google.com/…");
    await expect(page.getByLabel("File link")).toBeFocused();
    await expect(page.getByLabel("Part name")).toHaveValue(name);
    await expect(page.getByRole("radio", { name: /Laser cut/ })).toBeChecked();
    await expectNoHorizontalScroll(page);
    // A bare address is fine: the server adds https://.
    await page.getByLabel("File link").fill("cad.example.com/e2e-bracket.dxf");
    await page.getByRole("button", { name: "Add to the queue" }).click();
    await expect(page).toHaveURL(/\/parts(#part-[a-z0-9]+)?$/);

    let card = page.getByRole("article", { name });
    await expect(card).toBeVisible();
    await expect(card.getByText("Up for grabs")).toBeVisible();
    await expect(card.getByText("Asked by you")).toBeVisible();
    await expect(card.getByText("Laser cut", { exact: true })).toBeVisible();
    await expect(card.getByText("Intake", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: /Open file/ })).toHaveAttribute("href", "https://cad.example.com/e2e-bracket.dxf");
    // Members can't reorder the queue.
    await expect(card.getByRole("button", { name: `Move ${name} to the top` })).toHaveCount(0);
    const [row] = await sql<{ status: string; quantity: number; requester: string }>(
      `SELECT p.status, p.quantity, u.email AS requester FROM "Part" p JOIN "User" u ON u.id = p."requestedById" WHERE p.name = $1`,
      [name],
    );
    expect(row).toEqual({ status: "NEEDED", quantity: 3, requester: PEOPLE.buildMember });

    // The build leader moves it to the top of the queue; focus stays on the card's arrows.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/parts");
    card = page.getByRole("article", { name });
    await card.getByRole("button", { name: `Move ${name} to the top` }).click();
    await expect(page.getByRole("article").first()).toHaveAccessibleName(name);
    await expect(card.getByRole("button", { name: `Move ${name} to the top` })).toBeDisabled();
    await expect(card.getByRole("button", { name: `Move ${name} down` })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Moved" })).toHaveText(`Moved “${name}” to the top.`);
    await expectNoHorizontalScroll(page);

    // Another member grabs it: "Mark done" takes focus, and it shows on their Today page.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/parts");
    card = page.getByRole("article", { name });
    await card.getByRole("button", { name: `I'll make it: ${name}` }).click();
    await expect(card.getByText("You're making it")).toBeVisible();
    await expect(card.getByRole("button", { name: `Mark done: ${name}` })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "You're making" })).toHaveText(
      `You're making “${name}”. Mark it done when it's finished.`,
    );
    await expect(card.getByRole("button", { name: /I'll make it/ })).toHaveCount(0);

    await page.goto("/today");
    await page.getByRole("link", { name: "You're making 1 part" }).click();
    await expect(page).toHaveURL(/\/parts\?who=making$/);
    await expect(page.getByRole("link", { name: "I'm making" })).toHaveAttribute("aria-current", "true");
    // Only what they're making, so theirs is the first card.
    await expect(page.getByRole("article")).toHaveCount(1);
    card = page.getByRole("article", { name });
    await card.getByRole("button", { name: `Mark done: ${name}` }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Nice work" })).toHaveText(`“${name}” is done. Nice work!`);
    await expectNoHorizontalScroll(page);

    await page.goto("/today");
    await expect(page.getByRole("link", { name: /You're making/ })).toHaveCount(0);
    await page.goto("/parts?view=done");
    card = page.getByRole("article", { name });
    await expect(card.getByText("Made by you")).toBeVisible();
    const [done] = await sql<{ status: string; maker: string }>(
      `SELECT p.status, u.email AS maker FROM "Part" p JOIN "User" u ON u.id = p."claimedById" WHERE p.name = $1`,
      [name],
    );
    expect(done).toEqual({ status: "DONE", maker: PEOPLE.softwareMember });
  });

  test("the parts pages have no sideways scrolling for each role", async ({ page }) => {
    const [part] = await sql<{ id: string }>(`SELECT id FROM "Part" WHERE status = 'NEEDED' ORDER BY position LIMIT 1`);
    const pages: Record<string, string[]> = {
      [PEOPLE.buildMember]: ["/parts", "/parts?view=done", "/parts?process=PRINT_3D", "/parts?who=making", "/parts?who=asked", "/parts/new"],
      [PEOPLE.buildLeader]: ["/parts", "/parts?view=done&who=making", "/parts?who=asked&process=CNC", `/parts/${part.id}/edit`],
    };
    for (const [email, paths] of Object.entries(pages)) {
      await signIn(page, email);
      for (const path of paths) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBe(200);
        await expectNoHorizontalScroll(page);
      }
    }
    // Someone else's part can't be edited by a member.
    await signIn(page, PEOPLE.softwareMember);
    const res = await page.goto(`/parts/${part.id}/edit`);
    expect(res?.status()).toBe(404);
  });
});
