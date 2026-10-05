import { expect, type Page, test } from "@playwright/test";
import type { PublicWorkshop } from "../src/lib/workshop";
import { expectNoHorizontalScroll, PEOPLE, signIn, uniq } from "./helpers";

// Workshop: everyone adds projects (drafts), with photos of each version; a leader approves them for the team
// website, which reads GET /api/public/workshop. A member's later change to an approved project takes it off the
// website until it's approved again.

/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The server reuses a built answer for 10 s (src/server/public-api.ts): poll for changes. */
const FRESH = { timeout: 20_000 };

async function publicProjects(page: Page): Promise<PublicWorkshop["projects"]> {
  const res = await page.request.get("/api/public/workshop");
  expect(res.status()).toBe(200);
  return ((await res.json()) as PublicWorkshop).projects;
}

test.describe("workshop", () => {
  test("a member adds a part with a photo; a leader approves it for the website; the member's edit sends it back", async ({ page }, info) => {
    const title = `E2E intake bracket ${uniq(info.project.name)}`;

    // Ethan (Build) adds a 3D-printed part.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/workshop");
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Add a project" }).first().click();
    await expect(page).toHaveURL(/\/workshop\/new$/);
    await expect(page.getByRole("radio", { name: /3D prints & CAD/ })).toBeChecked();
    // The person adding it is credited first.
    await expect(page.getByRole("list", { name: "Credited, in order" })).toContainText("Ethan Chen");
    await page.getByLabel("Name", { exact: true }).fill(title);
    await page.getByLabel("What it does on the robot").fill("Holds the intake roller. Version 2 is lighter.");
    await page.getByLabel(/^Material/).fill("PETG");
    await page.getByLabel(/^Season/).fill("2025–26");
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Add project" }).click();
    await expect(page).toHaveURL(/\/workshop\/[^/?]+\?added=1$/);
    const projectId = new URL(page.url()).pathname.split("/")[2];
    await expect(page.getByRole("status").filter({ hasText: "Project added." })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Draft" })).toBeVisible();
    // No photo yet: it can't be sent.
    await expect(page.getByRole("button", { name: "Send for approval" })).toBeDisabled();

    // A photo of the first version: previewed, then added.
    await page.getByLabel(/^Photo\b/).setInputFiles({ name: "bracket-v1.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByRole("img", { name: "Preview of the picked photo" })).toBeVisible();
    await page.locator("#photo-label").fill("Version 1");
    await page.locator("#photo-note").fill("Cracked at the screw hole, so Version 2 is thicker there.");
    await page.getByRole("button", { name: "Add photo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Photo added." })).toBeVisible();
    await expect(page.getByRole("img", { name: "Version 1" })).toBeVisible();
    await expect(page.getByRole("img", { name: "Preview of the picked photo" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    await page.getByRole("button", { name: "Send for approval" }).click();
    await expect(page).toHaveURL(new RegExp(`/workshop/${projectId}\\?sent=1$`));
    await expect(page.getByRole("heading", { level: 2, name: "Waiting for approval" })).toBeVisible();
    // Not public yet.
    expect((await publicProjects(page)).some((p) => p.id === projectId)).toBe(false);

    // Marcus (a Build leader) finds it waiting for approval and approves it.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/workshop?view=review");
    await expect(page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: /Waiting for approval/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const card = page.getByRole("link", { name: new RegExp(escape(title)) });
    await expect(card).toBeVisible();
    await expectNoHorizontalScroll(page);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/workshop/${projectId}$`));
    await page.getByRole("button", { name: `Approve ${title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/workshop/${projectId}\\?approved=1$`));
    await expect(page.getByRole("heading", { level: 2, name: "On the team website" })).toBeVisible();
    await expect(page.getByRole("link", { name: /View on the team website/ })).toHaveAttribute(
      "href",
      `https://huskyteers19516.github.io/workshop#${projectId}`,
    );

    // The team website's JSON lists it (once its 10-second copy is renewed), with its photo, and the photo is public.
    await expect.poll(async () => (await publicProjects(page)).some((p) => p.id === projectId), FRESH).toBe(true);
    const listed = (await publicProjects(page)).find((p) => p.id === projectId);
    expect(listed?.title).toBe(title);
    expect(listed?.material).toBe("PETG");
    expect(listed?.photos).toHaveLength(1);
    expect(listed?.photos[0].label).toBe("Version 1");
    expect(listed?.cover?.id).toBe(listed?.photos[0].id);
    const photoPath = listed!.photos[0].path;
    const photo = await page.request.get(photoPath);
    expect(photo.status()).toBe(200);
    expect(photo.headers()["content-type"]).toMatch(/^image\/(png|jpeg|webp)$/);

    // Ethan changes what it does: it's off the website until it's approved again.
    await signIn(page, PEOPLE.buildMember);
    await page.goto(`/workshop/${projectId}`);
    await expect(page.getByText(/Adding or changing photos, files, or details sends it back for approval/)).toBeVisible();
    await page.getByRole("link", { name: "Edit details" }).click();
    await expect(page).toHaveURL(new RegExp(`/workshop/${projectId}/edit$`));
    await expectNoHorizontalScroll(page);
    await page.getByLabel("What it does on the robot").fill("Holds the intake roller. Version 3 adds a bearing.");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/workshop/${projectId}\\?resubmitted=1$`));
    await expect(page.getByRole("status").filter({ hasText: "off the team website until a leader approves it again" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Waiting for approval" })).toBeVisible();
    await expect.poll(async () => (await publicProjects(page)).some((p) => p.id === projectId), FRESH).toBe(false);
    expect((await page.request.get(photoPath)).status()).toBe(404); // files are checked on every request
  });
});
