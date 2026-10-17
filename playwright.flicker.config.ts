import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  outputDir: 'test-results-flicker',
  testMatch: 'terminal-flicker.spec.ts',
  timeout: 30_000,
  workers: 1,
  use: {
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    launchOptions: { chromiumSandbox: true },
    viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1425',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1425',
    url: 'http://127.0.0.1:1425',
    reuseExistingServer: false,
  },
});
