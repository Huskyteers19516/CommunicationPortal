import { expect, type Page, test } from "@playwright/test";
import { sql, uniq } from "./helpers";
import { FAKE_MIC, holdPartUploads, openRecorder } from "./meeting-recorder-helpers";

// The meeting recorder (/meetings/record), desktop only, in Chrome with its fake microphone (a beep; no permission
// prompt). The live transcript is switched off so no speech model is downloaded: record a few seconds with a pause and
// a key moment, stop, skip transcribing, review, save — the recording uploads in parts (MeetingAudioPart rows) and
// plays on the recap's page. A recording cut off by leaving the page is offered again from this browser's copy
// (IndexedDB), and a Discard sticks even with the review form's autosave due. Leaving while the recording uploads
// stops the upload and never takes the person anywhere afterwards; discarding that copy later deletes what reached
// the portal. The real speech model is tested in meeting-recorder-whisper.spec.ts (only with E2E_WHISPER=1).

/** How many recordings this browser keeps for the recorder (its IndexedDB copy). */
function localCopies(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open("huskyteers-recorder");
        req.onerror = () => resolve(-1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("recordings")) {
            db.close();
            resolve(0);
            return;
          }
          const count = db.transaction("recordings").objectStore("recordings").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
  );
}

async function recordFor(page: Page, seconds: number) {
  await expect(page.getByRole("timer", { name: "Recorded time" })).toHaveText(new RegExp(`^0:0[${seconds}-9]$`), { timeout: 20_000 });
}

/** Records a couple of seconds (live transcript off), stops, skips transcribing, and names the recap in the review. */
async function recordAndReview(page: Page, title: string) {
  await openRecorder(page);
  await page.getByText("Live transcript", { exact: true }).click();
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Recording" })).toBeVisible();
  await recordFor(page, 2);
  await page.getByRole("button", { name: "Stop and review" }).click();
  await page.getByRole("button", { name: "Skip — I'll write the key points myself" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Review and save" })).toBeVisible();
  await page.getByLabel("Title").fill(title);
}

/** A recap by its title, with how many of its recording's parts are in. */
async function recapByTitle(title: string) {
  const [row] = await sql<{ id: string; audioParts: number; audioDeletedAt: Date | null; parts: number }>(
    `SELECT r.id, r."audioParts", r."audioDeletedAt", (SELECT count(*)::int FROM "MeetingAudioPart" p WHERE p."recapId" = r.id) AS parts
     FROM "MeetingRecap" r WHERE r.title = $1`,
    [title],
  );
  return row ?? null;
}

// Launch options can't change inside a describe group (Playwright starts a new browser for them), so they're set for
// the whole file; the real-model test lives in meeting-recorder-whisper.spec.ts with its own microphone file.
test.use({ launchOptions: { args: FAKE_MIC }, permissions: ["microphone"] });

test.describe("meeting recorder (fake microphone)", () => {
  test("an admin records with the live transcript off, pauses, marks a moment, reviews, saves, and the recording plays", async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop", "the recorder is tested on a computer");
    const title = `E2E recorded sync ${uniq(info.project.name)}`;
    await openRecorder(page);
    await expect(page.getByText("Let everyone know the meeting is being recorded.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Write one up without a recording" })).toHaveAttribute("href", "/meetings/new");

    // Live transcript off: no model download; the recording can be transcribed after Stop instead.
    const live = page.getByRole("switch", { name: "Live transcript" });
    await page.getByText("Live transcript", { exact: true }).click();
    await expect(live).not.toBeChecked();

    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Recording" })).toBeVisible();
    await expect(page.getByText("Live transcript is off. You can transcribe the recording after you stop.")).toBeVisible();
    await expect(page.getByText("Keep this tab open — the recording is saved on this computer as you go.")).toBeVisible();
    await recordFor(page, 2);

    // Leaving asks first (here: no, stay).
    page.once("dialog", (d) => {
      expect(d.message()).toContain("Leave the recorder?");
      void d.dismiss();
    });
    await page.getByRole("link", { name: "Meeting recaps" }).click();
    await expect(page).toHaveURL(/\/meetings\/record$/);

    // Paused time isn't recorded: the clock stands still (read once it has settled — it ticks every 250 ms).
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Paused. Nothing is recorded until you resume.")).toBeVisible();
    const timer = page.getByRole("timer", { name: "Recorded time" });
    await page.waitForTimeout(500);
    const pausedAt = await timer.textContent();
    await page.waitForTimeout(1500);
    await expect(timer).toHaveText(pausedAt ?? "");
    await page.getByRole("button", { name: "Resume" }).click();
    await page.getByRole("button", { name: "Mark key moment" }).click();
    await expect(page.getByText("1 key moment marked")).toBeVisible();
    await recordFor(page, 4);

    await page.getByRole("button", { name: "Stop and review" }).click();
    // The choice is announced (the step's status line), not just shown.
    await expect(page.getByRole("status").filter({ hasText: "There's no transcript yet." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Transcribe the recording now" })).toBeVisible();
    await page.getByRole("button", { name: "Skip — I'll write the key points myself" }).click();

    // Review: the recording plays back here; the mark became a key point to fill in.
    await expect(page.getByRole("heading", { level: 1, name: "Review and save" })).toBeVisible();
    await expect(page.locator("audio")).toHaveAttribute("src", /^blob:/);
    await expect(page.getByRole("checkbox", { name: /Keep the recording for 3 days/ })).toBeChecked();
    await expect(
      page.getByText(/^Everyone can listen until \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2}\s[AP]M\. Then it's deleted automatically\.$/),
    ).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue(/^Meeting — \w{3}, \w{3} \d{1,2}$/);
    await expect(page.getByLabel("Key points")).toHaveValue(/^\[0:0\d\] Key moment\.$/);
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Key points").fill("[0:02] Decision: we test the recorder from start to finish.");
    await page.getByRole("button", { name: "Save recap" }).click();

    // Saved, then the recording uploaded: the recap opens.
    await expect(page).toHaveURL(/\/meetings\/[^/?]+\?saved=new$/, { timeout: 30_000 });
    await expect(page.getByText("Recap saved. Everyone on the team can read it now.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("Recorded by Jordan Lee")).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").pop()!;
    const [recap] = await sql<{
      audioType: string;
      audioParts: number;
      audioBytes: number;
      durationSec: number;
      parts: number;
      bytes: number;
    }>(
      `SELECT r."audioType", r."audioParts", r."audioBytes", r."durationSec",
              (SELECT count(*)::int FROM "MeetingAudioPart" p WHERE p."recapId" = r.id) AS parts,
              (SELECT coalesce(sum(size), 0)::int FROM "MeetingAudioPart" p WHERE p."recapId" = r.id) AS bytes
       FROM "MeetingRecap" r WHERE r.id = $1`,
      [id],
    );
    expect(recap.audioType).toBe("audio/webm");
    expect(recap.audioParts).toBeGreaterThanOrEqual(1);
    expect(recap.parts).toBe(recap.audioParts);
    expect(recap.bytes).toBe(recap.audioBytes);
    expect(recap.durationSec).toBeGreaterThanOrEqual(3);
    expect(recap.durationSec).toBeLessThan(30);
    // The copy on this computer goes once the portal has the whole recording.
    expect(await localCopies(page)).toBe(0);

    // The recap's recording loads and plays.
    await expect(page.getByText(/^Deleted automatically on \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2}\s[AP]M\.$/)).toBeVisible();
    await page.getByRole("button", { name: /^Listen \(\d/ }).click();
    const audio = page.locator("audio");
    await expect(audio).toBeVisible();
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration)).toBeGreaterThan(2);
  });

  test("a recording cut off by leaving the page is offered again from this browser's copy, and can be discarded", async ({
    page,
  }, info) => {
    test.skip(info.project.name !== "desktop", "the recorder is tested on a computer");
    await openRecorder(page);
    await page.getByText("Live transcript", { exact: true }).click();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Recording" })).toBeVisible();
    // MediaRecorder hands over (and the copy keeps) a piece every 5 seconds.
    await recordFor(page, 6);
    await page.getByRole("button", { name: "Mark key moment" }).click();
    await expect(page.getByText("1 key moment marked")).toBeVisible();
    await page.waitForTimeout(1000); // the mark is saved to the copy right away; let that write land

    // Leave anyway (the browser's "Leave site?": yes), then come back.
    page.once("dialog", (d) => void d.accept());
    await page.goto("/meetings/record");
    await expect(page.getByRole("heading", { level: 1, name: "Record a meeting" })).toBeVisible();
    const copies = page.getByRole("region", { name: "Not on the portal yet" });
    const item = copies.getByRole("listitem");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(/Unsaved recording from \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2}\s[AP]M · 0:0\d/);
    await expect(item).toContainText("Kept on this computer, not saved to the portal yet.");
    expect(await localCopies(page)).toBe(1);

    await item.getByRole("button", { name: "Review & save" }).click();
    await expect(page.getByText("There's no transcript yet.")).toBeVisible();
    await page.getByRole("button", { name: "Skip — I'll write the key points myself" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review and save" })).toBeVisible();
    await expect(page.locator("audio")).toHaveAttribute("src", /^blob:/);
    await expect(page.getByLabel("Key points")).toHaveValue(/Key moment\./);

    // Discard right after typing (the form's 1-second autosave is due) and read the confirm for a moment: the discarded
    // recording must not come back.
    await page.getByLabel("Title").fill("Typed just before Discard");
    page.once("dialog", (d) => {
      setTimeout(() => void d.accept(), 1500);
    });
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Record a meeting" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Not on the portal yet" })).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(await localCopies(page)).toBe(0);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Record a meeting" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Not on the portal yet" })).toHaveCount(0);
  });

  test("leaving while the recording uploads stops the upload and never takes the person anywhere afterwards", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the recorder is tested on a computer");
    const title = `E2E left mid-upload ${uniq(info.project.name)}`;
    const uploads = await holdPartUploads(page);
    await recordAndReview(page, title);
    await page.getByRole("button", { name: "Save recap" }).click();
    await expect.poll(() => uploads.held()).toBe(1);

    // Leave (the guard asks first), then go on to another page.
    page.once("dialog", (d) => {
      expect(d.message()).toContain("Leave while the recording uploads?");
      void d.accept();
    });
    await page.getByRole("link", { name: "Meeting recaps" }).click();
    await expect(page).toHaveURL(/\/meetings$/);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Today", exact: true }).click();
    await expect(page).toHaveURL(/\/today$/);

    // The part that was on its way still lands (it's the whole recording); the person stays where they are.
    uploads.release();
    await expect.poll(async () => (await recapByTitle(title))?.parts ?? 0, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/today$/);
    // The portal has the whole recording, so the copy on this computer went.
    await expect.poll(() => localCopies(page)).toBe(0);
  });

  test("an upload stopped by leaving waits on this computer; discarding it deletes what reached the portal too", async ({ page }, info) => {
    test.skip(info.project.name !== "desktop", "the recorder is tested on a computer");
    const title = `E2E discarded upload ${uniq(info.project.name)}`;
    const uploads = await holdPartUploads(page);
    await recordAndReview(page, title);
    await page.getByRole("button", { name: "Save recap" }).click();
    await expect.poll(() => uploads.held()).toBe(1);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("link", { name: "Meeting recaps" }).click();
    await expect(page).toHaveURL(/\/meetings$/);
    uploads.fail(); // the part never arrives
    expect(await recapByTitle(title)).toMatchObject({ audioParts: 1, parts: 0, audioDeletedAt: null });

    await page.goto("/meetings/record");
    const item = page.getByRole("region", { name: "Not on the portal yet" }).getByRole("listitem");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(`“${title}” didn't finish uploading its recording`);
    page.once("dialog", (d) => {
      expect(d.message()).toContain("what reached the portal is deleted too");
      void d.accept();
    });
    await item.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("region", { name: "Not on the portal yet" })).toHaveCount(0);
    expect(await localCopies(page)).toBe(0);

    // The recap stays, and says its recording was deleted (not "still uploading" for 3 days).
    const recap = (await recapByTitle(title))!;
    expect(recap.audioDeletedAt).not.toBeNull();
    expect(recap.parts).toBe(0);
    await page.goto(`/meetings/${recap.id}`);
    await expect(page.getByText(/^The recording was deleted on /)).toBeVisible();
  });
});
