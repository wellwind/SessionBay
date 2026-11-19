import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir, testMatch: 'ghostty-terminal.spec.ts',
  outputDir: output('test-results/ghostty-terminal'), workers: 1, timeout: 60_000,
  use: {
    browserName: 'chromium', headless: true,
    channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    baseURL: 'http://127.0.0.1:1466',
  },
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1466', url: 'http://127.0.0.1:1466', reuseExistingServer: false },
});
