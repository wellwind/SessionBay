import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

export default defineConfig({
  testDir, testMatch: 'tab-geometry.spec.ts',
  outputDir: output('test-results/tab-geometry'), workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    viewport: { width: 1200, height: 850 }, baseURL: 'http://127.0.0.1:1438',
  },
  webServer: {
    cwd: root, command: 'npm run dev:web -- --port 1438',
    url: 'http://127.0.0.1:1438', reuseExistingServer: false,
  },
});
