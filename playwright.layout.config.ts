import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'terminal-layout.spec.ts',
  timeout: 30_000,
  workers: 1,
  use: {
    browserName: 'chromium',
    headless: true,
    launchOptions: { chromiumSandbox: true },
    viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1423',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1423',
    url: 'http://127.0.0.1:1423',
    reuseExistingServer: false,
  },
});
