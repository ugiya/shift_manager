import { defineConfig, devices } from "@playwright/test";

// The app is served single-origin by FastAPI (which also serves the built SPA),
// so e2e runs against http://127.0.0.1:8000. Playwright starts the backend if it
// isn't already running. Requires: `npm run build` first, and Java on JAVA_HOME.
const JAVA_HOME = process.env.JAVA_HOME || "/opt/homebrew/opt/openjdk@21";

// Drive the installed Brave browser (Chromium-based) via the Playwright CLI,
// rather than downloading Playwright's bundled Chromium. Override with BRAVE_PATH.
const BRAVE_PATH =
  process.env.BRAVE_PATH || "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "brave",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: BRAVE_PATH },
      },
    },
  ],
  webServer: {
    command: `cd ../backend && JAVA_HOME=${JAVA_HOME} .venv/bin/python -m uvicorn app.main:app --port 8000 --host 127.0.0.1`,
    url: "http://127.0.0.1:8000/api/health",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
