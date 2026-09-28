import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, openNavIfNeeded, PEOPLE, signIn, sql } from "./helpers";

// Team members (/people): everyone ACTIVE sees who's on the team and emails them. Sign-ups waiting for approval,
// turned-down and disabled accounts never show up (they stay in Admin → People). Members get no way into Admin;
// people with admin access get a link to manage each person they're allowed to manage.

async function activeCount() {
  const [{ n }] = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM "User" WHERE status = 'ACTIVE'`);
  return Number(n);
}

test.describe("team members", () => {
  test("a member opens Team members from the menu, emails a teammate, and never sees inactive accounts", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/today");
    await openNavIfNeeded(page);
    await page.getByRole("link", { name: "Team members", exact: true }).click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(page.getByRole("heading", { level: 1, name: "Team members" })).toBeVisible();
    const main = page.getByRole("main");

    // Everyone ACTIVE, with their position, a mailto link, and the Owner badge.
    await expect(main.getByText(`${await activeCount()} people`, { exact: true })).toBeVisible();
    // The list is rendered twice (phone cards, desktop table); only one is shown.
    await expect(main.getByRole("listitem").filter({ hasText: "Priya Raman" })).toContainText("Software Leader");
    await expect(main.getByRole("link", { name: PEOPLE.softwareLeader })).toHaveAttribute("href", `mailto:${PEOPLE.softwareLeader}`);
    await expect(main.getByRole("link", { name: PEOPLE.admin })).toHaveAttribute("href", `mailto:${PEOPLE.admin}`);
    await expect(main.getByRole("listitem").filter({ hasText: "Jordan Lee" }).getByText("Owner", { exact: true })).toBeVisible();

    // Never a sign-up waiting for approval or someone who left (seeded: Rachel is pending, Noah is disabled).
    const inactive = await sql<{ name: string; email: string }>(`SELECT name, email FROM "User" WHERE status <> 'ACTIVE'`);
    expect(inactive.map((u) => u.email)).toEqual(expect.arrayContaining(["rachel.goldberg@example.com", "noah.fischer@example.com"]));
    for (const u of inactive) await expect(main.locator(`a[href="mailto:${u.email}"]`)).toHaveCount(0);
    await expect(main.getByText("Rachel Goldberg")).toHaveCount(0);
    await expect(main.getByText("Noah Fischer")).toHaveCount(0);

    // Read-only for members: no way into Admin.
    await expect(main.locator('a[href^="/admin"]')).toHaveCount(0);
    await expect(main.getByRole("link", { name: /Manage people/ })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Search by name or email.
    await main.getByLabel("Search name, email, or position").fill("priya");
    await main.getByRole("button", { name: "Filter" }).click();
    await expect(page).toHaveURL(/\/people\?q=priya/);
    await expect(main.getByText("1 person matches", { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: PEOPLE.softwareLeader })).toBeVisible();
    await expect(main.getByText("Maya Patel", { exact: true })).toHaveCount(0);
    await main.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/people$/);

    // Search by position: "build" finds the build team (Marcus is a Build Leader, Ethan a Build member).
    await main.getByLabel("Search name, email, or position").fill("build");
    await main.getByLabel("Search name, email, or position").press("Enter");
    await expect(page).toHaveURL(/\/people\?q=build/);
    await expect(main.getByText("Marcus Johnson", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(main.getByText("Ethan Chen", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(main.getByText("Priya Raman", { exact: true })).toHaveCount(0);
    // Noah (a Build member who left, disabled) stays hidden, as does anyone not ACTIVE right now. (Not Tyler, the seeded
    // pending Build Leader: flows.spec's "Approve anyway" activates him earlier in the run.)
    await expect(main.getByText("Noah Fischer")).toHaveCount(0);
    for (const u of inactive) await expect(main.locator(`a[href="mailto:${u.email}"]`)).toHaveCount(0);

    // Picking a position applies it right away (no Filter tap), together with the search.
    await main.getByLabel("Position", { exact: true }).selectOption("BUILD_LEADER");
    await expect(page).toHaveURL(/role=BUILD_LEADER/);
    await expect(page).toHaveURL(/q=build/);
    await expect(main.getByText("Marcus Johnson", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(main.getByText("Ethan Chen", { exact: true })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Clear filters resets the menus too, not just the list.
    await main.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/people$/);
    await expect(main.getByText(`${await activeCount()} people`, { exact: true })).toBeVisible();
    await expect(main.getByLabel("Position", { exact: true })).toHaveValue("");
    await expect(main.getByLabel("Subteam", { exact: true })).toHaveValue("");
    await expect(main.getByLabel("Search name, email, or position")).toHaveValue("");

    // So does opening Team members from the menu while filtered.
    await page.goto("/people?role=MENTOR&subteam=BUILD");
    await expect(main.getByLabel("Position", { exact: true })).toHaveValue("MENTOR");
    await openNavIfNeeded(page);
    await page.getByRole("link", { name: "Team members", exact: true }).click();
    await expect(main.getByText(`${await activeCount()} people`, { exact: true })).toBeVisible();
    await expect(main.getByLabel("Position", { exact: true })).toHaveValue("");
    await expect(main.getByLabel("Subteam", { exact: true })).toHaveValue("");

    // A pending sign-up can't be found, and a status in the link is ignored.
    await page.goto("/people?q=rachel");
    await expect(main.getByText("No one matches these filters.")).toBeVisible();
    await page.goto("/people?status=PENDING&role=NOPE");
    await expect(main.getByText(`${await activeCount()} people`, { exact: true })).toBeVisible();
    await expect(main.getByText("Rachel Goldberg")).toHaveCount(0);
  });

  test("the owner gets a link into Admin → People for each person", async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto("/people");
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "Manage people in Admin → People" })).toHaveAttribute("href", "/admin/users");
    await expect(main.locator('a[href^="/admin/users/"]').filter({ visible: true })).toHaveCount(await activeCount());
    await expectNoHorizontalScroll(page);

    const [priya] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [PEOPLE.softwareLeader]);
    await main.getByRole("link", { name: /Priya Raman/ }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/users/${priya.id}$`));

    // Admin → People's Clear filters resets its menus too.
    await page.goto("/admin/users?role=MEMBER&subteam=BUILD&status=ACTIVE");
    await expect(main.getByLabel("Position", { exact: true })).toHaveValue("MEMBER");
    await main.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(main.getByLabel("Position", { exact: true })).toHaveValue("");
    await expect(main.getByLabel("Subteam", { exact: true })).toHaveValue("");
    await expect(main.getByLabel("Status", { exact: true })).toHaveValue("");
  });

  test("a leader only gets manage links for people they can manage", async ({ page }) => {
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/people");
    const main = page.getByRole("main");
    await expect(main.getByRole("link", { name: "Manage people in Admin → People" })).toBeVisible();
    // Members: yes. The captain (an owner) and mentors: no — just their names and emails.
    await expect(main.getByRole("link", { name: /Maya Patel/ })).toHaveAttribute("href", /^\/admin\/users\//);
    await expect(main.getByRole("link", { name: /Jordan Lee/ })).toHaveCount(0);
    await expect(main.getByRole("link", { name: /Elena Petrova/ })).toHaveCount(0);
    await expect(main.getByText("Elena Petrova", { exact: true }).filter({ visible: true })).toBeVisible();
    await expect(main.getByRole("link", { name: PEOPLE.mentor })).toHaveAttribute("href", `mailto:${PEOPLE.mentor}`);
  });
});
