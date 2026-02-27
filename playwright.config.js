// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    // Use Vite dev server for E2E so tests always run against the latest
    // source without needing a manual SPA rebuild.  The Vite proxy forwards
    // /api → http://localhost:5000 (the .NET backend).
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    headless: !!process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Start the Vite dev server — it hot-reloads the React SPA and proxies
  // API calls to the separately running .NET backend on port 5000.
  // Run `dotnet run --project src/PoMiniGames/PoMiniGames/PoMiniGames.csproj`
  // in a separate terminal before running Playwright.
  webServer: {
    command: 'npm --prefix src/PoMiniGames.Client run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60 * 1000,
  },
});