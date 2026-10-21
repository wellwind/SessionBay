import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/git-workbench',
  testDir: './tests/browser', testMatch: 'git-workbench.spec.ts', workers: 1,
  use: { browserName: 'chromium', channel: 'chrome', headless: true, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromiumSandbox: true },
    viewport: { width: 1200, height: 850 }, baseURL: 'http://127.0.0.1:1447' },
  webServer: { command: 'npm run dev:web -- --port 1447', url: 'http://127.0.0.1:1447', reuseExistingServer: false },
});
