import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Team notebook: the captain sets up the standard notebooks; anyone writes an entry (the date, time, and their name
// are stamped for them); the notebook's leader can change it and the history says who changed what; export works.

/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
/** "Sun, Sep 27, 2026, 3:42 PM" */
const STAMP = /[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} (AM|PM)/;

/** The open Export menu fits on screen: no sideways scroll, and "Print / Save as PDF" is fully visible. */
async function expectMenuOnScreen(page: Page) {
  const print = page.getByRole("link", { name: "Print / Save as PDF" });
  await expect(print).toBeVisible();
  await expectNoHorizontalScroll(page);
  const box = (await print.boundingBox())!;
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

async function openIntake(page: Page) {
  await page.goto("/notebook");
  await page.getByRole("list", { name: "Pages in Hardware Notebook" }).getByRole("link", { name: /Intake/ }).click();
  await expect(page).toHaveURL(/\/notebook\/p\/[^/?#]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Intake" })).toBeVisible();
}

test.describe("team notebook", () => {
  test("captain sets it up, a member writes, a Build leader edits (with history), and it exports", async ({ page }, info) => {
    const body = `Tested the roller intake at 80% power ${uniq(info.project.name)}.`;
    const edited = `${body} Swapped to softer wheels.`;

    // A new season: no notebooks yet (the demo team comes with them).
    await sql(`DELETE FROM "Notebook"`);

    // The captain creates the standard notebooks in one click.
    await signIn(page, PEOPLE.admin);
    await page.goto("/notebook");
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Create the standard notebooks" }).click();
    await expect(page).toHaveURL(/\/notebook\?created=1$/);
    await expect(page.getByRole("status").filter({ hasText: "The notebooks are ready." })).toBeVisible();
    for (const title of ["Hardware Notebook", "Software Notebook", "Business Notebook"]) {
      // The notebook's fold-up button (not "Export …" or "Move …").
      await expect(page.getByRole("button", { name: new RegExp(`^${title}`) })).toBeVisible();
    }
    await expect(page.getByRole("list", { name: "Pages in Software Notebook" }).getByRole("link")).toHaveCount(3);
    await expectNoHorizontalScroll(page);

    // A Build member writes on Intake: the editor shows "You" and the time right away; the entry is stamped with their name.
    await signIn(page, PEOPLE.buildMember);
    await openIntake(page);
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "New entry" }).click();
    const editor = page.getByRole("form", { name: "New entry" });
    await expect(editor).toContainText("You");
    await expect(editor).toContainText(STAMP);
    // Saving with no text: focus goes to the text, with the reason.
    await editor.getByRole("button", { name: "Save entry" }).click();
    await expect(page.getByLabel("What did you do?")).toBeFocused();
    await expect(editor).toContainText("Write something for the entry.");

    await page.getByLabel(/^Title/).fill("Roller test");
    await page.getByLabel("What did you do?").fill(`${body}\n- grabs from the wall\n- no jams`);
    await editor.locator('input[type="file"]').setInputFiles({ name: "roller.png", mimeType: "image/png", buffer: PNG });
    await expect(editor.getByRole("img", { name: "Preview of roller.png" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await editor.getByRole("button", { name: "Save entry" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Entry saved." })).toBeAttached();

    const entry = page.locator("article").filter({ hasText: body });
    await expect(entry).toBeFocused();
    await expect(entry.getByRole("heading", { name: "Roller test" })).toBeVisible();
    await expect(entry).toContainText(/Written by Ethan Chen · /);
    await expect(entry.locator("[data-stamp]")).toHaveText(new RegExp(`^Written by Ethan Chen · ${STAMP.source}$`));
    await expect(entry.getByRole("listitem").filter({ hasText: "grabs from the wall" })).toBeVisible();
    await expect(entry.getByRole("link", { name: /Open picture 1, roller\.png/ })).toBeVisible();
    await expect(entry.getByText("History (")).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    const [row] = await sql<{ id: string; imageId: string; contentType: string }>(
      `SELECT e.id, i.id AS "imageId", i."contentType" FROM "NotebookEntry" e JOIN "NotebookImage" i ON i."entryId" = e.id WHERE e.body LIKE $1`,
      [`${body}%`],
    );
    expect(row.contentType).toBe("image/png");
    const img = await page.request.get(`/notebook/images/${row.imageId}`);
    expect(img.status()).toBe(200);
    expect(img.headers()["content-type"]).toBe("image/png");
    expect(img.headers()["x-content-type-options"]).toBe("nosniff");

    // Another member can read it but not change it.
    await signIn(page, PEOPLE.softwareMember);
    await openIntake(page);
    await expect(page.locator("article").filter({ hasText: body }).getByRole("button", { name: /^Edit/ })).toHaveCount(0);

    // A Build leader fixes it: "Edited by" and "History (1)" say who changed it, what the change did, and what it said before.
    await signIn(page, PEOPLE.buildLeader);
    await openIntake(page);
    const leaderEntry = page.locator("article").filter({ hasText: body });
    await leaderEntry.getByRole("button", { name: "Edit “Roller test”" }).click();
    const editForm = page.getByRole("form", { name: "Edit entry" });
    await expect(editForm).toContainText(/Written by Ethan Chen · /);
    await expect(editForm).toContainText("(editing)");
    await editForm.getByLabel("What did you do?").fill(edited);
    await editForm.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Changes saved." })).toBeAttached();

    const changed = page.locator("article").filter({ hasText: edited });
    await expect(changed.locator("[data-edited]")).toHaveText(new RegExp(`^Edited by Marcus Johnson · ${STAMP.source}$`));
    await changed.getByText("History (1)").click();
    await expect(changed).toContainText("Marcus Johnson changed the text");
    await expect(changed.getByText("grabs from the wall")).toBeVisible(); // what it said before
    await expectNoHorizontalScroll(page);

    // Export: a Word file for the page, and a print view. The menu stays on screen (the button sits at the right on phones).
    await page.getByRole("button", { name: "Export Hardware Notebook, Intake" }).click();
    await expectMenuOnScreen(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Word (.docx)" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^Hardware Notebook - Intake \d{4}-\d{2}-\d{2}\.docx$/);

    const pageId = new URL(page.url()).pathname.split("/").pop();
    const docx = await page.request.get(`/notebook/p/${pageId}/export`);
    expect(docx.status()).toBe(200);
    expect(docx.headers()["content-type"]).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect((await docx.body()).subarray(0, 2).toString()).toBe("PK");

    await page.goto(`/notebook/print/p/${pageId}`);
    await expect(page.getByRole("button", { name: "Print / Save as PDF" })).toBeVisible();
    await expect(page.getByText(edited)).toBeVisible();
    await expect(page.getByText(/Edited by Marcus Johnson on /)).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test("members see the notebook but no manager tools; phones get a foldable list", async ({ page }) => {
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/notebook");
    await expect(page.getByRole("link", { name: "New notebook" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Rename / })).toHaveCount(0);
    await expect(page.getByLabel("New page")).toHaveCount(0);
    const hardware = page.getByRole("button", { name: /^Hardware Notebook/ });
    await expect(hardware).toHaveAttribute("aria-expanded", "true");
    await hardware.click();
    await expect(hardware).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("list", { name: "Pages in Hardware Notebook" })).toBeHidden();
    await hardware.click();
    await expectNoHorizontalScroll(page);

    // A 375px phone: the Export menu opens leftwards from the button at the right, and Escape closes it.
    await page.setViewportSize({ width: 375, height: 812 });
    await openIntake(page);
    const exportButton = page.getByRole("button", { name: "Export Hardware Notebook, Intake" });
    await exportButton.click();
    await expectMenuOnScreen(page);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("link", { name: "Print / Save as PDF" })).toHaveCount(0);
    await expect(exportButton).toBeFocused();

    // "Jump to a page" closes on Escape too.
    const jump = page.locator("summary", { hasText: "Jump to a page" });
    await jump.click();
    await expect(page.getByRole("navigation", { name: "Jump to a page" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Jump to a page" })).toBeHidden();
    await expect(jump).toBeFocused();

    // A half-written entry isn't thrown away without asking.
    let answer: "accept" | "dismiss" = "dismiss";
    const asked: string[] = [];
    page.on("dialog", (dialog) => {
      if (dialog.type() === "confirm") asked.push(dialog.message());
      void (answer === "accept" ? dialog.accept() : dialog.dismiss());
    });
    await page.getByRole("button", { name: "New entry" }).click();
    const editor = page.getByRole("form", { name: "New entry" });
    await editor.getByLabel("What did you do?").fill("Half-written note");
    await page.keyboard.press("Escape");
    await expect(editor).toBeVisible();
    await expect(editor.getByLabel("What did you do?")).toHaveValue("Half-written note");
    answer = "accept";
    await editor.getByRole("button", { name: "Cancel" }).click();
    await expect(editor).toHaveCount(0);
    expect(asked).toEqual(["Discard this entry?", "Discard this entry?"]);
    await expect(page.getByRole("button", { name: "New entry" })).toBeFocused();
    await expect(page.getByText("Your unsaved draft is kept.")).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // The notebook's own leader manages its pages; other subteams' leaders don't.
    await signIn(page, PEOPLE.softwareLeader);
    await page.goto("/notebook");
    await expect(page.getByRole("form", { name: "Add a page to Software Notebook" })).toBeVisible();
    await expect(page.getByRole("form", { name: "Add a page to Hardware Notebook" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});
