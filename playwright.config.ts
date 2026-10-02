import { defineConfig } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const runId = (process.env.FORUM_E2E_RUN_ID ||= randomBytes(5).toString("hex"));
const sessionSecret = randomBytes(48).toString("base64");
const modes = ["pass", "hold", "error"] as const;
const portFor = (index: number) => 3141 + index;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
  },
  projects: modes.map((mode, index) => ({
    name: mode,
    metadata: { databasePath: resolve(`data/e2e-${runId}-${mode}.sqlite`) },
    testMatch: mode === "pass" ? "forum.spec.ts" : "privacy.spec.ts",
    use: { baseURL: `http://127.0.0.1:${portFor(index)}` },
  })),
  webServer: modes.map((mode, index) => ({
    command: "node scripts/start-e2e.mjs",
    url: `http://127.0.0.1:${portFor(index)}`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      PORT: String(portFor(index)),
      BETTER_AUTH_SECRET: sessionSecret,
      BETTER_AUTH_URL: `http://127.0.0.1:${portFor(index)}`,
      SITE_URL: `http://127.0.0.1:${portFor(index)}`,
      DATABASE_PATH: resolve(`data/e2e-${runId}-${mode}.sqlite`),
      NEXT_DIST_DIR: `.next-e2e-${mode}`,
      JEV_MOCK: mode,
    },
  })),
});
