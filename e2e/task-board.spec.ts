import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, PEOPLE, signIn, sql, uniq } from "./helpers";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test.describe("task dashboard", () => {
  test("a build leader adds a category and a sign-up task; a build member signs up and leaves; software can't sign up", async ({
    page,
  }, info) => {
    const id = uniq(info.project.name);
    const category = `E2E ${id}`.slice(0, 40);
    const title = `E2E sand the outtake plates ${id}`;

    // Build leader: "Category" on the Build section adds a category inline.
    await signIn(page, PEOPLE.buildLeader);
    await page.goto("/tasks");
    const build = page.getByRole("region", { name: /^Build/ });
    const plus = build.getByRole("button", { name: "Add a category to Build" });
    await plus.click();
    const input = build.getByLabel("New Build category");
    await expect(input).toBeFocused();
    await input.fill(category);
    await build.getByRole("button", { name: "Add", exact: true }).click();
    await expect(build.getByRole("heading", { name: new RegExp(escape(category)) })).toBeVisible();
    await expect(input).toHaveCount(0);
    await expect(plus).toBeFocused();

    // "New task in <category>" next to the new category opens the task form with Build and that category picked.
    await build.getByRole("link", { name: `New task in ${category}` }).click();
    await expect(page).toHaveURL(/\/manage\/tasks\/new\?subteam=BUILD&category=/);
    await expect(page.getByLabel("Category").locator("option:checked")).toHaveText(category);
    await page.getByLabel("Title").fill(title);
    await page.getByRole("radio", { name: /Let people sign up/ }).check();
    await page.getByLabel("Spots").fill("2");
    await page.getByRole("button", { name: "Create sign-up task" }).click();
    await expect(page).toHaveURL(/\/manage\/tasks\/(?!new$)[a-z0-9]+$/);
    await expect(page.getByText("0 of 2 spots taken · 2 left")).toBeVisible();
    const [task] = await sql<{ id: string; signupOpen: boolean; signupLimit: number; categoryName: string }>(
      `SELECT t.id, t."signupOpen", t."signupLimit", c.name AS "categoryName"
       FROM "Task" t JOIN "TaskCategory" c ON c.id = t."categoryId" WHERE t.title = $1`,
      [title],
    );
    expect(task).toMatchObject({ signupOpen: true, signupLimit: 2, categoryName: category });

    // A build member signs up from the dashboard.
    await signIn(page, PEOPLE.buildMember);
    await page.goto("/tasks?subteam=BUILD");
    let card = page.getByRole("article", { name: title });
    await expect(card.getByText("Sign-up · 0 of 2 spots taken")).toBeVisible();
    await card.getByRole("button", { name: `Sign up for ${title}` }).click();
    await expect(card.getByText("You're on it", { exact: true })).toBeVisible();
    await expect(card.getByText("Sign-up · 1 of 2 spots taken")).toBeVisible();
    // Focus follows to the new "Leave" button, and a status line says what happened.
    await expect(card.getByRole("button", { name: `Leave ${title}` })).toBeFocused();
    await expect(card.getByRole("status")).toHaveText("You're on it — it's on your Today list.");
    await expectNoHorizontalScroll(page);

    // It's on their checklist for today.
    await page.goto("/today");
    await expect(page.getByRole("checkbox", { name: `Check off: ${title}` })).toBeVisible();

    // …and they can leave again (after confirming).
    await page.goto("/tasks?subteam=BUILD");
    card = page.getByRole("article", { name: title });
    page.once("dialog", (dialog) => dialog.accept());
    await card.getByRole("button", { name: `Leave ${title}` }).click();
    await expect(card.getByRole("button", { name: `Sign up for ${title}` })).toBeVisible();
    await expect(card.getByRole("button", { name: `Sign up for ${title}` })).toBeFocused();
    await expect(card.getByRole("status")).toHaveText("You left this task.");
    await page.goto("/today");
    await expect(page.getByRole("checkbox", { name: `Check off: ${title}` })).toHaveCount(0);

    // A software member sees the task (on the full dashboard) but can't sign up for it.
    await signIn(page, PEOPLE.softwareMember);
    await page.goto("/tasks");
    await expectNoHorizontalScroll(page);
    card = page.getByRole("article", { name: title });
    await expect(card).toBeVisible();
    await expect(card.getByRole("button", { name: /Sign up/ })).toHaveCount(0);
    await card.getByRole("link", { name: title }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
    await expect(page.getByText("Only Build members can sign up.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Sign up/ })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test("the dashboard and a task page have no sideways scrolling for each role", async ({ page }) => {
    const [signupTask] = await sql<{ id: string }>(`SELECT id FROM "Task" WHERE "signupOpen" = true ORDER BY "dueDate" LIMIT 1`);
    for (const email of [PEOPLE.softwareMember, PEOPLE.buildLeader, PEOPLE.admin]) {
      await signIn(page, email);
      for (const path of ["/tasks", "/tasks?view=past", "/tasks?open=1", "/tasks?subteam=TEAM", `/tasks/${signupTask.id}`]) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBe(200);
        await expectNoHorizontalScroll(page);
      }
    }
    await signIn(page, PEOPLE.buildLeader);
    const res = await page.goto("/manage/categories");
    expect(res?.status()).toBe(200);
    await expectNoHorizontalScroll(page);
  });
});
