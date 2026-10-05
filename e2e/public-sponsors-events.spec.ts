import { expect, test } from "@playwright/test";
import { addDays, todayInTimezone } from "../src/lib/dates";
import { PEOPLE, signIn, sql, uniq } from "./helpers";

// The team website (huskyteers19516.github.io/sponsors and /events) reads GET /api/public/sponsors and
// GET /api/public/events from the browser, and shows logos from GET /api/public/sponsors/logos/<id>: no sign-in,
// CORS for the team website only, nothing private. The Business team uploads each sponsor's logo on its page
// ("Logo needed" until then); the Team calendar's "Hide from the team website" box keeps an outreach event off;
// Admin → Approvals → Team website turns sponsors and events off and on (off until then: the demo seed turns them on).

const TEAM_SITE = "https://huskyteers19516.github.io";
/** The server reuses a built answer for 10 s (src/server/public-api.ts): poll for changes. */
const FRESH = { timeout: 20_000 };
/** A real 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const teamDay = (days: number) => addDays(todayInTimezone("America/Los_Angeles"), days);

interface SponsorsAnswer {
  enabled: boolean;
  sponsors?: { name: string; url: string | null; years: number[]; logo: string | null }[];
}
interface EventsAnswer {
  enabled: boolean;
  timezone?: string;
  events?: { id: string; title: string; kind: string; kindLabel: string; startsOn: string; location: string; link: string | null }[];
}

test.describe("the team website's sponsors and events", () => {
  test("the JSON answers signed out, for the team website only, without anything private", async ({ playwright, baseURL }) => {
    const guest = await playwright.request.newContext({ baseURL }); // no cookies at all

    const res = await guest.get("/api/public/sponsors", { headers: { Origin: TEAM_SITE }, maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(res.headers()["access-control-allow-origin"]).toBe(TEAM_SITE);
    expect(res.headers()["cache-control"]).toBe("public, s-maxage=15, stale-while-revalidate=45");
    const text = await res.text();
    const sponsors = JSON.parse(text) as SponsorsAnswer;
    expect(sponsors.enabled).toBe(true);
    const names = sponsors.sponsors!.map((s) => s.name);
    // The demo's accepted and finished sponsors (Home Depot twice, as one entry with both years)…
    expect(names).toEqual(expect.arrayContaining(["REV Robotics", "Home Depot", "Anaheim Rotary Club", "Fresh Prints Anaheim"]));
    // (Last year's "The Home Depot" shows as Home Depot: its years are merged in.)
    expect(sponsors.sponsors!.find((s) => s.name === "Home Depot")!.years.length).toBeGreaterThanOrEqual(1);
    // …but not one that asked not to be named, nor anyone still being asked.
    for (const hidden of ["Bright Futures Fund", "The Home Depot", "Polymaker", "Bambu Lab", "Lockheed Martin"]) expect(names).not.toContain(hidden);
    for (const secret of ["@", "amountReceived", "asking", "notes", "ACCEPTED", "Amara", "Ava"]) expect(text).not.toContain(secret);

    // A logo: a picture the website may embed.
    const rev = sponsors.sponsors!.find((s) => s.name === "REV Robotics")!;
    expect(rev.logo).toMatch(/^\/api\/public\/sponsors\/logos\/[A-Za-z0-9_-]+$/);
    const logo = await guest.get(rev.logo!, { maxRedirects: 0 });
    expect(logo.status()).toBe(200);
    expect(logo.headers()["content-type"]).toBe("image/png");
    expect(logo.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(logo.headers()["x-content-type-options"]).toBe("nosniff");
    expect(logo.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(logo.headers()["content-disposition"]).toMatch(/^inline; filename="rev-robotics-logo\.png"/);
    // A query string never reaches the file: one CDN copy per logo.
    const busted = await guest.get(`${rev.logo!}?cb=${Date.now()}`, { maxRedirects: 0 });
    expect([busted.status(), busted.headers()["location"]]).toEqual([308, rev.logo]);
    // Only a website's homepage is ever linked.
    for (const s of sponsors.sponsors!) if (s.url) expect(new URL(s.url).pathname + new URL(s.url).search).toBe("/");
    // Anything else under the logos' prefix still needs a session; an unknown id is a 404.
    expect((await guest.get("/api/public/sponsors/logos/nope123", { maxRedirects: 0 })).status()).toBe(404);
    expect((await guest.get("/api/public/sponsors/logos/a%2Fb", { maxRedirects: 0 })).status()).toBe(401);

    const ev = await guest.get("/api/public/events", { headers: { Origin: "https://example.org" } });
    expect(ev.status()).toBe(200);
    expect(ev.headers()["access-control-allow-origin"]).toBe(TEAM_SITE); // never another site
    const evText = await ev.text();
    const events = JSON.parse(evText) as EventsAnswer;
    expect(events.timezone).toBe("America/Los_Angeles");
    const titles = events.events!.map((e) => e.title);
    expect(titles).toContain("Robot demo at the library");
    // Never team meetings, team events, or an event hidden from the website; never notes.
    for (const hidden of ["Extra build day", "Team pizza night", "Mentoring the middle school FLL team"]) expect(titles).not.toContain(hidden);
    expect(evText).not.toContain("Bring the practice bot");
    expect(new Set(events.events!.map((e) => e.kind))).not.toContain("MEETING");
    await guest.dispose();
  });

  test("a business member adds a sponsor's logo; it's on the website until they're taken off it", async ({ page, playwright, baseURL }, info) => {
    const name = `E2E Logo Co ${uniq(info.project.name)}`;
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "Sponsorship" (id, name, stage, "acceptedOn", "ownerId", "createdById", "updatedAt")
       SELECT 'e2e_' || md5(random()::text), $1, 'ACCEPTED', CURRENT_DATE, u.id, u.id, now() FROM "User" u WHERE u.email = $2
       RETURNING id`,
      [name, PEOPLE.businessMember],
    );
    const guest = await playwright.request.newContext({ baseURL });
    const listed = async () =>
      (((await (await guest.get("/api/public/sponsors")).json()) as SponsorsAnswer).sponsors ?? []).find((s) => s.name === name) ?? null;

    try {
      // Today: a nudge to the sponsors she's on that need a logo, which opens the "Logo needed" filter.
      await signIn(page, PEOPLE.businessMember);
      await page.goto("/today");
      await page.getByRole("link", { name: /sponsors? needs? a logo for the team website/ }).click();
      await expect(page).toHaveURL(/\/sponsors\?filter=logo&mine=1$/);
      const link = page.locator(`a[data-sponsor-link="${id}"]`).filter({ visible: true });
      await expect(link).toHaveText(name);
      await expect(page.getByText("Logo needed", { exact: true }).filter({ visible: true }).first()).toBeVisible();
      await link.click();

      // Its page: the Team website section says a logo is needed; the picker checks a file before sending it.
      await expect(page.getByRole("checkbox", { name: /Thank them on the team website/ })).toBeChecked();
      await expect(page.getByText(/^Logo needed: they're thanked on the team website/)).toBeVisible();
      const picker = page.getByLabel(/^Brand logo/);
      await picker.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") });
      await expect(page.getByText(/^Logos can be a PNG, JPG, or WebP picture/)).toBeVisible();
      await picker.setInputFiles({ name: "e2e-logo.png", mimeType: "image/png", buffer: PNG });
      await expect(page.getByRole("status").filter({ hasText: "Logo added." })).toBeVisible();
      await expect(page.getByRole("img", { name: `${name} logo` })).toBeVisible();
      await expect(page.getByText(/^Logo needed:/)).toHaveCount(0);

      // On the website now, with that logo.
      await expect.poll(async () => (await listed())?.logo ?? null, FRESH).toMatch(/^\/api\/public\/sponsors\/logos\//);
      const logoPath = (await listed())!.logo!;
      expect((await guest.get(logoPath)).status()).toBe(200);

      // Not thanked on the website any more: gone from the list, and its logo isn't served.
      await page.getByRole("checkbox", { name: /Thank them on the team website/ }).uncheck();
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page).toHaveURL(/\/sponsors\?saved=/);
      await expect.poll(listed, FRESH).toBeNull();
      expect((await guest.get(logoPath)).status()).toBe(404);
    } finally {
      await sql(`DELETE FROM "Sponsorship" WHERE id = $1`, [id]);
      await guest.dispose();
    }
  });

  test("a leader hides an outreach event from the website, then shows it", async ({ page, playwright, baseURL }, info) => {
    const title = `E2E outreach ${uniq(info.project.name)}`;
    const guest = await playwright.request.newContext({ baseURL });
    const titles = async () => (((await (await guest.get("/api/public/events")).json()) as EventsAnswer).events ?? []).map((e) => e.title);

    try {
      await signIn(page, PEOPLE.buildLeader);
      await page.goto("/calendar/new");
      await page.getByLabel("Title", { exact: true }).fill(title);
      // An extra meeting is never on the website: no box, a note instead.
      await page.getByRole("radio", { name: /Extra meeting/ }).check();
      await expect(page.getByRole("checkbox", { name: /Hide from the team website/ })).toBeHidden();
      await expect(page.getByText(/^Not on the team website: only league meets/)).toBeVisible();
      await page.getByRole("radio", { name: /Outreach/ }).check();
      const hide = page.getByRole("checkbox", { name: /Hide from the team website/ });
      await expect(hide).toBeVisible();
      await hide.check();
      await page.getByLabel("Date", { exact: true }).fill(teamDay(6));
      await page.getByRole("button", { name: "Add event" }).click();
      await expect(page).toHaveURL(/\/calendar\/[a-z0-9]+\?added=1$/);
      await expect(page.getByText("Hidden from the team website", { exact: true })).toBeVisible();
      const eventPath = new URL(page.url()).pathname;
      expect(await titles()).not.toContain(title);

      await page.goto(`${eventPath}/edit`);
      await expect(page.getByRole("checkbox", { name: /Hide from the team website/ })).toBeChecked();
      await page.getByRole("checkbox", { name: /Hide from the team website/ }).uncheck();
      await page.getByRole("button", { name: "Save changes" }).click();
      // Exact: the form's hints also say "Shown on the team website …".
      await expect(page.getByText("On the team website", { exact: true })).toBeVisible();
      await expect.poll(titles, FRESH).toContain(title);
      // The List view marks it too.
      await page.goto("/calendar?view=list&kind=OUTREACH");
      await expect(page.getByRole("link").filter({ hasText: title })).toContainText("On the team website");
    } finally {
      await sql(`DELETE FROM "CalendarEvent" WHERE title = $1`, [title]);
      await guest.dispose();
    }
  });

  test("an admin turns sponsors and events off (enabled: false) and on again", async ({ page, playwright, baseURL }) => {
    const guest = await playwright.request.newContext({ baseURL });
    const read = async (path: string) => (await (await guest.get(path)).json()) as { enabled: boolean };

    await signIn(page, PEOPLE.admin);
    await page.goto("/admin");
    const card = page.getByRole("region", { name: "Team website" });
    const sponsors = card.getByRole("checkbox", { name: /Thank our sponsors on the team website/ });
    const events = card.getByRole("checkbox", { name: /List events on the team website/ });
    await expect(sponsors).toBeChecked();
    await expect(events).toBeChecked();

    await sponsors.uncheck();
    await events.uncheck();
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByText(/^Saved\./)).toBeVisible();
    await expect.poll(() => read("/api/public/sponsors"), FRESH).toEqual({ enabled: false });
    await expect.poll(() => read("/api/public/events"), FRESH).toEqual({ enabled: false });
    // Progress is its own switch.
    expect((await read("/api/public/progress")).enabled).toBe(true);

    await sponsors.check();
    await events.check();
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(async () => (await read("/api/public/sponsors")).enabled, FRESH).toBe(true);
    await expect.poll(async () => (await read("/api/public/events")).enabled, FRESH).toBe(true);
    await guest.dispose();
  });
});
