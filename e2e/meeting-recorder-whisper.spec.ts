import path from "node:path";
import { expect, test } from "@playwright/test";
import { FAKE_MIC, openRecorder } from "./meeting-recorder-helpers";

// The real speech model: e2e/fixtures/meeting-speech.wav (macOS `say`, 16 kHz mono) plays as Chrome's fake microphone
// and the live transcript must hear it. Downloads 73–286 MB the first time, so it only runs with E2E_WHISPER=1.

// Chrome needs an absolute path; Playwright runs from the repository root (like global-setup.ts).
const SPEECH_WAV = path.resolve("e2e", "fixtures", "meeting-speech.wav");

test.use({ launchOptions: { args: [...FAKE_MIC, `--use-file-for-fake-audio-capture=${SPEECH_WAV}`] }, permissions: ["microphone"] });

test.describe("meeting recorder (real speech, real model)", () => {
  test("the live transcript hears what's said", async ({ page }, info) => {
    test.skip(!process.env.E2E_WHISPER, "downloads a speech model (73–286 MB): set E2E_WHISPER=1 to run it");
    test.skip(info.project.name !== "desktop", "the recorder is tested on a computer");
    test.setTimeout(15 * 60_000);
    await openRecorder(page);
    await expect(page.getByRole("switch", { name: "Live transcript" })).toBeChecked();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Recording" })).toBeVisible();
    // The file loops; the first line comes after one 25-second window (plus the download the first time).
    await expect(page.getByText(/intake/i).first()).toBeVisible({ timeout: 12 * 60_000 });
    await page.getByRole("button", { name: "Stop and review" }).click();
    // A computer that fell behind gets asked whether to transcribe the whole recording: keep the live one.
    const keepLive = page.getByRole("button", { name: "Keep the live transcript" });
    const review = page.getByRole("heading", { level: 1, name: "Review and save" });
    await expect(keepLive.or(review)).toBeVisible({ timeout: 5 * 60_000 });
    if (await keepLive.isVisible()) await keepLive.click();
    await expect(review).toBeVisible({ timeout: 5 * 60_000 });
    await expect(page.getByLabel("Transcript")).toHaveValue(/intake/i);
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Discard" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Record a meeting" })).toBeVisible();
  });
});
