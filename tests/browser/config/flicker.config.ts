import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir,
  outputDir: output('test-results-flicker'),
  testMatch: 'terminal-flicker.spec.ts',
  timeout: 30_000,
  workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    launchOptions: { chromiumSandbox: true },
    viewport: { width: 1200, height: 850 },
    baseURL: 'http://127.0.0.1:1425',
  },
  webServer: {
    cwd: root, command: 'npm run dev:web -- --port 1425',
    url: 'http://127.0.0.1:1425',
    reuseExistingServer: false,
  },
});
