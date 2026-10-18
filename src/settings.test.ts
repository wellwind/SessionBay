import { agentCapabilities, agentKinds, agentNames, bypassFlags, executableDefaults, historyAgentKinds, installationState, defaultAgentOptions, normalizedAgentOptions } from './agents';
import { createElement } from 'react';
import manifest from './agent-manifest.json';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canPickDirectory, pickDirectory } from './directory-picker';
vi.mock('./directory-picker', () => ({ canPickDirectory: vi.fn(() => false), pickDirectory: vi.fn() }));
beforeEach(() => { vi.mocked(canPickDirectory).mockReturnValue(false); vi.mocked(pickDirectory).mockReset(); });
import {
  SettingsPanel,
  normalizeShortcut,
  parseProfileArgs,
  parseProfileEnv,
  validateSettings,
} from './components/SettingsPanel';
import type { SettingsPanelProps } from './components/SettingsPanel';
import { shortcutDefaults } from './commands';
import type { AgentKind, Settings, ShellCandidate } from './types';

function validSettings(): Settings {
  return {
    version: 1,
    theme: 'dark',
    terminalTheme: 'bay',
    fontFamily: 'monospace',
    fontSize: 14,
    defaultAgent: 'codex',
    defaultProfileId: 'main',
    onboardingComplete: true,
    profiles: [
      { id: 'main', name: 'Default Shell', executable: '/bin/bash', args: ['-l'], env: {} },
    ],
    sources: [{ id: 'source-a', kind: 'codex', root: '/home/test/.codex', enabled: true }],
    agentOptions: defaultAgentOptions(),
    executables: { codex: 'codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
    shortcuts: { ...shortcutDefaults },
  };
}
function props(overrides: Partial<SettingsPanelProps> = {}): SettingsPanelProps {
  return {
    settings: validSettings(),
    installations: [],
    index: { running: false, processed: 0, total: 0, cancelled: false, errors: [], sources: [] },
    onSave: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
    onScan: vi.fn().mockResolvedValue(undefined),
    onCancelScan: vi.fn().mockResolvedValue(undefined),
    onClearIndex: vi.fn().mockResolvedValue(undefined),
    onDetect: vi.fn().mockResolvedValue(undefined),
    onDetectShells: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function selectAgent(kind: AgentKind) {
  const picker = screen.getByRole('combobox', { name: '搜尋 Agent' });
  if ((picker as HTMLInputElement).value === agentNames[kind] && picker.getAttribute('aria-expanded') === 'false') return picker.closest('.searchable-select')!;
  fireEvent.focus(picker);
  fireEvent.change(picker, { target: { value: '' } });
  fireEvent.click(screen.getByRole('option', { name: new RegExp(agentNames[kind]) }));
  return picker.closest('.searchable-select')!;
}

function openAgentOptions(name: string) {
  selectAgent(agentKinds.find((kind) => agentNames[kind] === name)!);
  const summary = screen.getByLabelText(`${name} 參數與權限設定`);
  const details = summary.closest('details')!;
  if (!details.open) fireEvent.click(summary);
}

describe('Windows history path settings', () => {
  afterEach(() => vi.restoreAllMocks());
  function windowsSettings(): Settings {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
    const settings = validSettings();
    settings.profiles[0] = { id: 'main', name: 'PowerShell', executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'], env: {} };
    settings.sources = historyAgentKinds.map((kind) => ({ id: `windows-${kind}`, kind, root: `C:\\Users\\Synthetic User\\.${kind}`, enabled: true }));
    return settings;
  }

  it('saves first-run Windows defaults with all native history roots', async () => {
    const settings = { ...windowsSettings(), onboardingComplete: false };
    expect(validateSettings(settings)).toEqual({});
    const config = props({ settings, onboarding: true });
    render(createElement(SettingsPanel, config));
    fireEvent.click(screen.getByRole('button', { name: '儲存並開始掃描' }));
    await waitFor(() => expect(config.onSave).toHaveBeenCalledExactlyOnceWith({ ...settings, onboardingComplete: true }));
    expect(config.onClose).toHaveBeenCalledOnce();
  });

  it.each([
    String.raw`D:\History & 中文\.codex`,
    String.raw`\\server\share\.codex`,
    String.raw`\\?\C:\Users\Synthetic User\.codex`,
    String.raw`\\?\UNC\server\share\.codex`,
  ])('saves an unchanged native directory-picker result: %s', async (root) => {
    const config = props({ settings: windowsSettings() });
    render(createElement(SettingsPanel, config));
    fireEvent.change(screen.getByRole('textbox', { name: 'CODEX_HOME 資料目錄' }), { target: { value: root } });
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(config.onSave).toHaveBeenCalledOnce());
    expect(vi.mocked(config.onSave).mock.calls[0][0].sources.find((source) => source.kind === 'codex')?.root).toBe(root);
  });

  it('adds and saves the canonical Windows path returned by source discovery', async () => {
    const root = String.raw`\\?\C:\History & 中文\.codex`;
    const config = props({ settings: windowsSettings(), onDetectHistorySources: vi.fn().mockResolvedValue({ kind: 'codex', supported: true, candidates: [
      { kind: 'codex', root, status: 'found', configured: false },
    ] }) });
    render(createElement(SettingsPanel, config));
    fireEvent.click(screen.getByRole('button', { name: '偵測 Codex 歷史來源' }));
    fireEvent.click(await screen.findByRole('button', { name: `加入 Codex 偵測來源 ${root}` }));
    expect(config.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(config.onSave).toHaveBeenCalledOnce());
    expect(vi.mocked(config.onSave).mock.calls[0][0].sources).toEqual(expect.arrayContaining([expect.objectContaining({ root })]));
  });

  it.each(['C:relative', '/Users/test/.codex', String.raw`C:\data\file:stream`, String.raw`\\.\pipe\name`])('blocks an invalid Windows source before save: %s', async (root) => {
    const settings = windowsSettings();
    settings.sources[0].root = root;
    const config = props({ settings, onboarding: true });
    render(createElement(SettingsPanel, config));
    fireEvent.click(screen.getByRole('button', { name: '儲存並開始掃描' }));
    expect(config.onSave).not.toHaveBeenCalled();
    expect(validateSettings(settings)['sources.0.root']).toBeTruthy();
  });
});

describe('settings validation', () => {
  it('accepts authoritative valid settings and an empty source list', () => {
    expect(validateSettings(validSettings())).toEqual({});
    expect(validateSettings({ ...validSettings(), sources: [] })).toEqual({});
  });
  it.each([8, 33, 12.5, Number.NaN])('rejects invalid font size %s', (fontSize) => {
    expect(validateSettings({ ...validSettings(), fontSize })).toHaveProperty('fontSize');
  });
  it('rejects empty executable overrides, invalid profile references and relative roots', () => {
    const settings = validSettings();
    settings.executables.codex = '';
    settings.defaultProfileId = 'missing';
    settings.sources[0].root = '~/.codex';
    expect(validateSettings(settings)).toMatchObject({
      'executables.codex': expect.any(String),
      defaultProfileId: expect.any(String),
      'sources.0.root': expect.any(String),
    });
  });
  it('rejects duplicate source roots and profile IDs', () => {
    const settings = validSettings();
    settings.sources.push({ ...settings.sources[0], id: 'different', root: '/home/test/.codex/' });
    settings.profiles.push({ ...settings.profiles[0] });
    expect(validateSettings(settings)).toMatchObject({
      'sources.1.root': expect.any(String),
      'profiles.1.id': expect.any(String),
    });
  });
  it('detects shortcut collisions regardless of case, spacing or modifier order', () => {
    const settings = validSettings();
    settings.shortcuts['new-agent'] = 'shift + mod + t';
    const errors = validateSettings(settings);
    expect(errors['shortcuts.new-agent']).toContain('衝突');
    expect(errors['shortcuts.new-terminal']).toContain('衝突');
    expect(normalizeShortcut('Command+shift+T')).toBe(normalizeShortcut('Meta+Shift+T'));
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
      expect(normalizeShortcut('Ctrl+Shift+T')).toBe(normalizeShortcut('Mod+Shift+T'));
      expect(normalizeShortcut('Command+Shift+T')).not.toBe(normalizeShortcut('Mod+Shift+T'));
    }
  });
  it('checks conflicts with default shortcuts even when settings only include overrides', () => {
    const settings = {
      ...validSettings(),
      shortcuts: { 'new-agent': shortcutDefaults['new-terminal'] },
    };
    expect(validateSettings(settings)['shortcuts.new-agent']).toContain('衝突');
  });
  it('allows blank shortcuts to disable a command', () => {
    const settings = validSettings();
    settings.shortcuts['new-terminal'] = '';
    expect(validateSettings(settings)).toEqual({});
  });
  it('rejects malformed shortcut expressions', () => {
    const settings = validSettings();
    settings.shortcuts['new-terminal'] = 'Shift+Mod+';
    expect(validateSettings(settings)['shortcuts.new-terminal']).toContain('修飾鍵');
  });
  it('enforces backend limits in UTF-8 bytes, rather than character count', () => {
    const settings = validSettings();
    settings.fontFamily = '字'.repeat(86);
    settings.profiles[0].args = Array(65).fill('a');
    expect(validateSettings(settings)).toMatchObject({
      fontFamily: expect.any(String),
      'profiles.0.args': expect.any(String),
    });
  });
});

describe('profile JSON fields', () => {
  it('preserves literal command-looking arguments as independent strings', () => {
    const args = ['-l', 'hello world', '$(touch /tmp/never-run)', 'a; b', '中文'];
    expect(parseProfileArgs(JSON.stringify(args))).toEqual({ value: args });
  });
  it.each(['not json', '{}', '[1]', '[null]', '["\\u0000"]'])(
    'rejects malformed arguments: %s',
    (value) => {
      expect(parseProfileArgs(value).error).toBeTruthy();
    },
  );
  it('accepts explicit string-valued environment variables', () => {
    expect(parseProfileEnv('{"LANG":"zh_TW.UTF-8","EMPTY":""}')).toEqual({
      value: { LANG: 'zh_TW.UTF-8', EMPTY: '' },
    });
  });
  it.each(['[]', 'null', '{"LANG": 42}', '{"BAD=NAME":"value"}', '{"LANG":"\\u0000"}'])(
    'rejects unsafe environment shapes: %s',
    (value) => {
      expect(parseProfileEnv(value).error).toBeTruthy();
    },
  );
});

describe('SettingsPanel', () => {
  it('shows installed tools independently from missing history', () => {
    const config = props({
      installations: [
        {
          kind: 'codex',
          executable: '/usr/bin/codex',
          version: '0.1.0',
          available: true,
          error: null,
        },
      ],
    });
    render(createElement(SettingsPanel, config));
    expect(screen.getByRole('combobox', { name: '搜尋 Agent' })).toHaveValue('Codex');
    expect(screen.getByText('已啟用 · 可啟動')).toBeInTheDocument();
    expect(screen.getByText('可啟動')).toBeInTheDocument();
    expect(screen.getByText('尚未掃描')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
  });
  it('submits onboarding completion once without launching an extra scan', async () => {
    const config = props({
      onboarding: true,
      settings: { ...validSettings(), onboardingComplete: false },
    });
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: '儲存並開始掃描' }));
    await waitFor(() => expect(config.onSave).toHaveBeenCalledTimes(1));
    expect(config.onSave).toHaveBeenCalledWith(
      expect.objectContaining({ onboardingComplete: true }),
    );
    expect(config.onScan).not.toHaveBeenCalled();
    expect(config.onClose).toHaveBeenCalledTimes(1);
  });
  it('keeps malformed profile JSON in the editor and blocks saving with an inline error', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: 'Shell Profiles' }));
    const field = screen.getByRole('textbox', { name: /啟動參數/ });
    fireEvent.change(field, { target: { value: '[broken' } });
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).not.toHaveBeenCalled();
    expect(field).toHaveValue('[broken');
    expect(screen.getByText('參數必須是有效的 JSON 字串陣列。')).toBeInTheDocument();
  });
  it('requires clear-index confirmation and explains original data is untouched', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: '清除索引' }));
    expect(config.onClearIndex).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByText(/原始 Agent 對話、來源檔案、專案與設定都不會被修改/),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: '返回' }));
    expect(config.onClearIndex).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '清除索引' }));
    await userEvent.click(screen.getByRole('button', { name: '確定清除索引' }));
    await waitFor(() => expect(config.onClearIndex).toHaveBeenCalledTimes(1));
  });
  it('defaults clear confirmation to native Enter while preserving IME and explicit return', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    const opener = screen.getByRole('button', { name: '清除索引' });
    opener.focus();
    await userEvent.keyboard('{Enter}');
    const confirm = screen.getByRole('button', { name: '確定清除索引' });
    expect(confirm).toHaveFocus();
    expect(config.onClearIndex).not.toHaveBeenCalled();
    for (const guard of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }])
      expect(fireEvent.keyDown(confirm, { key: 'Enter', ...guard })).toBe(false);
    fireEvent.compositionStart(confirm);
    expect(fireEvent.keyDown(confirm, { key: 'Enter' })).toBe(false);
    fireEvent.compositionEnd(confirm);
    expect(config.onClearIndex).not.toHaveBeenCalled();
    await userEvent.tab({ shift: true });
    await userEvent.keyboard('{Enter}');
    expect(config.onClearIndex).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
    await userEvent.keyboard('{Enter}{Enter}');
    await waitFor(() => expect(config.onClearIndex).toHaveBeenCalledOnce());
  });
  it('requires discard confirmation and restores focus when cancellation is dismissed', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    fireEvent.change(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' }), {
      target: { value: '/usr/local/bin/codex' },
    });
    const cancel = screen.getByRole('button', { name: '取消' });
    await userEvent.click(cancel);
    expect(config.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '捨棄變更' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(cancel).toHaveFocus();
    await userEvent.click(cancel);
    await userEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    expect(config.onClose).toHaveBeenCalledTimes(1);
  });
  it('traps keyboard focus inside the destructive confirmation', async () => {
    render(createElement(SettingsPanel, props()));
    await userEvent.click(screen.getByRole('button', { name: '清除索引' }));
    const back = screen.getByRole('button', { name: '返回' });
    const confirm = screen.getByRole('button', { name: '確定清除索引' });
    expect(confirm).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(back).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await userEvent.tab();
    expect(back).toHaveFocus();
  });
  it('never scans stale unsaved source settings', async () => {
    render(createElement(SettingsPanel, props()));
    fireEvent.change(screen.getByRole('textbox', { name: /CODEX_HOME 資料目錄/ }), {
      target: { value: '/other/codex' },
    });
    expect(screen.getByRole('button', { name: '重新掃描' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新偵測' })).toBeDisabled();
    expect(screen.getByText('尚未套用')).toBeInTheDocument();
  });
  it('offers scan cancellation instead of clearing an active index', async () => {
    const config = props({
      index: { running: true, processed: 4, total: 12, cancelled: false, errors: [], sources: [] },
    });
    render(createElement(SettingsPanel, config));
    expect(screen.queryByRole('button', { name: '清除索引' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '取消掃描' }));
    expect(config.onCancelScan).toHaveBeenCalledTimes(1);
  });
  it('keeps settings open and shows backend failure when saving fails', async () => {
    const config = props({ onSave: vi.fn().mockRejectedValue(new Error('設定檔無法寫入')) });
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('設定檔無法寫入'));
    expect(config.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '儲存設定' })).toBeEnabled();
  });
  it.each([undefined, '', 'Mod+Shift+Z'])('preserves Zen shortcut %s through save and reload', async binding => {
    const shortcuts: Record<string, string> = binding === undefined ? {} : { 'toggle-focus-mode': binding };
    const config = props({ settings: { ...validSettings(), shortcuts } });
    const view = render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: '鍵盤快捷鍵' }));
    expect(screen.getByRole('textbox', { name: /進入／退出專注模式/ })).toHaveValue(binding ?? 'Mod+Shift+Enter');
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(config.onSave).toHaveBeenCalledOnce());
    const saved = vi.mocked(config.onSave).mock.calls[0][0];
    expect(saved.shortcuts['toggle-focus-mode']).toBe(binding ?? 'Mod+Shift+Enter');
    view.unmount();
    render(createElement(SettingsPanel, props({ settings: saved })));
    await userEvent.click(screen.getByRole('button', { name: '鍵盤快捷鍵' }));
    expect(screen.getByRole('textbox', { name: /進入／退出專注模式/ })).toHaveValue(binding ?? 'Mod+Shift+Enter');
  });

  it('renders effective shortcut defaults and visible conflicts before save', async () => {
    const config = props({ settings: { ...validSettings(), shortcuts: {} } });
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: '鍵盤快捷鍵' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(Object.keys(shortcutDefaults).length);
    const agentShortcut = screen.getByRole('textbox', { name: /開始 Agent 工作/ });
    fireEvent.change(agentShortcut, { target: { value: shortcutDefaults['new-terminal'] } });
    expect(screen.getAllByText(/衝突/).length).toBeGreaterThan(1);
    expect(agentShortcut).toHaveAttribute('aria-invalid', 'true');
  });
  it('replaces drafts when authoritative settings props change', async () => {
    const config = props();
    const { rerender } = render(createElement(SettingsPanel, config));
    fireEvent.change(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' }), {
      target: { value: 'edited' },
    });
    rerender(
      createElement(SettingsPanel, {
        ...config,
        settings: {
          ...validSettings(),
          executables: { codex: 'authoritative', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
        },
      }),
    );
    expect(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toHaveValue('authoritative');
    expect(screen.getByRole('button', { name: '重新掃描' })).toBeEnabled();
  });
});


describe('selected-agent settings', () => {
  it.each(agentKinds)('initially shows only the saved default %s configuration', (kind) => {
    const config = props({ settings: { ...validSettings(), defaultAgent: kind }, onDetectHistorySources: vi.fn() });
    render(createElement(SettingsPanel, config));
    fireEvent.focus(screen.getByRole('combobox', { name: '搜尋 Agent' }));
    const picker = within(screen.getByRole('listbox', { name: '選擇要設定的 Agent' }));
    expect(picker.getAllByRole('option')).toHaveLength(agentKinds.length);
    for (const other of agentKinds) {
      expect(picker.getByRole('option', { name: new RegExp(agentNames[other]) })).toHaveAttribute('aria-selected', String(other === kind));
      const executable = screen.queryByRole('textbox', { name: `${agentNames[other]} 執行檔路徑` });
      const history = screen.queryByRole('region', { name: `${agentNames[other]} 歷史來源` });
      if (other === kind) {
        expect(executable).toHaveValue(config.settings.executables[other]);
        expect(history).toBeVisible();
        expect(screen.getByRole('checkbox', { name: `啟用 ${agentNames[other]}` })).toBeChecked();
      } else {
        expect(executable).not.toBeInTheDocument();
        expect(history).not.toBeInTheDocument();
        expect(screen.queryByLabelText(`${agentNames[other]} 參數與權限設定`)).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: `啟用 ${agentNames[other]}` })).not.toBeInTheDocument();
      }
    }
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onDetect).not.toHaveBeenCalled();
    expect(config.onDetectHistorySources).not.toHaveBeenCalled();
  });

  it('filters names and IDs without changing the selected draft and recovers from no results', () => {
    const config = props({ onDetectHistorySources: vi.fn() });
    render(createElement(SettingsPanel, config));
    const search = screen.getByRole('combobox', { name: '搜尋 Agent' });
    fireEvent.focus(screen.getByRole('combobox', { name: '搜尋 Agent' }));
    const picker = within(screen.getByRole('listbox', { name: '選擇要設定的 Agent' }));
    fireEvent.change(search, { target: { value: '  CLAUDE  ' } });
    expect(picker.getAllByRole('option')).toHaveLength(1);
    expect(picker.getByRole('option', { name: /Claude Code/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toHaveValue('codex');
    fireEvent.change(search, { target: { value: 'missing-provider' } });
    expect(picker.queryByRole('option')).not.toBeInTheDocument();
    expect(screen.getByText('沒有符合的 Agent。請試試其他名稱。')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Codex 歷史來源' })).toBeVisible();
    fireEvent.change(search, { target: { value: '' } });
    expect(screen.queryByText('沒有符合的 Agent。請試試其他名稱。')).not.toBeInTheDocument();
    expect(picker.getAllByRole('option')).toHaveLength(agentKinds.length);
    for (const kind of agentKinds) selectAgent(kind);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(config.onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onDetect).not.toHaveBeenCalled();
    expect(config.onDetectHistorySources).not.toHaveBeenCalled();
    expect(config.onScan).not.toHaveBeenCalled();
    expect(config.settings.defaultAgent).toBe('codex');
  });

  it('preserves each provider executable, source and incomplete argument drafts when switching', () => {
    const config = props({ settings: olderHistorySettings(), onDetectHistorySources: vi.fn() });
    const original = structuredClone(config.settings);
    render(createElement(SettingsPanel, config));
    fireEvent.change(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' }), { target: { value: '/draft/codex' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'CODEX_HOME 資料目錄' }), { target: { value: '/draft/codex-history' } });
    openAgentOptions('Codex');
    fireEvent.change(screen.getByRole('textbox', { name: 'Codex 自訂啟動參數' }), { target: { value: '[unfinished' } });
    selectAgent('claude');
    fireEvent.change(screen.getByRole('textbox', { name: 'Claude Code 執行檔路徑' }), { target: { value: '/draft/claude' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'CLAUDE_CONFIG_DIR 資料目錄' }), { target: { value: '/draft/claude-history' } });
    openAgentOptions('Claude Code');
    fireEvent.change(screen.getByRole('textbox', { name: 'Claude Code 自訂啟動參數' }), { target: { value: '["--model","draft-model"]' } });
    for (const kind of agentKinds) selectAgent(kind);
    selectAgent('codex');
    expect(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toHaveValue('/draft/codex');
    expect(screen.getByRole('textbox', { name: 'CODEX_HOME 資料目錄' })).toHaveValue('/draft/codex-history');
    openAgentOptions('Codex');
    expect(screen.getByRole('textbox', { name: 'Codex 自訂啟動參數' })).toHaveValue('[unfinished');
    selectAgent('claude');
    expect(screen.getByRole('textbox', { name: 'Claude Code 執行檔路徑' })).toHaveValue('/draft/claude');
    expect(screen.getByRole('textbox', { name: 'CLAUDE_CONFIG_DIR 資料目錄' })).toHaveValue('/draft/claude-history');
    openAgentOptions('Claude Code');
    expect(screen.getByRole('textbox', { name: 'Claude Code 自訂啟動參數' })).toHaveValue('["--model","draft-model"]');
    expect(screen.getByRole('checkbox', { name: '啟用資料來源 2' })).not.toBeChecked();
    expect(config.settings).toEqual(original);
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onDetect).not.toHaveBeenCalled();
    expect(config.onDetectHistorySources).not.toHaveBeenCalled();
    expect(config.onScan).not.toHaveBeenCalled();
  });

  it('reveals a hidden invalid provider and clears its search filter when Save is blocked', () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    fireEvent.change(screen.getByRole('textbox', { name: 'CODEX_HOME 資料目錄' }), { target: { value: '' } });
    selectAgent('grok');
    fireEvent.change(screen.getByRole('combobox', { name: '搜尋 Agent' }), { target: { value: 'grok' } });
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: '搜尋 Agent' })).toHaveValue('Codex');
    expect(screen.getByRole('textbox', { name: 'CODEX_HOME 資料目錄' })).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('agent enablement settings transaction', () => {
  it.each(agentKinds)('saves %s enablement only on Save while preserving all other configuration', async (kind) => {
    const settings = olderHistorySettings();
    settings.agentEnabled = { 'future-provider': false };
    settings.agentOptions[kind] = { extraArgs: ['--model', 'preserved-model'], bypassPermissions: false };
    const original = structuredClone(settings);
    const config = props({ settings, onDetectHistorySources: vi.fn() });
    render(createElement(SettingsPanel, config));
    selectAgent(kind);
    const toggle = screen.getByRole('checkbox', { name: `啟用 ${agentNames[kind]}` });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(selectAgent(kind)).toHaveTextContent('已停用');
    expect(screen.getByRole('textbox', { name: `${agentNames[kind]} 執行檔路徑` })).toBeEnabled();
    selectAgent(agentKinds.find((other) => other !== kind)!);
    expect(screen.getByRole('checkbox', { name: /^啟用 / })).toBeChecked();
    selectAgent(kind);
    expect(screen.getByRole('checkbox', { name: `啟用 ${agentNames[kind]}` })).not.toBeChecked();
    expect(settings).toEqual(original);
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onDetect).not.toHaveBeenCalled();
    expect(config.onDetectHistorySources).not.toHaveBeenCalled();
    expect(config.onScan).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledExactlyOnceWith({ ...original, agentEnabled: { 'future-provider': false, [kind]: false } });
    expect(settings).toEqual(original);
  });

  it.each(agentKinds)('can re-enable a saved disabled %s without discarding existing settings', async (kind) => {
    const settings = olderHistorySettings();
    settings.agentEnabled = { 'future-provider': true, [kind]: false };
    const original = structuredClone(settings);
    const config = props({ settings });
    render(createElement(SettingsPanel, config));
    selectAgent(kind);
    const toggle = screen.getByRole('checkbox', { name: `啟用 ${agentNames[kind]}` });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(config.onSave).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledExactlyOnceWith({ ...original, agentEnabled: { 'future-provider': true, [kind]: true } });
    expect(settings).toEqual(original);
  });

  it('discards enablement changes for every provider and preserves an absent map on reopen and save', async () => {
    const config = props();
    const original = structuredClone(config.settings);
    const view = render(createElement(SettingsPanel, config));
    for (const kind of agentKinds) {
      selectAgent(kind);
      fireEvent.click(screen.getByRole('checkbox', { name: `啟用 ${agentNames[kind]}` }));
    }
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(config.onClose).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '捨棄變更' }));
    expect(config.onClose).toHaveBeenCalledOnce();
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.settings).toEqual(original);
    view.unmount();
    render(createElement(SettingsPanel, config));
    for (const kind of agentKinds) {
      selectAgent(kind);
      expect(screen.getByRole('checkbox', { name: `啟用 ${agentNames[kind]}` })).toBeChecked();
    }
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledExactlyOnceWith(original);
    expect(vi.mocked(config.onSave).mock.calls[0][0]).not.toHaveProperty('agentEnabled');
  });
});

describe('per-agent launch options', () => {
  it('enforces shared argv count and UTF-8 byte limits, with empty arguments valid for Shell profiles', () => {
    expect(parseProfileArgs(JSON.stringify(Array(64).fill(''))).value).toHaveLength(64);
    expect(parseProfileArgs(JSON.stringify(Array(65).fill(''))).error).toBeTruthy();
    expect(parseProfileArgs(JSON.stringify(['a'.repeat(8192)])).error).toBeUndefined();
    expect(parseProfileArgs(JSON.stringify(['a'.repeat(8193)])).error).toBeTruthy();
    expect(parseProfileArgs(JSON.stringify(['字'.repeat(2730)])).error).toBeUndefined();
    expect(parseProfileArgs(JSON.stringify(['字'.repeat(2731)])).error).toBeTruthy();
  });

  it('creates independent safe defaults for every tool and every invocation', () => {
    const defaults = defaultAgentOptions();
    expect(Object.keys(defaults)).toEqual(['codex', 'claude', 'grok', 'antigravity', 'opencode']);
    for (const options of Object.values(defaults)) {
      expect(options).toEqual({ extraArgs: [], bypassPermissions: false });
    }
    defaults.grok.extraArgs.push('--verbose');
    defaults.grok.bypassPermissions = true;
    expect(defaults.antigravity).toEqual({ extraArgs: [], bypassPermissions: false });
    expect(defaultAgentOptions().grok).toEqual({ extraArgs: [], bypassPermissions: false });
  });
  it('normalizes partial older options without sharing mutable arrays', () => {
    const settings = validSettings();
    settings.agentOptions = { codex: { extraArgs: ['--model', 'synthetic model'], bypassPermissions: true } } as Settings['agentOptions'];
    const options = normalizedAgentOptions(settings);
    expect(options.codex).toEqual(settings.agentOptions.codex);
    expect(options.grok).toEqual({ extraArgs: [], bypassPermissions: false });
    expect(options.antigravity).toEqual({ extraArgs: [], bypassPermissions: false });
    options.codex.extraArgs.push('--verbose');
    expect(settings.agentOptions.codex.extraArgs).toEqual(['--model', 'synthetic model']);
  });
  it('migrates legacy two-tool settings to safe four-tool defaults when saved', async () => {
    const legacy: Partial<Settings> = { ...validSettings() };
    delete legacy.agentOptions;
    legacy.executables = { codex: '/synthetic/codex', claude: 'claude' } as Settings['executables'];
    const config = props({ settings: legacy as Settings });
    render(createElement(SettingsPanel, config));
    selectAgent('grok');
    expect(screen.getByRole('textbox', { name: 'Grok Build 執行檔路徑' })).toHaveValue('grok');
    selectAgent('antigravity');
    expect(screen.getByRole('textbox', { name: 'Antigravity CLI 執行檔路徑' })).toHaveValue('agy');
    for (const kind of agentKinds) {
      openAgentOptions(agentNames[kind]);
      expect(screen.getByRole('textbox', { name: `${agentNames[kind]} 自訂啟動參數` })).toHaveValue('[]');
      openAgentOptions(agentNames[kind]);
      expect(screen.getByRole('checkbox', { name: `${agentNames[kind]} 略過權限確認` })).not.toBeChecked();
    }
    expect(screen.getByRole('button', { name: '重新偵測' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      executables: { codex: '/synthetic/codex', claude: 'claude', grok: 'grok', antigravity: 'agy', opencode: 'opencode' },
      agentOptions: defaultAgentOptions(),
    }));
    expect(legacy.agentOptions).toBeUndefined();
  });
  it('saves each custom argv array literally and independently without changing authoritative settings', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    const argsByAgent = {
      codex: ['--model', 'synthetic codex'],
      claude: ['--model', 'synthetic claude'],
      grok: ['--model', '$(touch /tmp/never-run); "literal"', '--rules', '中文'],
      antigravity: ['--model', '<script>never execute</script>', '--agent', 'two words'],
      opencode: ['--model', 'synthetic/model', '--pure'],
    };
    for (const kind of agentKinds) {
      openAgentOptions(agentNames[kind]);
      fireEvent.change(screen.getByRole('textbox', { name: `${agentNames[kind]} 自訂啟動參數` }), {
        target: { value: JSON.stringify(argsByAgent[kind]) },
      });
    }
    expect(screen.getByRole('button', { name: '重新掃描' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新偵測' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    const saved = vi.mocked(config.onSave).mock.calls[0][0];
    for (const kind of agentKinds) {
      expect(saved.agentOptions[kind]).toEqual({ extraArgs: argsByAgent[kind], bypassPermissions: false });
    }
    expect(config.settings.agentOptions).toEqual(defaultAgentOptions());
    expect(document.querySelector('script')).toBeNull();
  });
  it.each(['[broken', '{}', '[1]', '[null]', '["\\u0000"]'])('preserves invalid custom argv %s and blocks save', async (raw) => {
    const config = props();
    render(createElement(SettingsPanel, config));
    openAgentOptions('Grok Build');
    const field = screen.getByRole('textbox', { name: 'Grok Build 自訂啟動參數' });
    fireEvent.change(field, { target: { value: raw } });
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).not.toHaveBeenCalled();
    expect(field).toHaveValue(raw);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: '重新偵測' })).toBeDisabled();
  });
  it.each([
    ['codex', '--yolo'], ['codex', '--dangerously-bypass-approvals-and-sandbox'],
    ['claude', '--dangerously-skip-permissions'], ['claude', '--allow-dangerously-skip-permissions'],
    ['grok', '--always-approve'], ['antigravity', '--dangerously-skip-permissions'], ['opencode', '--auto'],
  ] satisfies [AgentKind, string][])('requires explicit opt-in for %s risky custom flag %s', (kind, flag) => {
    const settings = validSettings();
    settings.agentOptions[kind].extraArgs = [flag];
    expect(validateSettings(settings)[`agentOptions.${kind}`]).toContain('明確勾選');
    settings.agentOptions[kind].bypassPermissions = true;
    expect(validateSettings(settings)).toEqual({});
  });
  it.each(agentKinds)('limits %s permission bypass opt-in to that tool and saves custom argv', async (kind) => {
    const config = props();
    render(createElement(SettingsPanel, config));
    openAgentOptions(agentNames[kind]);
    fireEvent.change(screen.getByRole('textbox', { name: `${agentNames[kind]} 自訂啟動參數` }), {
      target: { value: JSON.stringify([bypassFlags[kind]]) },
    });
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).not.toHaveBeenCalled();
    openAgentOptions(agentNames[kind]);
    await userEvent.click(screen.getByRole('checkbox', { name: `${agentNames[kind]} 略過權限確認` }));
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    const saved = vi.mocked(config.onSave).mock.calls[0][0];
    for (const other of agentKinds) {
      expect(saved.agentOptions[other]).toEqual(other === kind
        ? { extraArgs: [bypassFlags[kind]], bypassPermissions: true }
        : { extraArgs: [], bypassPermissions: false });
    }
  });
  it('preserves unsupported custom argv for correction when authoritative save validation rejects it', async () => {
    const config = props({ onSave: vi.fn().mockRejectedValue(new Error('Unsupported or managed grok argument: --session-id')) });
    render(createElement(SettingsPanel, config));
    openAgentOptions('Grok Build');
    const field = screen.getByRole('textbox', { name: 'Grok Build 自訂啟動參數' });
    fireEvent.change(field, { target: { value: '["--session-id","managed-id"]' } });
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unsupported or managed grok argument: --session-id'));
    expect(field).toHaveValue('["--session-id","managed-id"]');
    expect(config.onClose).not.toHaveBeenCalled();
    expect(config.settings.agentOptions.grok.extraArgs).toEqual([]);
  });
  it('does not save incomplete custom argv or bypass changes when they are discarded', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    openAgentOptions('Antigravity CLI');
    fireEvent.change(screen.getByRole('textbox', { name: 'Antigravity CLI 自訂啟動參數' }), {
      target: { value: '[incomplete' },
    });
    openAgentOptions('Antigravity CLI');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Antigravity CLI 略過權限確認' }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(config.onClose).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '捨棄變更' }));
    expect(config.onClose).toHaveBeenCalledTimes(1);
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.settings.agentOptions).toEqual(defaultAgentOptions());
  });
  it('replaces custom argv and risk edits when authoritative settings change', () => {
    const config = props();
    const view = render(createElement(SettingsPanel, config));
    openAgentOptions('Grok Build');
    fireEvent.change(screen.getByRole('textbox', { name: 'Grok Build 自訂啟動參數' }), {
      target: { value: '[unfinished' },
    });
    openAgentOptions('Grok Build');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Grok Build 略過權限確認' }));
    const authoritative = validSettings();
    authoritative.agentOptions.grok.extraArgs = ['--model', 'saved model'];
    view.rerender(createElement(SettingsPanel, { ...config, settings: authoritative }));
    openAgentOptions('Grok Build');
    expect(screen.getByRole('textbox', { name: 'Grok Build 自訂啟動參數' })).toHaveValue('["--model","saved model"]');
    openAgentOptions('Grok Build');
    expect(screen.getByRole('checkbox', { name: 'Grok Build 略過權限確認' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '重新偵測' })).toBeEnabled();
  });
  it('offers Antigravity CLI history alongside other providers and distinguishes App data', async () => {
    const config = props({ installations: [{ kind: 'antigravity', executable: '/synthetic/agy', version: 'synthetic', available: true, error: null }] });
    render(createElement(SettingsPanel, config));
    selectAgent('antigravity');
    expect(screen.getByText(/不包含 App／IDE/)).toBeInTheDocument();
    selectAgent('codex');
    const sourceKind = screen.getByRole('combobox', { name: 'Agent 類型' });
    fireEvent.click(sourceKind);
    const sourceOptions = within(screen.getByRole('listbox', { name: 'Agent 類型' }));
    expect(sourceOptions.getAllByRole('option')).toHaveLength(agentKinds.length);
    for (const name of ['Codex', 'Claude Code', 'Grok Build']) expect(sourceOptions.getByRole('option', { name })).toBeInTheDocument();
    expect(sourceOptions.getByRole('option', { name: 'Antigravity CLI' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '外觀與預設值' }));
    fireEvent.click(screen.getByRole('combobox', { name: '預設 Agent' }));
    expect(screen.getByRole('option', { name: 'Antigravity CLI' })).toBeInTheDocument();
  });
  it('saves a Grok history source with its own directory hint', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    fireEvent.click(screen.getByRole('combobox', { name: 'Agent 類型' }));
    fireEvent.click(screen.getByRole('option', { name: 'Grok Build' }));
    selectAgent('grok');
    const root = screen.getByRole('textbox', { name: /GROK.*資料目錄|Grok.*資料目錄/i });
    expect(root).toHaveAttribute('placeholder', expect.stringContaining('.grok'));
    fireEvent.change(root, { target: { value: '/synthetic/.grok' } });
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledWith(expect.objectContaining({
      sources: [{ id: 'source-a', kind: 'grok', root: '/synthetic/.grok', enabled: true }],
    }));
  });
  it('accepts Antigravity CLI history sources and the default launch agent', () => {
    const settings = validSettings();
    settings.defaultAgent = 'antigravity';
    expect(validateSettings(settings)).toEqual({});
    settings.sources[0].kind = 'antigravity';
    expect(validateSettings(settings)).toEqual({});
  });
});


function olderHistorySettings(): Settings {
  return {
    ...validSettings(),
    sources: [
      { id: 'source-a', kind: 'codex', root: '/synthetic/custom-codex', enabled: true },
      { id: 'source-b', kind: 'claude', root: '/synthetic/custom-claude', enabled: false },
    ],
  };
}
function providerHistory(kind: AgentKind) {
  selectAgent(kind);
  return within(screen.getByRole('region', { name: `${agentNames[kind]} 歷史來源` }));
}

describe('fixed provider history capabilities', () => {
  it('distinguishes a failed version probe from a missing binary without inferring login', () => {
    const installation = { kind: 'grok' as const, executable: '/synthetic/grok', version: null, available: true,
      status: 'versionCheckFailed' as const, loginStatus: 'unknown' as const, error: 'Synthetic version timeout' };
    expect(installationState(installation)).toEqual({ text: '已找到執行檔 · 版本檢查失敗', className: 'warning' });
    render(createElement(SettingsPanel, props({ installations: [installation] })));
    selectAgent('grok');
    expect(screen.getByText('已找到執行檔 · 版本檢查失敗')).toBeInTheDocument();
    expect(screen.queryByText('未偵測到')).not.toBeInTheDocument();
    expect(screen.getByText('Synthetic version timeout')).toBeInTheDocument();
    for (const kind of agentKinds) {
      selectAgent(kind);
      expect(screen.getAllByText('登入狀態：未驗證；沿用 CLI 自身登入。')).toHaveLength(1);
    }
  });
  it('reports discovered but unprobed binaries honestly for legacy and explicit detection results', () => {
    const discovered = { kind: 'codex' as const, executable: '/synthetic/codex', version: null, available: true, error: null };
    expect(installationState(discovered).text).toBe('已找到執行檔');
    expect(installationState({ ...discovered, status: 'available', loginStatus: 'unknown' }).text).toBe('已找到執行檔');
    expect(installationState({ ...discovered, available: false, status: 'missing', executable: null }).text).toBe('未偵測到');
    expect(installationState(undefined).text).toBe('尚未偵測');
  });

  it('keeps the shared built-in manifest complete and consistent with registered UI and managed argv contracts', () => {
    expect(manifest.version).toBe(1);
    expect(manifest.providers.map((provider) => provider.id)).toEqual(['codex', 'claude', 'grok', 'antigravity', 'opencode']);
    expect(new Set(manifest.providers.map((provider) => provider.id)).size).toBe(manifest.providers.length);
    expect([...agentKinds]).toEqual(manifest.providers.map((provider) => provider.id));
    for (const provider of manifest.providers) {
      expect(agentCapabilities[provider.id as AgentKind]).toEqual(provider);
      expect(provider.activity.transport).toBe('orderedBridgeOptIn');
      expect(provider.activity.adapter).toBe(provider.id === 'opencode' ? 'openCodeV1Events' : `${provider.id}Hooks`);
      expect(provider.launch.versionArgs).toEqual(provider.id === 'grok' ? ['version'] : ['--version']);
      expect(provider.launch.newArgs).toEqual([]);
      expect(provider.launch.resumeArgs).toEqual([provider.resume.argument, '{resumeId}']);
      expect(provider.launch.cwdArgs).toEqual(provider.id === 'codex' ? ['--cd', '{cwd}'] : []);
      expect(provider.history.defaultDirectory).not.toMatch(/^\//);
      expect(provider.history.supported).toBe(provider.history.parserId !== null);
      if (provider.history.supported) {
        expect(provider.history.parserId).toBe(provider.id);
        if (provider.history.sourceEnv !== null) expect(provider.history.sourceEnv).toMatch(/^[A-Z_]+$/);
        expect(provider.history.rootPlaceholder).toMatch(/^\//);
      } else {
        expect(provider.history.sourceEnv).toBeNull();
        expect(provider.history.rootPlaceholder).toBeNull();
      }
    }
    expect(agentCapabilities.antigravity.history.defaultDirectory).toBe('.gemini/antigravity-cli');
  });

  it('derives compatible names, executables, history providers and resume semantics from one registry', () => {
    expect(Object.keys(agentCapabilities)).toEqual([...agentKinds]);
    expect(historyAgentKinds).toEqual(['codex', 'claude', 'grok', 'antigravity', 'opencode']);
    for (const kind of agentKinds) {
      expect(agentNames[kind]).toBe(agentCapabilities[kind].name);
      expect(executableDefaults[kind]).toBe(agentCapabilities[kind].executable);
      expect(bypassFlags[kind]).toBe(agentCapabilities[kind].bypassFlag);
    }
    expect(agentCapabilities.grok.history).toMatchObject({ supported: true, sourceEnv: 'GROK_HOME' });
    expect(agentCapabilities.grok.resume).toMatchObject({ manualId: true, argument: '--resume' });
    expect(agentCapabilities.antigravity).toMatchObject({ executable: 'agy', history: { supported: true, sourceEnv: null, rootPlaceholder: '/Users/you/.gemini/antigravity-cli' } });
    expect(agentCapabilities.antigravity.resume).toMatchObject({ manualId: true, argument: '--conversation' });
  });
  it('makes every history provider selectable for older two-source settings without mutating or enabling sources', () => {
    const settings = olderHistorySettings();
    const config = props({ settings });
    render(createElement(SettingsPanel, config));
    for (const kind of agentKinds) {
      selectAgent(kind);
      expect(screen.getByRole('region', { name: `${agentNames[kind]} 歷史來源` })).toBeVisible();
    }
    expect(providerHistory('grok').getByText('尚未設定來源')).toBeInTheDocument();
    expect(providerHistory('grok').getByRole('button', { name: '設定 Grok Build 歷史來源' })).toBeEnabled();
    expect(providerHistory('grok').queryByRole('textbox')).not.toBeInTheDocument();
    expect(providerHistory('claude').getByRole('checkbox', { name: '啟用資料來源 2' })).not.toBeChecked();
    expect(providerHistory('codex').getByRole('textbox', { name: 'CODEX_HOME 資料目錄' })).toHaveValue('/synthetic/custom-codex');
    expect(providerHistory('antigravity').getByText('尚未設定來源')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新偵測' })).toBeEnabled();
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onScan).not.toHaveBeenCalled();
    expect(settings.sources).toEqual(olderHistorySettings().sources);
  });
  it('opens a blank focused Grok source draft, validates it, and saves without overwriting older sources', async () => {
    const settings = olderHistorySettings();
    const config = props({ settings });
    render(createElement(SettingsPanel, config));
    await userEvent.click(providerHistory('grok').getByRole('button', { name: '設定 Grok Build 歷史來源' }));
    const root = providerHistory('grok').getByRole('textbox', { name: 'GROK_HOME 資料目錄' });
    expect(root).toHaveValue('');
    expect(root).toHaveFocus();
    expect(root).toHaveAttribute('placeholder', '/Users/you/.grok');
    expect(providerHistory('grok').getByText('尚未套用')).toBeInTheDocument();
    expect(providerHistory('grok').queryByText('尚無歷史')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新掃描' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).not.toHaveBeenCalled();
    expect(root).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(root, { target: { value: '/synthetic/existing-grok' } });
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(config.onSave).mock.calls[0][0];
    expect(saved.sources.slice(0, 2)).toEqual(settings.sources);
    expect(saved.sources[2]).toEqual({ id: expect.any(String), kind: 'grok', root: '/synthetic/existing-grok', enabled: true });
    expect(new Set(saved.sources.map((source) => source.id)).size).toBe(3);
    expect(settings.sources).toHaveLength(2);
    expect(config.onScan).not.toHaveBeenCalled();
  });
  it('discards a new Grok source without saving or changing the original provider states', async () => {
    const settings = olderHistorySettings();
    const config = props({ settings });
    const view = render(createElement(SettingsPanel, config));
    await userEvent.click(providerHistory('grok').getByRole('button', { name: '設定 Grok Build 歷史來源' }));
    fireEvent.change(providerHistory('grok').getByRole('textbox', { name: 'GROK_HOME 資料目錄' }), { target: { value: '/synthetic/draft-only' } });
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(config.onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onClose).toHaveBeenCalledTimes(1);
    expect(settings.sources).toEqual(olderHistorySettings().sources);
    view.unmount();
    render(createElement(SettingsPanel, config));
    expect(providerHistory('grok').getByText('尚未設定來源')).toBeInTheDocument();
    expect(providerHistory('grok').queryByRole('textbox')).not.toBeInTheDocument();
    expect(providerHistory('claude').getByRole('checkbox')).not.toBeChecked();
  });
  it('keeps explicit provider selection and multiple custom sources with their original IDs and enablement', async () => {
    const settings = olderHistorySettings();
    settings.sources.push({ id: 'grok-disabled', kind: 'grok', root: '/synthetic/archived-grok', enabled: false });
    const config = props({ settings });
    render(createElement(SettingsPanel, config));
    fireEvent.focus(screen.getByRole('combobox', { name: '搜尋 Agent' }));
    const picker = within(screen.getByRole('listbox', { name: '選擇要設定的 Agent' }));
    expect(picker.getAllByRole('option')).toHaveLength(agentKinds.length);
    for (const kind of agentKinds) expect(picker.getByRole('option', { name: new RegExp(agentNames[kind]) })).toBeInTheDocument();
    selectAgent('grok');
    await userEvent.click(screen.getByRole('button', { name: '新增 Grok Build 歷史來源' }));
    const fields = providerHistory('grok').getAllByRole('textbox', { name: 'GROK_HOME 資料目錄' });
    expect(fields).toHaveLength(2);
    expect(fields[0]).toHaveValue('/synthetic/archived-grok');
    expect(fields[1]).toHaveValue('');
    expect(providerHistory('grok').getByRole('checkbox', { name: '啟用資料來源 3' })).not.toBeChecked();
    fireEvent.change(fields[1], { target: { value: '/synthetic/second-grok' } });
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    const saved = vi.mocked(config.onSave).mock.calls[0][0];
    expect(saved.sources.slice(0, 3)).toEqual(settings.sources);
    expect(saved.sources[3]).toMatchObject({ kind: 'grok', root: '/synthetic/second-grok', enabled: true });
  });
  it('returns Grok to unconfigured after removing its last draft source while retaining its provider card', async () => {
    render(createElement(SettingsPanel, props({ settings: olderHistorySettings() })));
    await userEvent.click(providerHistory('grok').getByRole('button', { name: '設定 Grok Build 歷史來源' }));
    await userEvent.click(providerHistory('grok').getByRole('button', { name: '移除資料來源 3' }));
    expect(providerHistory('grok').getByText('尚未設定來源')).toBeInTheDocument();
    expect(providerHistory('grok').queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新掃描' })).toBeEnabled();
  });
  it('shows installed Antigravity and unconfigured history as independent states', () => {
    render(createElement(SettingsPanel, props({ onDetectHistorySources: vi.fn(), installations: [{ kind: 'antigravity', executable: '/synthetic/agy', version: 'test', available: true, error: null }] })));
    const history = providerHistory('antigravity');
    expect(screen.getByText('可啟動')).toBeInTheDocument();
    expect(history.getByText('尚未設定來源')).toBeInTheDocument();
    expect(history.getByText(/不包含 App／IDE/)).toBeInTheDocument();
    expect(history.queryByRole('textbox')).not.toBeInTheDocument();
    expect(history.getByRole('button', { name: '偵測 Antigravity CLI 歷史來源' })).toBeEnabled();
    expect(history.queryByText('尚無歷史')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '搜尋 Agent' })).toHaveValue('Antigravity CLI');
    expect(history.getByRole('button', { name: '設定 Antigravity CLI 歷史來源' })).toBeEnabled();
  });
  it.each([
    { status: 'ready', files: 3, expected: '可讀取 · 3 個檔案' },
    { status: 'empty', files: 0, expected: '尚無歷史' },
    { status: 'missing', files: 0, expected: '找不到來源目錄' },
    { status: 'error', files: 0, expected: '來源讀取錯誤' },
    { status: 'cancelled', files: 1, expected: '掃描已取消' },
    { status: 'partial', files: 2, expected: '部分可讀取 · 2 個檔案' },
    { status: 'unexpected-state', files: 0, expected: '來源狀態待確認' },
  ])('shows known history status $status independently of a missing binary', ({ status, files, expected }) => {
    const config = props({ installations: [{ kind: 'codex', executable: null, version: null, available: false, error: 'CLI missing' }] });
    config.index.sources = [{ sourceId: 'source-a', status, files, message: 'Synthetic source detail' }];
    render(createElement(SettingsPanel, config));
    const history = providerHistory('codex');
    expect(screen.getByText('未偵測到')).toBeInTheDocument();
    expect(history.getByText(expected)).toBeInTheDocument();
    expect(history.getByText('Synthetic source detail')).toBeInTheDocument();
    if (status !== 'empty') expect(history.queryByText('尚無歷史')).not.toBeInTheDocument();
  });
  it('does not confuse installed CLI with configured or scanned history', () => {
    const settings = validSettings();
    settings.sources = [];
    render(createElement(SettingsPanel, props({ settings, installations: [{ kind: 'grok', executable: '/synthetic/grok', version: 'test', available: true, error: null }] })));
    const history = providerHistory('grok');
    expect(screen.getByText('可啟動')).toBeInTheDocument();
    expect(history.getByText('尚未設定來源')).toBeInTheDocument();
    expect(history.queryByText('尚無歷史')).not.toBeInTheDocument();
  });
  it('keeps unscanned and disabled states truthful during an active scan', () => {
    const config = props({ settings: olderHistorySettings() });
    const view = render(createElement(SettingsPanel, config));
    expect(providerHistory('codex').getByText('尚未掃描')).toBeInTheDocument();
    expect(providerHistory('codex').queryByText('尚無歷史')).not.toBeInTheDocument();
    view.rerender(createElement(SettingsPanel, { ...config, index: { ...config.index, running: true } }));
    expect(providerHistory('codex').getByText('索引中')).toBeInTheDocument();
    expect(providerHistory('claude').getByText('已停用')).toBeInTheDocument();
    expect(providerHistory('claude').queryByText('索引中')).not.toBeInTheDocument();
    expect(providerHistory('grok').getByText('尚未設定來源')).toBeInTheDocument();
  });
  it('marks an edited binary path unapplied without discarding known source health', () => {
    const config = props({ installations: [{ kind: 'codex', executable: '/synthetic/codex', version: 'test', available: true, error: null }] });
    config.index.sources = [{ sourceId: 'source-a', status: 'ready', files: 4, message: null }];
    render(createElement(SettingsPanel, config));
    fireEvent.change(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' }), { target: { value: '/synthetic/new-codex' } });
    expect(screen.getByText('設定尚未套用')).toBeInTheDocument();
    expect(providerHistory('codex').getByText('可讀取 · 4 個檔案')).toBeInTheDocument();
  });
  it('invalidates old scan health in the edited draft instead of presenting it as current', () => {
    const config = props();
    config.index.sources = [{ sourceId: 'source-a', status: 'empty', files: 0, message: null }];
    render(createElement(SettingsPanel, config));
    expect(providerHistory('codex').getByText('尚無歷史')).toBeInTheDocument();
    fireEvent.change(providerHistory('codex').getByRole('textbox', { name: 'CODEX_HOME 資料目錄' }), { target: { value: '/synthetic/different-source' } });
    expect(providerHistory('codex').getByText('尚未套用')).toBeInTheDocument();
    expect(providerHistory('codex').queryByText('尚無歷史')).not.toBeInTheDocument();
  });
});


describe('explicit shell discovery', () => {
  it('detects candidates only on request and does not replace profiles or choose a default', async () => {
    const settings = validSettings();
    settings.profiles[0] = { ...settings.profiles[0], name: 'My configured bash', args: ['--noprofile'], env: { SYNTHETIC: 'kept' } };
    const config = props({ settings, onDetectShells: vi.fn().mockResolvedValue([
      { name: 'Bash', executable: '/bin/bash' }, { name: 'Zsh', executable: '/synthetic/bin/zsh' },
    ]) });
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: 'Shell Profiles' }));
    expect(config.onDetectShells).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '重新偵測 Shell' }));
    await waitFor(() => expect(screen.getByRole('region', { name: '偵測到的 Shell' })).toBeInTheDocument());
    expect(config.onDetectShells).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Bash 已有 Profile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '加入 Zsh Profile' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: '名稱' })).toHaveValue('My configured bash');
    expect(config.onSave).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledWith(expect.objectContaining({ profiles: settings.profiles, defaultProfileId: 'main' }));
  });
  it('adds the chosen shell as an independent draft with empty args/env and leaves the custom profile/default intact', async () => {
    const settings = validSettings();
    settings.profiles[0] = { ...settings.profiles[0], name: 'Personal shell', args: ['-l', '--noprofile'], env: { LANG: 'synthetic' } };
    const config = props({ settings, onDetectShells: vi.fn().mockResolvedValue([{ name: 'Zsh', executable: '/synthetic/bin/zsh' }]) });
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: 'Shell Profiles' }));
    await userEvent.click(screen.getByRole('button', { name: '重新偵測 Shell' }));
    await userEvent.click(await screen.findByRole('button', { name: '加入 Zsh Profile' }));
    expect(screen.getByRole('button', { name: 'Zsh 已有 Profile' })).toBeDisabled();
    expect(config.onSave).not.toHaveBeenCalled();
    expect(settings.profiles).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    const saved = vi.mocked(config.onSave).mock.calls[0][0];
    expect(saved.profiles).toHaveLength(2);
    expect(saved.profiles[0]).toEqual(settings.profiles[0]);
    expect(saved.profiles[1]).toEqual({ id: expect.any(String), name: 'Zsh', executable: '/synthetic/bin/zsh', args: [], env: {} });
    expect(saved.defaultProfileId).toBe('main');
    expect(saved.profiles[1].id).not.toBe('main');
  });
  it('discards a selected shell without saving or overwriting existing profiles', async () => {
    const config = props({ onDetectShells: vi.fn().mockResolvedValue([{ name: 'Fish', executable: '/synthetic/fish' }]) });
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: 'Shell Profiles' }));
    await userEvent.click(screen.getByRole('button', { name: '重新偵測 Shell' }));
    await userEvent.click(await screen.findByRole('button', { name: '加入 Fish Profile' }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await userEvent.click(screen.getByRole('button', { name: '捨棄變更' }));
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onClose).toHaveBeenCalledTimes(1);
    expect(config.settings.profiles).toEqual(validSettings().profiles);
    expect(config.settings.defaultProfileId).toBe('main');
  });
  it('prevents concurrent discovery and leaves manual profile editing available after failure', async () => {
    let reject!: (reason: Error) => void;
    const config = props({ onDetectShells: vi.fn(() => new Promise<ShellCandidate[]>((_, fail) => { reject = fail; })) });
    render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('button', { name: 'Shell Profiles' }));
    const detect = screen.getByRole('button', { name: '重新偵測 Shell' });
    fireEvent.click(detect);
    fireEvent.click(detect);
    expect(config.onDetectShells).toHaveBeenCalledTimes(1);
    expect(detect).toBeDisabled();
    await act(async () => reject(new Error('Synthetic shell discovery failure')));
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic shell discovery failure');
    expect(detect).toBeEnabled();
    expect(screen.getByRole('button', { name: '新增 Profile' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Shell 執行檔' })).toHaveValue('/bin/bash');
    expect(config.onSave).not.toHaveBeenCalled();
  });
  it('reports no candidates truthfully and preserves the manual configuration route', async () => {
    render(createElement(SettingsPanel, props()));
    await userEvent.click(screen.getByRole('button', { name: 'Shell Profiles' }));
    await userEvent.click(screen.getByRole('button', { name: '重新偵測 Shell' }));
    expect(await screen.findByText(/沒有新的 Shell 可加入/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新增 Profile' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Shell 執行檔' })).toHaveValue('/bin/bash');
  });
});

describe('shared settings controls integration', () => {
  it('closes an open Select on Escape without closing settings or changing provider selection', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    const chooser = screen.getByRole('combobox', { name: 'Agent 類型' });
    await userEvent.click(chooser);
    expect(screen.getByRole('listbox', { name: 'Agent 類型' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(chooser).toHaveFocus();
    expect(config.onClose).not.toHaveBeenCalled();
    expect(config.onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '重新掃描' })).toBeEnabled();
  });
  it('closes a portalled provider menu and blocks it when settings become locked', async () => {
    const config = props();
    const view = render(createElement(SettingsPanel, config));
    await userEvent.click(screen.getByRole('combobox', { name: 'Agent 類型' }));
    expect(screen.getByRole('option', { name: 'Grok Build' })).toBeInTheDocument();
    view.rerender(createElement(SettingsPanel, { ...config, busy: true }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Agent 類型' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '搜尋 Agent' })).toBeDisabled();
    expect(screen.queryByRole('listbox', { name: '選擇要設定的 Agent' })).not.toBeInTheDocument();
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.settings.sources).toEqual(validSettings().sources);
  });
});

describe('progressive provider configuration', () => {
  it('keeps advanced args collapsed by default and reports unsaved custom arguments accurately', () => {
    render(createElement(SettingsPanel, props()));
    selectAgent('grok');
    const summary = screen.getByLabelText('Grok Build 參數與權限設定');
    // jsdom's accessibility tree does not hide descendants of a closed details.
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(summary).toHaveTextContent('使用安全預設');
    fireEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    fireEvent.change(screen.getByRole('textbox', { name: 'Grok Build 自訂啟動參數' }), { target: { value: '["--model","review-model"]' } });
    expect(summary).toHaveTextContent('已有自訂參數');
    fireEvent.click(summary);
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(summary).toHaveTextContent('已有自訂參數');
  });
  it('exposes an already opted-in risk mode without requiring disclosure navigation', () => {
    const settings = validSettings();
    settings.agentOptions.grok.bypassPermissions = true;
    render(createElement(SettingsPanel, props({ settings })));
    selectAgent('grok');
    expect(screen.getByRole('checkbox', { name: 'Grok Build 略過權限確認' })).toBeChecked();
    expect(screen.getByLabelText('Grok Build 參數與權限設定')).toHaveTextContent('高風險模式已開啟');
  });
});

describe('explicit history source discovery', () => {
  it('adds a found Grok root only to the draft, preserves custom sources, and saves only explicitly', async () => {
    const settings = validSettings();
    settings.sources.push({ id: 'custom-grok', kind: 'grok', root: '/custom/grok', enabled: false });
    const discover = vi.fn().mockResolvedValue({ kind: 'grok', supported: true, candidates: [
      { kind: 'grok', root: '/synthetic/.grok', status: 'found', configured: false, message: 'The root is readable.' },
    ] });
    const config = props({ settings, onDetectHistorySources: discover });
    render(createElement(SettingsPanel, config));
    expect(discover).not.toHaveBeenCalled();
    selectAgent('grok');
    fireEvent.click(screen.getByRole('button', { name: '偵測 Grok Build 歷史來源' }));
    const add = await screen.findByRole('button', { name: '加入 Grok Build 偵測來源 /synthetic/.grok' });
    expect(discover).toHaveBeenCalledExactlyOnceWith('grok');
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onScan).not.toHaveBeenCalled();
    fireEvent.click(add);
    expect(add).toBeDisabled();
    expect(screen.getByDisplayValue('/synthetic/.grok')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/custom/grok')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(config.onSave).toHaveBeenCalledOnce());
    const saved = vi.mocked(config.onSave).mock.calls[0][0];
    expect(saved.sources).toEqual(expect.arrayContaining(settings.sources));
    expect(saved.sources.filter((source) => source.root === '/synthetic/.grok')).toHaveLength(1);
    expect(settings.sources).toHaveLength(2);
  });
  it('distinguishes missing, permission, check errors and canonical configured roots without auto-adding', async () => {
    const config = props({ onDetectHistorySources: vi.fn().mockResolvedValue({ kind: 'codex', supported: true, candidates: [
      { kind: 'codex', root: '/missing', status: 'missing', configured: false },
      { kind: 'codex', root: '/denied', status: 'permissionDenied', configured: false },
      { kind: 'codex', root: '/failed', status: 'checkFailed', configured: false },
      { kind: 'codex', root: '/canonical-existing', status: 'found', configured: true, configuredSourceIds: ['source-a'] },
    ] }) });
    render(createElement(SettingsPanel, config));
    fireEvent.click(screen.getByRole('button', { name: '偵測 Codex 歷史來源' }));
    expect(await screen.findByText('目錄不存在')).toBeInTheDocument();
    expect(screen.getByText('無權限讀取')).toBeInTheDocument();
    expect(screen.getByText('檢查失敗')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '加入 Codex 偵測來源 /canonical-existing' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '加入 Codex 偵測來源 /denied' })).not.toBeInTheDocument();
    expect(config.onSave).not.toHaveBeenCalled();
    selectAgent('antigravity');
    expect(screen.getByRole('button', { name: '偵測 Antigravity CLI 歷史來源' })).toBeEnabled();
  });
  it('shows detection failure, retries explicitly and permits cancelling without changing settings', async () => {
    const discover = vi.fn().mockRejectedValueOnce(new Error('Synthetic source discovery failure')).mockResolvedValueOnce({ kind: 'grok', supported: true, candidates: [], message: 'No configured home.' });
    const config = props({ onDetectHistorySources: discover });
    render(createElement(SettingsPanel, config));
    selectAgent('grok');
    fireEvent.click(screen.getByRole('button', { name: '偵測 Grok Build 歷史來源' }));
    expect(await screen.findByText('Synthetic source discovery failure')).toBeInTheDocument();
    selectAgent('grok');
    fireEvent.click(screen.getByRole('button', { name: '偵測 Grok Build 歷史來源' }));
    expect(await screen.findByText('No configured home.')).toBeInTheDocument();
    expect(discover).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '關閉設定' }));
    expect(config.onClose).toHaveBeenCalledOnce();
    expect(config.onSave).not.toHaveBeenCalled();
  });
});

it('allows a discovered canonical root to be re-added after its saved alias was removed from the draft', async () => {
  const config = props({ onDetectHistorySources: vi.fn().mockResolvedValue({ kind: 'codex', supported: true, candidates: [
    { kind: 'codex', root: '/canonical/.codex', status: 'found', configured: true, configuredSourceIds: ['source-a'] },
  ] }) });
  render(createElement(SettingsPanel, config));
  fireEvent.click(screen.getByRole('button', { name: '偵測 Codex 歷史來源' }));
  const add = await screen.findByRole('button', { name: '加入 Codex 偵測來源 /canonical/.codex' });
  expect(add).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '移除資料來源 1' }));
  expect(add).toBeEnabled();
  fireEvent.click(add);
  expect(add).toBeDisabled();
  expect(screen.getByDisplayValue('/canonical/.codex')).toBeInTheDocument();
  expect(config.onSave).not.toHaveBeenCalled();
  expect(config.settings.sources[0].root).toBe('/home/test/.codex');
});

it('detects and explicitly saves a CLI-only Antigravity source without installing or launching it', async () => {
  const settings = olderHistorySettings();
  const original = structuredClone(settings);
  const root = '/synthetic/.gemini/antigravity-cli';
  const discover = vi.fn().mockResolvedValue({ kind: 'antigravity', supported: true, candidates: [
    { kind: 'antigravity', root, status: 'found', configured: false, configuredSourceIds: [], message: 'CLI brain directory is readable.' },
  ] });
  const config = props({ settings, onDetectHistorySources: discover });
  render(createElement(SettingsPanel, config));
  const card = providerHistory('antigravity');
  expect(screen.getByText('尚未偵測')).toBeInTheDocument();
  expect(card.getByText('尚未設定來源')).toBeInTheDocument();
  fireEvent.click(card.getByRole('button', { name: '偵測 Antigravity CLI 歷史來源' }));
  const add = await screen.findByRole('button', { name: `加入 Antigravity CLI 偵測來源 ${root}` });
  expect(discover).toHaveBeenCalledExactlyOnceWith('antigravity');
  expect(config.onSave).not.toHaveBeenCalled();
  expect(config.onScan).not.toHaveBeenCalled();
  expect(config.onDetect).not.toHaveBeenCalled();
  expect(card.queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(add);
  const field = card.getByRole('textbox', { name: 'Antigravity CLI 資料目錄' });
  expect(field).toHaveValue(root);
  expect(field).toHaveAttribute('placeholder', '/Users/you/.gemini/antigravity-cli');
  expect(add).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
  await waitFor(() => expect(config.onSave).toHaveBeenCalledOnce());
  expect(vi.mocked(config.onSave).mock.calls[0][0].sources).toEqual([
    ...original.sources, { id: expect.any(String), kind: 'antigravity', root, enabled: true },
  ]);
  expect(settings).toEqual(original);
  expect(config.onScan).not.toHaveBeenCalled();
});


describe('history root directory selection', () => {
  beforeEach(() => { vi.mocked(canPickDirectory).mockReturnValue(true); });
  it('only edits the selected source draft and saves through the existing action', async () => {
    vi.mocked(pickDirectory).mockResolvedValue('/synthetic/.codex');
    const config = props({ settings: olderHistorySettings() });
    render(createElement(SettingsPanel, config));
    await userEvent.click(providerHistory('codex').getByRole('button', { name: '選擇CODEX_HOME 資料目錄' }));
    expect(providerHistory('codex').getByLabelText('CODEX_HOME 資料目錄')).toHaveValue('/synthetic/.codex');
    expect(providerHistory('claude').getByLabelText('CLAUDE_CONFIG_DIR 資料目錄')).toHaveValue('/synthetic/custom-claude');
    expect(config.onSave).not.toHaveBeenCalled();
    expect(config.onScan).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(config.onSave).toHaveBeenCalledOnce();
    expect(vi.mocked(config.onSave).mock.calls[0][0].sources[0]).toEqual({ id: 'source-a', kind: 'codex', root: '/synthetic/.codex', enabled: true });
  });
  it('does not restore a deleted source when its picker completes', async () => {
    let resolve!: (value: string) => void;
    vi.mocked(pickDirectory).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const config = props();
    render(createElement(SettingsPanel, config));
    fireEvent.click(providerHistory('codex').getByRole('button', { name: '選擇CODEX_HOME 資料目錄' }));
    fireEvent.click(screen.getByRole('button', { name: '移除資料來源 1' }));
    await act(async () => resolve('/late'));
    expect(providerHistory('codex').queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    expect(vi.mocked(config.onSave).mock.calls[0][0].sources).toEqual([]);
  });
  it('discards a pending selection after settings section navigation', async () => {
    let resolve!: (value: string) => void;
    vi.mocked(pickDirectory).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(createElement(SettingsPanel, props()));
    fireEvent.click(providerHistory('codex').getByRole('button', { name: '選擇CODEX_HOME 資料目錄' }));
    fireEvent.click(screen.getByRole('button', { name: 'Shell Profiles' }));
    await act(async () => resolve('/late'));
    fireEvent.click(screen.getByRole('button', { name: '來源與工具' }));
    expect(providerHistory('codex').getByLabelText('CODEX_HOME 資料目錄')).toHaveValue('/home/test/.codex');
  });
});

describe('launch-local activity hook opt-in', () => {
  it.each(['codex', 'claude', 'opencode', 'grok', 'antigravity'] as const)('%s defaults off, saves explicitly, and keeps cancellation local to the draft', async (kind) => {
    const config = props();
    const view = render(createElement(SettingsPanel, config));
    selectAgent(kind);
    const toggle = screen.getByRole('checkbox', { name: `${agentNames[kind]} 真實活動 hooks` });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(config.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '儲存設定' }));
    await waitFor(() => expect(config.onSave).toHaveBeenCalledOnce());
    expect(vi.mocked(config.onSave).mock.calls[0][0].agentHooks).toEqual({ [kind]: true });
    view.unmount();
    render(createElement(SettingsPanel, props()));
    selectAgent(kind);
    expect(screen.getByRole('checkbox', { name: `${agentNames[kind]} 真實活動 hooks` })).not.toBeChecked();
  });
  it('keeps hook controls without repeating long implementation notes', () => {
    render(createElement(SettingsPanel, props()));
    for (const kind of ['codex', 'claude', 'opencode', 'grok', 'antigravity'] as const) {
      selectAgent(kind);
      expect(screen.getByRole('checkbox', { name: /真實活動 hooks/ })).toBeInTheDocument();
      expect(screen.queryByText(/僅套用 SessionBay 後續啟動/)).not.toBeInTheDocument();
      expect(screen.queryByText(/只傳遞 Session／回合識別/)).not.toBeInTheDocument();
    }
  });
});
