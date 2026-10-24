/** Conflict blocks in a work-tree file, including diff3 base sections. */
export interface ConflictBlock {
  start: number; end: number;
  ours: string[]; base: string[] | null; theirs: string[];
  oursLabel: string; theirsLabel: string;
}
export type BlockChoice = 'ours' | 'theirs' | 'base' | 'both' | 'bothReverse';

const marker = (line: string, char: string) => {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line;
  return bare === char.repeat(7) || bare.startsWith(`${char.repeat(7)} `) ? bare.slice(8) : null;
};

export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const blocks: ConflictBlock[] = [];
  for (let index = 0; index < lines.length; index++) {
    const oursLabel = marker(lines[index], '<');
    if (oursLabel === null) continue;
    const block: ConflictBlock = { start: index, end: -1, ours: [], base: null, theirs: [], oursLabel, theirsLabel: '' };
    let section: 'ours' | 'base' | 'theirs' = 'ours';
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      if (section === 'ours' && marker(line, '|') !== null) { section = 'base'; block.base = []; continue; }
      if (section !== 'theirs' && (line === '=======' || line === '=======\r')) { section = 'theirs'; continue; }
      const closing = section === 'theirs' ? marker(line, '>') : null;
      if (closing !== null) { block.end = cursor; block.theirsLabel = closing; break; }
      if (section === 'ours') block.ours.push(line);
      else if (section === 'base') block.base!.push(line);
      else block.theirs.push(line);
    }
    if (block.end < 0) break;
    blocks.push(block);
    index = block.end;
  }
  return blocks;
}

export function chooseBlock(text: string, blockIndex: number, choice: BlockChoice): string {
  const block = parseConflicts(text)[blockIndex];
  if (!block) return text;
  const lines = text.split('\n');
  const replacement = choice === 'ours' ? block.ours : choice === 'theirs' ? block.theirs : choice === 'base' ? block.base ?? []
    : choice === 'both' ? [...block.ours, ...block.theirs] : [...block.theirs, ...block.ours];
  lines.splice(block.start, block.end - block.start + 1, ...replacement);
  return lines.join('\n');
}

export function chooseAll(text: string, choice: 'ours' | 'theirs'): string {
  let next = text;
  while (parseConflicts(next).length) next = chooseBlock(next, 0, choice);
  return next;
}

/** Character offset of the start of a 0-based line, for focusing a block. */
export function lineOffset(text: string, line: number): number {
  return text.split('\n').slice(0, line).reduce((total, current) => total + current.length + 1, 0);
}
