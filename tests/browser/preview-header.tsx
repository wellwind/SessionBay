import { createRoot } from 'react-dom/client';
import { HistoryView } from '../../src/components/History';
import { api } from '../../src/api';
import type { Session } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

// Real HistoryView and product styles; all data and callbacks are synthetic.
const params = new URLSearchParams(location.search);
const session: Session = {
  id: 'synthetic-preview', trashIdentity: 'synthetic-trash', sourceId: 'synthetic',
  kind: 'codex', externalId: 'synthetic-preview', projectId: 'synthetic',
  title: params.has('long') ? 'Synthetic conversation preview '.repeat(12) + 'UnbrokenTitle'.repeat(12) : 'Synthetic browser tools pizza workshop',
  cwd: '/synthetic/preview', updatedAt: '2026-10-17T00:00:00Z', timeSource: 'event',
  archived: false, parentId: null, partial: false, snippet: 'Synthetic transcript',
};
api.sessions = async () => ({ catalogRevision: 'fixture', items: [session], total: 1 });
api.transcript = async () => ({ messages: Array.from({ length: 40 }, (_, line) => ({
  role: 'assistant', text: `Synthetic message ${line + 1}`, timestamp: null, line,
})), hasMore: false, beforeLine: null, stale: false, warning: null });
const resumed: string[] = [];
Object.assign(window, { previewFixture: { resumed } });
// Isolate the preview column at its available width without altering its header.
const style = document.createElement('style');
style.textContent = params.has('grid') ? '' : '.history-controls,.history-caption,.session-column{display:none}.history-columns{display:block}body{min-width:0}';
document.head.append(style);
createRoot(document.getElementById('root')!).render(
  <HistoryView projects={[]} refreshToken={0} onNew={() => {}} onResume={item => resumed.push(item.id)} />,
);
