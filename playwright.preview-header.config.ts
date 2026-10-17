import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', testMatch: 'preview-header.spec.ts',
  outputDir: './test-results/preview-header', workers: 1,
  use: {
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    baseURL: 'http://127.0.0.1:1441',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1441',
    url: 'http://127.0.0.1:1441', reuseExistingServer: false,
  },
});
