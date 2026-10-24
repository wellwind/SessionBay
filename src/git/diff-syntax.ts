import type { DiffHunk } from './types';

/** Token class per line, keyed by `hunk:line`; ranges are `[start, end, class]`. */
export type SyntaxMap = Map<string, [number, number, string][]>;

const classes: [RegExp, string][] = [
  [/comment/, 'tok-comment'], [/string|regexp/, 'tok-string'], [/number|constant/, 'tok-number'],
  [/keyword|storage/, 'tok-keyword'], [/type|class|tag/, 'tok-type'], [/attribute|property|key/, 'tok-attr'],
];
const classFor = (type: string) => classes.find(([pattern]) => pattern.test(type))?.[1] ?? '';

/**
 * Reuses the bundled Monaco tokenizers (no editor instance, no workers).
 * Old and new sides are tokenized separately so each keeps a coherent state.
 */
export async function highlight(path: string, hunks: DiffHunk[]): Promise<SyntaxMap | null> {
  const extension = path.includes('.') ? `.${path.split('.').pop()!.toLowerCase()}` : '';
  if (!extension) return null;
  const { monaco } = await import('../components/monaco-preview');
  const language = monaco.languages.getLanguages().find(entry => entry.extensions?.includes(extension))?.id;
  if (!language || language === 'plaintext') return null;
  // colorize() triggers the lazy tokenizer registration that tokenize() needs.
  await monaco.editor.colorize('', language, {});
  const map: SyntaxMap = new Map();
  hunks.forEach((hunk, hunkIndex) => {
    for (const side of ['old', 'new'] as const) {
      const members = hunk.lines.map((line, index) => ({ line, index }))
        .filter(({ line }) => line.kind === 'context' || line.kind === (side === 'old' ? 'delete' : 'add'));
      const tokens = monaco.editor.tokenize(members.map(({ line }) => line.text).join('\n'), language);
      members.forEach(({ line, index }, position) => {
        const key = `${hunkIndex}:${index}`;
        if (line.kind === 'context' && side === 'new') return;
        const lineTokens = tokens[position] ?? [];
        map.set(key, lineTokens.map((token, i) => [token.offset, lineTokens[i + 1]?.offset ?? line.text.length, classFor(token.type)] as [number, number, string])
          .filter(([, , className]) => className));
      });
    }
  });
  return map;
}
