import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceCanvas } from '../../src/components/WorkspaceCanvas';
import { api } from '../../src/api';
import type { Settings, Workspace } from '../../src/types';
import { setRatio } from '../../src/workspace';
import { defaultAgentOptions } from '../../src/agents';
import '../../src/styles.css';
import '../../src/workbench.css';
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'dark';

const settings: Settings = {
  version: 1, theme: 'dark', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 13,
  defaultAgent: 'codex', defaultProfileId: 'shell', profiles: [], sources: [],
  agentOptions: defaultAgentOptions(),
  executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
  shortcuts: {}, onboardingComplete: true,
};

// No native IPC, shell, history, filesystem, credentials, or user runtime is used.
api.attach = async (id, callback) => {
  const output = Array.from({ length: 120 }, (_, index) =>
    `Synthetic terminal output line ${index + 1}: toolbar boundary regression fixture\r\n`).join('') + '$ ';
  const data = Array.from(new TextEncoder().encode(output));
  callback({ type: 'snapshot', runtimeId: id, sequence: 1, data, cols: 100, rows: 30, truncated: false });
  return { id, paneId: 'pane', sessionId: null, state: 'running', cwd: '/synthetic/project', exitCode: null };
};
api.ack = api.write = api.detach = async () => {};
api.resize = async (_id, cols, rows) => { document.body.dataset.fit = `${cols}x${rows}`; };
const noop = () => {};

api.listWorkspaceFiles = async (_projectId, path, offset, showHidden) => ({
  entries: path ? [{ name: 'index.ts', path: 'src/index.ts', kind: 'file' }] : offset ? [{ name: 'last.txt', path: 'last.txt', kind: 'file' }] : [
    { name: 'src', path: 'src', kind: 'directory' },
    { name: 'README.md', path: 'README.md', kind: 'file' },
    { name: 'large.ts', path: 'large.ts', kind: 'file' },
    { name: 'outside-link', path: 'outside-link', kind: 'blocked' },
    ...(showHidden ? [{ name: '.config', path: '.config', kind: 'file' as const }] : []),
  ], nextOffset: !path && !offset ? 200 : null,
});
api.readWorkspaceFile = async (_projectId, path) => ({ path, text: path === 'large.ts'
  ? Array.from({ length: 3000 }, (_, index) => `const row = ${index};`).join('\n') + '\n' + 'x'.repeat(2000) + 'END_SENTINEL\n'
  : path === 'src/index.ts'
  ? 'export const greeting = "Hello, Session Bay";\nconsole.log(greeting);\n'
  : '# Synthetic project\n\nThis is read-only text.\n<script>alert("never executed")</script>\n', sizeBytes: 90 });
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [workspace, setWorkspace] = useState<Workspace>(() => ({ version: 1,
    tabs: [{ id: 'tab', projectId: 'project', name: 'Shell', focusedPaneId: 'pane',
      layout: new URLSearchParams(location.search).has('split')
        ? { kind: 'split', id: 'split', axis: 'horizontal', ratio: 0.5,
          first: { kind: 'pane', paneId: 'pane' }, second: { kind: 'pane', paneId: 'second' } }
        : { kind: 'pane', paneId: 'pane' } }],
    panes: Object.fromEntries(['pane', 'second'].map(id => [id, { id, kind: 'shell', title: 'Shell',
      projectId: 'project', cwd: '/synthetic/project', state: 'running', runtimeId: `synthetic-${id}` }])),
    activeTabByProject: { project: 'tab' },
  }));
  return (
  <main style={{ height: '100vh', position: 'relative' }}>
    <button style={{ position: 'absolute', top: 0, left: 0, zIndex: 10 }} onClick={() => setVisible(value => !value)} aria-label="Synthetic view switch">{visible ? 'History fixture' : 'Workspace fixture'}</button>
    <WorkspaceCanvas
      workspace={workspace}
      knownProjectIds={['project']} activeTabId="tab" settings={settings} visible={visible} maximizedId={null}
      onPatch={noop} onFocus={noop} onStart={noop} onClose={noop} onMaximize={noop} onSplit={noop}
      onRatio={(id, ratio) => setWorkspace(old => ({ ...old, tabs: old.tabs.map(tab => ({ ...tab, layout: setRatio(tab.layout, id, ratio) })) }))}
      onAlreadyOpen={noop}
    />
  </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
