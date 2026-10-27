import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  outputDir: output('test-results/agent-settings'),
  testDir, testMatch: 'agent-settings.spec.ts', timeout: 30_000, workers: 1,
  use: { locale: 'zh-TW', browserName: 'chromium', headless: true, ...(process.env.CHROMIUM_PATH ? {} : { channel: 'chrome' }), launchOptions: { executablePath: process.env.CHROMIUM_PATH, chromiumSandbox: true }, baseURL: 'http://127.0.0.1:1426' },
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1426', url: 'http://127.0.0.1:1426', reuseExistingServer: false },
});
