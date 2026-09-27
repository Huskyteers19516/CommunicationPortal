import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Posters: everyone sees them and adds them directly (no approval); the person who added one, and everyone
// with admin access, can change or remove it. Gwen (Business) adds them from her phone.

/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("posters", () => {
  test("a member adds a poster from a phone; the team sees it; only its author or a leader can change it", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const title = `E2E library demo ${uniq(info.project.name)}`;

    await signIn(page, PEOPLE.businessMember);
    await page.goto("/posters");
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Add a poster" }).first().click();
    await expect(page).toHaveURL(/\/posters\/new$/);
    await expectNoHorizontalScroll(page);

    // The picker checks the file right away: too big, or not a picture or PDF, never gets sent.
    const picker = page.getByLabel(/Poster picture or PDF/);
    const fileError = page.locator("#file-error");
    await picker.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });
    await expect(fileError).toHaveText(/^That file is 4\.0 MB\. Posters can be up to 4 MB/);
    await expect(picker).toHaveAttribute("aria-invalid", "true");
    await picker.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
    await expect(fileError).toHaveText(/^Posters can be a picture/);
    // Named like a picture but isn't one: the preview can't show it, so it's taken off right away.
    await picker.setInputFiles({ name: "not-really.png", mimeType: "image/png", buffer: Buffer.from("<html><body>hi</body></html>") });
    await expect(fileError).toHaveText(/^That picture couldn't be opened\./);
    await expect(page.getByRole("img", { name: "Preview of the picked poster" })).toHaveCount(0);
    await expect(page.getByText("not-really.png", { exact: true })).toHaveCount(0);

    // A real picture shows a preview.
    await picker.setInputFiles({ name: "library-demo.png", mimeType: "image/png", buffer: PNG });
    await expect(page.getByRole("img", { name: "Preview of the picked poster" })).toBeVisible();
    await expect(fileError).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Saving without a title: focus goes to it, and the picked file is kept.
    await page.getByRole("button", { name: "Add poster" }).click();
    await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
    await expect(page.getByText("library-demo.png", { exact: true })).toBeVisible();

    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel(/What it's for/).fill("Library demo");
    await page.getByRole("button", { name: "Add poster" }).click();
    await expect(page).toHaveURL(/\/posters\/[^/?]+\?added=1$/);
    // The message takes focus, so it (and the title) are on screen, wherever the form was scrolled to.
    const added = page.getByRole("status").filter({ hasText: "Poster added." });
    await expect(added).toBeInViewport();
    await expect(page.locator(":focus")).toContainText("Poster added.");
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeInViewport();
    await expect(page.getByRole("img", { name: `Poster: ${title}` })).toBeVisible();
    // Download comes before the big picture, so it's on screen without scrolling.
    const downloadLink = page.getByRole("link", { name: "Download", exact: true });
    await expect(downloadLink).toBeInViewport();
    const [dl, pic] = [await downloadLink.boundingBox(), await page.getByRole("img", { name: `Poster: ${title}` }).boundingBox()];
    expect(dl && pic && dl.y < pic.y).toBe(true);
    await expect(page.getByRole("link", { name: `Edit ${title}` })).toBeVisible();
    await expectNoHorizontalScroll(page);

    const [row] = await sql<{ id: string; fileId: string; contentType: string }>(
      `SELECT p.id, f.id AS "fileId", f."contentType" FROM "Poster" p JOIN "PosterFile" f ON f."posterId" = p.id WHERE p.title = $1`,
      [title],
    );
    expect(row.contentType).toBe("image/png");

    // The file is served inline as a PNG, never sniffed as anything else. Its address never shows different bytes,
    // so the browser keeps it (the grid isn't downloaded again on every visit); downloads aren't kept.
    const res = await page.request.get(`/posters/files/${row.fileId}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["content-disposition"]).toMatch(/^inline; filename="library-demo\.png"/);
    expect(res.headers()["cache-control"]).toBe("private, max-age=604800, immutable");
    expect(Buffer.from(await res.body()).equals(PNG)).toBe(true);
    const download = await page.request.get(`/posters/files/${row.fileId}?download=1`);
    expect(download.headers()["content-disposition"]).toMatch(/^attachment; /);
    expect(download.headers()["cache-control"]).toBe("private, no-store");

    // In the grid (two columns on a phone), with its picture.
    await page.goto("/posters");
    const card = page.getByRole("link", { name: new RegExp(escape(title)) });
    await expect(card).toBeVisible();
    await expect(card.locator("img")).toHaveAttribute("src", `/posters/files/${row.fileId}`);
    await expect(card.locator("img")).toHaveAttribute("loading", "lazy");
    const tiles = page.getByRole("main").getByRole("listitem");
    const [a, b] = [await tiles.nth(0).boundingBox(), await tiles.nth(1).boundingBox()];
    expect(a && b && Math.abs(a.y - b.y) < 1 && b.x > a.x).toBe(true);
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Added by me" }).click();
    await expect(page).toHaveURL(/\/posters\?who=mine$/);
    await expect(page.getByRole("link", { name: new RegExp(escape(title)) })).toBeVisible();

    // Another member sees it, but can't change it.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto(`/posters/${row.id}`);
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("Library demo", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `Edit ${title}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Remove ${title}` })).toHaveCount(0);
    expect((await page.goto(`/posters/${row.id}/edit`))?.status()).toBe(404);
    expect((await page.request.get(`/posters/files/${row.fileId}`)).status()).toBe(200);

    // A leader removes it (and its file).
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(`/posters/${row.id}`);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: `Remove ${title}` }).click();
    await expect(page).toHaveURL(/\/posters\?removed=1$/);
    await expect(page.getByRole("status").filter({ hasText: "Poster removed." })).toBeVisible();
    await expect(page.locator(":focus")).toContainText("Poster removed.");
    await expect(page.getByRole("link", { name: new RegExp(escape(title)) })).toHaveCount(0);
    expect((await page.request.get(`/posters/files/${row.fileId}`)).status()).toBe(404);
    await expectNoHorizontalScroll(page);
  });

  test("a photo over 4 MB is made smaller on the phone instead of being refused", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/posters/new");
    // A 1500 × 1500 PNG of noise (it doesn't compress): about 6–9 MB, made in the browser.
    const base64 = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1500;
      const g = canvas.getContext("2d")!;
      const pixels = g.createImageData(1500, 1500);
      for (let i = 0; i < pixels.data.length; i++) pixels.data[i] = i % 4 === 3 ? 255 : Math.floor(Math.random() * 256);
      g.putImageData(pixels, 0, 0);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    });
    const big = Buffer.from(base64, "base64");
    expect(big.byteLength).toBeGreaterThan(4 * 1024 * 1024);

    await page.getByLabel(/Poster picture or PDF/).setInputFiles({ name: "IMG_2041.png", mimeType: "image/png", buffer: big });
    await expect(page.getByRole("img", { name: "Preview of the picked poster" })).toBeVisible();
    await expect(page.getByText("IMG_2041.jpg", { exact: true })).toBeVisible();
    await expect(page.getByText(/made smaller from \d+(\.\d)? MB · uploads when you save/)).toBeVisible();
    await expect(page.locator("#file-error")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test("signed-out visitors are sent to sign in for a poster file", async ({ page }) => {
    const [file] = await sql<{ id: string }>(`SELECT id FROM "PosterFile" LIMIT 1`);
    test.skip(!file, "the demo seed has poster files");
    await page.context().clearCookies();
    const res = await page.request.get(`/posters/files/${file.id}`, { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    expect(res.status()).toBeLessThan(400);
    expect(res.headers()["location"]).toMatch(/\/login\?next=%2Fposters%2Ffiles%2F/);
  });
});
