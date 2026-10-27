import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', testMatch: ['terminal-file-links.spec.ts'],
  outputDir: './test-results/terminal-file-links', timeout: 30_000, workers: 1,
  use: { locale: 'zh-TW', browserName: 'chromium', channel: 'chrome', headless: true,
    launchOptions: { chromiumSandbox: true }, viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1446', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev:web -- --port 1446', url: 'http://127.0.0.1:1446', reuseExistingServer: false },
});
