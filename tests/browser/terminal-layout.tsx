import React from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalPane } from '../../src/components/TerminalPane';
import { api } from '../../src/api';
import type { Settings } from '../../src/types';
import { defaultAgentOptions } from '../../src/agents';
import '../../src/styles.css';
import '../../src/workbench.css';

const params = new URLSearchParams(location.search);
const baseline = params.get('baseline') === '1';
// Reintroduce only the two pre-fix rules from main 3623504 for a paired baseline.
if (baseline) {
  const style = document.createElement('style');
  style.textContent = '.terminal-body { padding: 0; overflow: visible; } .xterm-host { padding: 9px 7px; }';
  document.head.append(style);
}
const width = Number(params.get('width') || 1000);
const height = Number(params.get('height') || 600);
const zoom = Number(params.get('zoom') || 100);
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

createRoot(document.getElementById('root')!).render(
  <div style={{ width, height, zoom: zoom / 100, display: 'flex', flexDirection: 'column', margin: 12 }}>
    <div style={{ fontSize: 12, padding: 8 }}>
      {baseline ? 'BEFORE (old CSS)' : 'AFTER'} · Chromium · actual TerminalPane + xterm · synthetic runtime ·
      {' '}{width}×{height} · CSS zoom {zoom}% (not native WebView)
    </div>
    <div className="workspace-tabs">
      <div className="workspace-tab active"><button>Terminal</button></div>
    </div>
    <div style={{ flex: 1, minHeight: 0 }}>
      <TerminalPane
        pane={{ id: 'pane', kind: 'shell', title: 'Shell', projectId: null, cwd: '/synthetic/project', state: 'running', runtimeId: 'synthetic' }}
        settings={settings} visible focused maximized={false}
        onPatch={noop} onFocus={noop} onStart={noop} onClose={noop}
        onMaximize={noop} onSplit={noop} onAlreadyOpen={noop}
      />
    </div>
  </div>,
);
