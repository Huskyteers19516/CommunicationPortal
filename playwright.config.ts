import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against a production build (`npm run build` first), in the locally installed Chrome.
// A dedicated database (portal_e2e) is rebuilt with the demo team before every run.
export const E2E_PORT = 3100;
export const E2E_DATABASE_URL = "postgresql://postgres:postgres@localhost:54329/portal_e2e";
export const E2E_JOIN_CODE = "go-huskies";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e-results",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" } },
  ],
  webServer: {
    command: `npx next start -p ${E2E_PORT}`,
    url: `http://localhost:${E2E_PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      APP_URL: `http://localhost:${E2E_PORT}`,
      ADMIN_EMAILS: "",
      TEAM_JOIN_CODE: E2E_JOIN_CODE,
      TEAM_TIMEZONE: "America/Los_Angeles",
      SMTP_HOST: "",
      DISCORD_WEBHOOK_URL: "",
      RESEND_API_KEY: "",
      // Uploaded files stay in the e2e database, even if a local .env has Cloudflare R2 settings (set-but-empty values
      // win: Next's .env loading never overrides a variable that's already defined).
      R2_ACCOUNT_ID: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
      R2_BUCKET: "",
      R2_ENDPOINT: "",
    },
  },
});
