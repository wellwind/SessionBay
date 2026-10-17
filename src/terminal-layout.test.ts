/// <reference types="vite/client" />
import { afterEach, describe, expect, it } from 'vitest';
import { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

afterEach(() => { document.body.replaceChildren(); });

// jsdom cannot lay out a flexbox or paint a terminal. These checks exercise the
// installed FitAddon sizing contract;
// real-browser screenshots remain a separate acceptance check.
function fitDimensions(width: number, height: number, padding: string) {
  const host = document.createElement('div');
  host.style.cssText = `box-sizing:border-box;width:${width}px;height:${height}px;padding:${padding}`;
  const element = document.createElement('div');
  element.style.padding = '0px';
  host.append(element);
  document.body.append(host);
  const fit = new FitAddon();
  fit.activate({
    element, options: { scrollback: 5000 },
    _core: { viewport: { scrollBarWidth: 15 }, _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
  } as unknown as Terminal);
  return fit.proposeDimensions()!;
}

describe('terminal host sizing and toolbar boundary', () => {
  it('characterizes why padding on a border-box host overflows its content area', () => {
    const dims = fitDimensions(800, 400, '9px 7px');
    expect(dims).toEqual({ cols: 98, rows: 25 });
    expect(dims.rows * 16).toBeGreaterThan(400 - 18);
    expect(dims.cols * 8 + 15).toBeGreaterThan(800 - 14);
  });

  it.each([[800, 400], [400, 200], [320, 90], [1600, 800]])(
    'fits inside a padding-free host at %s × %s', (width, height) => {
      // The flex body owns the spacing; the host receives only its content box.
      const dims = fitDimensions(width - 14, height - 18, '0px');
      expect(dims.rows * 16).toBeLessThanOrEqual(height - 18);
      expect(dims.cols * 8 + 15).toBeLessThanOrEqual(width - 14);
    },
  );

});
