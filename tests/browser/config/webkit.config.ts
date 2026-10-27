import { defineConfig } from '@playwright/test';
import { output, root, testDir } from './root';

// Layout specs re-run on Playwright WebKit, the engine family behind WKWebView
// (macOS) and WebKitGTK (Linux). Not identical to those webviews; native smoke
// remains the acceptance signal. Chromium-only specs (CDP IME) stay out.
//
// Known WebKit differences still under triage.
// Each entry is excluded here only; Chromium configs still run them.
const knownWebKitDifferences = [
  // Pointer reorder preview transforms differ under WebKit pointer capture.
  'expanded project child tab is not a project reorder target',
  'pointer cancellation never saves',
  'held drag follows through a normal gap',
  // Programmatic focus does not draw the inset focus ring.
  'tab strip edge spacing and overflow',
  // Playwright's Control chords on macOS WebKit; the app uses Cmd there.
  'default Zen shortcut toggles symmetrically',
  'active overflow tabs and fixed rectangular controls',
  // CSS zoom emulation; the app uses native webview zoom.
  'edge-to-edge:',
  // Linux WebKit only: CSS zoom geometry differs.
  ...(process.platform === 'linux' ? [
    'history density, divider and queued undo toast retain geometry at CSS zoom',
  ] : []),
];

export default defineConfig({
  testDir,
  testMatch: [
    'terminal-layout.spec.ts', 'tab-geometry.spec.ts', 'viewport-layout.spec.ts',
    'sidebar.spec.ts', 'workspace-tabs.spec.ts', 'workspace-focus-mode.spec.ts', 'workspace-overview.spec.ts', 'pane-menu.spec.ts',
  ],
  grepInvert: new RegExp(knownWebKitDifferences.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')),
  outputDir: output('test-results/webkit'), workers: 1, timeout: 30_000,
  use: { locale: 'zh-TW', browserName: 'webkit', headless: true, screenshot: 'only-on-failure', viewport: { width: 1200, height: 850 }, baseURL: 'http://127.0.0.1:1447' },
  webServer: { cwd: root, command: 'npm run dev:web -- --port 1447', url: 'http://127.0.0.1:1447', reuseExistingServer: false },
});
