import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, openNavIfNeeded, PEOPLE, signIn, uniq } from "./helpers";

// Discussion (/discussion): the team-wide forum. Everyone starts discussions and replies; the nav badge counts
// discussions with something new from someone else; opening one marks it read (after the page is open) and shows
// a "New" divider before the replies since last time; people with admin access pin and lock.

/** The number on the menu's Discussion link (0 when there's no bubble). */
async function discussionBadge(page: Page): Promise<number> {
  await openNavIfNeeded(page);
  const link = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Discussion/ });
  const text = await link.innerText();
  const close = page.getByRole("button", { name: "Close menu" });
  if (await close.isVisible()) await close.click();
  return Number(text.replace(/\D/g, "") || 0);
}

test.describe("discussion", () => {
  test("a member starts one, another replies, the badge and New divider show then clear, a leader pins and locks", async ({ page }, info) => {
    // The menu (with its badge) is a sidebar from 1024 px; phones get the 375 px checks at the end.
    await page.setViewportSize({ width: 1280, height: 900 });
    const id = uniq(info.project.name);
    const title = `Swerve or tank drive? ${id}`;
    // A long unbroken link must wrap on phones.
    const body = `Let's decide before the scrimmage. Notes: https://example.com/${"drive-notes-".repeat(12)}end`;

    // Maya starts a discussion.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/today");
    const before = await discussionBadge(page);
    await page.goto("/discussion");
    await expect(page.getByRole("heading", { level: 1, name: "Discussion" })).toBeVisible();
    await page.getByRole("link", { name: "Start a discussion" }).click();
    await expect(page).toHaveURL(/\/discussion\/new$/);
    // Nothing typed: the first field to fix gets focus.
    await page.getByRole("button", { name: "Post discussion" }).click();
    await expect(page.getByLabel("Title")).toBeFocused();
    await expect(page.getByText("Title is required.")).toBeVisible();
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Category").selectOption("SOFTWARE");
    // Only the text missing: its error shows once, under the box (not again in a message box).
    await page.getByRole("button", { name: "Post discussion" }).click();
    await expect(page.getByLabel("What do you want to talk about?")).toBeFocused();
    await expect(page.getByText("Write a few words to get the discussion going.")).toHaveCount(1);
    await page.getByLabel("What do you want to talk about?").fill(body);
    await page.getByRole("button", { name: "Post discussion" }).click();
    await expect(page).toHaveURL(/\/discussion\/[^/?]+\?started=1$/);
    const threadUrl = new URL(page.url()).pathname;
    await expect(page.getByText("Your discussion is up.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    // Her own discussion isn't news to her.
    expect(await discussionBadge(page)).toBe(before);

    // Ethan sees it as new, opens it, and replies; members get no pin or lock buttons.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/discussion");
    const card = page.getByRole("main").getByRole("listitem").filter({ hasText: title });
    await expect(card).toContainText("New discussion");
    await expect(card).toContainText("Software");
    await expect(card).toContainText("Started by Maya Patel");
    // Screen readers hear what's new with the title (the link's name).
    await expect(card.getByRole("link", { name: `${title} (New discussion)` })).toBeVisible();
    await card.getByRole("link", { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`${threadUrl}$`));
    await expect(page.getByRole("button", { name: "Pin to top" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Lock" })).toHaveCount(0);
    await page.getByRole("textbox", { name: "Your reply", exact: true }).fill("Swerve! We have the modules from last year.");
    await page.getByRole("button", { name: "Post reply" }).click();
    await expect(page).toHaveURL(/\?posted=/);
    const replyId = new URL(page.url()).searchParams.get("posted");
    await expect(page.locator(`[id="reply-${replyId}"]`)).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Reply posted." })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Your reply", exact: true })).toHaveValue("");

    // Maya: one more on the badge; Unread lists it with the new reply; opening it shows the divider and clears the badge.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/today");
    expect(await discussionBadge(page)).toBe(before + 1);
    await page.goto("/discussion?unread=1");
    const unreadCard = page.getByRole("main").getByRole("listitem").filter({ hasText: title });
    await expect(unreadCard).toContainText("1 new reply");
    await expect(unreadCard).toContainText("last reply");
    await unreadCard.getByRole("link", { name: title }).click();
    const divider = page.getByRole("separator", { name: "New replies" });
    await expect(divider).toBeVisible();
    await expect(page.locator(`[id="reply-${replyId}"]`)).toContainText("Swerve! We have the modules");
    await expect.poll(() => discussionBadge(page)).toBe(before);
    // Still there while the page is open (with the link to it, which moves focus to the first new reply); gone next time.
    await expect(divider).toBeVisible();
    await page.getByRole("link", { name: "Jump to new replies" }).click();
    await expect(page.locator(`[id="reply-${replyId}"]`)).toBeFocused();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(divider).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Jump to new replies" })).toHaveCount(0);
    await page.goto("/discussion?unread=1");
    await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: title })).toHaveCount(0);

    // A leader pins it (listed first) and locks it (no more replies).
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(threadUrl);
    await page.getByRole("button", { name: "Pin to top" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Pinned." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unpin" })).toBeFocused();
    await page.getByRole("button", { name: "Lock" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Locked." })).toBeVisible();
    await expect(page.getByText("This discussion is locked")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Your reply", exact: true })).toHaveCount(0);
    await page.goto("/discussion");
    const firstCard = page.getByRole("main").getByRole("listitem").first();
    await expect(firstCard).toContainText(title);
    await expect(firstCard).toContainText("Pinned");
    await expect(firstCard).toContainText("Locked");

    // Maya can't reply or edit now; the pages fit a phone.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto(threadUrl);
    await expect(page.getByText("This discussion is locked")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Your reply", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Edit this discussion" })).toHaveCount(0);
    // An old link to its edit page leads back to the discussion (which says it's locked), not a 404.
    await page.goto(`${threadUrl}/edit`);
    await expect(page).toHaveURL(new RegExp(`${threadUrl}$`));
    await expect(page.getByText("This discussion is locked")).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.goto("/discussion");
    await expectNoHorizontalScroll(page);
    await page.goto("/discussion/new");
    await expectNoHorizontalScroll(page);
  });

  test("the author edits their reply in place; a search with % finds only what was typed", async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const id = uniq(info.project.name);
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/discussion/new?category=IDEAS");
    await expect(page.getByLabel("Category")).toHaveValue("IDEAS");
    await page.getByLabel("Title").fill(`100% robot demo at the library ${id}`);
    await page.getByLabel("What do you want to talk about?").fill("Who wants to help?");
    await page.getByRole("button", { name: "Post discussion" }).click();
    await expect(page).toHaveURL(/\?started=1$/);

    await page.getByRole("textbox", { name: "Your reply", exact: true }).fill("I can bring the practice field.");
    await page.getByRole("button", { name: "Post reply" }).click();
    await expect(page).toHaveURL(/\?posted=/);
    const replyId = new URL(page.url()).searchParams.get("posted");
    const reply = page.locator(`[id="reply-${replyId}"]`);
    await reply.getByRole("button", { name: "Edit your reply" }).click();
    const box = reply.getByLabel("Edit your reply");
    await expect(box).toBeFocused();
    await box.fill("I can bring the practice field and the banner.");
    await reply.getByRole("button", { name: "Save" }).click();
    await expect(reply.getByRole("status")).toHaveText("Reply updated.");
    await expect(reply).toBeFocused();
    await expect(reply).toContainText("and the banner.");
    await expect(reply).toContainText("edited");
    await expectNoHorizontalScroll(page);

    // On a phone the category strip scrolls sideways: the active chip is scrolled into view, and the count names it.
    await page.goto("/discussion?category=OFF_TOPIC");
    const strip = page.getByRole("navigation", { name: "Filter by category" });
    await expect(strip.getByRole("link", { name: "Off-topic" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByText(/discussions? in Off-topic/)).toBeVisible();
    await expectNoHorizontalScroll(page);

    // "%" is a literal character, not a wildcard.
    await page.goto(`/discussion?q=${encodeURIComponent(`100% robot demo at the library ${id}`)}`);
    await expect(page.getByRole("main").getByRole("listitem")).toHaveCount(1);
    await page.goto(`/discussion?q=${encodeURIComponent(`100%robot demo`)}`);
    await expect(page.getByText("No discussions match")).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
