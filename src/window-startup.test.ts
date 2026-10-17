import { describe, expect, it } from 'vitest';
import config from '../src-tauri/tauri.conf.json';
import windowsConfig from '../src-tauri/tauri.windows.conf.json';

describe('main window startup', () => {
  it('starts maximized without full screen and preserves its restored dimensions', () => {
    const main = config.app.windows.find(window => window.label === 'main');
    expect(main).toMatchObject({ maximized: true, fullscreen: false, width: 1440, height: 940, minWidth: 900, minHeight: 620 });
    // Tauri defaults preserve resizing and the standard maximize/restore control.
    expect(main).not.toHaveProperty('resizable', false);
    expect(main).not.toHaveProperty('maximizable', false);
  });
  it('does not override the main window defaults in Windows packaging', () => {
    expect(windowsConfig).not.toHaveProperty('app.windows');
  });
});
