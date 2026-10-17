import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/interactions',
  testDir: './tests/browser', testMatch: 'interactions.spec.ts', workers: 1,
  use: { browserName: 'chromium', channel: 'chrome', headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromiumSandbox: true },
    viewport: { width: 1200, height: 850 }, baseURL: 'http://127.0.0.1:1437' },
  webServer: { command: 'npm run dev:web -- --port 1437', url: 'http://127.0.0.1:1437', reuseExistingServer: false },
});
