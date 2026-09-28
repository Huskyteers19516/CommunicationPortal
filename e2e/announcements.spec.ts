import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, openNavIfNeeded, PEOPLE, signIn, sql, uniq } from "./helpers";

// Announcements: leaders, the captain, mentors, and teachers post news for the whole team or one subteam; everyone
// reads all of it. Marcus (Build leader) posts for Build: Ethan (Build member) gets the menu badge, the Today card,
// and "New"; opening Announcements clears the badge. Maya (Software member) sees it under All but not For you.

/** The menu's Announcements link: "Announcements" plus its count bubble (none when nothing is new). */
async function expectAnnouncementsBadge(page: Page, count: number | null) {
  await openNavIfNeeded(page);
  const nav = page.getByRole("navigation", { name: "Main" });
  const link = count === null ? nav.getByRole("link", { name: "Announcements", exact: true }) : nav.getByRole("link", { name: new RegExp(`^Announcements\\s*${count}$`) });
  await expect(link).toBeVisible();
  // Close the phone's menu drawer again.
  if (await page.getByRole("dialog", { name: "Menu" }).isVisible()) await page.keyboard.press("Escape");
}

/**
 * Only announcements posted from a minute ago on are new for these people (the demo's own are "seen"). A minute
 * back, so the test's own post can be dated back too (see below).
 */
async function markAllSeen(emails: string[]) {
  await sql(`UPDATE "User" SET "announcementsSeenAt" = now() - interval '1 minute' WHERE email = ANY($1)`, [emails]);
}

/**
 * Opening the list leaves unread what was posted in the 2 seconds before it loaded (it might still have been
 * saving): date the test's post back half a minute, so the steps after it don't race that.
 */
async function postedAWhileAgo(id: string) {
  await sql(`UPDATE "Announcement" SET "createdAt" = "createdAt" - interval '30 seconds' WHERE id = $1`, [id]);
}

/** The menu's Today link (the phone's menu drawer, or the sidebar). */
async function openTodayFromMenu(page: Page) {
  await openNavIfNeeded(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Today", exact: true }).click();
  await expect(page).toHaveURL(/\/today$/);
}

test.describe("announcements", () => {
  test("a leader posts for Build; Build members see it as new, Software members find it under All only", async ({ page }, info) => {
    const tag = uniq(info.project.name);
    const title = `E2E Build meeting moved to Friday ${tag}`;
    const body = `Same room, 3:30 to 5:30.\nAgenda: https://docs.example.com/agenda-${tag}`;
    await markAllSeen([PEOPLE.buildMember, PEOPLE.softwareMember]);

    // --- Marcus (Build leader) posts it. A missing title keeps what was typed and focuses the field.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/announcements");
    await expectNoHorizontalScroll(page);
    await page.getByRole("link", { name: "Post an announcement" }).first().click();
    await expect(page).toHaveURL(/\/announcements\/new$/);
    // A Build leader posts for the whole team or Build only.
    await expect(page.getByRole("group", { name: "For" }).getByRole("radio")).toHaveCount(2);
    await expect(page.getByRole("radio", { name: /^Whole team/ })).toBeChecked();
    await expectNoHorizontalScroll(page);

    await page.getByLabel("Message").fill(body);
    await page.getByRole("radio", { name: /^Build/ }).check();
    await page.getByRole("button", { name: "Post announcement" }).click();
    await expect(page.locator("#title-error")).toHaveText("Title is required.");
    await expect(page.getByLabel("Title")).toBeFocused();
    await expect(page.getByLabel("Message")).toHaveValue(body);
    await expect(page.getByRole("radio", { name: /^Build/ })).toBeChecked();

    await page.getByLabel("Title").fill(title);
    await page.getByRole("button", { name: "Post announcement" }).click();
    await expect(page).toHaveURL(/\/announcements\?(posted|focus)=/);
    let card = page.getByRole("article", { name: title });
    await expect(card).toBeFocused();
    await expect(card.getByRole("status").filter({ hasText: "Posted." })).toHaveText("Posted. Everyone can read it now.");
    // The address then only says which one to open at (no #hash, no "posted"), and the message stays.
    await expect(page).toHaveURL(/\/announcements\?focus=[^#&]+$/);
    await expect(card.getByRole("status").filter({ hasText: "Posted." })).toBeVisible();
    await expect(card).toContainText("Marcus Johnson (you) · Build Leader");
    await expect(card.getByText("Build", { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: `https://docs.example.com/agenda-${tag}` })).toBeVisible();
    // Their own isn't "New" for them.
    await expect(card.getByText("New", { exact: true })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    const id = (await card.getAttribute("id"))!.replace(/^announcement-/, "");
    const [row] = await sql<{ subteam: string; author: string; pinned: boolean }>(
      `SELECT a.subteam, u.email AS author, a.pinned FROM "Announcement" a JOIN "User" u ON u.id = a."authorId" WHERE a.id = $1`,
      [id],
    );
    expect(row).toEqual({ subteam: "BUILD", author: PEOPLE.buildLeader, pinned: false });
    await postedAWhileAgo(id);
    // A reload doesn't say "Posted." again.
    await page.reload();
    card = page.getByRole("article", { name: title });
    await expect(card).toBeFocused();
    await expect(card.getByRole("status").filter({ hasText: "Posted." })).toHaveCount(0);

    // --- Ethan (Build member): the menu badge and the Today card.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    const todayCard = page.getByRole("region", { name: "New announcement" });
    await expect(todayCard).toBeVisible();
    await expect(todayCard.getByRole("link").filter({ hasText: title })).toContainText("Marcus Johnson");
    await expectNoHorizontalScroll(page);
    await expectAnnouncementsBadge(page, 1);

    // Opening it from Today: the list opens on it, marked New — and the badge clears (the marker stays for this visit).
    await todayCard.getByRole("link").filter({ hasText: title }).click();
    await expect(page).toHaveURL(new RegExp(`/announcements\\?focus=${id}(#announcement-${id})?$`));
    card = page.getByRole("article", { name: title });
    await expect(card).toBeFocused();
    await expect(card.getByText("New", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await sql<{ seen: boolean }>(`SELECT "announcementsSeenAt" IS NOT NULL AND "announcementsSeenAt" > (SELECT "createdAt" FROM "Announcement" WHERE id = $2) AS seen FROM "User" WHERE email = $1`, [PEOPLE.buildMember, id]))[0].seen)
      .toBe(true);
    await expectAnnouncementsBadge(page, null);
    await expect(card.getByText("New", { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Members read; they don't post, edit, pin, or remove.
    await expect(page.getByRole("link", { name: "Post an announcement" })).toHaveCount(0);
    await expect(card.getByRole("link", { name: /^Edit/ })).toHaveCount(0);
    await expect(card.getByRole("button", { name: /^(Pin|Unpin|Remove)/ })).toHaveCount(0);

    // Seen now. The menu's Today opens at the top (after a visit that cleared the badge it used to stay scrolled
    // halfway down), with nothing new on it.
    await openTodayFromMenu(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.getByRole("region", { name: /new announcement/i })).toHaveCount(0);

    const edit = await page.goto(`/announcements/${id}/edit`);
    expect(edit?.status()).toBe(404);
    await page.goto("/announcements/new");
    await expect(page.getByText("Leaders post announcements")).toBeVisible();
    await expect(page.getByRole("button", { name: "Post announcement" })).toHaveCount(0);

    // The list no longer says New.
    await page.goto("/announcements");
    await expect(page.getByRole("article", { name: title }).getByText("New", { exact: true })).toHaveCount(0);

    // --- Maya (Software member): everyone reads everything, but it isn't for her.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/today");
    await expect(page.getByRole("region", { name: /new announcement/i })).toHaveCount(0);
    await expectAnnouncementsBadge(page, null);
    await page.goto("/announcements");
    card = page.getByRole("article", { name: title });
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: /^Edit/ })).toHaveCount(0);
    const chips = page.getByRole("navigation", { name: "Filter announcements" });
    await chips.getByRole("link", { name: "For you" }).click();
    await expect(page).toHaveURL(/\/announcements\?for=you$/);
    await expect(chips.getByRole("link", { name: "For you" })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("article", { name: title })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await chips.getByRole("link", { name: "Build", exact: true }).click();
    await expect(page).toHaveURL(/\/announcements\?for=BUILD$/);
    await expect(page.getByRole("article", { name: title })).toBeVisible();
    await chips.getByRole("link", { name: "Software", exact: true }).click();
    await expect(page.getByRole("article", { name: title })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // --- Marcus edits it ("edited"), pins it, and removes it.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/announcements");
    card = page.getByRole("article", { name: title });
    await card.getByRole("link", { name: `Edit “${title}”` }).click();
    await expect(page).toHaveURL(new RegExp(`/announcements/${id}/edit$`));
    await expect(page.getByLabel("Title")).toHaveValue(title);
    await expect(page.getByRole("radio", { name: /^Build/ })).toBeChecked();
    await expectNoHorizontalScroll(page);
    await page.getByLabel("Message").fill(`${body}\nBring your laptop.`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/announcements\?(saved|focus)=/);
    card = page.getByRole("article", { name: title });
    await expect(card).toBeFocused();
    await expect(card.getByRole("status").filter({ hasText: "Changes saved." })).toBeVisible();
    await expect(card).toContainText("Bring your laptop.");
    await expect(card.getByText("edited", { exact: true })).toBeVisible();

    // The button's name starts with its words (voice control). Pinning replaces "Changes saved." on the card.
    await card.getByRole("button", { name: `Pin to top: “${title}”` }).click();
    await expect(card.getByRole("status").filter({ hasText: "Pinned." })).toBeVisible();
    await expect(card.getByText("Changes saved.")).toHaveCount(0);
    await expect(card.getByText("Pinned", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: `Unpin “${title}”` })).toBeFocused();
    // Pinned ones come first.
    await expect(page.getByRole("article").first()).toHaveAccessibleName(title);
    await expect(card.getByRole("button", { name: `Unpin “${title}”` })).toBeInViewport();

    // Unpinned, it moves down the list: the page follows it, so the button and "Unpinned." stay in view.
    await card.getByRole("button", { name: `Unpin “${title}”` }).click();
    await expect(card.getByRole("status").filter({ hasText: "Unpinned." })).toBeVisible();
    await expect(card.getByText("Pinned", { exact: true })).toHaveCount(0);
    const pinButton = card.getByRole("button", { name: `Pin to top: “${title}”` });
    await expect(pinButton).toBeFocused();
    await expect(pinButton).toBeInViewport();
    await expect(card.getByRole("status").filter({ hasText: "Unpinned." })).toBeInViewport();

    // Someone else pins it while Marcus edits: saving says so, keeps his edit, and shows it pinned (an untouched
    // "Pin to the top" box doesn't quietly unpin it). Saving again keeps both.
    await card.getByRole("link", { name: `Edit “${title}”` }).click();
    await expect(page).toHaveURL(new RegExp(`/announcements/${id}/edit$`));
    await expect(page.getByRole("checkbox", { name: /Pin to the top/ })).not.toBeChecked();
    await sql(`UPDATE "Announcement" SET pinned = true, "updatedAt" = "updatedAt" + interval '1 second' WHERE id = $1`, [id]);
    await page.getByLabel("Message").fill(`${body}\nBring your laptop and charger.`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(":focus")).toContainText("Someone else changed this announcement while you were editing");
    await expect(page.getByRole("checkbox", { name: /Pin to the top/ })).toBeChecked();
    await expect(page.getByLabel("Message")).toHaveValue(`${body}\nBring your laptop and charger.`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/announcements\?(saved|focus)=/);
    card = page.getByRole("article", { name: title });
    await expect(card.getByText("Pinned", { exact: true })).toBeVisible();
    await expect(card).toContainText("Bring your laptop and charger.");

    page.once("dialog", (d) => void d.accept());
    await card.getByRole("button", { name: `Remove “${title}”` }).click();
    await expect(page).toHaveURL(/\/announcements\?removed=1$/);
    await expect(page.getByRole("status").filter({ hasText: "Announcement removed." })).toBeVisible();
    await expect(page.getByRole("article", { name: title })).toHaveCount(0);
    expect(await sql(`SELECT id FROM "Announcement" WHERE id = $1`, [id])).toEqual([]);
  });

  test("every announcements page fits a 375 px phone without sideways scrolling", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const title = `E2E captain's long-word check ${"Supercalifragilistic".repeat(3)} ${uniq(info.project.name)}`;

    // The captain posts for anyone: four choices.
    await signIn(page, PEOPLE.admin);
    await page.goto("/announcements/new?for=BUSINESS");
    await expect(page.getByRole("group", { name: "For" }).getByRole("radio")).toHaveCount(4);
    await expect(page.getByRole("radio", { name: /^Business/ })).toBeChecked();
    await expectNoHorizontalScroll(page);
    await page.getByRole("radio", { name: /^Whole team/ }).check();
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Message").fill(`${"Wordwordwordword".repeat(8)}\nhttps://example.com/${"x".repeat(90)}\n${"Line\n".repeat(14)}The end.`);
    await page.getByText("Pin to the top").click();
    await page.getByRole("button", { name: "Post announcement" }).click();
    await expect(page).toHaveURL(/\/announcements\?(posted|focus)=/);
    const card = page.getByRole("article", { name: title });
    await expect(card).toContainText("Jordan Lee (you) · Captain");
    await expect(card.getByText("Whole team", { exact: true })).toBeVisible();
    await expect(card.getByText("Pinned", { exact: true })).toBeVisible();
    // A long text is folded: "Show more" opens the rest.
    await expect(card.getByRole("button", { name: "Show more" })).toHaveAttribute("aria-expanded", "false");
    await card.getByRole("button", { name: "Show more" }).click();
    await expect(card.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    await expectNoHorizontalScroll(page);

    for (const path of ["/announcements", "/announcements?for=you", "/announcements?for=team", "/announcements?for=BUILD", "/announcements?page=2", "/announcements/new"]) {
      await page.goto(path);
      await expectNoHorizontalScroll(page);
    }
    await page.goto("/announcements");
    await page.getByRole("article", { name: title }).getByRole("link", { name: /^Edit/ }).click();
    await expect(page).toHaveURL(/\/announcements\/[^/]+\/edit$/);
    await expectNoHorizontalScroll(page);
    const id = page.url().match(/\/announcements\/([^/]+)\/edit$/)![1];

    // Someone removes it while the captain edits: saving says so and keeps what they typed (no 404 page).
    await page.getByLabel("Message").fill("A last-minute change");
    await sql(`DELETE FROM "Announcement" WHERE id = $1`, [id]);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(":focus")).toContainText("That announcement was removed.");
    await expect(page).toHaveURL(new RegExp(`/announcements/${id}/edit$`));
    await expect(page.getByLabel("Message")).toHaveValue("A last-minute change");
    await expectNoHorizontalScroll(page);

    // Removing it from its edit page anyway: it's gone, back to the list.
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: /^Remove/ }).click();
    await expect(page).toHaveURL(/\/announcements\?removed=1$/);
    await expect(page.getByRole("status").filter({ hasText: "Announcement removed." })).toBeVisible();
    await expect(page.getByRole("article", { name: title })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});
