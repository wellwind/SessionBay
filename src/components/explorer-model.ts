export interface FileTab { path: string; pinned: boolean }
export interface FileTabs { tabs: FileTab[]; active: string; notice: string }
export type TabAction = { type: 'open'; path: string; pinned?: boolean } | { type: 'close'; path: string } | { type: 'move'; path: string; target: string };
export const emptyFileTabs: FileTabs = { tabs: [], active: '', notice: '' };
export function fileTabsReducer(state: FileTabs, action: TabAction): FileTabs {
  if (action.type === 'move') {
    const tabs = [...state.tabs];
    const from = tabs.findIndex(tab => tab.path === action.path); const to = tabs.findIndex(tab => tab.path === action.target);
    if (from < 0 || to < 0) return state;
    tabs.splice(to, 0, ...tabs.splice(from, 1));
    return { ...state, tabs };
  }
  if (action.type === 'close') {
    const index = state.tabs.findIndex(tab => tab.path === action.path);
    const tabs = state.tabs.filter(tab => tab.path !== action.path);
    return { tabs, active: state.active === action.path ? tabs[Math.min(index, tabs.length - 1)]?.path ?? '' : state.active, notice: '' };
  }
  const found = state.tabs.find(tab => tab.path === action.path);
  if (found) return { tabs: state.tabs.map(tab => tab.path === action.path ? { ...tab, pinned: tab.pinned || !!action.pinned } : tab), active: action.path, notice: '' };
  const preview = state.tabs.findIndex(tab => !tab.pinned);
  if (preview < 0 && state.tabs.length >= 20) return { ...state, notice: '已開啟 20 個檔案，請先關閉分頁。' };
  const tabs = [...state.tabs];
  const next = { path: action.path, pinned: !!action.pinned };
  if (preview >= 0) tabs.splice(preview, 1, next); else tabs.push(next);
  return { tabs, active: action.path, notice: '' };
}

export function fileLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', json: 'JSON', css: 'CSS', html: 'HTML', htm: 'HTML', md: 'Markdown', rs: 'Rust', py: 'Python', sh: 'Shell', yml: 'YAML', yaml: 'YAML' } as Record<string, string>)[ext ?? ''] ?? '純文字';
}
export interface TextToken { text: string; kind: string }
// Bounded, linear lexical hints, not an HTML renderer or a full parser.
export function highlightLine(line: string, language: string): TextToken[] {
  if (language === '純文字' || line.length > 4096) return [{ text: line, kind: '' }];
  const pattern = /\/\/[^\n]*|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:const|let|var|function|return|export|import|from|class|interface|type|if|else|for|while|async|await|true|false|null|undefined|fn|pub|use|impl|struct|def|self|None|True|False)\b|\b\d+(?:\.\d+)?\b/g;
  const result: TextToken[] = [];
  let offset = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index;
    if (index > offset) result.push({ text: line.slice(offset, index), kind: '' });
    const text = match[0];
    const kind = text.startsWith('//') || text.startsWith('#') ? 'comment' : /^["'`]/.test(text) ? 'string' : /^\d/.test(text) ? 'number' : 'keyword';
    result.push({ text, kind }); offset = index + text.length;
  }
  if (offset < line.length) result.push({ text: line.slice(offset), kind: '' });
  return result;
}
export function literalMatches(text: string, query: string): number[] {
  if (!query) return [];
  const matches: number[] = [];
  let offset = 0;
  while (matches.length < 10000) {
    const index = text.indexOf(query, offset);
    if (index < 0) break;
    matches.push(index); offset = index + Math.max(1, query.length);
  }
  return matches;
}
