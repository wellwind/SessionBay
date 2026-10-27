import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  // Keep the preceding layout suite's screenshots and geometry intact.
  outputDir: './test-results/image-input',
  testMatch: 'image-input.spec.ts',
  timeout: 30_000,
  workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    headless: true,
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1432',
  },
  webServer: {
    command: 'npm run dev:web -- --port 1432',
    url: 'http://127.0.0.1:1432',
    reuseExistingServer: false,
  },
});
