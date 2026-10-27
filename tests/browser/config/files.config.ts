import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir, outputDir: output('test-results/files'),
  testMatch: ['workspace-files.spec.ts', 'explorer.spec.ts'],
  timeout: 30_000,
  workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium',
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    headless: true,
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1437',
  },
  webServer: {
    cwd: root, command: 'npm run dev:web -- --port 1437',
    url: 'http://127.0.0.1:1437',
    reuseExistingServer: false,
  },
});
