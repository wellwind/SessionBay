/** Character ranges `[start, end)` that differ between two paired lines. */
export type Range = [number, number];

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_CELLS = 40_000;

function tokens(text: string): { value: string; start: number }[] {
  return [...text.matchAll(TOKEN)].map(match => ({ value: match[0], start: match.index ?? 0 }));
}

/**
 * Token-level LCS; lines too long for a bounded table get no word hints
 * rather than a slow or misleading answer.
 */
export function wordDiff(before: string, after: string): { removed: Range[]; added: Range[] } | null {
  if (before === after) return { removed: [], added: [] };
  const a = tokens(before), b = tokens(after);
  if (a.length * b.length > MAX_CELLS) return null;
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] = a[i].value === b[j].value ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const removed: Range[] = [], added: Range[] = [];
  const push = (ranges: Range[], token: { value: string; start: number }) => {
    const last = ranges[ranges.length - 1];
    const end = token.start + token.value.length;
    if (last && last[1] === token.start) last[1] = end; else ranges.push([token.start, end]);
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].value === b[j].value) { i++; j++; }
    else if (j >= b.length || (i < a.length && table[i + 1][j] >= table[i][j + 1])) push(removed, a[i++]);
    else push(added, b[j++]);
  }
  // Whitespace-only fragments are noise unless they are the whole change.
  const meaningful = (ranges: Range[], text: string) => ranges.filter(([s, e]) => text.slice(s, e).trim() || ranges.length === 1);
  return { removed: meaningful(removed, before), added: meaningful(added, after) };
}
