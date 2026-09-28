import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

const TEAM_TZ = "America/Los_Angeles";

/** "YYYY-MM-DD" in the team timezone, `days` from today. */
function teamDay(days: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TEAM_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  );
}

/** The team timezone's wall-clock time now, "HH:MM" (24 h). */
function teamTime(): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TEAM_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
}

/** "September 2026" for a "YYYY-MM-DD". */
function monthName(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${date}T00:00:00Z`));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The .ics body with folded lines joined back up. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, "");
}

test.describe("team calendar", () => {
  test("a leader adds a meet; members see it everywhere and can download it; the leader edits and removes it", async ({ page }, info) => {
    const title = `E2E meet ${uniq(info.project.name)}`;
    const date = teamDay(3);
    const month = date.slice(0, 7);
    const titleRe = new RegExp(escapeRegExp(title));

    // A leader adds it. An end time before the start time is refused by the server: values stay, focus goes there.
    await signIn(page, PEOPLE.softwareLeader);
    await page.goto("/calendar");
    await page.getByRole("link", { name: "Add an event", exact: true }).first().click();
    await expect(page).toHaveURL(/\/calendar\/new$/);
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByRole("radio", { name: /League meet/ }).check();
    await page.getByLabel("Date", { exact: true }).fill(date);
    await page.getByLabel(/^Start time/).fill("08:00");
    await page.getByLabel(/^End time/).fill("07:00");
    await page.getByLabel(/^Location/).fill("Anaheim High School Gym");
    await page.getByLabel(/^Link/).fill("ftc-events.firstinspires.org/2026");
    await page.getByLabel(/^Notes/).fill("Bring the robot.\nArrive by 7:30.");
    await page.getByRole("button", { name: "Add event" }).click();
    await expect(page.locator("#endTime-error")).toHaveText("The end time must be after the start time.");
    await expect(page.getByLabel(/^End time/)).toBeFocused();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(title);
    await expect(page.getByLabel(/^Location/)).toHaveValue("Anaheim High School Gym");
    await expect(page.getByLabel(/^Start time/)).toHaveValue("08:00");
    await expect(page.getByRole("radio", { name: /League meet/ })).toBeChecked();
    await expectNoHorizontalScroll(page);
    await page.getByLabel(/^End time/).fill("16:00");
    await page.getByRole("button", { name: "Add event" }).click();
    await expect(page).toHaveURL(/\/calendar\/[a-z0-9]+\?added=1$/);
    await expect(page.getByText("Added. The whole team can see it now.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    const eventPath = new URL(page.url()).pathname;
    const [row] = await sql<{ kind: string; startsOn: string; startTime: string; endTime: string; link: string; creator: string }>(
      `SELECT e.kind, e."startsOn"::text AS "startsOn", e."startTime", e."endTime", e.link, u.email AS creator
         FROM "CalendarEvent" e JOIN "User" u ON u.id = e."createdById" WHERE e.title = $1`,
      [title],
    );
    expect(row).toEqual({
      kind: "MEET",
      startsOn: date,
      startTime: "08:00",
      endTime: "16:00",
      link: "https://ftc-events.firstinspires.org/2026",
      creator: PEOPLE.softwareLeader,
    });

    // A member sees it in the month view (a bar in its day on wide screens, the list under the grid on phones)…
    await signIn(page, PEOPLE.softwareMember);
    await page.goto(`/calendar?month=${month}`);
    await expect(page.getByRole("link", { name: "Add an event", exact: true })).toHaveCount(0);
    const monthRegion = page.getByRole("region", { name: monthName(date), exact: true });
    await expect(monthRegion.getByRole("link", { name: titleRe }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);

    // …the countdown at the top shows whichever meet is next (this one, unless another meet comes sooner; one
    // that already ended today doesn't count)…
    const [next] = await sql<{ title: string }>(
      `SELECT title FROM "CalendarEvent"
        WHERE kind IN ('MEET', 'ILT', 'SCRIMMAGE', 'COMPETITION')
          AND (COALESCE("endsOn", "startsOn") > $1::date
               OR (COALESCE("endsOn", "startsOn") = $1::date AND ("endTime" IS NULL OR "endTime" > $2)))
        ORDER BY "startsOn", "startTime" NULLS FIRST, title, id LIMIT 1`,
      [teamDay(0), teamTime()],
    );
    const hero = page.getByRole("region", { name: "Next meet" });
    await expect(hero.getByRole("link", { name: next.title, exact: true })).toBeVisible();
    if (next.title === title) await expect(hero).toContainText("3 days");

    // …in the List view with its countdown, filtered by kind…
    await page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "List" }).click();
    await expect(page).toHaveURL(/view=list/);
    await expect(page.getByRole("navigation", { name: "Tabs" }).getByRole("link", { name: "List" })).toHaveAttribute("aria-current", "page");
    const upcoming = page.getByRole("region", { name: "Coming up" });
    const listRow = upcoming.getByRole("link").filter({ hasText: title });
    await expect(listRow).toContainText("In 3 days");
    await expect(listRow).toContainText("Anaheim High School Gym");
    await expectNoHorizontalScroll(page);
    const kinds = page.getByRole("navigation", { name: "Filter by kind" });
    // From `sm` up the chips wrap instead of scrolling, so the last one is on screen too.
    if ((page.viewportSize()?.width ?? 0) >= 640) await expect(kinds.getByRole("link", { name: "Other", exact: true })).toBeInViewport();
    await kinds.getByRole("link", { name: "League meet" }).click();
    await expect(page).toHaveURL(/kind=MEET/);
    await expect(kinds.getByRole("link", { name: "League meet" })).toHaveAttribute("aria-current", "true");
    await expect(upcoming.getByRole("link").filter({ hasText: title })).toBeVisible();
    await kinds.getByRole("link", { name: "Outreach" }).click();
    await expect(page).toHaveURL(/kind=OUTREACH/);
    await expect(upcoming.getByRole("link").filter({ hasText: title })).toHaveCount(0);

    // …and on its page, without Edit or Remove.
    await page.goto(eventPath);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByText("In 3 days")).toBeVisible();
    await expect(page.getByText("8:00 AM – 4:00 PM")).toBeVisible();
    await expect(page.getByText("Arrive by 7:30.")).toBeVisible();
    const maps = page.getByRole("link", { name: /Open in Maps/ });
    await expect(maps).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=Anaheim%20High%20School%20Gym");
    await expect(maps).toHaveAttribute("target", "_blank");
    await expect(maps).toHaveAttribute("rel", /noopener noreferrer/);
    await expect(page.getByRole("link", { name: /Open link/ })).toHaveAttribute("href", "https://ftc-events.firstinspires.org/2026");
    await expect(page.getByText(/Added .* by Priya Raman/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Remove/ })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Members can't add or edit, even by URL.
    expect((await page.goto("/calendar/new"))?.status()).toBe(404);
    expect((await page.goto(`${eventPath}/edit`))?.status()).toBe(404);
    expect((await page.goto("/calendar/does-not-exist"))?.status()).toBe(404);

    // "Add to my calendar" downloads an .ics with the event in it (this event, and the whole calendar).
    await page.goto(eventPath);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Add to my calendar" }).click();
    expect((await download).suggestedFilename()).toMatch(/^huskyteers-e2e-meet-.*\.ics$/);
    const one = await page.request.get(`${eventPath}/event.ics`);
    expect(one.status()).toBe(200);
    expect(one.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(one.headers()["content-disposition"]).toMatch(/^attachment; filename="huskyteers-e2e-meet-.*\.ics"$/);
    expect(one.headers()["cache-control"]).toBe("private, no-store");
    expect(one.headers()["x-content-type-options"]).toBe("nosniff");
    const oneText = unfold(await one.text());
    expect(oneText).toContain(`SUMMARY:${title}\r\n`);
    expect(oneText).toContain(`DTSTART:`);
    expect(oneText).toContain("LOCATION:Anaheim High School Gym\r\n");
    const all = await page.request.get("/calendar/export.ics");
    expect(all.status()).toBe(200);
    expect(all.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(all.headers()["content-disposition"]).toBe('attachment; filename="huskyteers-calendar.ics"');
    const allText = await all.text();
    expect(allText.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(unfold(allText)).toContain(`SUMMARY:${title}\r\n`);
    await page.goto("/calendar");
    const fullDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: "Add to my calendar" }).click();
    expect((await fullDownload).suggestedFilename()).toBe("huskyteers-calendar.ics");

    // Signed out, the file isn't there (sent to sign in).
    await page.context().clearCookies();
    const signedOut = await page.request.get("/calendar/export.ics", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(signedOut.status());
    expect(signedOut.headers()["location"]).toContain("/login");

    // The leader edits it…
    await signIn(page, PEOPLE.softwareLeader);
    await page.goto(eventPath);
    await page.getByRole("link", { name: "Edit", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(eventPath)}/edit$`));
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(title);
    await expectNoHorizontalScroll(page);
    await page.getByLabel(/^Location/).fill("Anaheim High School, Room 12");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(eventPath)}\\?saved=1$`));
    await expect(page.getByText("Changes saved.")).toBeVisible();
    await expect(page.getByText("Anaheim High School, Room 12")).toBeVisible();
    await expect(page.getByText(/edited .* by you/)).toBeVisible();

    // …and removes it.
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: `Remove ${title}` }).click();
    await expect(page).toHaveURL(new RegExp(`/calendar\\?month=${month}&removed=`));
    await expect(page.getByText(`Removed ${title} from the calendar.`)).toBeVisible();
    expect(await sql(`SELECT id FROM "CalendarEvent" WHERE title = $1`, [title])).toHaveLength(0);
    expect((await page.goto(eventPath))?.status()).toBe(404);
  });

  test("a manager's day-cell + opens the form with that date; the calendar pages have no sideways scrolling", async ({ page }, info) => {
    // A long title and location, spanning a week boundary, to stress the layout.
    const title = `E2E long ${uniq(info.project.name)} ${"supercalifragilistic ".repeat(4)}`.trim();
    const starts = teamDay(9);
    // Its times are the first day's start and the last day's end (5 PM – 12 PM reads right only with the days).
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "CalendarEvent" (id, title, kind, "startsOn", "endsOn", "startTime", "endTime", location, notes, "createdAt", "updatedAt")
       VALUES ('e2e_' || md5(random()::text), $1, 'ILT', $2::date, $2::date + 3, '17:00', '12:00', $3, $4, now(), now()) RETURNING id`,
      [title, starts, "Somewhere-with-a-very-long-unbroken-venue-name-that-could-overflow-a-phone-screen", "https://example.com/" + "x".repeat(120)],
    );
    try {
      const month = starts.slice(0, 7);
      const pages: Record<string, string[]> = {
        [PEOPLE.buildMember]: ["/calendar", `/calendar?month=${month}`, "/calendar?view=list", "/calendar?view=past", `/calendar/${id}`],
        [PEOPLE.mentor]: [`/calendar?month=${month}&kind=ILT`, "/calendar/new", `/calendar/new?date=${starts}`, `/calendar/${id}`, `/calendar/${id}/edit`],
      };
      for (const [email, paths] of Object.entries(pages)) {
        await signIn(page, email);
        for (const path of paths) {
          const res = await page.goto(path);
          expect(res?.status(), path).toBe(200);
          await expectNoHorizontalScroll(page);
        }
      }

      // A multi-day event with times says when it starts and ends, each with its day.
      await page.goto(`/calendar/${id}`);
      await expect(page.locator("dd").filter({ hasText: /^Starts / })).toContainText("5:00 PM");
      await expect(page.locator("dd").filter({ hasText: /^Ends / })).toContainText("12:00 PM");

      // The "+" in a day cell (wide screens; a mouse shortcut, hidden from keyboards and screen readers) fills in
      // the date; `?date=` does it everywhere.
      await page.goto(`/calendar?month=${month}`);
      await expect(page.getByRole("link", { name: /^Add an event on / })).toHaveCount(0);
      const plus = page.locator('a[href^="/calendar/new?date="]').first();
      if (await plus.isVisible()) {
        await plus.click();
        await expect(page).toHaveURL(/\/calendar\/new\?date=\d{4}-\d{2}-\d{2}$/);
        const picked = new URL(page.url()).searchParams.get("date");
        await expect(page.getByLabel("Date", { exact: true })).toHaveValue(picked ?? "");
      }
      await page.goto(`/calendar/new?date=${starts}`);
      await expect(page.getByLabel("Date", { exact: true })).toHaveValue(starts);
      // A bad date in the address is ignored.
      await page.goto("/calendar/new?date=2026-02-30");
      await expect(page.getByLabel("Date", { exact: true })).toHaveValue("");
      // A bad month or view falls back to this month.
      expect((await page.goto("/calendar?month=nope&view=weird&kind=PARTY"))?.status()).toBe(200);
      await expect(page.getByRole("link", { name: "This month" })).toHaveAttribute("aria-current", "true");
    } finally {
      await sql(`DELETE FROM "CalendarEvent" WHERE id = $1`, [id]);
    }
  });
});
