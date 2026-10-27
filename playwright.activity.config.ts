import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['workspace-activity.spec.ts', 'workspace-focus-mode.spec.ts', 'workspace-files.spec.ts', 'explorer.spec.ts'],
  outputDir: './test-results/activity',
  timeout: 30_000,
  workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    headless: true,
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1438',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1438',
    url: 'http://127.0.0.1:1438',
    reuseExistingServer: false,
  },
});
