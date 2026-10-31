import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    // Match tsconfig and the oldest supported webview (macOS 12 / Safari 15).
    // Lowering `||=` for older targets trips an esbuild 0.25 minifier bug that
    // drops a declaration inside xterm's requestMode, so DECRQM throws.
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-search'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: { port: 1420, strictPort: true },
  test: {
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
