import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['workspace-focus-mode.spec.ts', 'workspace-activity.spec.ts', 'project-navigation-pointer.spec.ts', 'viewport-layout.spec.ts', 'workspace-overview.spec.ts'],
  outputDir: './test-results/focus-mode',
  timeout: 30_000,
  workers: 1,
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    launchOptions: { chromiumSandbox: true },
    viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1424',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1424',
    url: 'http://127.0.0.1:1424',
    reuseExistingServer: false,
  },
});
