import { expect, type Page } from "@playwright/test";
import { PEOPLE, signIn } from "./helpers";

/** Chrome's fake microphone (a beep, or the file given with --use-file-for-fake-audio-capture) with no permission prompt. */
export const FAKE_MIC = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];

/** Signs in as the captain (admin access) and opens the recorder. */
export async function openRecorder(page: Page) {
  await signIn(page, PEOPLE.admin);
  await page.goto("/meetings/record");
  await expect(page.getByRole("heading", { level: 1, name: "Record a meeting" })).toBeVisible();
}

/** A Server Action call's body field named `field` (React prefixes a FormData argument's fields with its id: "_1_position"). */
function hasField(body: string, field: string): boolean {
  return new RegExp(`name="(?:_?\\d+_)?${field}"`).test(body);
}

/**
 * Holds the recorder's part uploads (uploadMeetingAudioPartAction: a Server Action POST to the recorder's page with a
 * `position` field) until `release()` lets them through or `fail()` drops them like a lost connection. Everything else
 * (the page itself, saving the recap) goes through untouched.
 */
export async function holdPartUploads(page: Page) {
  let held = 0;
  let decide!: (how: "continue" | "abort") => void;
  const decided = new Promise<"continue" | "abort">((resolve) => (decide = resolve));
  await page.route("**/meetings/record", async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || !req.headers()["next-action"]) return route.continue();
    // Playwright can't read a body that carries a file (postDataBuffer() is null then): only a part upload sends one.
    const body = req.postDataBuffer()?.toString("latin1") ?? null;
    if (body !== null && !hasField(body, "position")) return route.continue();
    held++;
    if ((await decided) === "abort") await route.abort("failed");
    else await route.continue();
  });
  return {
    /** How many part uploads are being held. */
    held: () => held,
    release: () => decide("continue"),
    fail: () => decide("abort"),
  };
}
