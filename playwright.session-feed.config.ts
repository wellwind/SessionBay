import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', testMatch: 'session-feed.spec.ts',
  outputDir: './test-results/session-feed', workers: 1,
  use: { browserName: 'chromium', channel: 'msedge', headless: true,
    launchOptions: { chromiumSandbox: true }, baseURL: 'http://127.0.0.1:1456' },
  webServer: { command: 'npm run dev:web -- --port 1456', url: 'http://127.0.0.1:1456', reuseExistingServer: false },
});
