import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { Session } from '../types';
import { CommandPalette } from './CommandPalette';
import type { PaletteOption } from './CommandPalette';
import { FileIcon } from './ExplorerTree';
import { agentName } from './History';

interface Results { identity: string; sessions: Session[]; paths: string[]; sessionsMore: boolean; filesMore: boolean; loading: boolean; errors: string[] }
export function ProjectQuickSwitcher({ projectId, opened, openedSessionIds, onOpenFile, onOpenSession }: {
  projectId: string; opened: PaletteOption[]; openedSessionIds: string[];
  onOpenFile: (path: string) => void; onOpenSession: (session: Session) => void;
}) {
  const [query, setQuery] = useState('');
  const identity = JSON.stringify([projectId, query.trim()]);
  const [results, setResults] = useState<Results>();
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const next: Results = { identity, sessions: [], paths: [], sessionsMore: false, filesMore: false, loading: true, errors: [] };
      setResults(next);
      // Both sources are bounded and independently useful when the other fails.
      void Promise.allSettled([
        api.sessions({ projectId, query: query.trim() || undefined, includeChildren: true, limit: 40, offset: 0 }),
        api.searchWorkspaceFiles(projectId, query.trim()),
      ]).then(([sessions, files]) => {
        if (cancelled) return;
        if (sessions.status === 'fulfilled') { next.sessions = sessions.value.items; next.sessionsMore = sessions.value.total > next.sessions.length; }
        else next.errors.push(`Sessions：${errorMessage(sessions.reason)}`);
        if (files.status === 'fulfilled') { next.paths = files.value.paths; next.filesMore = files.value.truncated; }
        else next.errors.push(`檔案：${errorMessage(files.reason)}`);
        setResults({ ...next, loading: false });
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [identity, projectId, query]);
  const current = results?.identity === identity ? results : undefined;
  const openIds = new Set(opened.map(option => option.id));
  const options: PaletteOption[] = [...opened,
    ...(current?.sessions ?? []).filter(session => !openedSessionIds.includes(session.id) && !openedSessionIds.includes(`${session.kind}:${session.externalId}`)).map(session => ({
      id: `session:${session.id}`, label: <><History size={15} aria-hidden="true" />{session.title || session.externalId}</>,
      // Catalog full-text matches can be in snippets, not just the display title.
      search: `${query} ${session.title} ${session.snippet ?? ''}`, detail: <small>歷史 Session · {agentName(session.kind)} · 預覽</small>,
      run: () => onOpenSession(session),
    })),
    ...(current?.paths ?? []).filter(path => !openIds.has(`file:${path}`)).map(path => ({
      id: `file:${path}`, label: <><FileIcon path={path} />{path}</>, search: path,
      detail: <small>專案檔案 · 開啟</small>, run: () => onOpenFile(path),
    })),
  ];
  return <>
    <CommandPalette options={options} query={query} onQueryChange={setQuery} label="搜尋專案分頁、Sessions 與檔案"
      placeholder="搜尋分頁、歷史 Sessions 或檔案路徑…" listLabel="專案快速開啟"
      emptyLabel={!current || current.loading ? '搜尋中…' : '沒有符合的分頁、Sessions 或檔案'} />
    {(!current || current.loading) && <p role="status" className="palette-help">正在搜尋專案…</p>}
    {current?.errors.map(error => <p role="alert" key={error}>{error}</p>)}
    {current?.sessionsMore && <p role="status" className="palette-help">Sessions 顯示最近 40 筆，請輸入更多關鍵字縮小範圍。</p>}
    {current?.filesMore && <p role="status" className="palette-help">檔案搜尋已達數量或掃描上限，結果可能不完整。可縮小關鍵字，或使用 Files 目錄樹。</p>}
    <p className="palette-help">檔案依相對路徑搜尋，略過 .git、node_modules、target、dist 與符號連結。選取 Session 只開啟預覽。</p>
  </>;
}
