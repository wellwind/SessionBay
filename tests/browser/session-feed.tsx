import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from '../../src/api';
import { HistoryView } from '../../src/components/History';
import { SessionTrash } from '../../src/components/SessionTrash';
import type { Session, SessionQuery } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

// Purely generated metadata; never invokes Tauri or reads a native catalog.
const calls: { offset: number; limit: number; query?: string; trash?: boolean }[] = [];
const deleted = new Set<string>();
let revision = 1;
const fixture = { calls, fail: false };
Object.assign(window, { sessionFeedFixture: fixture });
const session = (i: number): Session => ({ id: `synthetic-${i}`, title: `Synthetic Session ${i} — 大量清單與鍵盤測試`,
  externalId: `external-${i}`, sourceId: 'synthetic', projectId: 'synthetic-project', kind: 'codex',
  cwd: '/synthetic/project', updatedAt: '2026-10-17T12:00:00Z', timeSource: 'event', archived: false,
  parentId: null, partial: false, snippet: 'Generated fixture only. No private sessions or source files are accessed.', trashIdentity: `token-${i}` });
api.sessions = async (query: SessionQuery) => {
  const { offset = 0, limit = 40 } = query;
  calls.push({ offset, limit, query: query.query });
  await new Promise(resolve => setTimeout(resolve, query.query === 'slow' ? 400 : 25));
  if (fixture.fail) { fixture.fail = false; throw new Error('Synthetic retryable error'); }
  const all = Array.from({ length: query.query ? 3 : 10000 }, (_, i) => i).filter(i => !deleted.has(`synthetic-${i}`));
  return { catalogRevision: String(revision), items: all.slice(offset, offset + limit).map(session), total: all.length };
};
api.transcript = async () => ({ messages: [], hasMore: false, beforeLine: null, stale: false, warning: null });
api.trashSession = async id => { deleted.add(id); revision++; return id; };
api.restoreSession = async id => { deleted.delete(id); revision++; };
api.trash = async (offset = 0, limit = 40) => {
  calls.push({ offset, limit, trash: true });
  return { catalogRevision: String(revision), items: Array.from({ length: Math.min(limit, 10000 - offset) }, (_, i) => ({ id: `trash-${offset + i}`,
    session: session(offset + i), sourceRoot: '/synthetic/source', deletedAt: '2026-10-17T12:00:00Z', unavailableReason: null })), total: 10000 };
};
api.prepareSessionOsTrash = async trashId => ({ planId: 'synthetic-plan', trashId, sessionId: 'synthetic-0',
  kind: 'codex', sourceRoot: '/synthetic/source',
  items: [{ relativePath: 'sessions/2026/10/synthetic-session.jsonl', directory: false, bytes: 2048, entries: 0 }],
  kept: ['history.jsonl（共享輸入歷史）'], blockers: [] });
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'dark';
function Fixture() {
  const [project, setProject] = useState('a');
  const [trash, setTrash] = useState(false);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    <nav><button onClick={() => setProject(project === 'a' ? 'b' : 'a')}>切換專案</button><button onClick={() => setTrash(true)}>資源回收筒</button></nav>
    <div style={{ flex: 1, minHeight: 0 }}><HistoryView projectId={project} projects={[]} refreshToken={0} onResume={() => {}} onNew={() => {}} /></div>
    {trash && <SessionTrash onClose={() => setTrash(false)} onChanged={() => {}} refreshToken={0} />}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
