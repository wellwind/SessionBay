import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

export default defineConfig({
  testDir, testMatch: 'preview-header.spec.ts',
  outputDir: output('test-results/preview-header'), workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    baseURL: 'http://127.0.0.1:1441',
  },
  webServer: {
    cwd: root, command: 'npm run dev:web -- --port 1441',
    url: 'http://127.0.0.1:1441', reuseExistingServer: false,
  },
});
