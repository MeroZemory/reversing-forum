import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";
import { fileURLToPath } from "node:url";

// Dedicated resource checks without changing the shared orchestration config.
export default defineConfig({
  ...base,
  testDir: ".",
  projects: [{ ...base.projects![0], testMatch: "resources.spec.ts" }],
  webServer: Array.isArray(base.webServer)
    ? [
        {
          ...base.webServer[0],
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
        },
      ]
    : base.webServer,
});
