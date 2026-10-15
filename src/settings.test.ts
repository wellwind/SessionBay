import { createElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  SettingsPanel,
  normalizeShortcut,
  parseProfileArgs,
  parseProfileEnv,
  validateSettings,
} from './components/SettingsPanel';
import type { SettingsPanelProps } from './components/SettingsPanel';
import { shortcutDefaults } from './commands';
import type { Settings } from './types';

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
    executables: { codex: 'codex', claude: 'claude' },
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
    ...overrides,
  };
}

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
  it('requires discard confirmation and restores focus when cancellation is dismissed', async () => {
    const config = props();
    render(createElement(SettingsPanel, config));
    fireEvent.change(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' }), {
      target: { value: '/usr/local/bin/codex' },
    });
    const cancel = screen.getByRole('button', { name: '取消' });
    await userEvent.click(cancel);
    expect(config.onClose).not.toHaveBeenCalled();
    const back = screen.getByRole('button', { name: '返回' });
    expect(back).toHaveFocus();
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
        settings: { ...validSettings(), executables: { codex: 'authoritative', claude: 'claude' } },
      }),
    );
    expect(screen.getByRole('textbox', { name: 'Codex 執行檔路徑' })).toHaveValue('authoritative');
    expect(screen.getByRole('button', { name: '重新掃描' })).toBeEnabled();
  });
});
