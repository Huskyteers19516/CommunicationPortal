import { config } from "dotenv";

config({ path: ".env.test", override: true });

// Tests never talk to a real Cloudflare R2: uploaded files stay in Postgres unless a test starts its own fake
// (tests/helpers/fake-s3.ts) and sets these itself.
for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"]) delete process.env[name];
