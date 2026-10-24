import type { DiffHunk, DiffLine } from './types';

/** Parses a provider's unified patch text (hunks only) for display. */
export function parsePatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let old = 0, next = 0;
  for (const raw of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (header) {
      old = Number(header[1]); next = Number(header[3]);
      hunks.push({ header: raw, oldStart: old, oldCount: Number(header[2] ?? 1), newStart: next, newCount: Number(header[4] ?? 1), lines: [] });
      continue;
    }
    const hunk = hunks[hunks.length - 1];
    if (!hunk) continue;
    if (raw.startsWith('\\')) { const last = hunk.lines[hunk.lines.length - 1]; if (last) last.noNewline = true; continue; }
    const kind = raw[0] === '+' ? 'add' : raw[0] === '-' ? 'delete' : raw[0] === ' ' || raw === '' ? 'context' : null;
    if (!kind) continue;
    const text = raw.slice(1);
    const line: DiffLine = { kind, text: text.endsWith('\r') ? text.slice(0, -1) : text, crlf: text.endsWith('\r'), noNewline: false, clipped: false,
      oldLine: kind === 'add' ? null : old, newLine: kind === 'delete' ? null : next };
    if (kind !== 'add') old++;
    if (kind !== 'delete') next++;
    hunk.lines.push(line);
  }
  // A trailing empty line from the final newline is not content.
  for (const hunk of hunks) {
    const last = hunk.lines[hunk.lines.length - 1];
    const counted = hunk.lines.filter(line => line.kind !== 'add').length;
    if (last && last.kind === 'context' && last.text === '' && counted > hunk.oldCount) hunk.lines.pop();
  }
  return hunks;
}
