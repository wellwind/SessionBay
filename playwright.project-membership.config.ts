import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', testMatch: 'project-membership.spec.ts',
  outputDir: './test-results/project-membership', workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    baseURL: 'http://127.0.0.1:1442',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1442',
    url: 'http://127.0.0.1:1442', reuseExistingServer: false,
  },
});
