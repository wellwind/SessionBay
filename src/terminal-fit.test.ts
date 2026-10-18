import { describe, expect, it, vi } from 'vitest';
import { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { fitTerminal } from './terminal-fit';

describe('public fit rounding reconciliation', () => {
  it('requires a post-render reconciliation when a hidden renderer defers its dimensions', () => {
    // CI narrow geometry: body 576px minus 14px outer padding gives a 562px
    // host; installed FitAddon reserves another 14px for its scrollbar.
    const host = document.createElement('div');
    host.style.width = '562px'; host.style.height = '259px';
    const element = document.createElement('div'); element.style.padding = '0px'; host.append(element);
    document.body.append(host);
    let renderedCols = 100;
    let paused = true;
    const terminal = {
      cols: 100, rows: 30, element, options: { scrollback: 1000, overviewRuler: { width: 0 } },
      resize(cols: number, rows: number) {
        this.cols = cols; this.rows = rows;
        // RenderService.handleResize defers this update while its
        // IntersectionObserver considers the terminal hidden.
        if (!paused) renderedCols = cols;
      },
    };
    const dimensions = { css: { cell: { get width() { return Math.round(7.826 * renderedCols) / renderedCols; }, height: 15 } } };
    Object.assign(terminal, { _core: { _renderService: { dimensions, clear() {} } } });
    const addon = new FitAddon(); addon.activate(terminal as unknown as Terminal);
    try {
      fitTerminal(terminal, addon);
      expect(terminal.cols).toBe(69);
      expect(addon.proposeDimensions()?.cols).toBe(69); // synchronous recheck is still stale
      paused = false;
      renderedCols = terminal.cols; // renderer flush on reveal
      expect(addon.proposeDimensions()?.cols).toBe(70);
      fitTerminal(terminal, addon);
      expect(terminal.cols).toBe(70);
      expect(terminal.rows).toBe(17);
      terminal.resize(31, 14); // the visible split renderer updates immediately
      fitTerminal(terminal, addon);
      expect(terminal.cols).toBe(70);
      expect(terminal.rows).toBe(17);
    } finally {
      host.remove(); addon.dispose();
    }
  });
  it('rechecks installed FitAddon after rounded cell width changes with column count', () => {
    const host = document.createElement('div');
    host.style.width = '1986px'; host.style.height = '1140px';
    const element = document.createElement('div'); element.style.padding = '0px'; host.append(element);
    document.body.append(host);
    const terminal = {
      cols: 221, rows: 76, element, options: { scrollback: 1000, overviewRuler: { width: 0 } },
      resize(cols: number, rows: number) { this.cols = cols; this.rows = rows; },
    };
    // Rendering-service stub models the documented upstream DOM rounding formula;
    // the actual installed FitAddon executes its own proposal/resize logic.
    const dimensions = { css: { cell: { get width() { return Math.round(7.826 * terminal.cols) / terminal.cols; }, height: 15 } } };
    Object.assign(terminal, { _core: { _renderService: { dimensions, clear() {} } } });
    const addon = new FitAddon(); addon.activate(terminal as unknown as Terminal);
    addon.fit(); expect(terminal.cols).toBe(251); // old single-fit path
    terminal.cols = 221;
    fitTerminal(terminal, addon); expect(terminal.cols).toBe(252);
    terminal.cols = 122; // split → single should recover the same dimensions
    fitTerminal(terminal, addon); expect(terminal.cols).toBe(252);
    fitTerminal(terminal, addon); expect(terminal.cols).toBe(252);
    expect(terminal.rows).toBe(76);
    host.remove(); addon.dispose();
  });
  it('does not add a redundant fit when the proposal already matches', () => {
    const addon = { fit: vi.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) };
    fitTerminal({ cols: 80, rows: 24 }, addon); expect(addon.fit).toHaveBeenCalledOnce();
  });
  it('does not refit hidden or invalid geometry', () => {
    for (const proposal of [undefined, { cols: NaN, rows: 24 }]) {
      const addon = { fit: vi.fn(), proposeDimensions: () => proposal };
      fitTerminal({ cols: 80, rows: 24 }, addon); expect(addon.fit).toHaveBeenCalledOnce();
    }
  });
  it('bounds correction even when a measurement keeps changing', () => {
    const addon = { fit: vi.fn(), proposeDimensions: () => ({ cols: 81, rows: 24 }) };
    fitTerminal({ cols: 80, rows: 24 }, addon); expect(addon.fit).toHaveBeenCalledTimes(2);
  });
});
