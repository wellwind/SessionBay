import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkspaceCanvas } from '../../src/components/WorkspaceCanvas';
import { api } from '../../src/api';
import type { Settings } from '../../src/types';
import { defaultAgentOptions } from '../../src/agents';
import '../../src/styles.css';
import '../../src/workbench.css';

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
    { name: 'outside-link', path: 'outside-link', kind: 'blocked' },
    ...(showHidden ? [{ name: '.config', path: '.config', kind: 'file' as const }] : []),
  ], nextOffset: !path && !offset ? 200 : null,
});
api.readWorkspaceFile = async (_projectId, path) => ({ path, text: path === 'src/index.ts'
  ? 'export const greeting = "Hello, Session Bay";\nconsole.log(greeting);\n'
  : '# Synthetic project\n\nThis is read-only text.\n<script>alert("never executed")</script>\n', sizeBytes: 90 });
createRoot(document.getElementById('root')!).render(
  <main style={{ height: '100vh', position: 'relative' }}>
    <WorkspaceCanvas
      workspace={{ version: 1, tabs: [{ id: 'tab', projectId: 'project', name: 'Shell', focusedPaneId: 'pane', layout: { kind: 'pane', paneId: 'pane' } }],
        panes: { pane: { id: 'pane', kind: 'shell', title: 'Shell', projectId: 'project', cwd: '/synthetic/project', state: 'running', runtimeId: 'synthetic' } }, activeTabByProject: { project: 'tab' } }}
      knownProjectIds={['project']} activeTabId="tab" settings={settings} visible maximizedId={null}
      onPatch={noop} onFocus={noop} onStart={noop} onClose={noop} onMaximize={noop} onSplit={noop} onRatio={noop} onAlreadyOpen={noop}
    />
  </main>,
);
