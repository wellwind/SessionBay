import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

export default defineConfig({
  testDir, testMatch: 'project-membership.spec.ts',
  outputDir: output('test-results/project-membership'), workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    baseURL: 'http://127.0.0.1:1442',
  },
  webServer: {
    cwd: root, command: 'npm run dev:web -- --port 1442',
    url: 'http://127.0.0.1:1442', reuseExistingServer: false,
  },
});
