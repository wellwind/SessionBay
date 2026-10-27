import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';
export default defineConfig({
  testDir, outputDir: output('test-results/monaco'), testMatch: ['monaco-lifecycle.spec.ts', 'monaco-theme.spec.ts', 'large-files.spec.ts', 'file-image-preview.spec.ts'],
  timeout: 45_000, workers: 1,
  use: { locale: 'zh-TW',
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    headless: true, launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    viewport: { width: 1200, height: 850 }, trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'vite-dev', use: { baseURL: 'http://127.0.0.1:1442' } },
    { name: 'production', use: { baseURL: 'http://127.0.0.1:1443' } },
  ],
  webServer: [
    { cwd: root, command: 'npm run dev:web -- --port 1442', url: 'http://127.0.0.1:1442', reuseExistingServer: false },
    { cwd: root, command: 'npx vite build --config vite.monaco-smoke.config.ts && npx vite preview --outDir dist-monaco-smoke --host 127.0.0.1 --port 1443 --strictPort',
      url: 'http://127.0.0.1:1443/tests/browser/workspace-focus-mode.html', reuseExistingServer: false, timeout: 120000 },
  ],
});
