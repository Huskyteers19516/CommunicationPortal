import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, openNavIfNeeded, PEOPLE, signIn, sql, uniq } from "./helpers";

// Sponsorships: the Business team's tracker (Business subteam + leaders, captain, mentors, teachers, owners).

/** Today in the team's timezone (the e2e server runs with TEAM_TIMEZONE=America/Los_Angeles), as YYYY-MM-DD. */
function teamToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

test.describe("sponsorships", () => {
  test("a business member adds a sponsor, then moves it to Submitted from the list", async ({ page }, info) => {
    const name = `E2E Sponsor ${uniq(info.project.name)}`;
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/today");
    await openNavIfNeeded(page);
    await page.getByRole("link", { name: "Sponsorships" }).first().click();
    await expect(page).toHaveURL(/\/sponsors$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sponsorships" })).toBeVisible();

    await page.getByRole("link", { name: "Add sponsor" }).first().click();
    await expect(page).toHaveURL(/\/sponsors\/new$/);
    await expectNoHorizontalScroll(page);
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Website").fill("example.com/e2e-sponsor");
    await page.getByLabel("What we're asking for").fill("$300 for competition fees");
    await page.getByLabel("Amount received ($)").fill("-5");
    await page.getByRole("button", { name: "Add sponsor" }).click();

    // The error points at the field; what was typed stays.
    await expect(page.locator("#amountReceived-error")).toHaveText("The amount can't be negative.");
    await expect(page.getByLabel("Amount received ($)")).toBeFocused();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
    await page.getByLabel("Amount received ($)").fill("");
    await page.getByRole("button", { name: "Add sponsor" }).click();

    // Back on the list: the new sponsor is highlighted and focused, with a note.
    await expect(page).toHaveURL(/\/sponsors\?added=/);
    const link = page.getByRole("link", { name, exact: true }).filter({ visible: true });
    await expect(link).toBeFocused();
    await expect(page.getByText("Added just now.").filter({ visible: true })).toBeVisible();

    // Change the stage right in the list, like the spreadsheet's dropdown. The list keeps its order.
    const order = () => page.locator("a[data-sponsor-link]").filter({ visible: true }).allTextContents();
    const before = await order();
    const stage = page.getByRole("combobox", { name: `Stage for ${name}` });
    await expect(stage).toHaveValue("NOT_STARTED");
    await stage.focus();
    await stage.selectOption("SUBMITTED");
    const status = stage.locator("xpath=../..").getByRole("status");
    await expect(status).toHaveText(/^Saved\. Submitted /);
    await expect(stage).toBeFocused();
    await expect(stage).toHaveValue("SUBMITTED");
    expect(await order()).toEqual(before);
    await expectNoHorizontalScroll(page);

    const [row] = await sql<{ stage: string; submitted: string | null; website: string }>(
      `SELECT stage::text AS stage, "submittedOn"::text AS submitted, website FROM "Sponsorship" WHERE name = $1`,
      [name],
    );
    expect(row).toEqual({ stage: "SUBMITTED", submitted: teamToday(), website: "https://example.com/e2e-sponsor" });

    // The sponsor's page shows the date that was filled in; saving goes back to the list.
    await link.click();
    await expect(page.getByLabel("Submitted")).toHaveValue(teamToday());
    await expect(page.getByText(/^Added .* by Ava Thompson/)).toBeVisible();
    await page.getByLabel("Contact name").fill("Jamie Rivera");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(/\/sponsors\?saved=/);
    await expect(page.getByText("Changes saved.").filter({ visible: true })).toBeVisible();
    await expect(page.getByRole("link", { name, exact: true }).filter({ visible: true })).toBeFocused();
  });

  test("saving an edit page that's out of date keeps what was typed and says to reload", async ({ page }, info) => {
    const name = `E2E Stale ${uniq(info.project.name)}`;
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "Sponsorship" (id, name, stage, "createdAt", "updatedAt") VALUES ('e2e_' || md5(random()::text), $1, 'NOT_STARTED', now(), now()) RETURNING id`,
      [name],
    );
    await signIn(page, PEOPLE.businessMember);
    await page.goto(`/sponsors/${id}`);
    await page.getByLabel("Notes").fill("Called them today");
    // Meanwhile someone moves it to Submitted from the list.
    await sql(`UPDATE "Sponsorship" SET stage = 'SUBMITTED', "submittedOn" = CURRENT_DATE, "updatedAt" = now() + interval '1 second' WHERE id = $1`, [id]);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Someone changed this sponsor since you opened it" })).toBeVisible();
    await expect(page.getByLabel("Notes")).toHaveValue("Called them today");
    const [row] = await sql<{ stage: string; notes: string }>(`SELECT stage::text AS stage, notes FROM "Sponsorship" WHERE id = $1`, [id]);
    expect(row).toEqual({ stage: "SUBMITTED", notes: "" });
  });

  test("removing a sponsor says so on the list", async ({ page }, info) => {
    const name = `E2E Remove ${uniq(info.project.name)}`;
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "Sponsorship" (id, name, stage, "createdAt", "updatedAt") VALUES ('e2e_' || md5(random()::text), $1, 'NOT_STARTED', now(), now()) RETURNING id`,
      [name],
    );
    await signIn(page, PEOPLE.businessLeader);
    await page.goto(`/sponsors/${id}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: `Remove ${name}` }).click();
    await expect(page).toHaveURL(/\/sponsors\?removed=/);
    const alert = page.getByRole("status").filter({ hasText: `Removed “${name}”.` });
    await expect(alert).toBeVisible();
    await expect(page.locator(":focus")).toContainText(`Removed “${name}”.`);
  });

  test("moving a sponsor out of a filtered list keeps keyboard focus in the list", async ({ page }, info) => {
    const name = `E2E Focus ${uniq(info.project.name)}`;
    await sql(
      `INSERT INTO "Sponsorship" (id, name, stage, "createdAt", "updatedAt") VALUES ('e2e_' || md5(random()::text), $1, 'DO_SOON', now(), now())`,
      [name],
    );
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/sponsors?filter=todo");
    const stage = page.getByRole("combobox", { name: `Stage for ${name}` });
    await stage.focus();
    await stage.selectOption("SUBMITTED");
    await expect(page.getByRole("status").filter({ hasText: `${name} moved to Submitted.` })).toBeVisible();
    await expect(stage).toHaveCount(0);
    await expect(page.locator("select[data-stage-select]:focus")).toHaveCount(1);
  });

  test("a stage picked right before leaving the list is still saved", async ({ page }, info) => {
    const name = `E2E Quick Leave ${uniq(info.project.name)}`;
    await sql(
      `INSERT INTO "Sponsorship" (id, name, stage, "createdAt", "updatedAt") VALUES ('e2e_' || md5(random()::text), $1, 'NOT_STARTED', now(), now())`,
      [name],
    );
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/sponsors");
    // Pick a stage and follow a link at once (before the menu's short save delay is up).
    await page.getByRole("combobox", { name: `Stage for ${name}` }).selectOption("DO_SOON");
    await page.getByRole("link", { name, exact: true }).filter({ visible: true }).click();
    await expect(page).toHaveURL(/\/sponsors\/e2e_/);
    await expect
      .poll(async () => (await sql<{ stage: string }>(`SELECT stage::text AS stage FROM "Sponsorship" WHERE name = $1`, [name]))[0].stage)
      .toBe("DO_SOON");
  });

  test("a business leader imports three rows pasted from the sheet", async ({ page }, info) => {
    const id = uniq(info.project.name);
    const rows = [
      "AMOUNT RECEIVED\tCOMPLETION STAGE\tBRAND/COMPANY\tEmail\tDATE ANNOUNCED\tDATE COMPLETED\tPERSON",
      `$1,000\tAccepted\tImport A ${id}\tone@example.com\t9/20/2026\t9/1/2026\tAva`,
      `\tWork in Progress\tImport B ${id}\t\t\t\tDaniel`,
      `\tHaven't touched\tImport C ${id}\t\t\t\tNobody Here`,
    ].join("\n");

    await signIn(page, PEOPLE.businessLeader);
    await page.goto("/sponsors");
    await page.getByRole("link", { name: "Import from a spreadsheet" }).first().click();
    await expect(page).toHaveURL(/\/sponsors\/import$/);
    await page.getByLabel("Paste rows from your spreadsheet").fill(rows);

    // The preview shows what will happen before anything is saved: how columns are read, and warnings
    // (Ava and Daniel matched by first name only, Nobody Here not matched).
    await expect(page.getByText(/^3 sponsors to import · 3 warnings$/)).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "DATE ANNOUNCED" })).toContainText("Accepted on");
    // (The settings test may have renamed Ava, e.g. "Ava Thompson desktop" — match the start of the name.)
    await expect(page.getByText(/^Matched “Ava” to Ava Thompson.* by first name — check it\.$/).filter({ visible: true })).toBeVisible();
    await expect(page.getByText("“Nobody Here” isn't anyone who can use this page", { exact: false }).filter({ visible: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Import 3 sponsors" }).click();

    await expect(page).toHaveURL(/\/sponsors\?imported=3&skipped=0$/);
    await expect(page.getByText("Imported 3 sponsors.")).toBeVisible();
    const imported = await sql<{ name: string; stage: string; amount: number | null; owner: string | null; notes: string }>(
      `SELECT s.name, s.stage::text AS stage, s."amountReceived" AS amount, u.email AS owner, s.notes
       FROM "Sponsorship" s LEFT JOIN "User" u ON u.id = s."ownerId" WHERE s.name LIKE $1 ORDER BY s.name`,
      [`Import _ ${id}`],
    );
    expect(imported).toEqual([
      { name: `Import A ${id}`, stage: "ACCEPTED", amount: 1000, owner: PEOPLE.businessMember, notes: "" },
      { name: `Import B ${id}`, stage: "IN_PROGRESS", amount: null, owner: "daniel.park@example.com", notes: "" },
      { name: `Import C ${id}`, stage: "NOT_STARTED", amount: null, owner: null, notes: "Person: Nobody Here" },
    ]);

    // Pasting the same rows again skips them.
    await page.goto("/sponsors/import");
    await page.getByLabel("Paste rows from your spreadsheet").fill(rows);
    await expect(page.getByText(/^Nothing new to import · 3 already here \(skipped\)/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Import", exact: true })).toBeDisabled();

    // Newer info in the sheet: the preview shows the difference, and can update the one already here.
    await page.getByLabel("Paste rows from your spreadsheet").fill(rows.replace("\tWork in Progress\t", "\tSubmitted\t"));
    await expect(page.getByText("Sheet: Submitted — here: Needs work.").filter({ visible: true })).toBeVisible();
    await page.getByLabel("Update sponsors that are already here").check();
    await expect(page.getByText(/^Nothing new to import · 1 to update · 2 already here \(skipped\)/)).toBeVisible();
    await page.getByRole("button", { name: "Update 1 sponsor" }).click();
    await expect(page).toHaveURL(/\/sponsors\?imported=0&updated=1&skipped=2$/);
    await expect(page.getByText("Updated 1 sponsor that was already here. Skipped 2 that were already here.")).toBeVisible();
    const [updated] = await sql<{ stage: string }>(`SELECT stage::text AS stage FROM "Sponsorship" WHERE name = $1`, [`Import B ${id}`]);
    expect(updated.stage).toBe("SUBMITTED");
  });

  test("the info card can be edited, and focus goes back to Edit", async ({ page }, info) => {
    const link = `https://docs.example.com/e2e-${uniq(info.project.name)}`;
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/sponsors");
    const toggle = page.getByRole("button", { name: "Info for applications", exact: true });
    if (await toggle.isVisible()) await toggle.click();
    await page.getByRole("button", { name: "Edit info for applications" }).click();
    const box = page.getByLabel("Info for applications", { exact: true });
    await expect(box).toBeFocused();
    await expect(page.getByText("Don't put passwords here")).toBeVisible();
    await box.fill(`Team address: 123 Example Ave, Anaheim, CA\nSponsorship packet: ${link}`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit info for applications" })).toBeFocused();
    await expect(page.getByRole("link", { name: link })).toHaveAttribute("href", link);
  });

  test("other subteams' members don't see Sponsorships, and a link to it explains why", async ({ page }) => {
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/today");
    await openNavIfNeeded(page);
    await expect(page.getByRole("link", { name: "Sponsorships" })).toHaveCount(0);
    const [sponsor] = await sql<{ id: string; name: string }>(`SELECT id, name FROM "Sponsorship" ORDER BY name LIMIT 1`);
    for (const path of ["/sponsors", "/sponsors?filter=todo", "/sponsors/new", "/sponsors/import", `/sponsors/${sponsor.id}`]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expect(page.getByText("Sponsorships are for the Business team and leaders"), path).toBeVisible();
      await expect(page.getByText(sponsor.name, { exact: true }), path).toHaveCount(0);
      await expect(page.getByRole("combobox"), path).toHaveCount(0);
    }
    await page.getByRole("link", { name: "Back to Today" }).click();
    await expect(page).toHaveURL(/\/today$/);
  });

  test("sponsor pages fit a 375px phone", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "phone layout");
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page, PEOPLE.businessMember);
    const [sponsor] = await sql<{ id: string }>(`SELECT id FROM "Sponsorship" ORDER BY length(notes) DESC LIMIT 1`);
    for (const path of [
      "/sponsors",
      "/sponsors?filter=todo",
      "/sponsors?filter=closing",
      "/sponsors?mine=1",
      "/sponsors/new",
      "/sponsors/import",
      `/sponsors/${sponsor.id}`,
    ]) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(200);
      await expectNoHorizontalScroll(page);
    }

    // The info card starts collapsed on phones.
    await page.goto("/sponsors");
    const toggle = page.getByRole("button", { name: "Info for applications", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("123 Example Ave, Anaheim, CA")).toBeVisible();

    // Stage menus are big enough to tap.
    const box = await page.getByRole("combobox").first().boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
    await expectNoHorizontalScroll(page);
  });
});
