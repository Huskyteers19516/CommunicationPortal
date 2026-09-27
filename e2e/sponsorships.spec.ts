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
    // Files can only be attached once it exists: the note links to its page.
    const attach = page.getByRole("link", { name: `Attach forms and files to ${name}` }).filter({ visible: true });
    await expect(attach).toHaveAttribute("href", await link.getAttribute("href") ?? "missing");

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
    // Someone attached a signed copy: removing the sponsor removes it too, and the question says so.
    await sql(
      `INSERT INTO "SponsorshipFile" (id, "sponsorshipId", filename, "contentType", size, data) VALUES ('e2e_' || md5(random()::text), $1, 'signed.pdf', 'application/pdf', 3, $2)`,
      [id, Buffer.from("PDF")],
    );
    await signIn(page, PEOPLE.businessLeader);
    await page.goto(`/sponsors/${id}`);
    let question = "";
    page.once("dialog", (dialog) => {
      question = dialog.message();
      void dialog.accept();
    });
    await page.getByRole("button", { name: `Remove ${name}` }).click();
    await expect(page).toHaveURL(/\/sponsors\?removed=/);
    expect(question).toBe(`Remove “${name}” and its attached file from Sponsorships? This can't be undone.`);
    expect(await sql(`SELECT id FROM "SponsorshipFile" WHERE "sponsorshipId" = $1`, [id])).toEqual([]);
    const alert = page.getByRole("status").filter({ hasText: `Removed “${name}”.` });
    await expect(alert).toBeVisible();
    await expect(page.locator(":focus")).toContainText(`Removed “${name}”.`);
  });

  test("a business leader selects several sponsors and removes them at once", async ({ page }, info) => {
    const id = uniq(info.project.name);
    const names = ["A", "B", "C"].map((letter) => `E2E Bulk ${letter} ${id}`);
    const ids: string[] = [];
    for (const name of names) {
      const [row] = await sql<{ id: string }>(
        `INSERT INTO "Sponsorship" (id, name, stage, "createdById", "createdAt", "updatedAt")
         VALUES ('e2e_' || md5(random()::text), $1, 'NOT_STARTED', (SELECT id FROM "User" WHERE email = $2), now(), now()) RETURNING id`,
        [name, PEOPLE.businessLeader],
      );
      ids.push(row.id);
    }
    await signIn(page, PEOPLE.businessLeader);
    // As if the first one was just added (highlighted): once it's removed, the page mustn't announce it as added.
    await page.goto(`/sponsors?added=${ids[0]}`);
    await expect(page.getByText("Added just now.").filter({ visible: true })).toBeVisible();

    // "Select" adds a checkbox to each sponsor and puts focus on "Select all"; Escape leaves, back on "Select".
    const select = page.getByRole("button", { name: "Select", exact: true });
    const selectAll = page.getByRole("checkbox", { name: /^Select all/ });
    const bar = page.getByRole("form", { name: "Remove selected sponsors" });
    if (info.project.name === "mobile") {
      // "Select" near the bottom of the screen: "Select all" is scrolled up above the bar and the tab bar, not left under them.
      const box = await select.boundingBox();
      await page.evaluate((dy) => window.scrollBy(0, dy), (box?.y ?? 0) - 690);
    }
    await select.click();
    await expect(selectAll).toBeFocused();
    const [allBox, openBarBox] = await Promise.all([selectAll.boundingBox(), bar.boundingBox()]);
    expect((allBox?.y ?? 0) + (allBox?.height ?? 0)).toBeLessThanOrEqual(openBarBox?.y ?? 0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(select).toBeFocused();

    await select.click();
    for (const name of names) await page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).check();
    await expect(bar.getByText("3 selected", { exact: true })).toBeVisible();

    // Keyboard: "Skip to Remove" (right after "Select all") jumps over the list to the bar.
    await selectAll.focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Skip to Remove" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(bar.getByRole("button", { name: "Remove 3 sponsors" })).toBeFocused();

    if (info.project.name === "mobile") {
      // On a 375px phone the bar fits on one line, above the bottom tab bar.
      await page.setViewportSize({ width: 375, height: 812 });
      await expectNoHorizontalScroll(page);
      const [barBox, tabsBox] = await Promise.all([bar.boundingBox(), page.getByRole("navigation", { name: "Quick" }).boundingBox()]);
      expect(barBox?.height ?? 0).toBeLessThan(70);
      expect((barBox?.y ?? 0) + (barBox?.height ?? 0)).toBeLessThanOrEqual(tabsBox?.y ?? 0);
    }

    let question = "";
    page.once("dialog", (dialog) => {
      question = dialog.message();
      void dialog.accept();
    });
    await bar.getByRole("button", { name: "Remove 3 sponsors" }).click();

    // The list says so (with focus on it), selection mode is over, and they're gone.
    const status = page.getByRole("status").filter({ hasText: "Removed 3 sponsors." });
    await expect(status).toBeVisible();
    await expect(status).toBeFocused();
    expect(question).toBe(`Remove 3 sponsors? “${names[0]}”, “${names[1]}” and “${names[2]}”. Any attached files are removed too. This can't be undone.`);
    await expect(bar).toHaveCount(0);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    for (const name of names) await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    await expect(page.getByText("Sponsor added.")).toHaveCount(0);
    await expect(page.getByText("Added just now.")).toHaveCount(0);
    await expect(status).toBeFocused();
    expect(await sql(`SELECT id FROM "Sponsorship" WHERE name = ANY($1)`, [names])).toEqual([]);
    await expectNoHorizontalScroll(page);
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

  test("a business member attaches a form to a sponsor, downloads it, and removes it", async ({ page }, info) => {
    const name = `E2E Files ${uniq(info.project.name)}`;
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "Sponsorship" (id, name, stage, "createdAt", "updatedAt") VALUES ('e2e_' || md5(random()::text), $1, 'NOT_STARTED', now(), now()) RETURNING id`,
      [name],
    );
    const pdf = "%PDF-1.4\n% E2E sponsor application form\n";
    await signIn(page, PEOPLE.businessMember);

    // Adding a sponsor says files come after saving.
    await page.goto("/sponsors/new");
    await expect(page.getByText("To attach forms and files, open the sponsor after you add it.")).toBeVisible();

    await page.goto(`/sponsors/${id}`);
    const card = page.getByRole("region", { name: "Forms and files" });
    await expect(card.getByText("No files yet.")).toBeVisible();
    const picker = card.getByLabel("Add a file");
    await expect(picker).toHaveAccessibleDescription(/^Uploads as soon as you pick it\. .*up to 4 MB/);
    await expect(card.getByText(/^Team file storage: .* of 300 MB used/)).toBeVisible();
    // Picking a file uploads it (there's no separate Upload button to forget before pressing Save changes).
    await picker.setInputFiles({ name: "sponsor-form.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf, "utf8") });

    // Listed right away, with focus on it and a status line saying what happened.
    await expect(card.getByRole("status")).toHaveText("Added “sponsor-form.pdf”.");
    const fileName = card.locator("[data-file-name]").filter({ hasText: "sponsor-form.pdf" });
    await expect(fileName).toBeFocused();
    await expect(card.getByText(/Added by Ava Thompson/)).toBeVisible();
    await expectNoHorizontalScroll(page);

    const [file] = await sql<{ id: string; size: number }>(`SELECT id, size FROM "SponsorshipFile" WHERE "sponsorshipId" = $1`, [id]);
    expect(file.size).toBe(Buffer.byteLength(pdf));
    const download = card.getByRole("link", { name: "Download sponsor-form.pdf" });
    await expect(download).toHaveAttribute("href", `/sponsors/files/${file.id}?download=1`);
    await expect(card.getByRole("link", { name: /^View sponsor-form\.pdf/ })).toHaveAttribute("href", `/sponsors/files/${file.id}`);

    // On a 375px phone, View, Download and Remove still fit on one row (Remove is just its icon there, 40×40).
    if (info.project.name === "mobile") {
      await page.setViewportSize({ width: 375, height: 812 });
      const actions = card.locator("[data-file-actions]").first();
      const boxes = await Promise.all([
        actions.getByRole("link", { name: /^View sponsor-form\.pdf/ }).boundingBox(),
        actions.getByRole("link", { name: "Download sponsor-form.pdf" }).boundingBox(),
        actions.getByRole("button", { name: "Remove sponsor-form.pdf" }).boundingBox(),
      ]);
      expect(boxes.map((b) => Math.round(b?.y ?? -1))).toEqual(Array(3).fill(Math.round(boxes[0]?.y ?? -1)));
      expect(Math.round(boxes[2]?.width ?? 0)).toBe(40);
      expect(Math.round(boxes[2]?.height ?? 0)).toBe(40);
      await expectNoHorizontalScroll(page);
    }

    // Download sends it as an attachment with locked-down headers; View opens the PDF in the browser.
    const res = await page.request.get(`/sponsors/files/${file.id}?download=1`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toBe("application/octet-stream");
    expect(res.headers()["content-disposition"]).toMatch(/^attachment; filename="sponsor-form\.pdf"/);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.text()).toBe(pdf);
    const view = await page.request.get(`/sponsors/files/${file.id}`);
    expect(view.headers()["content-type"]).toBe("application/pdf");
    expect(view.headers()["content-disposition"]).toMatch(/^inline; /);

    // The list shows a paperclip with the count next to the sponsor's name.
    await page.goto("/sponsors");
    const nameLink = page.getByRole("link", { name, exact: true }).filter({ visible: true });
    await expect(nameLink.locator("xpath=..").getByRole("img", { name: "1 file" })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Other subteams' members can't open it: it looks missing.
    await signIn(page, PEOPLE.softwareMember);
    expect((await page.request.get(`/sponsors/files/${file.id}`)).status()).toBe(404);

    // Remove it: the status says so and focus goes back to the file input.
    await signIn(page, PEOPLE.businessMember);
    await page.goto(`/sponsors/${id}`);
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: "Remove sponsor-form.pdf" }).click();
    await expect(card.getByRole("status")).toHaveText("Removed “sponsor-form.pdf”.");
    await expect(card.getByText("No files yet.")).toBeVisible();
    await expect(card.getByLabel("Add a file")).toBeFocused();
    expect(await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "SponsorshipFile" WHERE "sponsorshipId" = $1`, [id])).toEqual([{ n: 0 }]);
    await expectNoHorizontalScroll(page);
  });

  test("file changes from a page that's out of date show the sponsor's files as they are now", async ({ page }, info) => {
    const name = `E2E Stale Files ${uniq(info.project.name)}`;
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "Sponsorship" (id, name, stage, "createdById", "createdAt", "updatedAt")
       VALUES ('e2e_' || md5(random()::text), $1, 'NOT_STARTED', (SELECT id FROM "User" WHERE email = $2), now(), now()) RETURNING id`,
      [name, PEOPLE.businessMember],
    );
    const addFile = (n: number) =>
      sql(
        `INSERT INTO "SponsorshipFile" (id, "sponsorshipId", filename, "contentType", size, data, "createdAt")
         VALUES ('e2e_' || md5(random()::text), $1, $2, 'text/plain', 1, $3, now() + make_interval(secs => $4))`,
        [id, `page ${n}.txt`, Buffer.from("x"), n],
      );
    for (let n = 1; n <= 9; n++) await addFile(n);
    await signIn(page, PEOPLE.businessMember);
    await page.goto(`/sponsors/${id}`);
    const card = page.getByRole("region", { name: "Forms and files" });
    const names = card.locator("[data-file-name]");
    await expect(names).toHaveCount(9);

    // Someone else adds the 10th meanwhile: the upload is turned down, and the card catches up (all 10 files,
    // and the note that it's full, focused since the file picker went away).
    await addFile(10);
    await card.getByLabel("Add a file").setInputFiles({ name: "one more.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await expect(names).toHaveCount(10);
    await expect(card.getByText(/^This sponsor has 10 files, the most it can have\./)).toBeFocused();
    await expect(card.getByLabel("Add a file")).toHaveCount(0);
    expect(await sql<{ n: number }>(`SELECT count(*)::int AS n FROM "SponsorshipFile" WHERE "sponsorshipId" = $1`, [id])).toEqual([{ n: 10 }]);

    // Someone else removes a file meanwhile: removing it here says it's gone, the list drops it, and focus moves on.
    await sql(`DELETE FROM "SponsorshipFile" WHERE "sponsorshipId" = $1 AND filename = 'page 1.txt'`, [id]);
    page.once("dialog", (dialog) => void dialog.accept());
    await card.getByRole("button", { name: "Remove page 1.txt" }).click();
    await expect(card.getByRole("alert")).toHaveText("That file no longer exists.");
    await expect(names).toHaveCount(9);
    await expect(names.first()).toHaveText("page 2.txt");
    await expect(names.first()).toBeFocused();
    await expect(card.getByLabel("Add a file")).toBeVisible();
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
