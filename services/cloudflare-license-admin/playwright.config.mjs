import { defineConfig } from "@playwright/test";

const externalBaseUrl = process.env.LICENSECC_ADMIN_UI_E2E_BASE_URL;
const baseURL = externalBaseUrl ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./test",
  testMatch: /admin-ui\.e2e\.mjs$/,
  timeout: 30_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "on-first-retry",
  },
  webServer: externalBaseUrl === undefined
    ? {
        command: "npm run build:ui && npx vite preview --host 127.0.0.1 --port 4173",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
      }
    : undefined,
});
