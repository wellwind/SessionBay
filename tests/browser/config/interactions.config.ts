import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  outputDir: output('test-results/interactions'),
  testDir, testMatch: 'interactions.spec.ts', workers: 1,
  use: { locale: 'zh-TW', browserName: 'chromium', channel: 'chrome', headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromiumSandbox: true },
    viewport: { width: 1200, height: 850 }, baseURL: 'http://127.0.0.1:1437' },
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1437', url: 'http://127.0.0.1:1437', reuseExistingServer: false },
});
