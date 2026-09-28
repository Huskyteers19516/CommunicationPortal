import { expect, type Locator, type Page, test } from "@playwright/test";
import { E2E_PORT } from "../playwright.config";
import { currentCodes } from "../src/server/attendance/codes";
import { weekOf, weekProgressText } from "../src/lib/attendance";
import { addDays, todayInTimezone } from "../src/lib/dates";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

// Regular meetings are on Monday, Tuesday, and Thursday (Flex on Tuesday and Thursday); other days are meeting days
// only when there's an extra meeting on the Team calendar (the demo has one next Saturday: "Extra build day").

/**
 * "YYYY-MM-DD", `days` from today in the team timezone: counted on the date itself (not in 24-hour steps, which slip
 * a day across a daylight-saving change).
 */
function teamDay(days = 0): string {
  return addDays(todayInTimezone("America/Los_Angeles"), days);
}

/** The next Sunday after today (1–7 days ahead), `weeks` weeks later: never a regular meeting day. */
function nextSunday(weeks = 0): string {
  const today = teamDay();
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, ((7 - weekday) % 7 || 7) + weeks * 7);
}

/** A day card's label, "Sun, Oct 4" (the year only when it isn't this year). */
function dayLabel(date: string): string {
  const sameYear = date.slice(0, 4) === teamDay().slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(`${date}T00:00:00Z`));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Open "Show N more days" under Coming? when it's there, so every upcoming day is listed. */
async function showAllDays(page: Page) {
  const more = page.getByText(/^Show \d+ more days$/);
  if (await more.isVisible()) await more.click();
}

/** Tap an answer so it ends up chosen (tapping the chosen one clears it, so clear it first if needed). */
async function choose(group: Locator, name: string) {
  const button = group.getByRole("button", { name, exact: true });
  if ((await button.getAttribute("aria-pressed")) === "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
  }
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toBeFocused();
}

/** The business leader starts (or goes back to) today's Regular attendance; returns its live screen's URL. */
async function openRegular(page: Page): Promise<string> {
  // On a day without a meeting (a Wednesday, Friday, or weekend run), Start asks first.
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await page.goto("/attendance");
  const show = page.getByRole("link", { name: "Show Regular code" });
  if (await show.isVisible()) await show.click();
  else await page.getByRole("button", { name: /^(Start Regular attendance|Reopen Regular)$/ }).click();
  await expect(page).toHaveURL(/\/attendance\/sessions\/[a-z0-9]+$/);
  return page.url();
}

test.describe("attendance", () => {
  test("a business leader starts attendance; a member types the code and shows up on the roster", async ({ page, browser }, info) => {
    const member = info.project.name === "mobile" ? { email: PEOPLE.softwareMember, name: "Maya Patel" } : { email: PEOPLE.buildMember, name: "Ethan Chen" };

    await signIn(page, PEOPLE.businessLeader);
    const sessionUrl = await openRegular(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Regular attendance");
    await expect(page.getByRole("img", { name: "QR code for checking in" })).toBeVisible();
    // The projector's code comes first: Full screen is on screen without scrolling (the no-show list is folded below).
    await expect(page.getByRole("button", { name: "Full screen" })).toBeInViewport();
    const codeText = (await page.getByTestId("attendance-code").textContent()) ?? "";
    const code = codeText.replace(/\s/g, "");
    expect(code).toMatch(/^\d{6}$/);
    await expectNoHorizontalScroll(page);

    // The member, on a phone-sized screen in their own browser, types the code.
    const phone = await browser.newContext({ baseURL: `http://localhost:${E2E_PORT}`, viewport: { width: 375, height: 812 } });
    const memberPage = await phone.newPage();
    await signIn(memberPage, member.email);
    await memberPage.goto("/attendance");
    await expectNoHorizontalScroll(memberPage);
    await memberPage.getByRole("button", { name: "Enter code" }).click();
    const input = memberPage.getByLabel("Code on the screen");
    await expect(input).toBeFocused();

    // A wrong code keeps what was typed and says so.
    const wrong = code === "000000" ? "111111" : "000000";
    await input.fill(wrong);
    await memberPage.getByRole("button", { name: "Check in" }).click();
    await expect(memberPage.getByText("That code didn't work. Check the screen and try again.")).toBeVisible();
    await expect(input).toHaveValue(wrong);
    await expect(input).toBeFocused();

    await input.fill(code);
    await memberPage.getByRole("button", { name: "Check in" }).click();
    // The buttons make way for "You're checked in ✓", which takes focus.
    const done = memberPage.getByRole("status").filter({ hasText: /You're (already )?checked in/ }).first();
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
    await expect(memberPage.getByRole("button", { name: "Enter code" })).toHaveCount(0);
    await expectNoHorizontalScroll(memberPage);

    // The live screen refreshes on its own and lists them.
    await expect(page.getByRole("list", { name: "On the list" })).toContainText(member.name, { timeout: 25_000 });

    // Members can't open the runner's screen or the planner.
    const res = await memberPage.goto(sessionUrl);
    expect(res?.status()).toBe(404);
    await memberPage.goto("/attendance/plan");
    await expect(memberPage).toHaveURL(/\/attendance$/);
    await phone.close();
  });

  test("scanning the QR code on a phone checks a member in (not \"already\"), with focus on the result", async ({ page, browser }, info) => {
    // Someone no other test checks in (a different one per project, since both run against the same database).
    const email = info.project.name === "mobile" ? "grace.liu@example.com" : "isabella.rossi@example.com";
    await signIn(page, PEOPLE.businessLeader);
    const sessionUrl = await openRegular(page);
    const id = sessionUrl.split("/").pop() ?? "";
    const [row] = await sql<{ secret: string }>(`SELECT secret FROM "AttendanceSession" WHERE id = $1`, [id]);
    // The same link the QR code on the screen holds right now.
    const scanPath = `/attendance/scan/${currentCodes(row.secret, id, new Date()).token}`;

    const phone = await browser.newContext({ baseURL: `http://localhost:${E2E_PORT}`, viewport: { width: 375, height: 812 } });
    const memberPage = await phone.newPage();
    await signIn(memberPage, email);
    await memberPage.goto(scanPath);
    const result = memberPage.getByRole("status").filter({ hasText: "You're checked in for Regular ✓" });
    await expect(result).toBeVisible();
    await expect(memberPage.locator(":focus")).toContainText("You're checked in for Regular ✓");
    await expect(memberPage.getByText("You're already checked in ✓")).toHaveCount(0);
    // At Regular it counts as 1: nothing to pick.
    await expect(memberPage.getByText(/^Regular counts as 1\b/)).toBeVisible();
    await expect(memberPage.getByRole("radio")).toHaveCount(0);
    await expect(memberPage.locator(":focus")).toContainText("You're checked in for Regular ✓");
    await expectNoHorizontalScroll(memberPage);

    // Opening the link again says so, without checking in twice.
    await memberPage.reload();
    await expect(memberPage.getByRole("status").filter({ hasText: "You're already checked in ✓" })).toBeVisible();
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "AttendanceRecord" r JOIN "User" u ON u.id = r."userId" WHERE r."sessionId" = $1 AND u.email = $2`,
      [id, email],
    );
    expect(n).toBe(1);
    await phone.close();
  });

  test("a member's check-in counts as 1 (no picker); a build leader changes it but can't give EC; the Business leader gives 1 EC; the change log shows both", async ({
    page,
    browser,
  }, info) => {
    // Someone no other test checks in (one per project: both run against the same database).
    const member =
      info.project.name === "mobile"
        ? { email: "zara.ahmed@example.com", name: "Zara Ahmed" }
        : { email: "liam.oconnor@example.com", name: "Liam O'Connor" };
    await signIn(page, PEOPLE.businessLeader);
    const sessionUrl = await openRegular(page);
    const id = sessionUrl.split("/").pop() ?? "";
    const code = ((await page.getByTestId("attendance-code").textContent()) ?? "").replace(/\s/g, "");
    // A retry starts from a fresh check-in (no leftover credit or changes from an earlier try).
    await sql(`DELETE FROM "AttendanceRecord" WHERE "sessionId" = $1 AND "userId" = (SELECT id FROM "User" WHERE email = $2)`, [id, member.email]);
    await sql(`DELETE FROM "AttendanceChange" WHERE "sessionId" = $1 AND "userId" = (SELECT id FROM "User" WHERE email = $2)`, [id, member.email]);
    // What they already have this week (Mon–Sun) from the demo's check-ins, in sixths.
    const week = weekOf(teamDay());
    const [{ before }] = await sql<{ before: number }>(
      `SELECT coalesce(sum(r.credit), 0)::int AS before FROM "AttendanceRecord" r
         JOIN "AttendanceSession" s ON s.id = r."sessionId" JOIN "User" u ON u.id = r."userId"
        WHERE u.email = $1 AND s.date BETWEEN $2::date AND $3::date AND s.id <> $4`,
      [member.email, week.start, week.end, id],
    );

    // The member types the code on their phone: it counts as 1, with nothing to pick, and the week adds it up.
    const phone = await browser.newContext({ baseURL: `http://localhost:${E2E_PORT}`, viewport: { width: 375, height: 812 } });
    const memberPage = await phone.newPage();
    await signIn(memberPage, member.email);
    await memberPage.goto("/attendance");
    await memberPage.getByRole("button", { name: "Enter code" }).click();
    await memberPage.getByLabel("Code on the screen").fill(code);
    await memberPage.getByRole("button", { name: "Check in" }).click();
    await expect(memberPage.getByText(/^Regular counts as 1\b/)).toBeVisible();
    await expect(memberPage.getByRole("group", { name: /How long/ })).toHaveCount(0);
    await expect(memberPage.getByRole("radio")).toHaveCount(0);
    await expect(memberPage.getByText(`${weekProgressText(before + 6, 2)} this week`).first()).toBeVisible();
    await expectNoHorizontalScroll(memberPage);
    const credit = async () =>
      (
        await sql<{ credit: number; creditKind: string; by: string | null }>(
          `SELECT r.credit, r."creditKind", c.email AS by FROM "AttendanceRecord" r JOIN "User" u ON u.id = r."userId"
             LEFT JOIN "User" c ON c.id = r."creditChangedById" WHERE r."sessionId" = $1 AND u.email = $2`,
          [id, member.email],
        )
      )[0];
    expect(await credit()).toEqual({ credit: 6, creditKind: "REGULAR", by: null });

    // A Build leader (admin access, doesn't run attendance) opens the session: no QR code, but they fix credits —
    // only the ones they may give (no EC).
    const leaderContext = await browser.newContext({
      baseURL: `http://localhost:${E2E_PORT}`,
      viewport: info.project.name === "mobile" ? { width: 375, height: 812 } : undefined,
    });
    const leaderPage = await leaderContext.newPage();
    await signIn(leaderPage, PEOPLE.buildLeader);
    await leaderPage.goto(sessionUrl);
    await expect(leaderPage.getByRole("heading", { level: 1 })).toHaveText("Regular attendance");
    await expect(leaderPage.getByRole("img", { name: "QR code for checking in" })).toHaveCount(0);
    await expect(leaderPage.getByRole("button", { name: "Close attendance" })).toHaveCount(0);
    const leaderMenu = leaderPage.getByRole("combobox", { name: `Credit for ${member.name}` });
    await expect(leaderMenu).toHaveValue("1");
    await expect(leaderMenu.locator("option")).toHaveText(["1", "2/3", "1/2", "1/3", "No credit"]);
    // A tap on the menu focuses it (selectOption alone doesn't), and it keeps focus after the save.
    await leaderMenu.focus();
    await leaderMenu.selectOption("1/2");
    await expect(leaderPage.getByRole("status").filter({ hasText: `${member.name}: 1/2.` })).toBeVisible();
    await expect(leaderMenu).toBeFocused();
    const leaderRow = leaderPage.getByRole("list", { name: "On the list" }).getByRole("listitem").filter({ hasText: member.name });
    await expect(leaderRow.getByText("Credit changed by Marcus Johnson")).toBeVisible();
    await expectNoHorizontalScroll(leaderPage);
    expect(await credit()).toEqual({ credit: 3, creditKind: "REGULAR", by: PEOPLE.buildLeader });

    // The Business leader sees it on the live screen (it refreshes on its own) and gives 1 EC.
    const menu = page.getByRole("combobox", { name: `Credit for ${member.name}` });
    await expect(menu).toHaveValue("1/2", { timeout: 25_000 });
    await expect(menu.locator("option")).toHaveText(["1", "2/3", "1/2", "1/3", "1/2 EC", "1 EC", "No credit"]);
    await menu.selectOption("1ec");
    await expect(page.getByRole("status").filter({ hasText: `${member.name}: 1 EC.` })).toBeVisible();
    const row = page.getByRole("list", { name: "On the list" }).getByRole("listitem").filter({ hasText: member.name });
    await expect(row.getByText("Credit changed by Amara Okafor")).toBeVisible();
    await expect(row.getByText(weekProgressText(before + 6, 2))).toBeVisible();
    await expectNoHorizontalScroll(page);
    expect(await credit()).toEqual({ credit: 6, creditKind: "EXTRA", by: PEOPLE.businessLeader });

    // On the Build leader's (now stale) page, 1 EC shows but isn't offered.
    await leaderPage.reload();
    await expect(leaderMenu).toHaveValue("1ec");
    await expect(leaderMenu.locator("option:not([disabled])")).toHaveText(["1", "2/3", "1/2", "1/3", "No credit"]);

    // The change log shows both, as sentences — and the session's History too.
    const day = dayLabel(teamDay());
    await leaderPage.goto("/attendance/changes");
    await expect(leaderPage.getByRole("heading", { level: 1 })).toHaveText("Attendance changes");
    await leaderPage.getByRole("combobox", { name: "Person" }).selectOption({ label: member.name });
    await expect(leaderPage).toHaveURL(/person=/);
    // Only the filters that are set go in the address, and focus lands on the result.
    await expect(leaderPage).not.toHaveURL(/by=|action=|from=|to=/);
    await expect(leaderPage.getByRole("status").filter({ hasText: /changes? match/ })).toBeFocused();
    await expect(leaderPage.getByLabel("Changed by")).toHaveValue("");
    const log = leaderPage.getByRole("list", { name: "Attendance changes" });
    await expect(log.getByText(`Amara Okafor changed ${member.name}'s Regular · ${day} from 1/2 to 1 EC`)).toBeVisible();
    await expect(log.getByText(`Marcus Johnson changed ${member.name}'s Regular · ${day} from 1 to 1/2`)).toBeVisible();
    await expect(leaderPage.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", /^\/attendance\/changes\/csv\?person=/);
    await expectNoHorizontalScroll(leaderPage);
    await expect(page.getByRole("list", { name: "History" })).toContainText(`Marcus Johnson changed ${member.name}'s Regular`, { timeout: 25_000 });
    await leaderContext.close();

    // Now it's the admins' call: the member sees who set it, and their week. Members never see the change log.
    await memberPage.reload();
    await expect(memberPage.getByText(/Regular counts as 1 EC \(Amara Okafor set it\)/)).toBeVisible();
    await expect(memberPage.getByText(`${weekProgressText(before + 6, 2)} this week`).first()).toBeVisible();
    await expectNoHorizontalScroll(memberPage);
    await expect(memberPage.getByRole("link", { name: "Changes" })).toHaveCount(0);
    expect((await memberPage.goto("/attendance/changes"))?.status()).toBe(404);
    expect((await memberPage.goto("/attendance/changes/csv"))?.status()).toBe(404);
    await phone.close();
  });

  test("someone who said they'd come isn't here: the admin sees it on Today and the live screen, gives 1/2 by hand (with Undo); scanning in later counts as 1", async ({
    page,
    browser,
  }, info) => {
    // Someone no other test uses (one per project).
    const person =
      info.project.name === "mobile"
        ? { email: "leila.hosseini@example.com", name: "Leila Hosseini" }
        : { email: "daniel.park@example.com", name: "Daniel Park" };
    await signIn(page, PEOPLE.businessLeader);
    const sessionUrl = await openRegular(page);
    const id = sessionUrl.split("/").pop() ?? "";
    // They said Yes for today and aren't on the list (a retry starts clean).
    await sql(`DELETE FROM "AttendanceRecord" WHERE "sessionId" = $1 AND "userId" = (SELECT id FROM "User" WHERE email = $2)`, [id, person.email]);
    await sql(`DELETE FROM "AttendanceChange" WHERE "sessionId" = $1 AND "userId" = (SELECT id FROM "User" WHERE email = $2)`, [id, person.email]);
    await sql(
      `INSERT INTO "AttendanceRsvp" (id, "userId", date, regular, note, "createdAt", "updatedAt")
         SELECT 'e2e-' || md5(random()::text), id, $2::date, 'YES', '', now(), now() FROM "User" WHERE email = $1
       ON CONFLICT ("userId", date) DO UPDATE SET regular = 'YES'`,
      [person.email, teamDay()],
    );

    // Today (admins) lists them, folded while attendance is open, with quick actions and a link to the session.
    await page.goto("/today");
    const card = page.getByRole("region", { name: /Regular: said they'd come/ });
    await card.getByRole("button", { name: "Show list" }).click();
    await expect(card.getByText(person.name, { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "Open Regular" })).toHaveAttribute("href", `/attendance/sessions/${id}`);
    // The Business leader started it: never listed as a no-show, even on their own Today.
    await expect(card.getByText("Amara Okafor", { exact: true })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // The live screen has them folded under the counts; 1/2 puts them on the list by hand, and Undo takes it back.
    await page.goto(sessionUrl);
    const noShows = page.getByRole("region", { name: /Said they'd come — not checked in yet/ });
    await noShows.getByRole("button", { name: "Show list" }).click();
    await expect(noShows.getByText(person.name, { exact: true })).toBeVisible();
    await expect(noShows.getByRole("button", { name: `Give ${person.name} 1`, exact: true })).toHaveCount(0);
    await noShows.getByRole("button", { name: `Give ${person.name} 1/2`, exact: true }).click();
    await expect(noShows.getByRole("status")).toHaveText(`Added ${person.name} (1/2).`);
    await expect(noShows.getByText(person.name, { exact: true })).toHaveCount(0);
    await expect(page.locator(":focus")).toBeVisible();
    await noShows.getByRole("button", { name: `Undo: ${person.name}` }).click();
    await expect(noShows.getByRole("status")).toHaveText(`Undone: ${person.name} is back on the list.`);
    await expect(noShows.getByRole("button", { name: `Give ${person.name} 2/3`, exact: true })).toBeFocused();
    await noShows.getByRole("button", { name: `Give ${person.name} 1/2`, exact: true }).click();
    await expect(noShows.getByRole("status")).toHaveText(`Added ${person.name} (1/2).`);
    const menu = page.getByRole("combobox", { name: `Credit for ${person.name}` });
    await expect(menu).toHaveValue("1/2");
    // Added by hand: never 1 or Flex (that needs a scan).
    await expect(menu.locator("option")).toHaveText(["2/3", "1/2", "1/3", "1/2 EC", "1 EC", "No credit"]);
    await expectNoHorizontalScroll(page);
    const record = async () =>
      (
        await sql<{ method: string; credit: number }>(
          `SELECT r.method, r.credit FROM "AttendanceRecord" r JOIN "User" u ON u.id = r."userId" WHERE r."sessionId" = $1 AND u.email = $2`,
          [id, person.email],
        )
      )[0];
    expect(await record()).toEqual({ method: "MANUAL", credit: 3 });
    const [{ n }] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM "AttendanceChange" c JOIN "User" u ON u.id = c."userId"
        WHERE c."sessionId" = $1 AND u.email = $2 AND c.action = 'ADDED' AND c."toCredit" = 3`,
      [id, person.email],
    );
    expect(n).toBe(2);
    await expect(page.getByRole("list", { name: "History" })).toContainText(`Amara Okafor added ${person.name} to Regular`);

    // They get there after all: their card says who added them and to scan, and the code makes it a real check-in (1).
    const code = ((await page.getByTestId("attendance-code").textContent()) ?? "").replace(/\s/g, "");
    const phone = await browser.newContext({ baseURL: `http://localhost:${E2E_PORT}`, viewport: { width: 375, height: 812 } });
    const personPage = await phone.newPage();
    await signIn(personPage, person.email);
    await personPage.goto("/attendance");
    await expect(personPage.getByText(/Amara Okafor added you by hand as 1\/2\. If you're here now, scan the code/)).toBeVisible();
    await personPage.getByRole("button", { name: "Enter code" }).click();
    await personPage.getByLabel("Code on the screen").fill(code);
    await personPage.getByRole("button", { name: "Check in" }).click();
    await expect(personPage.getByRole("status").filter({ hasText: "You're checked in for Regular ✓" }).first()).toBeVisible();
    await expectNoHorizontalScroll(personPage);
    expect(await record()).toEqual({ method: "CODE", credit: 6 });
    await expect(page.getByRole("list", { name: "History" })).toContainText(`${person.name} scanned in to Regular`, { timeout: 25_000 });
    await phone.close();
  });

  test("a failed schedule save keeps the picked days", async ({ page }) => {
    await signIn(page, PEOPLE.businessLeader);
    await page.goto("/attendance/settings");
    // The regular days, and the extra meetings coming up (from the Team calendar), with a way to add one.
    await expect(page.getByText(/^Regular meetings: Mon, Tue, Thu · Flex: Tue, Thu$/)).toBeVisible();
    const extras = page.getByRole("list", { name: "Upcoming extra meetings" });
    await expect(extras.getByRole("link").filter({ hasText: "Extra build day" })).toHaveAttribute("href", /^\/calendar\/[a-z0-9]+$/);
    await expect(page.getByRole("link", { name: "Add an extra meeting" })).toHaveAttribute("href", "/calendar/new?kind=MEETING&from=schedule");
    await expectNoHorizontalScroll(page);
    const regular = page.getByRole("group", { name: /Regular meetings/ });
    const wednesday = regular.getByRole("checkbox", { name: "Wednesday" });
    const wasChecked = await wednesday.isChecked();
    await wednesday.setChecked(!wasChecked);
    // A Tuesday isn't allowed, so nothing is saved.
    await page.getByLabel("Reports start").fill("2026-09-29");
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByText(/Pick a Monday/).first()).toBeVisible();
    await expect(page.getByLabel("Reports start")).toBeFocused();
    await expect(wednesday).toBeChecked({ checked: !wasChecked });
  });

  test("a member answers Coming? with Yes / Half / No, and Attend Flex? on a Tuesday or Thursday", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, info.project.name === "mobile" ? PEOPLE.businessMember : PEOPLE.softwareMember);
    await page.goto("/attendance");

    // The next Flex day in the list (Tuesdays and Thursdays).
    const day = page
      .getByRole("list", { name: "Upcoming team days" })
      .getByRole("article")
      .filter({ has: page.getByRole("group", { name: "Attend Flex?" }) })
      .first();
    await expect(day).toBeVisible();
    await expect(day.getByText("Flex day")).toBeVisible();
    const coming = day.getByRole("group", { name: "Coming?" });
    const status = day.getByRole("status");

    await choose(coming, "Yes");
    await expect(status).toHaveText("Saved: Yes.");
    await choose(coming, "Half");
    await expect(status).toHaveText("Saved: Half.");
    await choose(coming, "No");
    await expect(status).toHaveText("Saved: No.");
    await choose(day.getByRole("group", { name: "Attend Flex?" }), "Yes");
    await expect(status).toHaveText("Saved: Flex Yes.");
    // Flex has no "Half".
    await expect(day.getByRole("group", { name: "Attend Flex?" }).getByRole("button", { name: "Half" })).toHaveCount(0);

    // A short note.
    await day.getByRole("button", { name: /^(Add|Edit) (a )?note for/ }).click();
    await day.getByRole("textbox").fill("Leaving at 5");
    await day.getByRole("button", { name: "Save note" }).click();
    await expect(status).toHaveText("Note saved.");
    await expect(day.getByText("Leaving at 5")).toBeVisible();
    await expect(day.getByRole("button", { name: /^Edit note for/ })).toBeFocused();
    await expectNoHorizontalScroll(page);

    // Saved for real.
    await page.reload();
    const again = page
      .getByRole("list", { name: "Upcoming team days" })
      .getByRole("article")
      .filter({ has: page.getByRole("group", { name: "Attend Flex?" }) })
      .first();
    await expect(again.getByRole("group", { name: "Coming?" }).getByRole("button", { name: "No", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(again.getByRole("group", { name: "Attend Flex?" }).getByRole("button", { name: "Yes", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("a leader adds an extra meeting on the calendar; a member is asked Coming? for that day, until it's removed", async ({ page }, info) => {
    const title = `E2E extra meeting ${uniq(info.project.name)}`;
    const titleRe = new RegExp(escapeRegExp(title));
    // A Sunday (never a regular meeting day); desktop and mobile each use their own.
    const date = nextSunday(info.project.name === "mobile" ? 1 : 0);
    const label = dayLabel(date);

    try {
      // The Build leader goes from Who's coming to the calendar form, which opens on "Extra meeting" and explains it.
      await signIn(page, PEOPLE.buildLeader);
      await page.goto("/attendance/plan");
      await page.getByRole("link", { name: "Add an extra meeting" }).click();
      await expect(page).toHaveURL(/\/calendar\/new\?kind=MEETING&from=plan$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add an event");
      await expect(page.getByRole("link", { name: "Who's coming", exact: true })).toHaveAttribute("href", "/attendance/plan");
      await expect(page.getByRole("radio", { name: /Extra meeting/ })).toBeChecked();
      await expect(page.getByLabel("Title", { exact: true })).toHaveAttribute("placeholder", "e.g. Extra build day");
      const note = page.getByText(/everyone's asked “Coming\?” in Attendance/);
      await expect(note).toBeVisible();
      await expectNoHorizontalScroll(page);
      // The note and the example follow the kind that's picked.
      await page.getByRole("radio", { name: /Outreach/ }).check();
      await expect(note).toHaveCount(0);
      await expect(page.getByLabel("Title", { exact: true })).toHaveAttribute("placeholder", "e.g. League Meet 2");
      await page.getByRole("radio", { name: /Extra meeting/ }).check();
      await expect(note).toBeVisible();
      await page.getByLabel("Title", { exact: true }).fill(title);
      await page.getByLabel("Date", { exact: true }).fill(date);
      await page.getByLabel(/^Start time/).fill("10:00");
      await page.getByLabel(/^End time/).fill("14:00");
      await page.getByRole("button", { name: "Add event" }).click();
      await expect(page).toHaveURL(/\/calendar\/[a-z0-9]+\?added=1&from=plan$/);
      await expect(page.getByText(/counts as a meeting day in Attendance/)).toBeVisible();
      const eventPath = new URL(page.url()).pathname;
      const [row] = await sql<{ kind: string; startsOn: string }>(`SELECT kind, "startsOn"::text AS "startsOn" FROM "CalendarEvent" WHERE title = $1`, [title]);
      expect(row).toEqual({ kind: "MEETING", startsOn: date });

      // Back to Who's coming on that day, which lists it, marked as an extra meeting.
      await expect(page.getByRole("link", { name: "See who's coming" })).toHaveAttribute("href", `/attendance/plan?day=${date}`);
      await page.getByRole("link", { name: "Who's coming", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/attendance/plan\\?day=${date}$`));
      await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: titleRe })).toHaveAttribute("href", eventPath);
      await expect(page.getByRole("navigation", { name: "Pick a day" }).locator('[aria-current="page"]')).toBeInViewport();
      await expectNoHorizontalScroll(page);

      // A member opens it from the event's page: "Say if you're coming" goes straight to that day under Coming?
      // (Yes / Half / No; no Flex on a Sunday), without opening "Show more days".
      await signIn(page, PEOPLE.buildMember);
      await page.goto(eventPath);
      await expect(page.getByRole("link", { name: "See who's coming" })).toHaveCount(0);
      await page.getByRole("link", { name: "Say if you're coming" }).click();
      await expect(page).toHaveURL(new RegExp(`/attendance\\?day=${date}#day-${date}$`));
      const day = page.getByRole("article", { name: label, exact: true });
      await expect(day).toBeVisible();
      await expect(day.getByText("Extra meeting", { exact: true })).toBeVisible();
      await expect(day.getByRole("link", { name: titleRe })).toHaveAttribute("href", eventPath);
      await expect(day.getByRole("group", { name: "Attend Flex?" })).toHaveCount(0);
      await choose(day.getByRole("group", { name: "Coming?" }), "Yes");
      await expect(day.getByRole("status")).toHaveText("Saved: Yes.");
      await expectNoHorizontalScroll(page);

      // Removed from the calendar: the day comes off Coming? (the answer already given stays saved).
      await signIn(page, PEOPLE.buildLeader);
      await page.goto(eventPath);
      page.once("dialog", (d) => void d.accept());
      await page.getByRole("button", { name: `Remove ${title}` }).click();
      await expect(page.getByText(`Removed ${title} from the calendar.`)).toBeVisible();
      await signIn(page, PEOPLE.buildMember);
      await page.goto("/attendance");
      await showAllDays(page);
      await expect(page.getByRole("list", { name: "Upcoming team days" })).toBeVisible();
      await expect(page.getByRole("article", { name: label, exact: true })).toHaveCount(0);
      const [{ n }] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM "AttendanceRsvp" r JOIN "User" u ON u.id = r."userId" WHERE r.date = $1::date AND u.email = $2`,
        [date, PEOPLE.buildMember],
      );
      expect(n).toBe(1);
    } finally {
      // A failed run doesn't leave its meeting behind (it would keep the Sunday listed on a retry).
      await sql(`DELETE FROM "CalendarEvent" WHERE title = $1`, [title]);
    }
  });

  test("the in-app scanner explains when there's no camera, and offers the code instead", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    // Someone no other test checks in (the first test checks in Ethan on desktop and Maya on mobile).
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/attendance");
    await page.getByRole("button", { name: "Scan QR code" }).click();
    const problem = page.getByRole("alert").filter({ hasText: /camera/i });
    await expect(problem).toBeVisible();
    await expect(problem).toContainText(/type the code/i);
    await page.getByRole("button", { name: "Type the code instead" }).click();
    await expect(page.getByLabel("Code on the screen")).toBeFocused();
    await expectNoHorizontalScroll(page);
  });

  test("staff see who's coming and the two-week reports", async ({ page }) => {
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/attendance/plan");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Who's coming");
    await expect(page.getByRole("navigation", { name: "Pick a day" })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto("/attendance/reports");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Two-week reports");
    await page.locator('a[href^="/attendance/reports/"]').first().click();
    await expect(page.getByRole("heading", { name: "When attendance was taken" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download CSV" })).toHaveAttribute("href", /\/csv$/);
    // Each person's two weeks toward the weekly goal.
    await expect(page.getByText(/^Week 1\b/).filter({ visible: true }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
