import { defineConfig } from '@playwright/test';

// Clipped or overflowing text in both interface languages (see layout-audit.spec.ts).
export default defineConfig({
  testDir: './tests/browser', testMatch: 'layout-audit.spec.ts', workers: 1, timeout: 90_000,
  outputDir: 'test-results/layout-audit',
  use: {
    browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
    launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    headless: true, colorScheme: 'dark', baseURL: 'http://127.0.0.1:1462',
  },
  projects: [
    { name: 'en', use: { locale: 'en-US' } },
    { name: 'zh-tw', use: { locale: 'zh-TW' } },
  ],
  webServer: [
    { command: 'npm run dev:web -- --port 1462', url: 'http://127.0.0.1:1462', reuseExistingServer: false },
    { env: { SESSIONBAY_GIT_BRIDGE_ORIGIN: 'http://127.0.0.1:1462' }, command: `${process.env.CARGO ?? 'cargo'} run --quiet --manifest-path src-tauri/Cargo.toml --no-default-features --example git_bridge -- 1463`,
      url: 'http://127.0.0.1:1463/health', reuseExistingServer: false, timeout: 600_000 },
  ],
});
