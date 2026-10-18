import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', testMatch: ['monaco-lifecycle.spec.ts', 'large-files.spec.ts'],
  timeout: 45_000, workers: 1,
  use: {
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    viewport: { width: 1200, height: 850 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'vite-dev', use: { baseURL: 'http://127.0.0.1:1442' } },
    { name: 'production', use: { baseURL: 'http://127.0.0.1:1443' } },
  ],
  webServer: [
    { command: 'npm run dev:web -- --port 1442', url: 'http://127.0.0.1:1442', reuseExistingServer: false },
    { command: 'npx vite build --config vite.monaco-smoke.config.ts && npx vite preview --outDir dist-monaco-smoke --host 127.0.0.1 --port 1443 --strictPort',
      url: 'http://127.0.0.1:1443/tests/browser/workspace-focus-mode.html', reuseExistingServer: false, timeout: 120000 },
  ],
});
