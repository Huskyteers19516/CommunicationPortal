import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Tomorrow in the team's timezone (YYYY-MM-DD): due soon, so it's under "Coming up" on Today until it's done. */
function tomorrow(): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The leader's example: a Build task for Ethan and Isabella, due tomorrow. Isabella's item is approved one by one
 * (like Paige's); Ethan's is still to do (like Grant's). Returns the task's id.
 */
async function drivetrain(page: Page, title: string): Promise<string> {
  await signIn(page, PEOPLE.buildLeader);
  await page.goto("/manage/tasks/new");
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Due date").fill(tomorrow());
  await page.getByRole("checkbox", { name: /Ethan Chen/ }).check();
  await page.getByRole("checkbox", { name: /Isabella Rossi/ }).check();
  await page.getByRole("button", { name: "Create task for 2" }).click();
  await expect(page).toHaveURL(/\/manage\/tasks\/(?!new$)[a-z0-9]+$/);
  const [task] = await sql<{ id: string }>(`SELECT id FROM "Task" WHERE title = $1`, [title]);
  await sql(
    `UPDATE "TaskAssignment" a SET status = 'APPROVED', "submittedAt" = now(), "reviewedAt" = now(),
       "reviewedById" = (SELECT id FROM "User" WHERE email = $2)
     FROM "User" u WHERE u.id = a."userId" AND u.email = $3 AND a."taskId" = $1`,
    [task.id, PEOPLE.buildLeader, PEOPLE.buildMember2],
  );
  return task.id;
}

test.describe("mark a whole task finished", () => {
  test("a build leader counts it as done for everyone: 2/2, Finished, off Ethan's Today; reopening puts it back", async ({ page }, info) => {
    const title = `E2E drivetrain construction ${uniq(info.project.name)}`;
    const id = await drivetrain(page, title);

    // Before: on Ethan's Today (coming up), and on the active dashboard.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await expect(page.getByRole("checkbox", { name: `Check off: ${title}` })).toBeVisible();

    // The leader marks it finished from the manage page.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(`/manage/tasks/${id}`);
    await expect(page.getByText("1 approved · 1 to do")).toBeVisible();
    await page.getByRole("button", { name: "Mark task finished" }).click();
    const dialog = page.getByRole("dialog", { name: "Mark this task finished?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Ethan Chen hasn't been approved yet.")).toBeVisible();
    // One person left: the choices name him.
    await expect(dialog.getByRole("radio", { name: /Count it as done for Ethan/ })).toBeChecked();
    await expectNoHorizontalScroll(page);
    await dialog.getByRole("button", { name: "Mark finished" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reopen task" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Task marked finished." })).toHaveText(
      "Task marked finished. 1 person counted as done.",
    );
    await expect(page.getByText("Finished", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Marked finished by you/)).toBeVisible();
    await expect(page.getByText("2 approved")).toBeVisible();
    await expect(page.locator("li").filter({ hasText: "Ethan Chen" }).getByText("Counted as done when the task was marked finished.")).toBeVisible();
    const [row] = await sql<{ status: string; finishedWithTask: boolean; statusBeforeFinish: string }>(
      `SELECT a.status, a."finishedWithTask", a."statusBeforeFinish" FROM "TaskAssignment" a JOIN "User" u ON u.id = a."userId"
       WHERE a."taskId" = $1 AND u.email = $2`,
      [id, PEOPLE.buildMember],
    );
    expect(row).toEqual({ status: "APPROVED", finishedWithTask: true, statusBeforeFinish: "TODO" });

    // The dashboard: past (not active), Finished, 2/2.
    await page.goto("/tasks?subteam=BUILD");
    await expect(page.getByRole("article", { name: title })).toHaveCount(0);
    await page.goto("/tasks?view=past&subteam=BUILD");
    const card = page.getByRole("article", { name: title });
    await expect(card.getByText("Finished", { exact: true })).toBeVisible();
    await page.goto(`/tasks/${id}`);
    await expect(page.getByText("2/2")).toBeVisible();
    await expect(page.getByText("2 done")).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Gone from Ethan's Today; listed as done.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await expect(page.getByRole("checkbox", { name: new RegExp(escape(title)) })).toHaveCount(0);
    await page.goto("/my-tasks?tab=done");
    await expect(page.getByRole("checkbox", { name: `Approved: ${title}` })).toBeVisible();
    await expect(page.getByText(/marked the whole task finished/).first()).toBeVisible();

    // Reopen: Ethan's item goes back to to do, Isabella's stays approved.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto(`/manage/tasks/${id}`);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Reopen task" }).click();
    await expect(page.getByRole("button", { name: "Mark task finished" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Task reopened." })).toHaveText(
      "Task reopened. 1 person went back to where they were.",
    );
    await expect(page.getByText("1 approved · 1 to do")).toBeVisible();

    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await expect(page.getByRole("checkbox", { name: `Check off: ${title}` })).toBeVisible();
  });

  test("'Just close it' from the dashboard page: Ethan's item closes without credit", async ({ page }, info) => {
    const title = `E2E intake rollers ${uniq(info.project.name)}`;
    const id = await drivetrain(page, title);

    await page.goto(`/tasks/${id}`);
    await page.getByRole("button", { name: "Mark task finished" }).click();
    const dialog = page.getByRole("dialog", { name: "Mark this task finished?" });
    await dialog.getByRole("radio", { name: /Just close it — Ethan gets no credit/ }).check();
    await dialog.getByRole("button", { name: "Mark finished" }).click();
    await expect(page.getByRole("button", { name: "Reopen task" })).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "Task marked finished." })).toHaveText(
      "Task marked finished. 1 person closed without credit.",
    );
    // "you" for the person who finished it.
    await expect(page.getByText(/Marked finished by you/)).toBeVisible();
    await expect(page.getByText("1/2")).toBeVisible();
    await expect(page.locator("li").filter({ hasText: "Ethan Chen" }).getByText("Closed")).toBeVisible();
    await expectNoHorizontalScroll(page);
    const [task] = await sql<{ done: boolean; status: string }>(
      `SELECT t."completedAt" IS NOT NULL AS done, a.status FROM "Task" t
       JOIN "TaskAssignment" a ON a."taskId" = t.id JOIN "User" u ON u.id = a."userId" WHERE t.id = $1 AND u.email = $2`,
      [id, PEOPLE.buildMember],
    );
    expect(task).toEqual({ done: true, status: "TODO" });

    // Off Ethan's Today and open list; under Done as closed.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    await expect(page.getByRole("checkbox", { name: new RegExp(escape(title)) })).toHaveCount(0);
    await page.goto("/my-tasks");
    await expect(page.getByRole("checkbox", { name: new RegExp(escape(title)) })).toHaveCount(0);
    await page.goto("/my-tasks?tab=done");
    const closed = page.getByRole("checkbox", { name: `Closed: ${title}. The task was marked finished without it.` });
    await expect(closed).toBeVisible();
    await expect(closed).toBeDisabled();
  });

  test("taking one person's credit back on a finished task: confirm, a status line, and the row says it doesn't count", async ({
    page,
  }, info) => {
    const title = `E2E chain tensioner ${uniq(info.project.name)}`;
    const id = await drivetrain(page, title);
    await page.goto(`/manage/tasks/${id}`);
    await page.getByRole("button", { name: "Mark task finished" }).click();
    await page.getByRole("dialog", { name: "Mark this task finished?" }).getByRole("button", { name: "Mark finished" }).click();
    await expect(page.getByRole("button", { name: "Reopen task" })).toBeFocused();

    const ethan = page.locator("li").filter({ hasText: "Ethan Chen" });
    let confirmText = "";
    page.once("dialog", (d) => {
      confirmText = d.message();
      void d.accept();
    });
    await ethan.getByRole("button", { name: "Take back Ethan Chen's credit" }).click();
    const status = ethan.getByRole("status");
    await expect(status).toHaveText("Credit taken back — it no longer counts for them. The task stays finished.");
    await expect(status).toBeVisible();
    await expect(status).toBeFocused();
    expect(confirmText).toBe("Ethan Chen will no longer count for this task. The task stays finished.");
    await expect(ethan.getByText("Doesn't count — the task was marked finished without it.")).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Reopening the task now puts nobody back, and its confirm doesn't promise to.
    page.once("dialog", (d) => {
      confirmText = d.message();
      void d.accept();
    });
    await page.getByRole("button", { name: "Reopen task" }).click();
    await expect(page.getByRole("button", { name: "Mark task finished" })).toBeFocused();
    expect(confirmText).toBe("Reopen this task? People can check it off and sign up again.");
  });

  test("a stale check-off after 'Count it as done' says so calmly instead of showing an error", async ({ page }, info) => {
    const title = `E2E wheel pods ${uniq(info.project.name)}`;
    const id = await drivetrain(page, title);

    await signIn(page, PEOPLE.buildMember);
    await page.goto("/today");
    const box = page.getByRole("checkbox", { name: `Check off: ${title}` });
    await expect(box).toBeVisible();
    // Meanwhile Marcus counts it as done for everyone (what finishTask writes).
    await sql(
      `WITH lead AS (SELECT id FROM "User" WHERE email = $2)
       UPDATE "TaskAssignment" SET "statusBeforeFinish" = status, status = 'APPROVED', "finishedWithTask" = true,
         "reviewedById" = (SELECT id FROM lead), "reviewedAt" = now(), "updatedAt" = now()
       WHERE "taskId" = $1 AND status <> 'APPROVED'`,
      [id, PEOPLE.buildLeader],
    );
    await sql(`UPDATE "Task" SET "completedAt" = now(), "completedById" = (SELECT id FROM "User" WHERE email = $2) WHERE id = $1`, [
      id,
      PEOPLE.buildLeader,
    ]);

    await box.click();
    const notice = page.getByRole("status").filter({ hasText: "marked the whole task finished" });
    await expect(notice).toHaveText("Marcus Johnson marked the whole task finished — it counts as done for you.");
    await expect(notice).toBeFocused();
    // Shown as done in place, with no red error.
    const item = page.locator("li").filter({ hasText: title });
    await expect(item.getByText("Done — the whole task was marked finished")).toBeVisible();
    await expect(item.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("the Business leader's whole-team tasks", () => {
  test("the Business leader creates a whole-team task for a build member and a software member", async ({ page }, info) => {
    const title = `E2E car wash crew ${uniq(info.project.name)}`;
    await signIn(page, PEOPLE.businessLeader);

    // The Whole team section of the dashboard has "New task" for them.
    await page.goto("/tasks?subteam=TEAM");
    await expect(page.getByRole("region", { name: /^Whole team/ }).getByRole("link", { name: "New task", exact: true })).toBeVisible();

    await page.goto("/manage/tasks/new");
    // A Business task lists Business people only, and says how to get everyone…
    await expect(page.getByLabel("Subteam")).toHaveValue("BUSINESS");
    await expect(page.getByRole("checkbox", { name: /Ethan Chen/ })).toHaveCount(0);
    await expect(page.getByText("Need people from other subteams? Choose Whole team.")).toBeVisible();
    // …a whole-team task lists everyone.
    await page.getByLabel("Subteam").selectOption({ label: "Whole team" });
    await page.getByLabel("Title").fill(title);
    await page.getByRole("checkbox", { name: /Ethan Chen/ }).check();
    await page.getByRole("checkbox", { name: /Maya Patel/ }).check();
    // Existing whole-team categories can be picked, but not added to.
    await expect(page.getByLabel("Category").locator("option", { hasText: "New category…" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Create task for 2" }).click();
    await expect(page).toHaveURL(/\/manage\/tasks\/(?!new$)[a-z0-9]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByText("Whole team", { exact: true }).first()).toBeVisible();

    const rows = await sql<{ subteam: string | null; creator: string; assignee: string }>(
      `SELECT t.subteam, c.email AS creator, u.email AS assignee FROM "Task" t
       JOIN "User" c ON c.id = t."createdById" JOIN "TaskAssignment" a ON a."taskId" = t.id JOIN "User" u ON u.id = a."userId"
       WHERE t.title = $1 ORDER BY u.email`,
      [title],
    );
    expect(rows).toEqual([
      { subteam: null, creator: PEOPLE.businessLeader, assignee: PEOPLE.buildMember },
      { subteam: null, creator: PEOPLE.businessLeader, assignee: PEOPLE.softwareMember },
    ]);

    // It's on both people's checklists.
    for (const email of [PEOPLE.buildMember, PEOPLE.softwareMember]) {
      await signIn(page, email);
      await page.goto("/today");
      await expect(page.getByRole("checkbox", { name: `Check off: ${title}` }), email).toBeVisible();
    }

    // Questions about it go to Amara (she runs it), not to the captain by default.
    const [task] = await sql<{ id: string }>(`SELECT id FROM "Task" WHERE title = $1`, [title]);
    await page.goto(`/questions/new?taskId=${task.id}`);
    await expect(page.getByRole("radio", { name: /Amara Okafor/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Captain/ })).not.toBeChecked();
  });
});
