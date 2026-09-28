import { expect, test } from "@playwright/test";
import { E2E_JOIN_CODE } from "../playwright.config";
import { expectNoHorizontalScroll, openNavIfNeeded, PASSWORD, PEOPLE, signIn, sql, uniq } from "./helpers";

test.describe("access control", () => {
  test("signed-out visitors are sent to sign in, then back where they were going", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/questions");
    await expect(page).toHaveURL(/\/login\?next=%2Fquestions/);
    await page.getByLabel("Email").fill(PEOPLE.softwareMember);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/questions$/);
  });

  test("wrong password shows an error and stays on sign in", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/login");
    await page.getByLabel("Email").fill(PEOPLE.softwareMember);
    await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Incorrect email or password.")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("members can't open Manage or Admin", async ({ page }) => {
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/manage");
    await expect(page).toHaveURL(/\/today$/);
    await page.goto("/manage/review");
    await expect(page).toHaveURL(/\/today$/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/today$/);
  });

  test("a build leader has admin access but can't manage another subteam's task or an owner's account", async ({ page }) => {
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
    const [softwareTask] = await sql<{ id: string }>(`SELECT id FROM "Task" WHERE subteam = 'SOFTWARE' LIMIT 1`);
    const res = await page.goto(`/manage/tasks/${softwareTask.id}`);
    expect(res?.status()).toBe(404);
    const [owner] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [PEOPLE.admin]);
    await page.goto(`/admin/users/${owner.id}`);
    await expect(page.getByText("Only an owner can change an owner's account.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  });

  test("members only see their own questions", async ({ page }) => {
    const [other] = await sql<{ id: string }>(
      `SELECT q.id FROM "Question" q JOIN "User" u ON u.id = q."askerId" WHERE u.email <> $1 LIMIT 1`,
      [PEOPLE.businessMember],
    );
    await signIn(page, PEOPLE.businessMember);
    const res = await page.goto(`/questions/${other.id}`);
    expect(res?.status()).toBe(404);
  });
});

test.describe("sign-up and approval", () => {
  test("a member signs up with the team code and goes straight to Today", async ({ page }, info) => {
    const id = uniq(info.project.name);
    await page.context().clearCookies();
    await page.goto("/register");
    await page.getByLabel("Your name").fill(`New Member ${id}`);
    await page.getByLabel("Email").fill(`new-member-${id}@example.com`);
    await page.getByLabel("Your position").selectOption("MEMBER");
    await page.getByText("Build", { exact: true }).click();
    await page.getByLabel("Password", { exact: true }).fill("a-good-password");
    await page.getByLabel("Confirm password").fill("a-good-password");
    await page.getByLabel("Team code").fill("wrong-code");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.locator("#joinCode-error")).toContainText("That team code isn't right.");

    // Input survives the error; fix the code and submit again.
    await expect(page.getByLabel("Your name")).toHaveValue(`New Member ${id}`);
    await page.getByLabel("Password", { exact: true }).fill("a-good-password");
    await page.getByLabel("Confirm password").fill("a-good-password");
    await page.getByLabel("Team code").fill(E2E_JOIN_CODE.toUpperCase());
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening), New/);
    await expectNoHorizontalScroll(page);
  });

  test("a mentor waits for approval, the admin approves, and the mentor gets the Manage area", async ({ page }, info) => {
    const id = uniq(info.project.name);
    const email = `new-mentor-${id}@example.com`;
    await page.context().clearCookies();
    await page.goto("/register");
    await page.getByLabel("Your name").fill(`Mentor ${id}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Your position").selectOption("MENTOR");
    await page.getByLabel("Password", { exact: true }).fill("a-good-password");
    await page.getByLabel("Confirm password").fill("a-good-password");
    await page.getByLabel("Team code").fill(E2E_JOIN_CODE);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/pending$/);
    await expect(page.getByText(/waiting for approval/i).first()).toBeVisible();

    // Pending accounts can't reach the app.
    await page.goto("/today");
    await expect(page).toHaveURL(/\/pending$/);

    // The admin was told (logged as SKIPPED because no mail server is configured in tests).
    await expect
      .poll(async () => (await sql(`SELECT 1 FROM "EmailLog" WHERE kind = 'account.pending' AND "to" = $1`, [PEOPLE.admin])).length)
      .toBeGreaterThan(0);

    await signIn(page, PEOPLE.admin);
    await page.goto("/admin");
    const card = page.locator("div").filter({ has: page.getByText(email) }).filter({ has: page.getByRole("button", { name: "Approve" }) }).last();
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(email)).toHaveCount(0);

    await signIn(page, email, "a-good-password");
    await expect(page).toHaveURL(/\/today$/);
    await openNavIfNeeded(page);
    await expect(page.getByRole("link", { name: /Overview/ }).first()).toBeVisible();
    const approved = await sql(`SELECT 1 FROM "EmailLog" WHERE kind = 'account.approved' AND "to" = $1`, [email]);
    expect(approved.length).toBe(1);
  });
});

test.describe("checklist lifecycle", () => {
  test("assign → check off → send back → fix → approve", async ({ page }, info) => {
    const title = `E2E wire the drivetrain ${uniq(info.project.name)}`;

    // Build leader assigns a task to a build member.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/manage/tasks/new");
    await page.getByLabel("Title").fill(title);
    await page.getByRole("checkbox", { name: /Ethan Chen/ }).check();
    await page.getByRole("button", { name: /Create task/ }).click();
    await expect(page).toHaveURL(/\/manage\/tasks\/(?!new$)[a-z0-9]+$/);
    const taskUrl = page.url();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);

    // Member sees it today and checks it off.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await page.getByRole("checkbox", { name: `Check off: ${title}` }).click();
    await expect(page.getByRole("checkbox", { name: `Waiting for review: ${title}. Tap to uncheck.` })).toBeVisible();

    // Leader sends it back with a note.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(taskUrl);
    const row = page.locator("li").filter({ hasText: "Ethan Chen" });
    await row.getByRole("button", { name: "Send back" }).click();
    await row.getByRole("textbox").fill("Please add a photo of the wiring.");
    await row.getByRole("button", { name: "Send back" }).last().click();
    await expect(row.getByText("Needs changes")).toBeVisible();

    // Member sees the feedback under "Needs changes" and checks it off again.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await expect(page.getByText("Please add a photo of the wiring.")).toBeVisible();
    await page.getByRole("checkbox", { name: `Check off: ${title}` }).click();
    await expect(page.getByRole("checkbox", { name: `Waiting for review: ${title}. Tap to uncheck.` })).toBeVisible();

    // Leader approves from the review queue.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/manage/review");
    const card = page.locator("li").filter({ hasText: "Ethan Chen" }).filter({ has: page.getByRole("button", { name: "Approve" }) });
    await expect(page.getByText(title)).toBeVisible();
    await page.goto(taskUrl);
    await page.locator("li").filter({ hasText: "Ethan Chen" }).getByRole("button", { name: "Approve" }).click();
    await expect(page.locator("li").filter({ hasText: "Ethan Chen" }).getByText("Approved")).toBeVisible();
    void card;

    // It is officially done for the member.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/my-tasks?tab=done");
    await expect(page.getByRole("checkbox", { name: `Approved: ${title}` })).toBeVisible();

    // Emails: two submissions to the leader, two review results to the member.
    const kinds = await sql<{ kind: string; to: string }>(
      `SELECT e.kind, e."to" FROM "EmailLog" e WHERE e.subject LIKE $1 ORDER BY e."createdAt"`,
      [`%${title}%`],
    );
    expect(kinds.filter((k) => k.kind === "task.submitted" && k.to === PEOPLE.buildLeader)).toHaveLength(2);
    expect(kinds.filter((k) => k.kind === "task.reviewed" && k.to === PEOPLE.buildMember)).toHaveLength(2);
  });
});

test.describe("questions", () => {
  test("member asks their leaders, a leader answers, the member resolves it", async ({ page }, info) => {
    const title = `E2E how tight should the chain be ${uniq(info.project.name)}`;

    await signIn(page, PEOPLE.buildMember);
    await page.goto("/questions/new");
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Details").fill("It skips under load. I tried adding a tensioner.");
    await page.getByRole("button", { name: "Send question" }).click();
    await expect(page).toHaveURL(/\/questions\/(?!new$)[a-z0-9]+$/);
    const threadUrl = page.url();

    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/questions");
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await page.getByLabel("Your reply").fill("About 1/4 inch of slack. Check the sprocket alignment too.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("About 1/4 inch of slack.")).toBeVisible();

    await signIn(page, PEOPLE.buildMember);
    await page.goto(threadUrl);
    await expect(page.getByText("Answered").first()).toBeVisible();
    await page.getByRole("button", { name: "Mark as resolved" }).click();
    await expect(page.getByText("Resolved").first()).toBeVisible();

    const emails = await sql<{ kind: string; to: string }>(`SELECT kind, "to" FROM "EmailLog" WHERE subject LIKE $1`, [`%${title.slice(0, 40)}%`]);
    expect(emails.some((e) => e.kind === "question.asked" && e.to === PEOPLE.buildLeader)).toBe(true);
    expect(emails.some((e) => e.kind === "question.replied" && e.to === PEOPLE.buildMember)).toBe(true);
  });
});

test.describe("settings", () => {
  test("name and email preferences are saved", async ({ page }, info) => {
    await signIn(page, PEOPLE.businessMember);
    await page.goto("/settings");
    const name = `Ava Thompson ${info.project.name}`;
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByText("Profile saved.")).toBeVisible();

    const assigned = page.getByRole("switch", { name: /assigned a new task/i });
    const before = await assigned.isChecked();
    await page.getByText("I'm assigned a new task").click();
    await expect(assigned).toBeChecked({ checked: !before });
    // Switches save on their own.
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
    await expect(page.getByRole("switch", { name: /assigned a new task/i })).toBeChecked({ checked: !before });
  });
});

test.describe("layout", () => {
  const pagesFor: Record<string, string[]> = {
    [PEOPLE.softwareMember]: [
      "/today",
      "/my-tasks",
      "/my-tasks?tab=done",
      "/tasks",
      "/tasks?view=past",
      "/attendance",
      "/questions",
      "/questions/new",
      "/resources",
      "/resources/new",
      "/parts",
      "/parts?view=done",
      "/parts/new",
      "/fundraising",
      "/fundraising/new",
      "/posters",
      "/posters?view=past",
      "/posters?who=mine",
      "/posters/new",
      "/notebook",
      "/orders",
      "/orders?filter=all",
      "/orders?mine=1",
      "/orders/new",
      "/strategy",
      "/strategy?kind=AUTO",
      "/strategy?who=mine",
      "/strategy/new",
      "/strategy/teams",
      "/strategy/teams?q=steam",
      "/strategy/teams/9040",
      "/strategy/new?team=9040",
      "/calendar",
      "/calendar?view=list",
      "/calendar?view=past",
      "/calendar?month=2026-11&kind=SCRIMMAGE",
      "/people",
      "/people?q=priya",
      "/people?q=build",
      "/people?role=BUILD_LEADER&subteam=BUILD",
      "/announcements",
      "/announcements?for=you",
      "/announcements?for=BUILD&page=2",
      "/announcements/new",
      "/discussion",
      "/discussion?category=SOFTWARE",
      "/discussion?unread=1&mine=1",
      "/discussion?q=pedro",
      "/discussion/new",
      "/discussion/demo-thread-autos",
      "/discussion/demo-thread-shirts",
      "/settings",
    ],
    [PEOPLE.buildLeader]: [
      "/manage",
      "/manage/tasks",
      "/manage/tasks/new",
      "/manage/categories",
      "/manage/review",
      "/manage/progress",
      "/attendance",
      "/attendance/plan",
      "/attendance/reports",
      // Every admin (leaders too) reads the change log.
      "/attendance/changes",
      "/questions",
      "/tasks",
      "/resources",
      "/parts",
      "/sponsors",
      "/sponsors?filter=todo",
      "/sponsors/new",
      "/sponsors/import",
      "/fundraising",
      "/fundraising/new",
      "/posters",
      "/notebook",
      "/strategy",
      "/strategy/teams",
      "/strategy/teams/new",
      "/strategy/teams/9040/edit",
      "/orders",
      "/orders?filter=done&for=BUILD",
      "/orders/new",
      "/calendar",
      "/calendar/new",
      "/calendar/season2627scrimmage0",
      "/calendar/season2627scrimmage0/edit",
      "/discussion",
      "/discussion/demo-thread-intake",
      "/discussion/demo-thread-shirts",
      "/people",
      "/announcements",
      "/announcements?for=team",
      "/announcements/new",
      "/admin",
      "/admin/users",
    ],
    [PEOPLE.admin]: [
      "/people",
      "/admin",
      "/admin/users",
      "/admin/emails",
      "/discussion/demo-thread-welcome",
      "/discussion/demo-thread-welcome/edit",
      "/announcements/new?for=BUSINESS",
      "/manage/progress?range=month",
      "/notebook",
      "/notebook/new",
      "/attendance",
      "/attendance/settings",
      "/attendance/plan",
      "/attendance/reports",
      // The demo's reports start about three weeks back: the past two weeks (0) and these two (1), with week columns.
      "/attendance/reports/0",
      "/attendance/reports/1",
      "/attendance/changes",
      "/attendance/changes?action=CREDIT_CHANGED",
    ],
  };
  for (const [email, paths] of Object.entries(pagesFor)) {
    test(`no sideways scrolling and no server errors for ${email}`, async ({ page }) => {
      await signIn(page, email);
      for (const path of paths) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBe(200);
        await expectNoHorizontalScroll(page);
      }
    });
  }
});

test.describe("mobile menu", () => {
  test("the menu drawer covers the screen and its links work (Settings, Approvals)", async ({ page }, info) => {
    test.skip(info.project.name !== "mobile", "the drawer only exists on small screens");
    await signIn(page, PEOPLE.admin);
    await page.goto("/today");
    await page.getByRole("button", { name: "Open menu" }).click();
    const dialog = page.getByRole("dialog", { name: "Menu" });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual((viewport?.height ?? 800) * 0.95);
    // Focus moves into the drawer.
    await expect(dialog.getByRole("button", { name: "Close menu" })).toBeFocused();

    // The admin's menu is taller than a phone screen, so scroll the drawer's list to it the way a person would,
    // then tap the link at its real position (no auto-scrolling tricks): nothing (like the Sign out bar) covers it.
    const settings = dialog.getByRole("link", { name: "Settings" });
    await settings.scrollIntoViewIfNeeded();
    const s = await settings.boundingBox();
    const [x, y] = [s!.x + s!.width / 2, s!.y + s!.height / 2];
    expect(await page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest("a")?.textContent, [x, y])).toBe("Settings");
    await page.mouse.click(x, y);
    await expect(page).toHaveURL(/\/settings$/);
    await expect(dialog).toHaveCount(0);

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("dialog", { name: "Menu" }).getByRole("link", { name: /Approvals/ }).click();
    await expect(page).toHaveURL(/\/admin$/);

    // Escape closes it and returns focus to the menu button.
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });
});

test.describe("admin people editing", () => {
  test("a status change survives a second save, and 'Approve anyway' really activates", async ({ page }, info) => {
    await signIn(page, PEOPLE.admin);
    // A throwaway member to disable (unique per project run).
    const email = `e2e-edit-${uniq(info.project.name)}@example.com`;
    const [{ id }] = await sql<{ id: string }>(
      `INSERT INTO "User" (id, email, name, "passwordHash", role, subteam, status, "createdAt", "updatedAt")
       SELECT 'e2e_' || md5(random()::text), $1, 'Edit Target', "passwordHash", 'MEMBER', 'BUILD', 'ACTIVE', now(), now()
       FROM "User" WHERE email = $2 RETURNING id`,
      [email, PEOPLE.admin],
    );
    await page.goto(`/admin/users/${id}`);
    await page.getByLabel("Account status").selectOption("DISABLED");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/saved/i).first()).toBeVisible();
    // Second save (only the name changes) must not undo the status change.
    await page.getByLabel("Name", { exact: true }).fill("Edit Target Renamed");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Edit Target Renamed");
    await expect
      .poll(async () => (await sql<{ status: string; name: string }>(`SELECT status, name FROM "User" WHERE id = $1`, [id]))[0])
      .toEqual({ status: "DISABLED", name: "Edit Target Renamed" });
    await expect(page.getByLabel("Account status")).toHaveValue("DISABLED");

    // Build leader seats are full (3/3): the first try is refused, ticking "Approve anyway" activates.
    const [pending] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE email = 'tyler.brooks@example.com'`);
    await page.goto(`/admin/users/${pending.id}`);
    const status = await sql<{ status: string }>(`SELECT status FROM "User" WHERE id = $1`, [pending.id]);
    test.skip(status[0].status !== "PENDING", "already approved by the other project's run");
    await page.getByLabel("Account status").selectOption("ACTIVE");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/seats filled/i).first()).toBeVisible();
    await expect(page.getByLabel("Account status")).toHaveValue("ACTIVE");
    await page.getByText("Approve anyway (over seat limit)").click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect
      .poll(async () => (await sql<{ status: string }>(`SELECT status FROM "User" WHERE id = $1`, [pending.id]))[0].status)
      .toBe("ACTIVE");
  });
});

test.describe("leaders can't drop themselves from a task", () => {
  test("'Clear all' in the edit form keeps a leader who can't remove themselves, and saving works", async ({ page }, info) => {
    const title = `E2E captain task for Marcus ${uniq(info.project.name)}`;
    const [task] = await sql<{ id: string }>(
      `WITH cap AS (SELECT id FROM "User" WHERE email = $2), t AS (
         INSERT INTO "Task" (id, title, description, subteam, "dueDate", priority, "createdById", "createdAt", "updatedAt")
         SELECT 'e2e_' || md5(random()::text), $1, '', 'BUILD', CURRENT_DATE, 'NORMAL', cap.id, now(), now() FROM cap RETURNING id)
       INSERT INTO "TaskAssignment" (id, "taskId", "userId", status, "createdAt", "updatedAt")
       SELECT 'e2e_' || md5(random()::text), t.id, u.id, 'TODO', now(), now() FROM t, "User" u WHERE u.email IN ($3, $4)
       RETURNING "taskId" AS id`,
      [title, PEOPLE.admin, PEOPLE.buildLeader, PEOPLE.buildMember],
    );
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(`/manage/tasks/${task.id}/edit`);
    const self = page.getByRole("checkbox", { name: /Marcus Johnson/ });
    await expect(self).toBeChecked();
    await expect(self).toBeDisabled();
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(self).toBeChecked();
    await page.getByRole("checkbox", { name: /Ethan Chen/ }).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/manage/tasks/${task.id}$`));
    const assignees = await sql<{ email: string }>(
      `SELECT u.email FROM "TaskAssignment" a JOIN "User" u ON u.id = a."userId" WHERE a."taskId" = $1 ORDER BY u.email`,
      [task.id],
    );
    expect(assignees.map((a) => a.email)).toEqual([PEOPLE.buildMember, PEOPLE.buildLeader].sort());
  });
});

test.describe("resources", () => {
  test("a leader adds a resource with quick links; members see it but can't change it", async ({ page }, info) => {
    const title = `E2E Team Docs ${uniq(info.project.name)}`;
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/resources");
    await page.getByRole("link", { name: "Add resource" }).first().click();
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Link", { exact: true }).fill("https://docs.example.com/team");
    await page.getByLabel("Section").fill("Team Docs");
    // A long unbroken string must not make phones scroll sideways.
    await page.getByLabel("Description").fill(`See https://docs.example.com/${"x".repeat(160)} for details`);
    await page.getByLabel("Quick links").fill("Meeting Agenda | https://docs.example.com/team?tab=agenda\nnot a link");
    await page.getByRole("button", { name: "Add resource" }).click();
    await expect(page.getByText("Line 2:", { exact: false })).toBeVisible();
    // Focus goes to the field to fix (the message at the top can be far away on a phone).
    await expect(page.getByLabel("Quick links")).toBeFocused();
    // The form kept what was typed; fix the bad line and save.
    await expect(page.getByLabel("Title")).toHaveValue(title);
    await page.getByLabel("Quick links").fill("Meeting Agenda | https://docs.example.com/team?tab=agenda");
    await page.getByText("Pin to the top").click();
    await page.getByRole("button", { name: "Add resource" }).click();
    await expect(page).toHaveURL(/\/resources$/);

    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/resources");
    const link = page.getByRole("link", { name: new RegExp(title) });
    await expect(link).toHaveAttribute("href", "https://docs.example.com/team");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(page.getByRole("link", { name: "Meeting Agenda" }).first()).toHaveAttribute("href", "https://docs.example.com/team?tab=agenda");
    await expect(page.getByRole("link", { name: "Add resource" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: `Edit ${title}` })).toHaveCount(0);
    // Members share instead (it waits for approval; see e2e/resources.spec.ts), and can't pin.
    await page.getByRole("link", { name: "Share a resource" }).first().click();
    await expect(page).toHaveURL(/\/resources\/new$/);
    await expect(page.getByText("Pin to the top")).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });
});
