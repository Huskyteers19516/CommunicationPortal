import { expect, test } from "@playwright/test";
import { PEOPLE, signIn } from "./helpers";

// The team website (huskyteers19516.github.io/progress) reads GET /api/public/progress from the browser: it answers
// without signing in, with a CORS header for the team website only, and only aggregate numbers. Admin → Approvals →
// Team website turns it off ({"enabled": false}) and on again. Each person can leave themselves off in Settings.

const TEAM_SITE = "https://huskyteers19516.github.io";

interface Answer {
  enabled: boolean;
  totals?: { itemsDone: number; itemsOpen: number; people: number };
  people?: { id: string; name: string }[];
}

test.describe("public progress for the team website", () => {
  test("the JSON answers signed out, for the team website only, without anything private", async ({ playwright, baseURL }) => {
    const guest = await playwright.request.newContext({ baseURL }); // no cookies at all
    const res = await guest.get("/api/public/progress", { headers: { Origin: TEAM_SITE }, maxRedirects: 0 });
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers["access-control-allow-origin"]).toBe(TEAM_SITE);
    expect(headers["vary"]).toContain("Origin");
    expect(headers["cache-control"]).toBe("public, s-maxage=15, stale-while-revalidate=45");
    expect(headers["content-type"]).toContain("application/json");
    const text = await res.text();
    const body = JSON.parse(text) as Answer;
    expect(body.enabled).toBe(true);
    expect(body.totals?.people).toBeGreaterThan(0);
    expect(body.people?.map((p) => p.name)).toContain("Ethan Chen");
    // No emails, no mentors (Elena is the demo mentor).
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("Elena");

    // Another site isn't named as allowed.
    const other = await guest.get("/api/public/progress", { headers: { Origin: "https://example.org" } });
    expect(other.headers()["access-control-allow-origin"]).toBe(TEAM_SITE);
    // The rest of the API still needs a session.
    expect((await guest.get("/api/planner/session")).status()).toBe(401);
    await guest.dispose();
  });

  test("an admin turns the page off (it then says enabled: false) and on again", async ({ page, playwright, baseURL }) => {
    const guest = await playwright.request.newContext({ baseURL });
    const read = async () => (await (await guest.get("/api/public/progress", { headers: { Origin: TEAM_SITE } })).json()) as Answer;

    await signIn(page, PEOPLE.admin);
    await page.goto("/admin");
    const card = page.getByRole("region", { name: "Team website" });
    await expect(card.getByRole("link", { name: /Open the progress page/ })).toHaveAttribute("href", `${TEAM_SITE}/progress`);
    const enabled = card.getByRole("checkbox", { name: /Show live progress on the team website/ });
    await expect(enabled).toBeChecked();

    await enabled.uncheck();
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByText(/now says progress is private/)).toBeVisible();
    await expect(card.getByText("Off", { exact: true })).toBeVisible();
    expect(await read()).toEqual({ enabled: false });

    await enabled.check();
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByText(/shows the new settings/)).toBeVisible();
    const back = await read();
    expect(back.enabled).toBe(true);
    expect(back.people?.length).toBeGreaterThan(0);
    await guest.dispose();
  });

  test("a member leaves themselves off the list in Settings, and back on", async ({ page, playwright, baseURL }) => {
    const guest = await playwright.request.newContext({ baseURL });
    const names = async () =>
      (((await (await guest.get("/api/public/progress")).json()) as Answer).people ?? []).map((p) => p.name);
    expect(await names()).toContain("Ethan Chen");

    await signIn(page, PEOPLE.buildMember);
    await page.goto("/settings");
    const show = page.getByRole("switch", { name: /Show me on the team website/ });
    await expect(show).toBeChecked();
    await page.getByText("Show me on the team website's progress page").click();
    await expect(page.getByRole("status").filter({ hasText: "no longer listed" })).toBeVisible();
    await expect(show).not.toBeChecked();
    expect(await names()).not.toContain("Ethan Chen");

    await page.getByText("Show me on the team website's progress page").click();
    await expect(page.getByRole("status").filter({ hasText: "You're shown on the team website." })).toBeVisible();
    await expect(show).toBeChecked();
    expect(await names()).toContain("Ethan Chen");
    await guest.dispose();
  });
});
