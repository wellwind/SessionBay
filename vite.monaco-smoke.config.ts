import { mergeConfig } from 'vite';
import base from './vite.config';

// Production bundling of the same synthetic App fixture used by dev tests.
export default mergeConfig(base, {
  build: { outDir: 'dist-monaco-smoke', rollupOptions: { input: 'tests/browser/workspace-focus-mode.html' } },
});
