import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

export default defineConfig({
  testDir, testMatch: 'confirmation-enter.spec.ts',
  outputDir: output('test-results/confirmation'), workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true },
    baseURL: 'http://127.0.0.1:1443',
  },
  webServer: {
    cwd: root, command: 'npm run dev:web -- --port 1443',
    url: 'http://127.0.0.1:1443', reuseExistingServer: false,
  },
});
