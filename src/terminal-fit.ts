import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

/** Reconcile one renderer rounding adjustment using only public addon APIs. */
export function fitTerminal(terminal: Pick<Terminal, 'cols' | 'rows'>, addon: Pick<FitAddon, 'fit' | 'proposeDimensions'>): void {
  addon.fit();
  // xterm 6 derives CSS cell width from rounded canvas width / current cols.
  // Resizing can therefore change the next fit proposal by a column. Recheck
  // synchronously before publishing geometry to the PTY; never schedule a timer
  // or loop to convergence (rounding can oscillate for some font/width pairs).
  const measured = addon.proposeDimensions();
  if (measured && Number.isFinite(measured.cols) && Number.isFinite(measured.rows) &&
      (measured.cols !== terminal.cols || measured.rows !== terminal.rows)) addon.fit();
}
