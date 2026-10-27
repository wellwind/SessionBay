import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir, testMatch: ['terminal-file-links.spec.ts'],
  outputDir: output('test-results/terminal-file-links'), timeout: 30_000, workers: 1,
  use: { locale: 'zh-TW', browserName: 'chromium', channel: 'chrome', headless: true,
    launchOptions: { chromiumSandbox: true }, viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1446', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1446', url: 'http://127.0.0.1:1446', reuseExistingServer: false },
});
