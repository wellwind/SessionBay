import React from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { TerminalPane } from '../../src/components/TerminalPane';
import { api } from '../../src/api';
import type { Settings, TerminalEvent } from '../../src/types';
import { defaultAgentOptions } from '../../src/agents';
import '../../src/styles.css';
import '../../src/workbench.css';

// Synthetic output only. Counters contain no terminal contents or input bytes.
const counts = { resets: 0, resizes: 0, writes: 0, acks: 0, renders: 0, blankRenders: 0, frames: 0, done: false };
Object.assign(window, { flickerCounts: counts });
const batched = new URLSearchParams(location.search).get('batched') === '1';
let measuring = false;
const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function (host: HTMLElement) {
  originalOpen.call(this, host);
  this.onRender(() => {
    if (!measuring) return;
    counts.renders++;
    if (!host.querySelector('.xterm-rows')?.textContent?.trim()) counts.blankRenders++;
  });
};
const originalReset = Terminal.prototype.reset;
Terminal.prototype.reset = function () { counts.resets++; originalReset.call(this); };
const originalWrite = Terminal.prototype.write;
Terminal.prototype.write = function (data: string | Uint8Array, callback?: () => void) {
  counts.writes++; originalWrite.call(this, data, callback);
};
const settings: Settings = {
  version: 1, theme: 'dark', terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 13,
  defaultAgent: 'codex', defaultProfileId: 'shell', profiles: [], sources: [],
  agentOptions: defaultAgentOptions(),
  executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
  shortcuts: {}, onboardingComplete: true,
};
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let sequence = 0;
let acknowledged: (() => void) | undefined;
api.ack = async () => { counts.acks++; acknowledged?.(); acknowledged = undefined; };
api.write = api.detach = async () => {};
api.resize = async () => { counts.resizes++; };
api.attach = async (id, callback) => {
  const send = async (text: string, snapshot = false) => {
    const data = Array.from(new TextEncoder().encode(text));
    const event: TerminalEvent = snapshot
      ? { type: 'snapshot', runtimeId: id, sequence: ++sequence, data, cols: 100, rows: 30, truncated: false }
      : { type: 'output', runtimeId: id, sequence: ++sequence, data };
    const ready = new Promise<void>(resolve => { acknowledged = resolve; });
    callback(event);
    await ready;
  };
  void (async () => {
    await send('Synthetic stable frame', true);
    await delay(100);
    measuring = true;
    for (let i = 0; i < 30; i++) {
      // Split a synchronized frame over real asynchronous writes, like IPC/PTY.
      const clear = '\x1b[?2026h\x1b[2J\x1b[H';
      const paint = `Synthetic complete frame ${i}\x1b[?2026l`;
      if (batched) await send(clear + paint);
      else {
        await send(clear);
        // Synthetic IPC latency, not a measurement of the user's computer.
        await delay(25);
        await send(paint);
      }
      counts.frames++;
      await delay(25);
    }
    await delay(100);
    measuring = false;
    counts.done = true;
  })();
  return { id, paneId: 'pane', sessionId: null, state: 'running', cwd: '/synthetic', exitCode: null };
};
const noop = () => {};
createRoot(document.getElementById('root')!).render(
  <div style={{ width: 900, height: 600, margin: 12 }}>
    <TerminalPane pane={{ id: 'pane', kind: 'codex', title: 'Synthetic agent', projectId: null, cwd: '/synthetic', state: 'running', runtimeId: 'synthetic' }}
      settings={settings} visible focused maximized={false} onPatch={noop} onFocus={noop} onStart={noop}
      onClose={noop} onMaximize={noop} onSplit={noop} onAlreadyOpen={noop} />
  </div>,
);
