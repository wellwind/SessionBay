import type { DiffHunk, DiffLine } from './types';
import { wordDiff } from './word-diff';
import type { Range } from './word-diff';

export interface Cell { hunk: number; line: number; data: DiffLine; ranges: Range[] | null }
export type Row =
  | { type: 'hunk'; hunk: number; header: string }
  | { type: 'inline'; cell: Cell; blockStart: boolean }
  | { type: 'split'; left: Cell | null; right: Cell | null; blockStart: boolean };

/** Pairs deletions with additions inside each change block for word hints. */
function pairBlocks(hunk: DiffHunk, hunkIndex: number) {
  const cells: Cell[] = hunk.lines.map((data, line) => ({ hunk: hunkIndex, line, data, ranges: null }));
  let index = 0;
  const blocks: { deletions: Cell[]; additions: Cell[] }[] = [];
  while (index < cells.length) {
    if (cells[index].data.kind === 'context') { index++; continue; }
    const deletions: Cell[] = [], additions: Cell[] = [];
    while (index < cells.length && cells[index].data.kind !== 'context') {
      (cells[index].data.kind === 'delete' ? deletions : additions).push(cells[index]);
      index++;
    }
    for (let pair = 0; pair < Math.min(deletions.length, additions.length); pair++) {
      const result = wordDiff(deletions[pair].data.text, additions[pair].data.text);
      if (result) { deletions[pair].ranges = result.removed; additions[pair].ranges = result.added; }
    }
    blocks.push({ deletions, additions });
  }
  return { cells, blocks };
}

export function buildRows(hunks: DiffHunk[], mode: 'inline' | 'split'): Row[] {
  const rows: Row[] = [];
  hunks.forEach((hunk, hunkIndex) => {
    rows.push({ type: 'hunk', hunk: hunkIndex, header: hunk.header });
    const { cells } = pairBlocks(hunk, hunkIndex);
    if (mode === 'inline') {
      cells.forEach((cell, index) => rows.push({ type: 'inline', cell,
        blockStart: cell.data.kind !== 'context' && (index === 0 || cells[index - 1].data.kind === 'context') }));
      return;
    }
    let index = 0;
    while (index < cells.length) {
      const cell = cells[index];
      if (cell.data.kind === 'context') { rows.push({ type: 'split', left: cell, right: cell, blockStart: false }); index++; continue; }
      const deletions: Cell[] = [], additions: Cell[] = [];
      while (index < cells.length && cells[index].data.kind !== 'context') {
        (cells[index].data.kind === 'delete' ? deletions : additions).push(cells[index]);
        index++;
      }
      for (let pair = 0; pair < Math.max(deletions.length, additions.length); pair++)
        rows.push({ type: 'split', left: deletions[pair] ?? null, right: additions[pair] ?? null, blockStart: pair === 0 });
    }
  });
  return rows;
}

export const cellKey = (cell: { hunk: number; line: number }) => `${cell.hunk}:${cell.line}`;
