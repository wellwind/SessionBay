import { defineConfig } from '@playwright/test';

// Website screenshots from synthetic data; one project per documented language.
export default defineConfig({
  testDir: './tests/browser', testMatch: 'showcase.spec.ts', workers: 1,
  outputDir: 'test-results/showcase',
  use: {
    browserName: 'chromium', channel: 'chrome', headless: true, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2,
    colorScheme: 'dark', baseURL: 'http://127.0.0.1:1471',
  },
  projects: [
    { name: 'en', use: { locale: 'en-US' } },
    { name: 'zh-tw', use: { locale: 'zh-TW' } },
  ],
  webServer: [
    { command: 'npm run dev:web -- --port 1471', url: 'http://127.0.0.1:1471', reuseExistingServer: false },
    { env: { SESSIONBAY_GIT_BRIDGE_ORIGIN: 'http://127.0.0.1:1471' }, command: `${process.env.CARGO ?? 'cargo'} run --quiet --manifest-path src-tauri/Cargo.toml --no-default-features --example git_bridge -- 1472`,
      url: 'http://127.0.0.1:1472/health', reuseExistingServer: false, timeout: 600_000 },
  ],
});
