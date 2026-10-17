import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'history-search-shortcut.spec.ts',
  outputDir: './test-results/search-shortcut',
  workers: 1,
  use: {
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    baseURL: 'http://127.0.0.1:1437',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1437',
    url: 'http://127.0.0.1:1437', reuseExistingServer: false,
  },
});
