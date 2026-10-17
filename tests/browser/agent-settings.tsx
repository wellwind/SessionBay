import { createRoot } from 'react-dom/client';
import { SettingsPanel } from '../../src/components/SettingsPanel';
import { agentKinds, defaultAgentOptions, executableDefaults } from '../../src/agents';
import { shortcutDefaults } from '../../src/commands';
import { uiTokens } from '../../src/themes';
import type { Settings } from '../../src/types';
import '../../src/styles.css';
import '../../src/workbench.css';

const mode = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';
for (const [key, value] of Object.entries(uiTokens('bay', mode))) document.documentElement.style.setProperty(`--${key}`, value);
const settings: Settings = {
  version: 1, theme: mode, terminalTheme: 'bay', fontFamily: 'monospace', fontSize: 14,
  defaultAgent: 'codex', defaultProfileId: 'shell', profiles: [{ id: 'shell', name: 'Shell', executable: '/bin/sh', args: [], env: {} }],
  sources: [{ id: 'synthetic', kind: 'codex', root: '/synthetic/.codex', enabled: true }],
  agentOptions: defaultAgentOptions(), executables: { ...executableDefaults },
  agentEnabled: { grok: false }, shortcuts: { ...shortcutDefaults }, onboardingComplete: true,
};
const noop = async () => {};
createRoot(document.getElementById('root')!).render(<SettingsPanel settings={settings}
  installations={agentKinds.map((kind) => ({ kind, available: kind === 'codex', executable: kind === 'codex' ? '/synthetic/codex' : null, version: null, error: null }))}
  index={{ running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] }}
  onSave={noop} onClose={() => {}} onDetect={noop} onScan={noop} onCancelScan={noop} onClearIndex={noop} />);
