import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { Session } from '../types';
import { CommandPalette } from './CommandPalette';
import type { PaletteOption } from './CommandPalette';
import { FileIcon } from './ExplorerTree';
import { agentName } from './History';
import { t } from '../i18n';

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
        else next.errors.push(t('Sessions: {{error}}', { error: errorMessage(sessions.reason) }));
        if (files.status === 'fulfilled') { next.paths = files.value.paths; next.filesMore = files.value.truncated; }
        else next.errors.push(t('Files: {{error}}', { error: errorMessage(files.reason) }));
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
      search: `${query} ${session.title} ${session.snippet ?? ''}`, detail: <small>{t('History session · {{agent}} · preview', { agent: agentName(session.kind) })}</small>,
      run: () => onOpenSession(session),
    })),
    ...(current?.paths ?? []).filter(path => !openIds.has(`file:${path}`)).map(path => ({
      id: `file:${path}`, label: <><FileIcon path={path} />{path}</>, search: path,
      detail: <small>{t('Project file · open')}</small>, run: () => onOpenFile(path),
    })),
  ];
  return <>
    <CommandPalette options={options} query={query} onQueryChange={setQuery} label={t('Search project tabs, sessions and files')}
      placeholder={t('Search tabs, history sessions or file paths…')} listLabel={t('Quick open')}
      emptyLabel={!current || current.loading ? t('Searching…') : t('No matching tabs, sessions or files')} />
    {(!current || current.loading) && <p role="status" className="palette-help">{t('Searching the project…')}</p>}
    {current?.errors.map(error => <p role="alert" key={error}>{error}</p>)}
    {current?.sessionsMore && <p role="status" className="palette-help">{t('Showing the 40 most recent sessions. Type more to narrow the results.')}</p>}
    {current?.filesMore && <p role="status" className="palette-help">{t('File search hit its result or scan limit, so results may be incomplete. Narrow the query or use the Files tree.')}</p>}
    <p className="palette-help">{t('Files are matched by relative path, skipping .git, node_modules, target, dist and symlinks. Choosing a session only opens its preview.')}</p>
  </>;
}
