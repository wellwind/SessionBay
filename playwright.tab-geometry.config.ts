import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser', testMatch: 'tab-geometry.spec.ts',
  outputDir: './test-results/tab-geometry', workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    viewport: { width: 1200, height: 850 }, baseURL: 'http://127.0.0.1:1438',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1438',
    url: 'http://127.0.0.1:1438', reuseExistingServer: false,
  },
});
