import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

// Real Git over a synthetic repository through the loopback bridge; the
// browser UI is the full App with every other IPC call synthetic.
export default defineConfig({
  testDir,
  testMatch: ['git-workbench.spec.ts', 'git-performance.spec.ts'],
  outputDir: output('test-results/git'),
  timeout: 60_000,
  workers: 1,
  use: { locale: 'zh-TW',
    headless: true,
    viewport: { width: 1280, height: 850 },
    baseURL: 'http://127.0.0.1:1440',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  // WebKit runs the same flows as the engine family of WKWebView / WebKitGTK.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? undefined : 'chrome',
      launchOptions: { chromiumSandbox: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: [
    { cwd: root, command: 'npm run dev:web -- --port 1440', url: 'http://127.0.0.1:1440', reuseExistingServer: false },
    { cwd: root, command: `${process.env.CARGO ?? 'cargo'} run --quiet --manifest-path src-tauri/Cargo.toml --no-default-features --example git_bridge -- 1441`,
      url: 'http://127.0.0.1:1441/health', reuseExistingServer: false, timeout: 600_000 },
  ],
});
