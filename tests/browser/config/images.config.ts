import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir,
  // Keep the preceding layout suite's screenshots and geometry intact.
  outputDir: output('test-results/image-input'),
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
    cwd: root, command: 'npm run dev:web -- --port 1432',
    url: 'http://127.0.0.1:1432',
    reuseExistingServer: false,
  },
});
