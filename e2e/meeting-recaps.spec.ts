import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, openNavIfNeeded, PEOPLE, signIn, sql, uniq } from "./helpers";

// Meeting recaps (/meetings): the key points of team meetings, for everyone to read; people with admin access record,
// write up, edit, and delete them and keep the categories; a recording plays for 3 days. The demo seed has three:
// demo-recap-kickoff (recent, no recording), demo-recap-scrimmage-prep (its recording deleted after 3 days), and
// demo-recap-drive-practice (a 1-second WAV kept until 3 days after seeding). The recorder itself has its own spec.

const KICKOFF = "Season kickoff: game strategy";
const SCRIMMAGE = "Scrimmage prep";
const DRIVE = "Drive practice debrief";

/** A recap of its own with a copy of the demo recording (1 s of WAV, kept 3 days), for a test that changes it. */
async function recapWithDemoRecording(id: string, title: string) {
  await sql(
    `INSERT INTO "MeetingRecap" (id, title, "meetingDate", "keyPoints", transcript, "durationSec", "createdById", "audioType",
       "audioParts", "audioBytes", "audioExpiresAt", "createdAt", "updatedAt")
     SELECT $1, $2, "meetingDate", "keyPoints", transcript, "durationSec", "createdById", "audioType", "audioParts", "audioBytes",
       now() + interval '72 hours', now(), now()
     FROM "MeetingRecap" WHERE id = 'demo-recap-drive-practice'`,
    [id, title],
  );
  await sql(
    `INSERT INTO "MeetingAudioPart" (id, "recapId", position, filename, "contentType", size, data, "createdAt")
     SELECT $1 || '-part-' || position, $1, position, filename, "contentType", size, data, now()
     FROM "MeetingAudioPart" WHERE "recapId" = 'demo-recap-drive-practice'`,
    [id],
  );
}

/** A recap whose "recording" starts like WebM (so the server took it) but is garbage after that: no browser plays it. */
async function recapWithBrokenRecording(id: string, title: string) {
  const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(4096, 0x5a)]);
  await sql(
    `INSERT INTO "MeetingRecap" (id, title, "meetingDate", "keyPoints", transcript, "durationSec", "createdById", "audioType",
       "audioParts", "audioBytes", "audioExpiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, CURRENT_DATE, '[0:05] Decision: we test the broken file.', '[0:05] This line has a time.', 60,
       (SELECT id FROM "User" WHERE email = $3), 'audio/webm', 1, $4, now() + interval '72 hours', now(), now())`,
    [id, title, PEOPLE.admin, bytes.byteLength],
  );
  await sql(
    `INSERT INTO "MeetingAudioPart" (id, "recapId", position, filename, "contentType", size, data, "createdAt")
     VALUES ($1 || '-part-0', $1, 0, 'recording-1.webm', 'audio/webm', $2, $3, now())`,
    [id, bytes.byteLength, bytes],
  );
}

/** Make every Server Action call fail as if the connection dropped (until the route is taken off again). */
async function dropServerActions(page: Page) {
  await page.route("**/*", (route) =>
    route.request().method() === "POST" && route.request().headers()["next-action"] ? route.abort("internetdisconnected") : route.continue(),
  );
}

test.describe("meeting recaps", () => {
  test("members read every recap (Today, filters, search, key points, exports) but change nothing", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.softwareMember);

    // Today: the recaps saved in the last 3 days.
    await page.goto("/today");
    // It shows the 3 newest, so recaps other tests saved meanwhile may have pushed the demo ones off it.
    const today = page.getByRole("region", { name: "Meeting recaps" });
    await expect(today.getByRole("link", { name: /See all/ })).toHaveAttribute("href", "/meetings");
    await expect(today.locator("a[href^='/meetings/']").first()).toBeVisible();
    await expect(today.getByText("Saved in the last 3 days.")).toBeVisible();
    await expectNoHorizontalScroll(page);

    // The menu item, then the list: no recording, writing, or categories for members.
    await openNavIfNeeded(page);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Meeting recaps", exact: true }).click();
    await expect(page).toHaveURL(/\/meetings$/);
    await expect(page.getByRole("heading", { level: 1, name: "Meeting recaps" })).toBeVisible();
    await expect(page.getByText("Recordings are kept for 3 days.")).toBeVisible();
    for (const name of ["Record a meeting", "Write one up", "Categories"])
      await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    const kickoff = page.getByRole("article", { name: KICKOFF });
    await expect(kickoff).toContainText("Recorded by Jordan Lee");
    await expect(kickoff).toContainText("Decision: we build a 4-bar intake this season");
    await expect(kickoff).toContainText("and 3 more key points");
    await expect(page.getByRole("article", { name: DRIVE })).toContainText("Recording until");
    await expect(page.getByRole("article", { name: SCRIMMAGE })).not.toContainText("Recording");
    await expectNoHorizontalScroll(page);

    // A category chip, then a search (it looks in transcripts too) that keeps the category.
    await page.getByRole("navigation", { name: "Filter by category" }).getByRole("link", { name: "Competition", exact: true }).click();
    await expect(page).toHaveURL(/\/meetings\?category=meetingcat-competition$/);
    await expect(page.getByText(/^\d+ recaps? in Competition$/)).toBeVisible();
    await expect(page.getByRole("article", { name: DRIVE })).toBeVisible();
    await expect(page.getByRole("article", { name: KICKOFF })).toHaveCount(0);
    await page.getByRole("searchbox", { name: "Search meeting recaps" }).fill("encoders");
    await page.getByRole("searchbox", { name: "Search meeting recaps" }).press("Enter");
    await expect(page).toHaveURL(/\/meetings\?category=meetingcat-competition&q=encoders$/);
    await expect(page.getByText("1 recap in Competition matching “encoders”")).toBeVisible();
    await expect(page.getByRole("article")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search meeting recaps" }).fill("no such words here");
    await page.getByRole("searchbox", { name: "Search meeting recaps" }).press("Enter");
    await expect(page.getByText("No recaps match")).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/meetings$/);

    // One recap: key points (a time shows that moment in the transcript), the transcript, exports — no Edit or Delete.
    await page.getByRole("article", { name: KICKOFF }).getByRole("link", { name: KICKOFF }).click();
    await expect(page).toHaveURL(/\/meetings\/demo-recap-kickoff$/);
    await expect(page.getByRole("heading", { level: 1, name: KICKOFF })).toBeVisible();
    await expect(page.getByText("Recorded by Jordan Lee")).toBeVisible();
    await expect(page.getByText("Captain ·")).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit this recap" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete this recap" })).toHaveCount(0);
    await page.getByRole("button", { name: "Show 11:05 in the transcript" }).click();
    await expect(page.locator("li", { hasText: "Priya, can you port last year's drive constants" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Copy key points" })).toBeVisible();
    const md = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download .md" }).click();
    expect((await md).suggestedFilename()).toMatch(/^Season kickoff game strategy \d{4}-\d{2}-\d{2}\.md$/);
    const txt = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download transcript .txt" }).click();
    expect((await txt).suggestedFilename()).toMatch(/^Season kickoff game strategy \d{4}-\d{2}-\d{2} transcript\.txt$/);
    await expectNoHorizontalScroll(page);

    // A recording past its 3 days: gone, the text stays.
    await page.goto("/meetings/demo-recap-scrimmage-prep");
    await expect(page.getByText("The recording was deleted after 3 days. The transcript and key points stay.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Listen/ })).toHaveCount(0);

    // The admin pages send members back.
    await page.goto("/meetings/new");
    await expect(page).toHaveURL(/\/meetings$/);
    await page.goto("/meetings/categories");
    await expect(page).toHaveURL(/\/meetings$/);
    await page.goto("/meetings/demo-recap-kickoff/edit");
    await expect(page).toHaveURL(/\/meetings\/demo-recap-kickoff$/);
    await page.goto("/meetings/record");
    await expect(page).toHaveURL(/\/meetings$/);
    const missing = await page.goto("/meetings/no-such-recap");
    expect(missing?.status()).toBe(404);
  });

  test("the demo recording loads and plays; members listen, admins also download it", async ({ page }) => {
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/meetings/demo-recap-drive-practice");
    await expect(page.getByText(/^Deleted automatically on \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2}\s[AP]M\.$/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Download recording" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete recording now" })).toHaveCount(0);
    // Before it's loaded, a key point's time only shows the transcript line.
    await expect(page.getByRole("button", { name: "Show 2:10 in the transcript" })).toBeVisible();

    await page.getByRole("button", { name: /^Listen \(\d/ }).click();
    const audio = page.locator("audio");
    await expect(audio).toBeVisible();
    expect(await audio.getAttribute("src")).toMatch(/^blob:/);
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(0.5);
    await page.getByRole("button", { name: "1.5×" }).click();
    await expect(page.getByRole("button", { name: "1.5×" })).toHaveAttribute("aria-pressed", "true");
    expect(await audio.evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(1.5);
    // Loaded: times and transcript lines play from their moment.
    await expect(page.getByRole("button", { name: "Play from 2:10", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^Play from 0:20: The climb worked/ }).click();
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
    await expectNoHorizontalScroll(page);

    await signIn(page, PEOPLE.admin);
    await page.goto("/meetings/demo-recap-drive-practice");
    await expect(page.getByRole("button", { name: "Delete recording now" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download recording" }).click();
    expect((await download).suggestedFilename()).toMatch(/^Drive practice debrief \d{4}-\d{2}-\d{2}\.wav$/);
  });

  test("an admin writes one up with a new category, edits it, deletes it, then renames and deletes the category", async ({
    page,
  }, info) => {
    const tag = uniq(info.project.name);
    const title = `E2E build sync ${tag}`;
    const category = `E2E ${tag}`;
    await signIn(page, PEOPLE.admin);
    await page.goto("/meetings");
    await expect(page.getByRole("link", { name: "Record a meeting" })).toHaveAttribute("href", "/meetings/record");
    await page.getByRole("link", { name: "Write one up" }).first().click();
    await expect(page).toHaveURL(/\/meetings\/new$/);
    await expectNoHorizontalScroll(page);

    // Nothing typed: the title gets focus, and the rest stays.
    await page
      .getByLabel("Key points")
      .fill("[1:05] Decision: we try the new intake rollers.\n[2:30] To do (Ethan, by Friday): print the brackets.");
    await page.getByRole("button", { name: "Save recap" }).click();
    await expect(page.getByLabel("Title")).toBeFocused();
    await expect(page.getByText("Title is required.")).toBeVisible();
    await expect(page.getByLabel("Key points")).toHaveValue(/new intake rollers/);
    await page.getByLabel("Title").fill(title);

    // A new category, added inline (Enter adds it, not the recap) and picked; and one of the usual ones.
    await page.getByRole("button", { name: "New category…" }).click();
    await page.getByLabel("New category").fill(category);
    await page.getByLabel("New category").press("Enter");
    await expect(page.getByText(`Added “${category}” and picked it.`)).toBeVisible();
    await expect(page.getByRole("checkbox", { name: category })).toBeChecked();
    await expect(page).toHaveURL(/\/meetings\/new$/);
    await page
      .locator("label")
      .filter({ hasText: /^Build$/ })
      .click();
    await expect(page.getByRole("checkbox", { name: "Build", exact: true })).toBeChecked();

    // A short (here: empty) transcript box starts open.
    await expect(page.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
    await page
      .getByLabel("Transcript")
      .fill("[1:05] We'll try the new rollers next week.\n[2:30] Ethan, can you print the brackets by Friday?");
    await page.getByRole("button", { name: "Save recap" }).click();
    await expect(page).toHaveURL(/\/meetings\/[^/?]+\?saved=new$/);
    await expect(page.getByText("Recap saved. Everyone on the team can read it now.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("Written up by Jordan Lee")).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const [row] = await sql<{ title: string; categories: string[]; author: string; durationSec: number | null; audioParts: number }>(
      `SELECT r.title, array_agg(c.name ORDER BY c.name) AS categories, u.email AS author, r."durationSec", r."audioParts"
       FROM "MeetingRecap" r JOIN "User" u ON u.id = r."createdById"
       JOIN "MeetingRecapCategory" rc ON rc."recapId" = r.id JOIN "MeetingCategory" c ON c.id = rc."categoryId"
       WHERE r.id = $1 GROUP BY r.id, u.email`,
      [id],
    );
    expect(row).toEqual({ title, categories: ["Build", category].sort(), author: PEOPLE.admin, durationSec: null, audioParts: 0 });
    await page.getByRole("button", { name: "Show 2:30 in the transcript" }).click();
    await expect(page.locator("li", { hasText: "Ethan, can you print the brackets" })).toBeFocused();
    await expectNoHorizontalScroll(page);

    // Edit: a new title, one category fewer → "Changes saved.", marked edited. Saving again without changes says so.
    await page.getByRole("link", { name: "Edit this recap" }).click();
    await expect(page).toHaveURL(new RegExp(`/meetings/${id}/edit$`));
    await expect(page.getByLabel("Title")).toHaveValue(title);
    await page.getByLabel("Title").fill(`${title} (edited)`);
    await page
      .locator("label")
      .filter({ hasText: /^Build$/ })
      .click();
    await expect(page.getByRole("checkbox", { name: "Build", exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/meetings/${id}\\?saved=1$`));
    await expect(page.getByText("Changes saved.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: `${title} (edited)` })).toBeVisible();
    await expect(page.getByText("· edited")).toBeVisible();
    await page.getByRole("link", { name: "Edit this recap" }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/meetings/${id}\\?saved=0$`));
    await expect(page.getByText("Nothing changed, so there was nothing to save.")).toBeVisible();

    // Delete it (after a confirm) → the list says so, and it's gone.
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete this recap" }).click();
    await expect(page).toHaveURL(/\/meetings\?removed=1$/);
    await expect(page.getByText("Recap deleted.")).toBeVisible();
    await expect(page.getByRole("article", { name: `${title} (edited)` })).toHaveCount(0);
    expect(await sql(`SELECT 1 FROM "MeetingRecap" WHERE id = $1`, [id])).toHaveLength(0);

    // The categories page: rename the new category, then delete it.
    await page.getByRole("link", { name: "Categories", exact: true }).click();
    await expect(page).toHaveURL(/\/meetings\/categories$/);
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: `Rename ${category}` }).click();
    await page.getByLabel(`New name for “${category}”`).fill(`${category} 2`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: `Renamed to “${category} 2”.` })).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: `Delete ${category} 2` }).click();
    await expect(page.getByRole("status").filter({ hasText: `Deleted “${category} 2”.` })).toBeVisible();
    expect(await sql(`SELECT 1 FROM "MeetingCategory" WHERE name LIKE $1`, [`${category}%`])).toHaveLength(0);
  });

  test("the player says when a recording can't be played or was just deleted, and offers a way on", async ({ page }, info) => {
    const tag = uniq(info.project.name);
    const broken = `e2e-broken-${tag}`;
    const expiring = `e2e-expiring-${tag}`;
    await recapWithBrokenRecording(broken, `E2E broken recording ${tag}`);
    await recapWithDemoRecording(expiring, `E2E expiring recording ${tag}`);
    try {
      await signIn(page, PEOPLE.buildMember);

      // This browser can't decode it: said right away, with Try again; its moments don't play.
      await page.goto(`/meetings/${broken}`);
      await page.getByRole("button", { name: /^Listen \(/ }).click();
      const cantPlay = page.getByRole("alert").filter({ hasText: "This browser can't play this recording." });
      await expect(cantPlay).toBeVisible({ timeout: 5_000 });
      await expect(cantPlay).not.toContainText("download it"); // members can't download it
      await expect(page.getByText("Getting the recording ready…")).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Playback speed" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Play from/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Show 0:05 in the transcript" })).toBeVisible();
      await cantPlay.getByRole("button", { name: "Try again" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "This browser can't play this recording." })).toBeVisible({ timeout: 5_000 });

      // Deleted (past its 3 days) after the page opened: the part is a 404 → said so, and "Show what's left" refreshes.
      await page.goto(`/meetings/${expiring}`);
      await expect(page.getByRole("button", { name: /^Listen \(/ })).toBeVisible();
      await sql(`UPDATE "MeetingRecap" SET "audioExpiresAt" = now() - interval '1 minute' WHERE id = $1`, [expiring]);
      await page.getByRole("button", { name: /^Listen \(/ }).click();
      const gone = page.getByRole("alert").filter({ hasText: "The recording was just deleted" });
      await expect(gone).toBeVisible();
      await expect(page.getByRole("button", { name: /^Listen \(/ })).toHaveCount(0);
      await gone.getByRole("button", { name: "Show what's left" }).click();
      await expect(page.getByText("The recording was deleted after 3 days. The transcript and key points stay.")).toBeVisible();
      await expect(page.locator("audio")).toHaveCount(0);
    } finally {
      await sql(`DELETE FROM "MeetingRecap" WHERE id = ANY($1)`, [[broken, expiring]]);
    }
  });

  test("an admin deletes a recording early: it asks first, then says it's done and focus goes to that", async ({ page }, info) => {
    const tag = uniq(info.project.name);
    const id = `e2e-delete-audio-${tag}`;
    await recapWithDemoRecording(id, `E2E delete the recording ${tag}`);
    try {
      await signIn(page, PEOPLE.admin);
      await page.goto(`/meetings/${id}`);
      const deleteButton = page.getByRole("button", { name: "Delete recording now" });

      // Cancelled: nothing happens.
      page.once("dialog", (d) => void d.dismiss());
      await deleteButton.click();
      await expect(deleteButton).toBeVisible();
      expect(await sql(`SELECT 1 FROM "MeetingAudioPart" WHERE "recapId" = $1`, [id])).toHaveLength(1);

      let question = "";
      page.once("dialog", (d) => {
        question = d.message();
        void d.accept();
      });
      await deleteButton.click();
      const done = page.getByRole("status").filter({ hasText: "Recording deleted. The transcript and key points stay." });
      await expect(done).toBeVisible();
      expect(question).toContain("Delete the recording now?");
      await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? "")).toContain("Recording deleted.");
      await expect(deleteButton).toHaveCount(0);
      await expect(page.getByText(/^The recording was deleted on .+\. The transcript and key points stay\.$/)).toBeVisible();
      const [row] = await sql<{ parts: number; deleted: boolean }>(
        `SELECT (SELECT count(*)::int FROM "MeetingAudioPart" WHERE "recapId" = r.id) AS parts, r."audioDeletedAt" IS NOT NULL AS deleted
         FROM "MeetingRecap" r WHERE r.id = $1`,
        [id],
      );
      expect(row).toEqual({ parts: 0, deleted: true });
    } finally {
      await sql(`DELETE FROM "MeetingRecap" WHERE id = $1`, [id]);
    }
  });

  test("a save that can't reach the server keeps everything typed and says so, writing up and editing", async ({ page }, info) => {
    const tag = uniq(info.project.name);
    const title = `E2E offline ${tag}`;
    let id = "";
    try {
      await signIn(page, PEOPLE.admin);
      await page.goto("/meetings/new");
      await page.getByLabel("Title").fill(title);
      await page.getByLabel("Key points").fill("[0:30] Decision: we keep the old gearbox.");
      await page.getByLabel("Transcript").fill("[0:30] Let's keep the old gearbox for now.");
      await dropServerActions(page);
      await page.getByRole("button", { name: "Save recap" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Couldn't reach the server." })).toBeVisible();
      await expect(page).toHaveURL(/\/meetings\/new$/);
      await expect(page.getByLabel("Title")).toHaveValue(title);
      await expect(page.getByLabel("Key points")).toHaveValue("[0:30] Decision: we keep the old gearbox.");
      await expect(page.getByLabel("Transcript")).toHaveValue("[0:30] Let's keep the old gearbox for now.");
      await page.unroute("**/*");
      await page.getByRole("button", { name: "Save recap" }).click();
      await expect(page).toHaveURL(/\/meetings\/[^/?]+\?saved=new$/);
      id = new URL(page.url()).pathname.split("/").pop()!;

      await page.getByRole("link", { name: "Edit this recap" }).click();
      await page.getByLabel("Title").fill(`${title} (edited)`);
      await dropServerActions(page);
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Couldn't reach the server." })).toBeVisible();
      await expect(page.getByLabel("Title")).toHaveValue(`${title} (edited)`);
      await page.unroute("**/*");
      // A save that works opens the recap (Next's redirect isn't taken for a failure).
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(new RegExp(`/meetings/${id}\\?saved=1$`));
      await expect(page.getByText("Changes saved.")).toBeVisible();
      await expect(page.getByText("Couldn't reach the server.")).toHaveCount(0);
    } finally {
      if (id) await sql(`DELETE FROM "MeetingRecap" WHERE id = $1`, [id]);
      else await sql(`DELETE FROM "MeetingRecap" WHERE title = $1`, [title]);
    }
  });

  test("the edit form never saves over someone else's newer changes unless the admin says so", async ({ page }, info) => {
    const tag = uniq(info.project.name);
    const id = `e2e-conflict-${tag}`;
    const category = `E2E conflict ${tag}`;
    await sql(
      `INSERT INTO "MeetingRecap" (id, title, "meetingDate", "keyPoints", "createdById", "createdAt", "updatedAt")
       VALUES ($1, $2, CURRENT_DATE, '[0:10] Decision: we start here.', (SELECT id FROM "User" WHERE email = $3), now(), now())`,
      [id, `E2E conflict ${tag}`, PEOPLE.admin],
    );
    // Another admin saving the recap (a new version).
    const someoneSaves = (title: string) =>
      sql(`UPDATE "MeetingRecap" SET title = $2, "updatedAt" = "updatedAt" + interval '1 second' WHERE id = $1`, [id, title]);
    const savedTitle = async () => (await sql<{ title: string }>(`SELECT title FROM "MeetingRecap" WHERE id = $1`, [id]))[0]?.title;
    try {
      await signIn(page, PEOPLE.admin);
      await page.goto(`/meetings/${id}/edit`);
      await someoneSaves("Theirs 1");
      await page.getByLabel("Title").fill("Mine");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Someone else changed this recap while you were editing." })).toBeVisible();
      await expect(page.getByText("Someone else saved this recap while you were editing")).toBeVisible();
      await expect(page.getByLabel("Title")).toHaveValue("Mine");

      // They save again, and a category added here refreshes the page: Save changes still doesn't save over theirs (it
      // only points at the warning), and the page's newer version isn't taken as the form's.
      await someoneSaves("Theirs 2");
      await page.getByRole("button", { name: "New category…" }).click();
      await page.getByLabel("New category").fill(category);
      await page.getByLabel("New category").press("Enter");
      await expect(page.getByText(`Added “${category}” and picked it.`)).toBeVisible();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? "")).toContain("Someone else saved this recap");
      await expect(page).toHaveURL(new RegExp(`/meetings/${id}/edit$`));
      expect(await savedTitle()).toBe("Theirs 2");

      // Saying so saves over theirs.
      await page.getByRole("button", { name: "Save mine anyway" }).click();
      await expect(page).toHaveURL(new RegExp(`/meetings/${id}\\?saved=1$`));
      expect(await savedTitle()).toBe("Mine");

      // Or start again from theirs (after a confirm): that's the version saved over then.
      await page.getByRole("link", { name: "Edit this recap" }).click();
      await someoneSaves("Theirs 3");
      await page.getByLabel("Title").fill("Mine 2");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Someone else saved this recap while you were editing")).toBeVisible();
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: "Use their version" }).click();
      await expect(page.getByLabel("Title")).toHaveValue("Theirs 3");
      await expect(page.getByLabel("Title")).toBeFocused();
      await expect(page.getByText("Someone else saved this recap while you were editing")).toHaveCount(0);
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(new RegExp(`/meetings/${id}\\?saved=0$`));
    } finally {
      await sql(`DELETE FROM "MeetingRecap" WHERE id = $1`, [id]);
      await sql(`DELETE FROM "MeetingCategory" WHERE name = $1`, [category]);
    }
  });

  test("the category picker keeps up when other admins change the team's list while the form is open", async ({ page }, info) => {
    const tag = uniq(info.project.name);
    const title = `E2E picker ${tag}`;
    const gone = `E2E gone ${tag}`;
    const taken = `E2E taken ${tag}`;
    const sixth = `E2E sixth ${tag}`;
    const goneId = `e2e-cat-gone-${tag}`;
    const addCategory = (id: string, name: string) =>
      sql(`INSERT INTO "MeetingCategory" (id, name, "nameKey", "createdAt", "updatedAt") VALUES ($1, $2, lower($2), now(), now())`, [id, name]);
    const pick = (name: string) =>
      page
        .locator("label")
        .filter({ hasText: new RegExp(`^${name}$`) })
        .click();
    try {
      await addCategory(goneId, gone);
      await signIn(page, PEOPLE.admin);
      await page.goto("/meetings/new");
      await page.getByLabel("Title").fill(title);
      await page.getByLabel("Key points").fill("[1:00] Decision: we keep up with the list.");
      await pick(gone);
      await pick("Build");

      // Someone deletes a picked category: the save says so, and the refreshed list unpicks it by name.
      await sql(`DELETE FROM "MeetingCategory" WHERE id = $1`, [goneId]);
      await page.getByRole("button", { name: "Save recap" }).click();
      await expect(page.getByText("One of the categories was removed — pick again.")).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: `“${gone}” was deleted from the team's list, so it isn't picked anymore.` })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: gone })).toHaveCount(0);
      await expect(page.getByRole("checkbox", { name: "Build", exact: true })).toBeChecked();
      await expect(page.getByLabel("Key points")).toHaveValue("[1:00] Decision: we keep up with the list.");

      // Someone adds a category after the page opened; typing its name here picks theirs.
      await addCategory(`e2e-cat-taken-${tag}`, taken);
      await page.getByRole("button", { name: "New category…" }).click();
      await page.getByLabel("New category").fill(taken.toUpperCase());
      await page.getByLabel("New category").press("Enter");
      await expect(page.getByRole("status").filter({ hasText: `“${taken}” was already on the list, so it's picked now.` })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: taken })).toBeChecked();

      // Five picked: a new category is added without being picked, focus stays near (not lost to the page), and it says why.
      for (const name of ["Software", "Business", "Outreach"]) await pick(name);
      await page.getByRole("button", { name: "New category…" }).click();
      await expect(page.getByText("This recap has 5 categories already")).toBeVisible();
      await page.getByLabel("New category").fill(sixth);
      await page.getByLabel("New category").press("Enter");
      await expect(page.getByRole("status").filter({ hasText: `Added “${sixth}”. Untick a category to pick it (up to 5).` })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: sixth })).not.toBeChecked();
      await expect(page.getByRole("checkbox", { name: sixth })).toBeDisabled();
      await expect(page.getByRole("button", { name: "New category…" })).toBeFocused();

      await page.getByRole("button", { name: "Save recap" }).click();
      await expect(page).toHaveURL(/\/meetings\/[^/?]+\?saved=new$/);
      const id = new URL(page.url()).pathname.split("/").pop()!;
      const [row] = await sql<{ categories: string[] }>(
        `SELECT array_agg(c.name ORDER BY c.name) AS categories FROM "MeetingRecapCategory" rc
         JOIN "MeetingCategory" c ON c.id = rc."categoryId" WHERE rc."recapId" = $1`,
        [id],
      );
      expect(row.categories).toEqual(["Build", "Business", "Outreach", "Software", taken].sort());
    } finally {
      await sql(`DELETE FROM "MeetingRecap" WHERE title = $1`, [title]);
      await sql(`DELETE FROM "MeetingCategory" WHERE name = ANY($1)`, [[gone, taken, sixth]]);
    }
  });
});
