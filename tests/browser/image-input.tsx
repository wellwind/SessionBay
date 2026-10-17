import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TerminalPane } from '../../src/components/TerminalPane';
import { api } from '../../src/api';
import { defaultAgentOptions } from '../../src/agents';
import type { Settings } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';
const settings: Settings = {
  version: 1, theme: 'dark', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 13,
  defaultAgent: 'codex', defaultProfileId: 'shell', profiles: [], sources: [], agentOptions: defaultAgentOptions(),
  executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
  shortcuts: {}, onboardingComplete: true,
};
// Pure synthetic bridge. Never reads OS clipboard/user files, runs agents, or uploads bytes.
const trace: { writes: string[]; begins: number; retained: string[]; discarded: string[]; chunks: number[]; names: string[]; payloads: number[][] } = {
  writes: [], begins: 0, retained: [], discarded: [], chunks: [], names: [], payloads: [],
};
Object.assign(window, { fileTrace: trace });
api.attach = async (id, callback) => {
  callback({ type: 'snapshot', runtimeId: id, sequence: 1, data: Array.from(new TextEncoder().encode('\x1b[?2004hSynthetic Agent prompt > ')), cols: 100, rows: 30, truncated: false });
  return { id, paneId: 'pane', sessionId: null, state: 'running', cwd: '/synthetic/project', exitCode: null };
};
const staged = new Map<string, { originalName: string; name: string }>();
api.beginFile = async (_runtime, originalName) => {
  const id = `file-${++trace.begins}`;
  trace.names.push(originalName);
  // Only synthetic fixture names. Production filename handling is tested in Rust.
  staged.set(id, { originalName, name: originalName.includes('/') || originalName.includes('\n') ? 'safe.png' : originalName });
  return id;
};
api.appendFile = async (_runtime, _id, _offset, bytes) => {
  trace.chunks.push(bytes.length);
  trace.payloads.push([...bytes]);
  if (new URLSearchParams(location.search).has('pauseFile')) {
    await new Promise<void>(resolve => Object.assign(window, { releaseFile: resolve }));
  }
};
api.finishFile = async (_runtime, id) => {
  const name = staged.get(id)!;
  return { id, path: `/private/synthetic/${id}/${name.name}`, ...name };
};
api.retainFile = async (_runtime, id) => { trace.retained.push(id); };
api.discardFile = async (_runtime, id) => { trace.discarded.push(id); };
api.write = async (_runtime, data) => { trace.writes.push(data); };
api.detach = api.ack = api.resize = async () => {};
function Fixture() {
  const [focused, setFocused] = useState(true);
  return <div style={{ width: 1000, height: 650, margin: 12, display: 'flex', flexDirection: 'column' }}>
    <p>General file input · actual TerminalPane + xterm · synthetic browser events and bridge</p>
    <button onClick={() => setFocused(!focused)}>Toggle pane focus</button>
    <div style={{ flex: 1, minHeight: 0 }}><TerminalPane
      pane={{ id: 'pane', kind: 'codex', title: 'Codex synthetic', projectId: null, cwd: '/synthetic/project', state: 'running', runtimeId: 'runtime' }}
      settings={settings} visible focused={focused} maximized={false} onFocus={() => setFocused(true)}
      onPatch={() => {}} onStart={() => {}} onClose={() => {}} onMaximize={() => {}} onSplit={() => {}} onAlreadyOpen={() => {}}
    /></div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
