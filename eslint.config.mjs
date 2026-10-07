import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Pedro Pathing planner's static build (npm run planner:sync), not our code.
    "public/planner/**",
    // The meeting recorder's static speech-to-text files (a vendored transformers.js build and plain-JS workers).
    "public/asr/**",
  ]),
]);

export default eslintConfig;
