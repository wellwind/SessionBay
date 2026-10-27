import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir, testMatch: 'session-feed.spec.ts',
  outputDir: output('test-results/session-feed'), workers: 1,
  use: { locale: 'zh-TW', browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome', headless: true,
    launchOptions: { chromiumSandbox: true }, baseURL: 'http://127.0.0.1:1456' },
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1456', url: 'http://127.0.0.1:1456', reuseExistingServer: false },
});
