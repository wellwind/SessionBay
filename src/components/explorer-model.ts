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

const languageExtensions: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', md: 'markdown',
  rs: 'rust', py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql',
  c: 'cpp', h: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', java: 'java',
  go: 'go', rb: 'ruby', php: 'php', swift: 'swift', kt: 'kotlin',
  vue: 'html', svelte: 'html', graphql: 'graphql', gql: 'graphql',
  ps1: 'powershell', bat: 'bat', cmd: 'bat', diff: 'diff', patch: 'diff',
};
export function monacoLanguage(path: string): string {
  const name = path.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  return languageExtensions[name.split('.').pop() ?? ''] ?? 'plaintext';
}
export function fileLanguage(path: string): string {
  const language = monacoLanguage(path);
  return language === 'plaintext' ? '純文字' : language;
}
