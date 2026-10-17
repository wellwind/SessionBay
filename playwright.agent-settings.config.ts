import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: './test-results/agent-settings',
  testDir: './tests/browser', testMatch: 'agent-settings.spec.ts', timeout: 30_000, workers: 1,
  use: { browserName: 'chromium', headless: true, ...(process.env.CHROMIUM_PATH ? {} : { channel: 'chrome' }), launchOptions: { executablePath: process.env.CHROMIUM_PATH, chromiumSandbox: true }, baseURL: 'http://127.0.0.1:1426' },
  webServer: { command: 'npm run dev:web -- --port 1426', url: 'http://127.0.0.1:1426', reuseExistingServer: false },
});
