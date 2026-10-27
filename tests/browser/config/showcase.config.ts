import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

// Website screenshots from synthetic data; one project per documented language.
export default defineConfig({
  testDir, testMatch: 'showcase.spec.ts', workers: 1,
  outputDir: output('test-results/showcase'),
  use: {
    browserName: 'chromium', channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    colorScheme: 'dark', baseURL: 'http://127.0.0.1:1451',
  },
  projects: [
    { name: 'en', use: { locale: 'en-US' } },
    { name: 'zh-tw', use: { locale: 'zh-TW' } },
  ],
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1451', url: 'http://127.0.0.1:1451', reuseExistingServer: false },
});
