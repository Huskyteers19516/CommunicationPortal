import { expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E_DATABASE_URL } from "../playwright.config";

export const PASSWORD = "huskyteers123";

export const PEOPLE = {
  admin: "admin@example.com", // captain + admin
  softwareLeader: "priya.raman@example.com",
  buildLeader: "marcus.johnson@example.com",
  buildLeader2: "sofia.hernandez@example.com",
  mentor: "elena.petrova@example.com",
  softwareMember: "maya.patel@example.com",
  buildMember: "ethan.chen@example.com",
  buildMember2: "isabella.rossi@example.com",
  businessMember: "ava.thompson@example.com",
  businessLeader: "amara.okafor@example.com",
} as const;

/** Unique suffix per test run + project so desktop and mobile runs don't collide. */
export function uniq(projectName: string) {
  return `${projectName}-${Date.now().toString(36)}`;
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  // The whole suite (both projects) signs in more often than the app's per-address limit allows in 15 minutes
  // (AUTH_RATE_LIMITS.loginPerIp, sized for a school's one shared address), and every request here comes from the
  // same address — so each sign-in starts with that counter cleared. The per-email and per-account limits still apply.
  await sql(`DELETE FROM "RateLimit" WHERE key LIKE 'login:ip:%'`);
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Query the e2e database directly (for assertions about emails, etc.). */
export async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: E2E_DATABASE_URL });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** The page has no horizontal scrolling (mobile layout check). */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `page ${page.url()} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

/** Open the mobile drawer if the desktop sidebar isn't visible, so nav links can be clicked. */
export async function openNavIfNeeded(page: Page) {
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
}
