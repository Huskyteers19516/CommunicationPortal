// Centralised, typed access to runtime configuration.

/** Where Cloudflare R2 (uploaded files) is reached, and with which key. Server-only: never send it to a page. */
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * https://<account id>.r2.cloudflarestorage.com, unless R2_ENDPOINT overrides it (tests use a local fake; on the live
   * site it can only be another Cloudflare R2 address, e.g. an EU bucket's …eu.r2.cloudflarestorage.com).
   */
  endpoint: string;
}

/** The R2_* settings as found: all four set (on), none (off), some (partial), or set but unusable (invalid). */
export type R2Status =
  | { state: "on"; config: R2Config }
  | { state: "off" }
  | { state: "partial"; missing: string[] }
  | { state: "invalid"; problem: string };

/** The four settings that must all be set for uploaded files to go to Cloudflare R2. */
export const R2_REQUIRED_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;

/** Cloudflare R2's S3 addresses (<account>.r2.cloudflarestorage.com, and jurisdictions like <account>.eu.r2…). */
const R2_HOST_SUFFIX = ".r2.cloudflarestorage.com";

/**
 * An http(s) endpoint without credentials, query, or fragment; plain http only for this computer (tests). In
 * production only an https Cloudflare R2 address: a stray or mistyped R2_ENDPOINT in Vercel must never send signed
 * requests and everyone's files to some other server.
 */
function r2Endpoint(raw: string, production: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  if (production && (url.protocol !== "https:" || !url.hostname.endsWith(R2_HOST_SUFFIX))) return null;
  return url.origin;
}

/** Reads the R2_* settings (see R2Status). Values are never included in problems, only variable names. */
export function readR2Status(source: Record<string, string | undefined> = process.env): R2Status {
  const values = Object.fromEntries(R2_REQUIRED_VARS.map((name) => [name, source[name]?.trim() ?? ""])) as Record<
    (typeof R2_REQUIRED_VARS)[number],
    string
  >;
  const missing = R2_REQUIRED_VARS.filter((name) => !values[name]);
  if (missing.length === R2_REQUIRED_VARS.length) return { state: "off" };
  if (missing.length > 0) return { state: "partial", missing };
  const accountId = values.R2_ACCOUNT_ID;
  const bucket = values.R2_BUCKET;
  if (!/^[A-Za-z0-9]{1,64}$/.test(accountId)) {
    return { state: "invalid", problem: "R2_ACCOUNT_ID should be the Account ID from Cloudflare (letters and numbers only)." };
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    return { state: "invalid", problem: "R2_BUCKET should be the bucket's name (lowercase letters, numbers, and dashes)." };
  }
  const override = source.R2_ENDPOINT?.trim();
  const production = source.NODE_ENV === "production";
  const endpoint = override ? r2Endpoint(override, production) : `https://${accountId.toLowerCase()}${R2_HOST_SUFFIX}`;
  if (!endpoint) {
    return {
      state: "invalid",
      problem: production
        ? "R2_ENDPOINT should be left empty in Vercel (on the live site it can only be a Cloudflare R2 address, https://….r2.cloudflarestorage.com)."
        : "R2_ENDPOINT should be left empty (it's only for tests).",
    };
  }
  return {
    state: "on",
    config: { accountId, accessKeyId: values.R2_ACCESS_KEY_ID, secretAccessKey: values.R2_SECRET_ACCESS_KEY, bucket, endpoint },
  };
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  get appUrl(): string {
    // VERCEL_PROJECT_PRODUCTION_URL is the stable production domain; VERCEL_URL changes every deploy.
    const raw =
      process.env.APP_URL ||
      (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
      (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
    return raw.replace(/\/+$/, "");
  },
  get teamTimezone(): string {
    return process.env.TEAM_TIMEZONE || "America/Los_Angeles";
  },
  get adminEmails(): string[] {
    return list(process.env.ADMIN_EMAILS);
  },
  get teamJoinCode(): string | null {
    const code = process.env.TEAM_JOIN_CODE?.trim();
    return code ? code : null;
  },
  get emailFrom(): string {
    return process.env.EMAIL_FROM || "Huskyteers Portal <no-reply@example.com>";
  },
  get smtp() {
    const host = process.env.SMTP_HOST?.trim();
    if (!host) return null;
    const port = Number(process.env.SMTP_PORT || 465);
    return {
      host,
      port,
      secure: port === 465,
      user: process.env.SMTP_USER ?? "",
      pass: process.env.SMTP_PASS ?? "",
    };
  },
  get resendApiKey(): string | null {
    return process.env.RESEND_API_KEY?.trim() || null;
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
  /**
   * Origins (comma-separated) besides the team website that may read GET /api/public/progress from a browser, e.g.
   * `http://localhost:4321` while working on the team website locally. Optional; parsed by parseExtraOrigins.
   */
  get publicProgressExtraOrigins(): string {
    return process.env.PUBLIC_PROGRESS_EXTRA_ORIGINS ?? "";
  },
  /**
   * Cloudflare R2 for uploaded files: on only when R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET
   * are all set (and look right). Otherwise files stay in Postgres. Read on every call, so a redeploy with new
   * settings (or a test) takes effect right away.
   */
  get r2Status(): R2Status {
    return readR2Status();
  },
  get r2(): R2Config | null {
    const status = readR2Status();
    return status.state === "on" ? status.config : null;
  },
};
