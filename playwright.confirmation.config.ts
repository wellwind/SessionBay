import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', testMatch: 'confirmation-enter.spec.ts',
  outputDir: './test-results/confirmation', workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    baseURL: 'http://127.0.0.1:1443',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1443',
    url: 'http://127.0.0.1:1443', reuseExistingServer: false,
  },
});
