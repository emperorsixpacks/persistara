import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({ testDir: "e2e", workers: 1, fullyParallel: false, timeout: 40_000,
  use: { baseURL: "http://127.0.0.1:4387", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  outputDir: "../../test-results", reporter: "list",
  webServer: { command: "node dist/tests/fixtures/owner-browser.js", cwd: fileURLToPath(new URL("../..", import.meta.url)), url: "http://127.0.0.1:4387/api/info", reuseExistingServer: false, timeout: 20_000, env: { PERSISTARA_FIXTURE_CONTROL_TOKEN: "owner-browser-fixture-only" } },
});
