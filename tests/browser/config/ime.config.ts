import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir, testMatch: 'terminal-ime.spec.ts',
  outputDir: output('test-results/terminal-ime'), workers: 1, timeout: 30_000,
  use: { locale: 'zh-TW',
    browserName: 'chromium', headless: true,
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    baseURL: 'http://127.0.0.1:1437',
  },
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1437', url: 'http://127.0.0.1:1437', reuseExistingServer: false },
});
