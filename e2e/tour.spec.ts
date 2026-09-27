import { test } from "@playwright/test";
import { PEOPLE, signIn, sql } from "./helpers";

// Visual tour: full-page screenshots of every screen for each role, at phone and desktop sizes.
//   TOUR=1 npx playwright test e2e/tour.spec.ts   → e2e-artifacts/tour/<project>/*.png
test.skip(!process.env.TOUR, "set TOUR=1 to capture the screenshot tour");

const dir = (project: string) => `e2e-artifacts/tour/${project}`;

async function shoot(page: import("@playwright/test").Page, project: string, name: string, path: string) {
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${dir(project)}/${name}.png`, fullPage: true });
}

test("signed out", async ({ page }, info) => {
  await page.context().clearCookies();
  await shoot(page, info.project.name, "00-login", "/login");
  await shoot(page, info.project.name, "01-register", "/register");
  await page.getByLabel("Your position").selectOption("MEMBER");
  await page.screenshot({ path: `${dir(info.project.name)}/01b-register-member.png`, fullPage: true });
  await shoot(page, info.project.name, "02-forgot-password", "/forgot-password");
  await shoot(page, info.project.name, "03-reset-invalid", "/reset-password?token=nope");
});

test("pending account", async ({ page }, info) => {
  await signIn(page, "tyler.brooks@example.com");
  await shoot(page, info.project.name, "04-pending", "/pending");
});

test("member", async ({ page }, info) => {
  const p = info.project.name;
  await signIn(page, PEOPLE.softwareMember);
  const [q] = await sql<{ id: string }>(
    `SELECT q.id FROM "Question" q JOIN "User" u ON u.id = q."askerId" WHERE u.email = $1 ORDER BY q."createdAt" LIMIT 1`,
    [PEOPLE.softwareMember],
  );
  await shoot(page, p, "10-member-today", "/today");
  await shoot(page, p, "11-member-my-tasks", "/my-tasks");
  await shoot(page, p, "12-member-my-tasks-done", "/my-tasks?tab=done");
  await shoot(page, p, "13-member-questions", "/questions");
  await shoot(page, p, "14-member-ask", "/questions/new");
  if (q) await shoot(page, p, "15-member-thread", `/questions/${q.id}`);
  await shoot(page, p, "16-member-settings", "/settings");
  await shoot(page, p, "16b-member-resources", "/resources");
  await shoot(page, p, "16e-member-dashboard", "/tasks");
  await shoot(page, p, "16g-member-parts", "/parts");
  await shoot(page, p, "16h-member-add-part", "/parts/new");
  const [signupTask] = await sql<{ id: string }>(`SELECT id FROM "Task" WHERE "signupOpen" = true ORDER BY "dueDate" LIMIT 1`);
  if (signupTask) await shoot(page, p, "16f-member-dashboard-task", `/tasks/${signupTask.id}`);
  await shoot(page, p, "16c-member-share-resource", "/resources/new");
  const [codeFile] = await sql<{ id: string }>(
    `SELECT r.id FROM "Resource" r JOIN "ResourceFile" f ON f."resourceId" = r.id WHERE r.status = 'APPROVED' ORDER BY r."createdAt" LIMIT 1`,
  );
  if (codeFile) await shoot(page, p, "16d-member-resource-file", `/resources/${codeFile.id}`);
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) {
    await page.goto("/today");
    await menu.click();
    await page.screenshot({ path: `${dir(p)}/17-member-menu.png` });
  }
});

test("member with changes requested", async ({ page }, info) => {
  const [who] = await sql<{ email: string }>(
    `SELECT u.email FROM "TaskAssignment" a JOIN "User" u ON u.id = a."userId" WHERE a.status = 'REJECTED' AND u.role = 'MEMBER' LIMIT 1`,
  );
  if (!who) return;
  await signIn(page, who.email);
  await shoot(page, info.project.name, "18-member-today-needs-changes", "/today");
});

test("build leader", async ({ page }, info) => {
  const p = info.project.name;
  await signIn(page, PEOPLE.buildLeader);
  const [task] = await sql<{ id: string }>(
    `SELECT t.id FROM "Task" t JOIN "TaskAssignment" a ON a."taskId" = t.id WHERE t.subteam = 'BUILD' GROUP BY t.id ORDER BY count(*) DESC LIMIT 1`,
  );
  const [member] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE email = $1`, [PEOPLE.buildMember]);
  const [q] = await sql<{ id: string }>(`SELECT id FROM "Question" WHERE subteam = 'BUILD' ORDER BY "createdAt" LIMIT 1`);
  await shoot(page, p, "20-leader-today", "/today");
  await shoot(page, p, "21-leader-overview", "/manage");
  await shoot(page, p, "22-leader-tasks", "/manage/tasks");
  await shoot(page, p, "23-leader-new-task", "/manage/tasks/new");
  if (task) await shoot(page, p, "24-leader-task-detail", `/manage/tasks/${task.id}`);
  if (task) await shoot(page, p, "25-leader-task-edit", `/manage/tasks/${task.id}/edit`);
  await shoot(page, p, "26-leader-review", "/manage/review");
  await shoot(page, p, "27-leader-progress", "/manage/progress?range=week");
  if (member) await shoot(page, p, "28-leader-member-progress", `/manage/progress/${member.id}?range=week`);
  await shoot(page, p, "29-leader-questions-inbox", "/questions");
  if (q) await shoot(page, p, "30-leader-thread", `/questions/${q.id}`);
  await shoot(page, p, "31-leader-settings", "/settings");
  await shoot(page, p, "32-leader-resources", "/resources");
  await shoot(page, p, "33-leader-add-resource", "/resources/new");
  await shoot(page, p, "36-leader-dashboard", "/tasks");
  await shoot(page, p, "37-leader-categories", "/manage/categories");
  await shoot(page, p, "38-leader-parts", "/parts");
  await shoot(page, p, "38b-leader-parts-done", "/parts?view=done");
  const [part] = await sql<{ id: string }>(`SELECT id FROM "Part" WHERE status = 'NEEDED' ORDER BY position LIMIT 1`);
  if (part) await shoot(page, p, "38c-leader-edit-part", `/parts/${part.id}/edit`);
  const [waiting] = await sql<{ id: string }>(`SELECT id FROM "Resource" WHERE status = 'PENDING' ORDER BY "createdAt" LIMIT 1`);
  if (waiting) await shoot(page, p, "34-leader-resource-waiting", `/resources/${waiting.id}`);
});

test("business member (sponsorships)", async ({ page }, info) => {
  const p = info.project.name;
  await signIn(page, PEOPLE.businessMember);
  await shoot(page, p, "39-business-sponsors", "/sponsors");
  await shoot(page, p, "39b-business-sponsors-todo", "/sponsors?filter=todo");
  await shoot(page, p, "39c-business-add-sponsor", "/sponsors/new");
  const [sponsor] = await sql<{ id: string }>(`SELECT id FROM "Sponsorship" WHERE notes <> '' ORDER BY name LIMIT 1`);
  if (sponsor) await shoot(page, p, "39d-business-sponsor", `/sponsors/${sponsor.id}`);
  await page.goto("/sponsors/import");
  await page
    .getByLabel("Paste rows from your spreadsheet")
    .fill("AMOUNT RECEIVED\tCOMPLETION STAGE\tBRAND/COMPANY\tEmail\tDATE ANNOUNCED\tDATE COMPLETED\tPERSON\n$250\tSubmitted\tTour Sponsor\ttour@example.com\t\t9/1\tAva\n\tsomeday\tAnother Sponsor\tnot-an-email\t\t\tBob");
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${dir(p)}/39e-business-import-preview.png`, fullPage: true });
});

test("admin", async ({ page }, info) => {
  const p = info.project.name;
  await signIn(page, PEOPLE.admin);
  const [pending] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE status = 'PENDING' ORDER BY "createdAt" LIMIT 1`);
  await shoot(page, p, "40-admin-approvals", "/admin");
  await shoot(page, p, "41-admin-people", "/admin/users");
  if (pending) await shoot(page, p, "42-admin-person", `/admin/users/${pending.id}`);
  await shoot(page, p, "43-admin-emails", "/admin/emails");
  await shoot(page, p, "44-captain-overview", "/manage");
  await shoot(page, p, "45-captain-progress", "/manage/progress?range=month");
});
