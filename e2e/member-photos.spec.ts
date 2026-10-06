import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import { TEAM_PHOTO_KEY_LENGTH, TEAM_PHOTO_KEY_PREFIX, teamPhotoNameKey } from "../src/lib/user-photos";
import { openNavIfNeeded, PEOPLE, signIn, sql } from "./helpers";

// Members' own photos: a member uploads one in Settings → My photo (the browser crops it to a square and sends a small
// JPG), sees it on their name in the menu (a photo that can't be loaded leaves just the initials), turns "Show my photo
// in the portal" off (initials again); the team website's GET /api/public/team-photos lists them (under a key made from
// their full name, never the name) until they rename themselves (held until someone checks the new name; renaming back
// lifts it) or turn "Show my photo on the team website" off.

const TEAM_SITE = "https://huskyteers19516.github.io";
/** The JSON is rebuilt at most every 10 s per server (src/server/public-api.ts): poll for changes. */
const FRESH = { timeout: 20_000 };
const WHO = { email: PEOPLE.buildMember2, name: "Isabella Rossi" };

interface Answer {
  enabled: boolean;
  photos?: { key: string; photo: string }[];
}

/** The key the JSON lists a name under (src/server/queries/public-team-photos.ts: publicTeamPhotoKey). */
const keyOf = (name: string) =>
  createHash("sha256").update(TEAM_PHOTO_KEY_PREFIX + teamPhotoNameKey(name), "utf8").digest("hex").slice(0, TEAM_PHOTO_KEY_LENGTH);

/** A real 240 × 160 PNG (two colors), built here so the browser has a non-square picture to crop. */
function testPng(): Buffer {
  const width = 240;
  const height = 160;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const inside = (x - 120) ** 2 + (y - 80) ** 2 < 50 ** 2;
      raw[o] = inside ? 240 : 40;
      raw[o + 1] = inside ? 200 : 120;
      raw[o + 2] = inside ? 160 : 90;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Start from no photo, both switches on, their own name, and no hold (both projects run this against the same database). */
async function reset() {
  await sql(`DELETE FROM "UserPhoto" WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`, [WHO.email]);
  await sql(`UPDATE "User" SET "showPhotoInPortal" = true, "showPhotoOnWebsite" = true, name = $2 WHERE email = $1`, [WHO.email, WHO.name]);
  await sql(`DELETE FROM "TeamNote" WHERE key = 'website-photo-hold:' || (SELECT id FROM "User" WHERE email = $1)`, [WHO.email]);
  await sql(`DELETE FROM "RateLimit" WHERE key LIKE 'user-photo:%'`);
}

/** How many portal photos the signed-in person's own chip in the menu shows (sidebar, or the phone menu). */
async function navChipPhotos(page: Page): Promise<number> {
  await openNavIfNeeded(page);
  const menu = page.getByRole("dialog", { name: "Menu" });
  const onPhone = await menu.isVisible();
  const scope = onPhone ? menu : page.locator("aside");
  // The chip links to Settings on desktop; on phones it's the drawer's header.
  const count = await scope.locator('img[src^="/people/photos/"]').count();
  if (onPhone) await page.getByRole("button", { name: "Close menu" }).click();
  return count;
}

test.describe("members' photos", () => {
  test.beforeEach(reset);
  test.afterAll(reset);

  test("upload in Settings, on my name in the menu, off in the portal, and on the team website until I turn it off", async ({
    page,
    playwright,
    baseURL,
  }) => {
    const guest = await playwright.request.newContext({ baseURL });
    const read = async () => (await (await guest.get("/api/public/team-photos", { headers: { Origin: TEAM_SITE } })).json()) as Answer;
    const mine = async () => (await read()).photos?.find((p) => p.key === keyOf(WHO.name))?.photo ?? null;

    await signIn(page, WHO.email);
    await page.goto("/settings");
    const card = page.getByRole("region", { name: "My photo" });
    await expect(card.getByText("No photo yet")).toBeVisible();
    expect(await navChipPhotos(page)).toBe(0);

    // Pick a wide picture: it's shown as the round crop, then saved as a small square JPG.
    await card.getByLabel("Choose a picture").setInputFiles({ name: "me.png", mimeType: "image/png", buffer: testPng() });
    await expect(card.getByRole("img", { name: /Your new photo/ })).toBeVisible();
    await card.getByRole("button", { name: "Zoom in" }).click();
    await card.getByRole("button", { name: "Save photo" }).click();
    await expect(card.getByRole("status").filter({ hasText: "Photo saved." })).toBeVisible();
    await expect(card.locator('img[src^="/people/photos/"]')).toBeVisible();
    const stored = await sql<{ contentType: string; width: number; height: number }>(
      `SELECT "contentType", width, height FROM "UserPhoto" WHERE "userId" = (SELECT id FROM "User" WHERE email = $1)`,
      [WHO.email],
    );
    expect(stored).toEqual([{ contentType: "image/jpeg", width: 512, height: 512 }]);

    // On my name in the menu.
    await page.reload();
    expect(await navChipPhotos(page)).toBe(1);
    await expect(card.getByRole("list", { name: "Where your photo shows" })).toContainText("In the portal: on your name.");

    // A photo that can't be loaded (replaced or hidden since the page was drawn: a 404) leaves only the initials —
    // no broken-picture icon over them.
    const profile = page.getByRole("region", { name: "My photo" }).locator('img[src^="/people/photos/"]').first();
    await profile.evaluate((img: HTMLImageElement) => {
      img.src = "/people/photos/doesnotexist000";
    });
    await expect(profile).toHaveAttribute("data-failed", "");
    await expect(profile).toBeHidden();
    await page.reload();

    // The team website lists it (under a key made from the full name — the JSON never says the name), and the photo
    // answers without signing in, not for search engines.
    await expect.poll(mine, FRESH).toMatch(/^\/api\/public\/team-photos\/[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(await read())).not.toContain("Isabella");
    const path = (await mine())!;
    const photo = await guest.get(path);
    expect(photo.status()).toBe(200);
    expect(photo.headers()["content-type"]).toBe("image/jpeg");
    expect(photo.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(photo.headers()["x-robots-tag"]).toBe("noindex, noimageindex");

    // A new name holds it off the website until someone checks it; the old name back lifts that.
    const nameField = page.getByLabel("Name", { exact: true });
    await nameField.fill("Bella Renamed");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText(/Your photo is off the team website until a leader checks your new name/).first()).toBeVisible();
    await expect.poll(mine, FRESH).toBeNull();
    expect((await guest.get(path)).status()).toBe(404);
    await nameField.fill(WHO.name);
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Profile saved.", { exact: true })).toBeVisible();
    await expect.poll(mine, FRESH).toBe(path);

    // Off in the portal: initials on my name again (still on the website).
    await page.getByText("Show my photo in the portal", { exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "The team sees your initials in the portal now." })).toBeVisible();
    await expect(page.getByRole("switch", { name: "Show my photo in the portal" })).not.toBeChecked();
    await page.reload();
    expect(await navChipPhotos(page)).toBe(0);
    // Settings' preview still shows it (to me), and says nobody else sees it.
    await expect(card.getByRole("list", { name: "Where your photo shows" })).toContainText("Hidden in the portal: the team sees your initials instead.");
    expect(await mine()).toBe(path);

    // Off on the website: it leaves the JSON, and its address answers 404.
    const website = page.getByRole("switch", { name: /Show my photo on the team website/ });
    await expect(website).toBeChecked();
    await page.getByText("Show my photo on the team website (public)", { exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "comes off the team website" })).toBeVisible();
    await expect(website).not.toBeChecked();
    await expect.poll(mine, FRESH).toBeNull();
    expect((await guest.get(path)).status()).toBe(404);
    await page.reload();
    await expect(card.getByRole("list", { name: "Where your photo shows" })).toContainText("Not on the team website: your switch below is off.");
    await guest.dispose();
  });
});
