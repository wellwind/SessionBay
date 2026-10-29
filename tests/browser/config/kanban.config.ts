import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

export default defineConfig({
  testDir, testMatch: 'project-board.spec.ts', workers: 1, timeout: 45_000,
  outputDir: output('test-results/kanban'),
  use: {
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    headless: true, colorScheme: 'dark', baseURL: 'http://127.0.0.1:1464', viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'en', use: { locale: 'en-US' } }, { name: 'zh-tw', use: { locale: 'zh-TW' } }],
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1464', url: 'http://127.0.0.1:1464', reuseExistingServer: false },
});
