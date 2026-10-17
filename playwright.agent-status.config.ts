import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/agent-status',
  testDir: './tests/browser', testMatch: 'agent-status.spec.ts', timeout: 30_000, workers: 1,
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', browserName: 'chromium', channel: 'chrome', headless: true,
    launchOptions: { chromiumSandbox: true }, viewport: { width: 1200, height: 900 }, baseURL: 'http://127.0.0.1:1428' },
  webServer: { command: 'npm run dev:web -- --port 1428', url: 'http://127.0.0.1:1428', reuseExistingServer: false },
});
