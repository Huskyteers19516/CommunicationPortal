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
  await shoot(page, p, "16u-member-attendance", "/attendance");
  await shoot(page, p, "16g-member-parts", "/parts");
  await shoot(page, p, "16h-member-add-part", "/parts/new");
  await shoot(page, p, "16i-member-fundraising", "/fundraising");
  const [fundraiser] = await sql<{ id: string }>(`SELECT id FROM "Fundraiser" WHERE status = 'ACTIVE' ORDER BY "createdAt" LIMIT 1`);
  if (fundraiser) await shoot(page, p, "16j-member-fundraiser", `/fundraising/${fundraiser.id}`);
  await shoot(page, p, "16k-member-posters", "/posters");
  await shoot(page, p, "16l-member-posters-past", "/posters?view=past");
  await shoot(page, p, "16m-member-add-poster", "/posters/new");
  const [poster] = await sql<{ id: string }>(
    `SELECT p.id FROM "Poster" p JOIN "PosterFile" f ON f."posterId" = p.id WHERE p."eventDate" IS NOT NULL ORDER BY p."eventDate" DESC LIMIT 1`,
  );
  if (poster) await shoot(page, p, "16n-member-poster", `/posters/${poster.id}`);
  await shoot(page, p, "16r-member-orders", "/orders");
  await shoot(page, p, "16s-member-add-order", "/orders/new");
  const [orderItem] = await sql<{ id: string }>(`SELECT id FROM "PurchaseItem" WHERE status = 'APPROVED' ORDER BY "createdAt" LIMIT 1`);
  if (orderItem) await shoot(page, p, "16t-member-order", `/orders/${orderItem.id}`);
  await shoot(page, p, "16o-member-strategy", "/strategy");
  await shoot(page, p, "16p-member-add-strategy", "/strategy/new");
  const [strategy] = await sql<{ id: string }>(
    `SELECT s.id FROM "Strategy" s JOIN "StrategyFile" f ON f."strategyId" = s.id WHERE s."teamId" IS NULL ORDER BY s."createdAt" LIMIT 1`,
  );
  if (strategy) {
    await shoot(page, p, "16q-member-strategy-detail", `/strategy/${strategy.id}`);
  }
  await shoot(page, p, "16q2-member-other-teams", "/strategy/teams");
  await shoot(page, p, "16q3-member-other-team", "/strategy/teams/9040");
  await shoot(page, p, "16q4-member-add-strategy-about-team", "/strategy/new?team=9040");
  await shoot(page, p, "16t1-member-calendar", "/calendar?month=2026-11");
  await shoot(page, p, "16t2-member-calendar-list", "/calendar?view=list");
  await shoot(page, p, "16t3-member-calendar-event", "/calendar/season2627scrimmage0");
  await shoot(page, p, "16u3-member-team-members", "/people");
  await shoot(page, p, "16u4-member-team-members-search", "/people?role=BUILD_LEADER");
  await shoot(page, p, "16u5-member-announcements", "/announcements");
  await shoot(page, p, "16u6-member-announcements-for-you", "/announcements?for=you");
  await shoot(page, p, "16u7-member-discussion", "/discussion");
  await shoot(page, p, "16u8-member-discussion-thread", "/discussion/demo-thread-autos");
  await shoot(page, p, "16u9-member-start-discussion", "/discussion/new");
  await shoot(page, p, "16v-member-notebook", "/notebook");
  const [notebookPage] = await sql<{ id: string }>(
    `SELECT p.id FROM "NotebookPage" p JOIN "NotebookEntry" e ON e."pageId" = p.id GROUP BY p.id ORDER BY count(*) DESC, p.id LIMIT 1`,
  );
  if (notebookPage) {
    await shoot(page, p, "16w-member-notebook-page", `/notebook/p/${notebookPage.id}`);
    await page.getByRole("button", { name: "New entry" }).click();
    await page.screenshot({ path: `${dir(p)}/16x-member-notebook-new-entry.png`, fullPage: true });
    await shoot(page, p, "16y-member-notebook-print", `/notebook/print/p/${notebookPage.id}`);
  }
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
  await shoot(page, p, "37b-leader-attendance-plan", "/attendance/plan");
  await shoot(page, p, "37c-leader-attendance-reports", "/attendance/reports");
  const report = await page.locator('a[href^="/attendance/reports/"]').first().getAttribute("href");
  if (report) await shoot(page, p, "37d-leader-attendance-report", report);
  await shoot(page, p, "37e-leader-notebook", "/notebook");
  await shoot(page, p, "37f-leader-team-members", "/people");
  await shoot(page, p, "37g-leader-announcements", "/announcements");
  await shoot(page, p, "37h-leader-post-announcement", "/announcements/new");
  await shoot(page, p, "37i-leader-discussion-locked", "/discussion/demo-thread-shirts");
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
  await shoot(page, p, "39f-business-fundraising", "/fundraising");
  await shoot(page, p, "39g-business-add-fundraiser", "/fundraising/new");
  await shoot(page, p, "39j-business-orders", "/orders");
  await shoot(page, p, "39k-business-orders-all", "/orders?filter=all");
  await shoot(page, p, "39l-business-add-order", "/orders/new");
  const [orderItem] = await sql<{ id: string }>(`SELECT id FROM "PurchaseItem" WHERE status = 'REQUESTED' ORDER BY "createdAt" LIMIT 1`);
  if (orderItem) await shoot(page, p, "39m-business-edit-order", `/orders/${orderItem.id}`);
  const [fundraiser] = await sql<{ id: string }>(`SELECT id FROM "Fundraiser" WHERE status = 'UPCOMING' ORDER BY "startsOn" LIMIT 1`);
  if (fundraiser) {
    await shoot(page, p, "39h-business-fundraiser", `/fundraising/${fundraiser.id}`);
    await shoot(page, p, "39i-business-edit-fundraiser", `/fundraising/${fundraiser.id}?edit=1`);
  }
});

test("admin", async ({ page }, info) => {
  const p = info.project.name;
  await signIn(page, PEOPLE.admin);
  const [pending] = await sql<{ id: string }>(`SELECT id FROM "User" WHERE status = 'PENDING' ORDER BY "createdAt" LIMIT 1`);
  await shoot(page, p, "40-admin-approvals", "/admin");
  await shoot(page, p, "41-admin-people", "/admin/users");
  await shoot(page, p, "41b-admin-team-members", "/people");
  if (pending) await shoot(page, p, "42-admin-person", `/admin/users/${pending.id}`);
  await shoot(page, p, "43-admin-emails", "/admin/emails");
  await shoot(page, p, "44-captain-overview", "/manage");
  await shoot(page, p, "45-captain-progress", "/manage/progress?range=month");
  await shoot(page, p, "45a-captain-add-other-team", "/strategy/teams/new");
  await shoot(page, p, "45b-captain-notebook", "/notebook");
  await shoot(page, p, "45d-captain-add-event", "/calendar/new");
  await shoot(page, p, "45e-captain-post-announcement", "/announcements/new");
  const [announcement] = await sql<{ id: string }>(`SELECT id FROM "Announcement" ORDER BY pinned DESC, "createdAt" DESC LIMIT 1`);
  if (announcement) await shoot(page, p, "45f-captain-edit-announcement", `/announcements/${announcement.id}/edit`);
  await shoot(page, p, "45g-captain-edit-discussion", "/discussion/demo-thread-welcome/edit");
  await shoot(page, p, "45c-captain-new-notebook", "/notebook/new");
  const [notebook] = await sql<{ id: string }>(`SELECT id FROM "Notebook" ORDER BY position LIMIT 1`);
  if (notebook) await shoot(page, p, "45d-captain-edit-notebook", `/notebook/n/${notebook.id}/edit`);
  await shoot(page, p, "46-captain-attendance", "/attendance");
  await shoot(page, p, "47-captain-attendance-schedule", "/attendance/settings");
  const [session] = await sql<{ id: string }>(`SELECT id FROM "AttendanceSession" ORDER BY date DESC, kind LIMIT 1`);
  if (session) await shoot(page, p, "48-captain-attendance-session", `/attendance/sessions/${session.id}`);
  // The last full two weeks: each person's week 1 and week 2 toward the weekly goal.
  await shoot(page, p, "48b-captain-attendance-report-weeks", "/attendance/reports/0");
  // The admins' change log (people added by hand, taken off, credits changed).
  await shoot(page, p, "48c-captain-attendance-changes", "/attendance/changes");
});
