import { DirectoryPathField } from './DirectoryPathField';
import { workspaceZoomShortcutHelp } from '../workspace-zoom';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  Folder,
  Keyboard,
  LoaderCircle,
  Palette,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { AgentKind, HistorySourceDiscovery, IndexStatus, Installation, Settings, ShellCandidate, ShellProfile } from '../types';
import { normalizedShortcut, normalizeLegacyShortcuts, reservedWorkspaceShortcut, shortcutDefaults, workspaceTabShortcutHelp } from '../commands';
import { agentCapabilities, agentKinds, historyAgentKinds, agentNames, executableDefaults, bypassFlags, installationState, normalizedAgentOptions, isAgentEnabled } from '../agents';
import type { HistoryAgentKind } from '../agents';
import { isAbsoluteFilesystemPath } from '../paths';
import { Select } from './controls';
import { AgentIcon } from './AgentIcon';
import { ThemeControls, TerminalPreview } from './ThemeControls';
import { appearanceOf, validThemeId } from '../themes';
import type { Appearance } from '../themes';
import './settings.css';

export interface SettingsPanelProps {
  settings: Settings;
  installations: Installation[];
  index: IndexStatus;
  onboarding?: boolean;
  busy?: boolean;
  onSave: (settings: Settings) => Promise<void>;
  onClose: () => void;
  onPreviewAppearance?: (appearance: Appearance | null) => void;
  onScan: (rebuild: boolean) => Promise<void>;
  onCancelScan: () => Promise<void>;
  onClearIndex: () => Promise<void>;
  onDetect: () => Promise<void>;
  onDetectShells?: () => Promise<ShellCandidate[]>;
  onDetectHistorySources?: (kind: AgentKind) => Promise<HistorySourceDiscovery>;
}

type Section = 'sources' | 'profiles' | 'appearance' | 'shortcuts';
type ValidationErrors = Record<string, string>;
type JsonFields = Record<string, { args: string; env: string }>;
const shortcutNames: Record<string, string> = {
  'new-terminal': '開啟終端機',
  'new-agent': '開始 Agent 工作',
  'search-sessions': '搜尋 Session',
  'split-right': '左右分割',
  'split-down': '上下分割',
  'next-pane': '切換下一個面板',
  'maximize-pane': '最大化／還原面板',
  'close-pane': '關閉面板',
  'command-palette': '命令面板',
  'toggle-sidebar': '顯示／隱藏側邊欄',
};
const sections = [
  { id: 'sources' as const, label: '來源與工具', icon: Folder },
  { id: 'profiles' as const, label: 'Shell Profiles', icon: Terminal },
  { id: 'appearance' as const, label: '外觀與預設值', icon: Palette },
  { id: 'shortcuts' as const, label: '鍵盤快捷鍵', icon: Keyboard },
];

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    ...(settings.agentEnabled ? { agentEnabled: { ...settings.agentEnabled } } : {}),
    profiles: settings.profiles.map((profile) => ({
      ...profile,
      args: [...profile.args],
      env: { ...profile.env },
    })),
    sources: settings.sources.map((source) => ({ ...source })),
    executables: { ...executableDefaults, ...settings.executables },
    agentOptions: normalizedAgentOptions(settings),
    shortcuts: normalizeLegacyShortcuts(settings.shortcuts),
  };
}
function profileFields(settings: Settings): JsonFields {
  return Object.fromEntries(
    settings.profiles.map((profile) => [
      profile.id,
      {
        args: JSON.stringify(profile.args, null, 2),
        env: JSON.stringify(profile.env, null, 2),
      },
    ]),
  );
}
function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
function containsNull(value: string): boolean {
  return value.includes('\0');
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}
function validText(value: string, maximum: number): boolean {
  return Boolean(value.trim()) && byteLength(value) <= maximum && !containsNull(value);
}

/** Canonicalizes modifier order and common aliases for visible conflict detection. */
export function normalizeShortcut(shortcut: string): string {
  return normalizedShortcut(shortcut);
}

export function parseProfileArgs(text: string): { value?: string[]; error?: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !Array.isArray(value) ||
      value.length > 64 ||
      value.some(
        (item) => typeof item !== 'string' || containsNull(item) || byteLength(item) > 8192,
      )
    ) {
      return {
        error: '請輸入字串陣列，例如 ["-l"]；最多 64 個參數，每項最多 8192 bytes，不能包含空字元。',
      };
    }
    return { value: value as string[] };
  } catch {
    return { error: '參數必須是有效的 JSON 字串陣列。' };
  }
}

export function parseAgentArgs(text: string): { value?: string[]; error?: string } {
  const parsed = parseProfileArgs(text);
  if (parsed.value?.some((arg) => arg.length === 0)) return { error: 'Agent 參數不可包含空字串。' };
  return parsed;
}

export function parseProfileEnv(text: string): { value?: Record<string, string>; error?: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > 64
    ) {
      return { error: '環境變數須為最多 64 項的 JSON 物件，例如 {"LANG":"zh_TW.UTF-8"}。' };
    }
    for (const [key, item] of Object.entries(value)) {
      if (
        !/^[A-Za-z0-9_]+$/.test(key) ||
        byteLength(key) > 128 ||
        typeof item !== 'string' ||
        containsNull(item) ||
        byteLength(item) > 8192
      ) {
        return {
          error:
            '變數名稱只能使用英數字與底線，最多 128 bytes；值須為不含空字元的字串，最多 8192 bytes。',
        };
      }
    }
    return { value: value as Record<string, string> };
  } catch {
    return { error: '環境變數必須是有效的 JSON 物件。' };
  }
}

/** Client-side checks complement, but do not replace, backend validation. */
export function validateSettings(settings: Settings): ValidationErrors {
  const errors: ValidationErrors = {};
  if (settings.version !== 1) errors.version = '不支援的設定版本。';
  if (!['dark', 'light', 'system'].includes(settings.theme))
    errors.theme = '請選擇有效的介面主題。';
  if (!validThemeId(settings.themePalette ?? 'bay'))
    errors.themePalette = '請選擇有效的介面色系。';
  if (!validThemeId(settings.terminalTheme))
    errors.terminalTheme = '請選擇有效的終端色票。';
  if (!validText(settings.fontFamily, 256))
    errors.fontFamily = '請填寫有效的字型名稱，最多 256 bytes。';
  if (!Number.isInteger(settings.fontSize) || settings.fontSize < 9 || settings.fontSize > 32)
    errors.fontSize = '字型大小請填寫 9 到 32 的整數。';
  if (!Number.isInteger(settings.appZoom ?? 100) || (settings.appZoom ?? 100) < 50 || (settings.appZoom ?? 100) > 200)
    errors.appZoom = '工作台縮放請填寫 50 到 200 的整數百分比。';
  if (!agentKinds.includes(settings.defaultAgent))
    errors.defaultAgent = '請選擇預設 Agent。';
  if (!settings.profiles.length || settings.profiles.length > 32)
    errors.profiles = '請保留 1 到 32 個 Shell Profiles。';
  if (settings.sources.length > 32) errors.sources = '最多可以加入 32 個資料來源。';
  if (!settings.profiles.some((profile) => profile.id === settings.defaultProfileId))
    errors.defaultProfileId = '請選擇有效的預設 Shell Profile。';
  if (settings.agentEnabled && Object.values(settings.agentEnabled).some((enabled) => typeof enabled !== 'boolean'))
    errors.agentEnabled = 'Agent 啟用設定必須為開關值。';
  const profileIds = new Set<string>();
  settings.profiles.forEach((profile, i) => {
    if (!validText(profile.id, 128) || profileIds.has(profile.id))
      errors[`profiles.${i}.id`] = 'Profile 識別碼必須唯一。';
    profileIds.add(profile.id);
    if (!validText(profile.name, 128))
      errors[`profiles.${i}.name`] = '請填寫 Profile 名稱，最多 128 bytes。';
    if (!validText(profile.executable, 4096))
      errors[`profiles.${i}.executable`] = '請填寫 Shell 執行檔路徑或名稱。';
    if (
      profile.args.length > 64 ||
      profile.args.some(
        (arg) => typeof arg !== 'string' || containsNull(arg) || byteLength(arg) > 8192,
      )
    )
      errors[`profiles.${i}.args`] = '參數須為不含空字元的字串。';
    if (
      Object.keys(profile.env).length > 64 ||
      Object.entries(profile.env).some(
        ([key, value]) =>
          !/^[A-Za-z0-9_]+$/.test(key) ||
          byteLength(key) > 128 ||
          typeof value !== 'string' ||
          containsNull(value) ||
          byteLength(value) > 8192,
      )
    )
      errors[`profiles.${i}.env`] = '請檢查環境變數名稱與值。';
  });
  const sourceIds = new Set<string>();
  const sourceRoots = new Set<string>();
  settings.sources.forEach((source, i) => {
    if (!validText(source.id, 128) || sourceIds.has(source.id))
      errors[`sources.${i}.id`] = '資料來源識別碼必須唯一。';
    sourceIds.add(source.id);
    if (!(historyAgentKinds as readonly string[]).includes(source.kind))
      errors[`sources.${i}.kind`] = '請選擇支援的 Agent 類型。';
    if (!validText(source.root, 4096) || !isAbsoluteFilesystemPath(source.root))
      errors[`sources.${i}.root`] = '請填寫此平台的完整資料夾路徑，例如 C:\\Users\\you\\.codex 或 /Users/you/.codex。';
    const rootKey = `${source.kind}:${source.root.trim().replace(/[\\/]+$/, '')}`;
    if (sourceRoots.has(rootKey)) errors[`sources.${i}.root`] = '此 Agent 的相同資料目錄已經加入。';
    sourceRoots.add(rootKey);
  });
  agentKinds.forEach((kind) => {
    if (!validText(settings.executables[kind], 4096))
      errors[`executables.${kind}`] = `請填寫執行檔路徑，或填入 ${kind} 由 PATH 偵測。`;
  });
  for (const kind of agentKinds) {
    const options = settings.agentOptions?.[kind];
    if (!options) continue; // Older settings are normalized before editing/saving.
    const parsed = parseAgentArgs(JSON.stringify(options.extraArgs));
    if (parsed.error) errors[`agentOptions.${kind}`] = parsed.error;
    if (typeof options.bypassPermissions !== 'boolean') errors[`agentOptions.${kind}`] = '請確認工具權限設定。';
    if (!options.bypassPermissions && options.extraArgs.some((arg) =>
      /^(--auto|--yolo|--always-approve|--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--allow-dangerously-skip-permissions)(=|$)/.test(arg)))
      errors[`agentOptions.${kind}`] = '高風險參數需要先明確勾選下方的略過權限確認選項。';
  }
  const bindings = new Map<string, string[]>();
  if (Object.keys(settings.shortcuts).length > 32) errors.shortcuts = '最多可設定 32 個快捷鍵。';
  for (const [action, binding] of Object.entries({ ...shortcutDefaults, ...settings.shortcuts })) {
    if (!validText(action, 64) || byteLength(binding) > 64 || containsNull(binding)) {
      errors[`shortcuts.${action}`] = '快捷鍵名稱與組合最多 64 bytes，且不能包含空字元。';
      continue;
    }
    if (!binding.trim()) continue;
    if (reservedWorkspaceShortcut(binding)) errors[`shortcuts.${action}`] = '這個組合保留給工作區分頁切換、全工作台縮放或 Terminal Shift+Enter，請選擇其他快捷鍵。';
    const parts = binding
      .trim()
      .split('+')
      .map((part) => part.trim());
    const modifiers = [
      'mod',
      'ctrl',
      'control',
      'cmd',
      'command',
      'meta',
      'alt',
      'option',
      'shift',
    ];
    if (
      parts.some((part) => !part) ||
      parts.length < 2 ||
      !parts.slice(0, -1).every((part) => modifiers.includes(part.toLowerCase())) ||
      modifiers.includes(parts.at(-1)!.toLowerCase())
    ) {
      errors[`shortcuts.${action}`] = '請使用修飾鍵與按鍵，例如 Mod+Shift+T。';
    }
    const canonical = normalizeShortcut(binding);
    bindings.set(canonical, [...(bindings.get(canonical) ?? []), action]);
  }
  for (const actions of bindings.values()) {
    if (actions.length < 2) continue;
    actions.forEach((action) => {
      errors[`shortcuts.${action}`] = `與「${actions
        .filter((other) => other !== action)
        .map((other) => shortcutNames[other] ?? other)
        .join('、')}」衝突。`;
    });
  }
  return errors;
}

function sectionForError(key: string): Section {
  if (key.startsWith('sources') || key.startsWith('executables.') || key.startsWith('agentOptions.') || key.startsWith('agentEnabled')) return 'sources';
  if (key.startsWith('profiles')) return 'profiles';
  if (key.startsWith('shortcuts')) return 'shortcuts';
  return 'appearance';
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <span id={id} className="settings-field-error">
      <CircleAlert size={13} aria-hidden="true" />
      {message}
    </span>
  ) : null;
}

export function SettingsPanel({
  settings,
  installations,
  index,
  onboarding = false,
  busy = false,
  onSave,
  onClose,
  onPreviewAppearance,
  onScan,
  onCancelScan,
  onClearIndex,
  onDetect,
  onDetectShells,
  onDetectHistorySources,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState(() => cloneSettings(settings));
  const [jsonFields, setJsonFields] = useState(() => profileFields(settings));
  const [agentJson, setAgentJson] = useState(() => Object.fromEntries(agentKinds.map((kind) =>
    [kind, JSON.stringify(normalizedAgentOptions(settings)[kind].extraArgs)])));
  const [section, setSection] = useState<Section>('sources');
  const [selectedAgent, setSelectedAgent] = useState<AgentKind>(settings.defaultAgent);
  const [agentSearch, setAgentSearch] = useState('');
  const [focusSourceId, setFocusSourceId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [shellCandidates, setShellCandidates] = useState<ShellCandidate[] | null>(null);
  const [sourceDiscoveries, setSourceDiscoveries] = useState<Partial<Record<AgentKind, HistorySourceDiscovery>>>({});
  const [operationError, setOperationError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmation, setConfirmation] = useState<'clear' | 'discard' | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const operationInFlight = useRef(false);
  const locked = busy || working;

  useEffect(() => {
    setDraft(cloneSettings(settings));
    setJsonFields(profileFields(settings));
    setAgentJson(Object.fromEntries(agentKinds.map((kind) => [kind, JSON.stringify(normalizedAgentOptions(settings)[kind].extraArgs)])));
    setShowErrors(false);
    setSourceDiscoveries({});
  }, [settings]);

  useEffect(() => {
    // Preview only valid appearance fields; unrelated draft edits never reach running panes.
    const appearance = appearanceOf(draft);
    if (!Number.isInteger(appearance.fontSize) || appearance.fontSize < 9 || appearance.fontSize > 32)
      appearance.fontSize = settings.fontSize;
    if (!validText(appearance.fontFamily, 256)) appearance.fontFamily = settings.fontFamily;
    if (!Number.isInteger(appearance.appZoom) || appearance.appZoom! < 50 || appearance.appZoom! > 200)
      appearance.appZoom = settings.appZoom ?? 100;
    onPreviewAppearance?.(appearance);
  }, [draft, settings.fontSize, settings.fontFamily, settings.appZoom, onPreviewAppearance]);
  useEffect(() => () => onPreviewAppearance?.(null), [onPreviewAppearance]);
  useEffect(() => {
    const back = () => { if (!operationInFlight.current && !busy) onClose(); };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, [onClose, busy]);

  useEffect(() => {
    if (!focusSourceId) return;
    const field = document.getElementById(`source-root-${focusSourceId}`);
    field?.focus();
    setFocusSourceId(null);
  }, [focusSourceId, draft.sources]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector<HTMLElement>('[role="alertdialog"] button')?.focus();
    return () => {
      previous?.focus();
    };
  }, [confirmation]);

  const prepared = useMemo(() => {
    const next = cloneSettings(draft);
    const jsonErrors: ValidationErrors = {};
    next.profiles.forEach((profile, i) => {
      const input = jsonFields[profile.id];
      if (!input) return;
      const args = parseProfileArgs(input.args);
      const env = parseProfileEnv(input.env);
      if (args.error) jsonErrors[`profiles.${i}.args`] = args.error;
      else profile.args = args.value!;
      if (env.error) jsonErrors[`profiles.${i}.env`] = env.error;
      else profile.env = env.value!;
    });
    for (const kind of agentKinds) {
      const args = parseAgentArgs(agentJson[kind]);
      if (args.error) jsonErrors[`agentOptions.${kind}`] = args.error;
      else next.agentOptions[kind].extraArgs = args.value!;
    }
    return { settings: next, errors: { ...validateSettings(next), ...jsonErrors } };
  }, [draft, jsonFields, agentJson]);
  const dirty =
    JSON.stringify(prepared.settings) !== JSON.stringify(cloneSettings(settings)) ||
    Object.keys(prepared.errors).some((key) => key.endsWith('.args') || key.endsWith('.env') || key.startsWith('agentOptions.'));
  const errors = showErrors
    ? prepared.errors
    : Object.fromEntries(
        Object.entries(prepared.errors).filter(([key]) => key.startsWith('shortcuts.')),
      );
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const updateProfile = (id: string, patch: Partial<ShellProfile>) =>
    setDraft((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile,
      ),
    }));
  const close = () => {
    if (locked || operationInFlight.current) return;
    if (dirty) setConfirmation('discard');
    else onClose();
  };
  const run = async (action: () => Promise<void>) => {
    if (locked || operationInFlight.current) return;
    operationInFlight.current = true;
    setWorking(true);
    setOperationError(null);
    try {
      await action();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      operationInFlight.current = false;
      setWorking(false);
    }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    setShowErrors(true);
    const firstError = Object.keys(prepared.errors)[0];
    if (firstError) {
      setSection(sectionForError(firstError));
      const kind = firstError.startsWith('sources.')
        ? prepared.settings.sources[Number(firstError.split('.')[1])]?.kind
        : firstError.split('.')[1] as AgentKind;
      if (agentKinds.includes(kind)) { setSelectedAgent(kind); setAgentSearch(''); }
      return;
    }
    void run(async () => {
      await onSave({
        ...prepared.settings,
        onboardingComplete: onboarding ? true : prepared.settings.onboardingComplete,
      });
      onClose();
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (confirmation) setConfirmation(null);
      else close();
    }
    if (event.key !== 'Tab') return;
    const focusRoot = confirmation
      ? panelRef.current?.querySelector('[role="alertdialog"]')
      : panelRef.current;
    const focusable = focusRoot?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
    );
    if (!focusable?.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === panelRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || document.activeElement === panelRef.current)
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  const addSource = (kind: HistoryAgentKind, root = '') => {
    if (draft.sources.length >= 32) return;
    if (root && draft.sources.some((source) => source.kind === kind && source.root.trim().replace(/\/+$/, '') === root.replace(/\/+$/, ''))) return;
    const id = newId('source');
    update('sources', [...draft.sources, { id, kind, root, enabled: true }]);
    setFocusSourceId(id);
  };
  const sourceStatus = (sourceId: string, enabled: boolean, changed: boolean) => {
    if (changed)
      return { text: '尚未套用', className: 'neutral', detail: '儲存後會使用新的資料來源設定。' };
    if (!enabled)
      return { text: '已停用', className: 'neutral', detail: '此來源不會納入下一次掃描。' };
    const health = index.sources.find((source) => source.sourceId === sourceId);
    if (index.running)
      return { text: '索引中', className: 'neutral', detail: '正在掃描已啟用的來源，完成後更新讀取結果。' };
    if (!health)
      return { text: '尚未掃描', className: 'neutral', detail: '尚未確認是否有歷史資料，請先掃描。' };
    const state = health.status.toLowerCase();
    if (state === 'empty')
      return { text: '尚無歷史', className: 'neutral', detail: health.message || '掃描完成，目前沒有支援的歷史紀錄。' };
    if (state === 'missing')
      return { text: '找不到來源目錄', className: 'warning', detail: health.message || '請確認歷史資料目錄的完整路徑。' };
    if (['error', 'failed', 'invalid', 'unavailable'].includes(state))
      return { text: '來源讀取錯誤', className: 'warning', detail: health.message || '請檢查路徑與讀取權限後重新掃描。' };
    if (['ok', 'ready', 'healthy', 'scanned', 'complete'].includes(state))
      return { text: `可讀取 · ${health.files} 個檔案`, className: 'success', detail: health.message };
    if (state === 'partial')
      return { text: `部分可讀取 · ${health.files} 個檔案`, className: 'warning', detail: health.message || '部分歷史未能完整讀取，請查看掃描提醒。' };
    if (state === 'cancelled')
      return { text: '掃描已取消', className: 'neutral', detail: health.message || '結果可能不完整，請重新掃描。' };
    if (state === 'disabled' || state === 'paused')
      return { text: '等待重新掃描', className: 'neutral', detail: '已啟用來源，但尚未取得新的掃描結果。' };
    return { text: '來源狀態待確認', className: 'neutral', detail: health.message || `尚未確認的掃描狀態：${health.status}` };
  };

  return (
    <div className="settings-backdrop">
      <div
        className={`settings-panel${onboarding ? ' settings-onboarding' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby="settings-description"
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <header className="settings-header" inert={Boolean(confirmation)}>
          <div className="settings-mark" aria-hidden="true">
            <Terminal size={23} />
          </div>
          <div>
            <span className="settings-eyebrow">
              {onboarding ? 'WELCOME TO SESSION BAY' : 'MAKE IT YOURS'}
            </span>
            <h2 id="settings-title">{onboarding ? '讓工作，回到同一個地方。' : '工作台設定'}</h2>
            <p id="settings-description">
              {onboarding
                ? '連接本機 Agent 歷史，設定你習慣的工作環境。'
                : '你的資料來源、終端機，以及順手的工作方式。'}
            </p>
          </div>
          <button
            type="button"
            className="settings-icon-button settings-close"
            onClick={close}
            disabled={locked}
            aria-label={onboarding ? '稍後設定' : '關閉設定'}
          >
            <X size={19} />
          </button>
        </header>
        <form onSubmit={save} className="settings-form" noValidate inert={Boolean(confirmation)}>
          <div className="settings-layout">
            <nav className="settings-nav" aria-label="設定分類">
              {sections.map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  className={section === id ? 'is-active' : ''}
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => setSection(id)}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span>{label}</span>
                  {Object.keys(errors).some((key) => sectionForError(key) === id) && (
                    <span className="settings-error-dot" aria-label="有欄位需要修正" />
                  )}
                  {section === id && <ChevronRight size={14} aria-hidden="true" />}
                </button>
              ))}
              <div className="settings-privacy">
                <ShieldCheck size={18} aria-hidden="true" />
                <span>
                  原始歷史保持唯讀。
                  <br />
                  資料留在這台電腦。
                </span>
              </div>
            </nav>
            <div className="settings-content">
              <fieldset className="settings-fieldset" disabled={locked}>
                {section === 'sources' && (
                  <>
                    <div className="settings-agent-picker">
                      <label className="settings-field">
                        <span>搜尋 Agent</span>
                        <input type="search" aria-label="搜尋 Agent" placeholder="依名稱搜尋…"
                          value={agentSearch} onChange={(event) => setAgentSearch(event.target.value)} />
                      </label>
                      <div className="settings-agent-choices" role="group" aria-label="選擇要設定的 Agent">
                        {agentKinds.filter((kind) => `${agentNames[kind]} ${kind}`.toLowerCase().includes(agentSearch.trim().toLowerCase())).map((kind) => {
                          const binary = installationState(installations.find((item) => item.kind === kind));
                          return <button type="button" key={kind} className="settings-agent-choice" data-agent-kind={kind}
                            aria-pressed={selectedAgent === kind} onClick={() => setSelectedAgent(kind)}>
                            <AgentIcon kind={kind} /><strong>{agentNames[kind]}</strong>
                            <small>{isAgentEnabled(draft, kind) ? '已啟用' : '已停用'}</small>
                            <span className={`settings-status ${binary.className}`}>{binary.text}</span>
                          </button>;
                        })}
                        {!agentKinds.some((kind) => `${agentNames[kind]} ${kind}`.toLowerCase().includes(agentSearch.trim().toLowerCase())) &&
                          <p className="settings-help" role="status">沒有符合的 Agent。請試試其他名稱。</p>}
                      </div>
                    </div>
                    <div className="settings-agent-enabled">
                      <label className="settings-toggle-label">
                        <input className="checkbox" type="checkbox" aria-label={`啟用 ${agentNames[selectedAgent]}`}
                          checked={isAgentEnabled(draft, selectedAgent)}
                          onChange={(event) => update('agentEnabled', { ...draft.agentEnabled, [selectedAgent]: event.target.checked })} />
                        <strong>啟用 {agentNames[selectedAgent]}</strong>
                      </label>
                      <p className="settings-help">儲存後套用。停用會暫停新啟動、接續與歷史掃描；保留既有歷史、來源與工具設定，執行中的工作不受影響。</p>
                      {!isAgentEnabled(draft, selectedAgent) && <p className="settings-subtle-warning">此 Agent 已停用，仍可調整設定；重新啟用後恢復使用。</p>}
                    </div>
                    <div className="settings-section-heading" id="settings-agent-tools">
                      <div>
                        <h3>{agentNames[selectedAgent]} 工具</h3>
                        <p>工具可啟動與歷史可讀取，會分別確認。</p>
                      </div>
                      <button
                        type="button"
                        className="settings-button secondary compact"
                        onClick={() => void run(onDetect)}
                        disabled={dirty}
                      >
                        <RefreshCw size={14} />
                        重新偵測
                      </button>
                    </div>
                    <div className="settings-installations">
                      {[selectedAgent].map((kind) => {
                        const installation = installations.find((item) => item.kind === kind);
                        const parsedArgs = parseAgentArgs(agentJson[kind]);
                        const argumentSummary = parsedArgs.error ? '參數待修正' : parsedArgs.value?.length ? '已有自訂參數' : '使用安全預設';
                        const binary = installationState(installation, draft.executables[kind] !== (settings.executables[kind] ?? executableDefaults[kind]));
                        return (
                          <div className="settings-installation" key={kind}>
                            <div className="settings-installation-top">
                              <AgentIcon kind={kind} />
                              <strong>{agentNames[kind]}</strong>
                              <span className={`settings-status ${binary.className}`}>
                                {binary.className === 'success' && <Check size={12} />}{binary.text}
                              </span>
                            </div>
                            <p className="settings-help">登入狀態：未驗證；沿用 CLI 自身登入。</p>
                            <p className="settings-version">
                              {installation?.available
                                ? installation.version || '已找到執行檔'
                                : agentCapabilities[kind].history.supported ? '仍可瀏覽已存在的歷史紀錄' : '支援啟動／指定對話 ID 恢復，尚不索引歷史'}
                            </p>
                            <label className="settings-field">
                              <span>執行檔路徑</span>
                              <input
                                aria-label={`${agentNames[kind]} 執行檔路徑`}
                                value={draft.executables[kind]}
                                placeholder={`${executableDefaults[kind]} 或完整執行檔路徑`}
                                onChange={(event) =>
                                  update('executables', {
                                    ...draft.executables,
                                    [kind]: event.target.value,
                                  })
                                }
                                spellCheck={false}
                                aria-invalid={Boolean(errors[`executables.${kind}`])}
                                aria-describedby={`settings-${kind}-error`}
                              />
                              <FieldError
                                id={`settings-${kind}-error`}
                                message={errors[`executables.${kind}`]}
                              />
                            </label>
                            {installation?.executable && (
                              <p className="settings-detected-path" title={installation.executable}>
                                目前：{installation.executable}
                              </p>
                            )}
                            {installation?.error && (
                              <p className="settings-subtle-warning">{installation.error}</p>
                            )}
                            <p className="settings-help">{agentCapabilities[kind].history.supported
                              ? '支援唯讀歷史索引、搜尋及接續。'
                              : '支援啟動／指定對話 ID 恢復，尚不索引歷史。'}</p>
                            <details className="settings-agent-advanced" open={draft.agentOptions[kind].bypassPermissions || !!errors[`agentOptions.${kind}`] || undefined}>
                              <summary aria-label={`${agentNames[kind]} 參數與權限設定`}>
                                <span>參數與權限</span><span>{draft.agentOptions[kind].bypassPermissions ? '高風險模式已開啟' : argumentSummary}</span>
                              </summary>
                              <div className="settings-agent-advanced-body">
                            <label className="settings-field">
                              <span>自訂啟動參數 <small>JSON 字串陣列</small></span>
                              <textarea rows={3} aria-label={`${agentNames[kind]} 自訂啟動參數`}
                                value={agentJson[kind]} spellCheck={false}
                                onChange={(event) => setAgentJson((current) => ({ ...current, [kind]: event.target.value }))}
                                aria-invalid={Boolean(errors[`agentOptions.${kind}`])} />
                              <FieldError id={`settings-${kind}-args-error`} message={errors[`agentOptions.${kind}`]} />
                            </label>
                            <p className="settings-help">例如 ["--model", "模型名稱"]。每項為一個參數，不需 Shell 引號；不接受覆寫工作目錄／來源／Session 的參數。儲存為本機明文，勿填密碼或金鑰。</p>
                            <label className="settings-risk-toggle">
                              <input className="checkbox" type="checkbox" checked={draft.agentOptions[kind].bypassPermissions}
                                aria-label={`${agentNames[kind]} 略過權限確認`}
                                onChange={(event) => update('agentOptions', { ...draft.agentOptions,
                                  [kind]: { ...draft.agentOptions[kind], bypassPermissions: event.target.checked } })} />
                              <span>我了解風險，為 {agentNames[kind]} 略過工具權限確認</span>
                            </label>
                            <p className="settings-subtle-warning">啟用預設加入 {bypassFlags[kind]}；自訂權限選項以啟動預覽為準。Agent 可能不再詢問就執行命令、讀寫或刪除檔案。{kind === 'codex'
                              ? 'Codex 此模式也會停用 sandbox。'
                              : '這不代表停用 sandbox，隔離仍依原工具設定。'}僅在可信目錄使用；儲存後套用後續新啟動與恢復，現有程序不變。</p>
                              </div>
                            </details>
                          </div>
                        );
                      })}
                    </div>
                    {dirty && (
                      <p className="settings-help">變更設定後，請先儲存，再重新偵測或掃描。</p>
                    )}
                    <div className="settings-section-heading settings-section-space" id="settings-history-sources">
                      <div>
                        <h3>歷史資料來源 <span className="settings-count">{draft.sources.filter((source) => source.kind === selectedAgent).length}</span></h3>
                        <p>管理目前 Agent 的資料目錄；歷史讀取不以 CLI 安裝為前提。</p>
                      </div>
                    </div>
                    <FieldError id="sources-error" message={errors.sources} />
                    <div className="settings-history-providers">
                      {[selectedAgent].map((kind) => {
                        const capability = agentCapabilities[kind];
                        const installation = installations.find((item) => item.kind === kind);
                        const binary = installationState(installation, draft.executables[kind] !== (settings.executables[kind] ?? executableDefaults[kind]));
                        const sources = draft.sources.map((source, i) => ({ source, i })).filter(({ source }) => source.kind === kind);
                        return (
                          <section className="settings-history-provider" key={kind} aria-label={`${capability.name} 歷史來源`}>
                            <div className="settings-history-provider-top">
                              <AgentIcon kind={kind} />
                              <h4>{capability.name}</h4>
                              <span className={`settings-status ${binary.className}`}>CLI {binary.text}</span>
                            </div>
                            <p className="settings-help">{capability.history.description}</p>
                            <button type="button" className="settings-button secondary compact"
                              disabled={!capability.history.supported || !onDetectHistorySources}
                              aria-label={`偵測 ${capability.name} 歷史來源`}
                              onClick={() => void run(async () => {
                                const result = await onDetectHistorySources!(kind);
                                setSourceDiscoveries((previous) => ({ ...previous, [kind]: result }));
                              })}><Search size={14} />偵測歷史來源</button>
                            {sourceDiscoveries[kind] && <div className="settings-source-discovery" aria-live="polite">
                              <p className="settings-help">只檢查官方已知位置，不會啟動 Agent。找到目錄不代表已有歷史；加入後仍需儲存與掃描。</p>
                              {sourceDiscoveries[kind]!.message && <p className="settings-help">{sourceDiscoveries[kind]!.message}</p>}
                              {sourceDiscoveries[kind]!.candidates.map((candidate) => {
                                const configured = (candidate.configuredSourceIds ?? []).some((id) => {
                                  const saved = settings.sources.find((source) => source.id === id);
                                  return saved && draft.sources.some((source) => source.id === id && source.kind === kind && source.root === saved.root);
                                }) || draft.sources.some((source) => source.kind === kind && source.root.trim().replace(/\/+$/, '') === candidate.root.replace(/\/+$/, ''));
                                const status = { found: '找到可讀目錄', missing: '目錄不存在', permissionDenied: '無權限讀取', checkFailed: '檢查失敗' }[candidate.status];
                                return <div className="settings-source-candidate" key={candidate.root}>
                                  <span className={`settings-status ${candidate.status === 'found' ? 'neutral' : 'warning'}`}>{status}</span>
                                  <code>{candidate.root}</code>
                                  {candidate.message && <p className="settings-help">{candidate.message}</p>}
                                  {candidate.status === 'found' && <button type="button" className="settings-button secondary compact"
                                    disabled={configured || draft.sources.length >= 32}
                                    aria-label={`加入 ${capability.name} 偵測來源 ${candidate.root}`}
                                    onClick={() => addSource(kind as HistoryAgentKind, candidate.root)}><Plus size={14} />{configured ? '已加入設定' : '加入此來源'}</button>}
                                </div>;
                              })}
                            </div>}
                            {!capability.history.supported ? <>
                              <span className="settings-status neutral">歷史尚不支援</span>
                              <p className="settings-help">{capability.resume.description}</p>
                            </> : <>
                              {!sources.length && <div className="settings-history-unconfigured">
                                <span className="settings-status neutral">尚未設定來源</span>
                                <p className="settings-help">請指定已有歷史的完整資料目錄。尚未掃描，無法判斷是否有對話。</p>
                              </div>}
                              <div className="settings-source-list">
                                {sources.map(({ source, i }) => {
                                  const saved = settings.sources.find((item) => item.id === source.id);
                                  const status = !isAgentEnabled(draft, kind) ? { className: 'neutral', text: 'Agent 已停用 · 暫停掃描', detail: '此來源的個別開關與已索引歷史保留。' } : sourceStatus(source.id, source.enabled, !saved || saved.root !== source.root || saved.kind !== source.kind || saved.enabled !== source.enabled);
                                  return (
                                    <div className={`settings-source${source.enabled ? '' : ' is-disabled'}`} key={source.id}>
                                      <div className="settings-source-top">
                                        <label className="settings-toggle-label">
                                          <input className="checkbox" type="checkbox" checked={source.enabled} aria-label={`啟用資料來源 ${i + 1}`}
                                            onChange={(event) => update('sources', draft.sources.map((item) => item.id === source.id ? { ...item, enabled: event.target.checked } : item))} />
                                          <span>來源 {String(i + 1).padStart(2, '0')}</span>
                                        </label>
                                        <span className={`settings-status ${status.className}`}>{status.text}</span>
                                        <button type="button" className="settings-icon-button danger" aria-label={`移除資料來源 ${i + 1}`}
                                          onClick={() => update('sources', draft.sources.filter((item) => item.id !== source.id))}>
                                          <Trash2 size={15} />
                                        </button>
                                      </div>
                                      <div className="settings-source-fields">
                                        <label className="settings-field">
                                          <span>Agent 類型</span>
                                          <Select aria-label="Agent 類型" value={source.kind} disabled={locked}
                                            onChange={(value) => { update('sources', draft.sources.map((item) => item.id === source.id ? { ...item, kind: value as AgentKind } : item)); setSelectedAgent(value as AgentKind); setAgentSearch(''); }}
                                            options={historyAgentKinds.map((option) => ({ value: option, label: agentNames[option], icon: <AgentIcon kind={option} /> }))} />
                                        </label>
                                        <DirectoryPathField key={`${source.id}:${source.kind}`} className="settings-field"
                                          label={`${capability.history.sourceEnv || capability.name} 資料目錄`}
                                          id={`source-root-${source.id}`} value={source.root} disabled={locked}
                                          placeholder={capability.history.rootPlaceholder!}
                                          onChange={(root) => setDraft((current) => ({ ...current,
                                            sources: current.sources.map((item) => item.id === source.id ? { ...item, root } : item),
                                          }))}
                                          aria-invalid={Boolean(errors[`sources.${i}.root`])} aria-describedby={`source-${i}-error`}>
                                          <FieldError id={`source-${i}-error`} message={errors[`sources.${i}.root`] ?? errors[`sources.${i}.id`] ?? errors[`sources.${i}.kind`]} />
                                        </DirectoryPathField>
                                      </div>
                                      {status.detail && <p className="settings-help">{status.detail}</p>}
                                    </div>
                                  );
                                })}
                              </div>
                              <button type="button" className="settings-button secondary compact settings-provider-add"
                                disabled={draft.sources.length >= 32} onClick={() => addSource(kind as HistoryAgentKind)}>
                                <Plus size={14} />{sources.length ? `新增 ${capability.name} 歷史來源` : `設定 ${capability.name} 歷史來源`}
                              </button>
                            </>}
                          </section>
                        );
                      })}
                    </div>
                    {!onboarding && (
                      <div className="settings-index-box">
                        <div className="settings-section-heading">
                          <div>
                            <h3>本機搜尋索引</h3>
                            <p aria-live="polite">
                              {index.running
                                ? `掃描中 · 已處理 ${index.processed} / ${index.total} 個檔案`
                                : index.cancelled
                                  ? '上次掃描已取消，可隨時重新掃描。'
                                  : `已處理 ${index.processed} 個檔案`}
                            </p>
                          </div>
                          {index.running && (
                            <LoaderCircle
                              size={17}
                              className="settings-spinning"
                              aria-label="掃描進行中"
                            />
                          )}
                        </div>
                        {index.running && (
                          <progress
                            max={Math.max(index.total, 1)}
                            value={index.processed}
                            aria-label="索引掃描進度"
                          />
                        )}
                        <div className="settings-index-actions">
                          {index.running ? (
                            <button
                              type="button"
                              className="settings-button secondary"
                              onClick={() => void run(onCancelScan)}
                            >
                              取消掃描
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="settings-button secondary"
                                disabled={dirty}
                                onClick={() => void run(() => onScan(false))}
                              >
                                <RefreshCw size={14} />
                                重新掃描
                              </button>
                              <button
                                type="button"
                                className="settings-button secondary"
                                disabled={dirty}
                                onClick={() => void run(() => onScan(true))}
                              >
                                重建索引
                              </button>
                              <button
                                type="button"
                                className="settings-button danger-text"
                                onClick={() => setConfirmation('clear')}
                              >
                                清除索引
                              </button>
                            </>
                          )}
                        </div>
                        {index.errors.length > 0 && (
                          <details className="settings-index-errors">
                            <summary>查看 {index.errors.length} 個掃描提醒</summary>
                            <ul>
                              {index.errors.map((error, i) => (
                                <li key={i}>{error}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    )}
                  </>
                )}

                {section === 'profiles' && (
                  <>
                    <div className="settings-section-heading">
                      <div>
                        <h3>你的 Shell Profiles</h3>
                        <p>執行檔與參數分開傳入，不會拼接成 Shell 指令。</p>
                      </div>
                      <button
                        type="button"
                        className="settings-button secondary compact"
                        disabled={draft.profiles.length >= 32}
                        onClick={() => {
                          const profile: ShellProfile = {
                            id: newId('profile'),
                            name: '新的 Profile',
                            executable: '',
                            args: [],
                            env: {},
                          };
                          update('profiles', [...draft.profiles, profile]);
                          setJsonFields((current) => ({
                            ...current,
                            [profile.id]: { args: '[]', env: '{}' },
                          }));
                        }}
                      >
                        <Plus size={14} />
                        新增 Profile
                      </button>
                    </div>
                    <div className="settings-shell-discovery">
                      <div className="settings-section-heading">
                        <div><h4>可用的 Shell</h4><p>偵測只讀取本機執行檔資訊；選擇加入後才建立新的 Profile。</p></div>
                        <button type="button" className="settings-button secondary compact" disabled={!onDetectShells}
                          onClick={() => void run(async () => {
                            setShellCandidates(null);
                            setShellCandidates(await onDetectShells!());
                          })}>
                          <RefreshCw size={14} />重新偵測 Shell
                        </button>
                      </div>
                      {shellCandidates !== null && <div role="region" aria-label="偵測到的 Shell" className="settings-shell-candidates">
                        {shellCandidates.length === 0 && <p className="settings-help">沒有新的 Shell 可加入。已設定的 Shell 會自動排除；你仍可手動新增完整執行檔路徑。</p>}
                        {shellCandidates.map((candidate) => {
                          const added = draft.profiles.some((profile) => profile.executable === candidate.executable);
                          return <div className="settings-shell-candidate" key={candidate.executable}>
                            <div><strong>{candidate.name}</strong><p>{candidate.executable}</p></div>
                            <button type="button" className="settings-button secondary compact" disabled={added || draft.profiles.length >= 32}
                              aria-label={added ? `${candidate.name} 已有 Profile` : `加入 ${candidate.name} Profile`}
                              onClick={() => {
                                const profile: ShellProfile = { id: newId('profile'), name: candidate.name, executable: candidate.executable, args: [], env: {} };
                                update('profiles', [...draft.profiles, profile]);
                                setJsonFields((current) => ({ ...current, [profile.id]: { args: '[]', env: '{}' } }));
                              }}>
                              {added ? '已有 Profile' : '加入 Profile'}
                            </button>
                          </div>;
                        })}
                      </div>}
                      <p className="settings-help">不會取代既有 Profile 的名稱、參數、環境變數或預設選擇。新增的參數與環境變數預設為空，可自行編輯。</p>
                    </div>
                    <FieldError id="profiles-error" message={errors.profiles} />
                    <div className="settings-profile-list">
                      {draft.profiles.map((profile, i) => (
                        <div className="settings-profile" key={profile.id}>
                          <div className="settings-profile-title">
                            <Terminal size={17} aria-hidden="true" />
                            <strong>{profile.name || '未命名 Profile'}</strong>
                            {draft.defaultProfileId === profile.id && (
                              <span className="settings-status success">預設</span>
                            )}
                            <button
                              type="button"
                              className="settings-icon-button danger"
                              aria-label={`移除 ${profile.name || '未命名 Profile'}`}
                              disabled={draft.profiles.length === 1}
                              title={
                                draft.profiles.length === 1
                                  ? '至少需要保留一個 Profile'
                                  : '移除 Profile'
                              }
                              onClick={() => {
                                const profiles = draft.profiles.filter(
                                  (item) => item.id !== profile.id,
                                );
                                setDraft((current) => ({
                                  ...current,
                                  profiles,
                                  defaultProfileId:
                                    current.defaultProfileId === profile.id
                                      ? (profiles[0]?.id ?? '')
                                      : current.defaultProfileId,
                                }));
                                setJsonFields((current) =>
                                  Object.fromEntries(
                                    Object.entries(current).filter(([id]) => id !== profile.id),
                                  ),
                                );
                              }}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                          <div className="settings-two-columns">
                            <label className="settings-field">
                              <span>名稱</span>
                              <input
                                value={profile.name}
                                onChange={(event) =>
                                  updateProfile(profile.id, { name: event.target.value })
                                }
                                aria-invalid={Boolean(errors[`profiles.${i}.name`])}
                                aria-describedby={`profile-${i}-name-error`}
                              />
                              <FieldError
                                id={`profile-${i}-name-error`}
                                message={errors[`profiles.${i}.name`] ?? errors[`profiles.${i}.id`]}
                              />
                            </label>
                            <label className="settings-field">
                              <span>Shell 執行檔</span>
                              <input
                                value={profile.executable}
                                onChange={(event) =>
                                  updateProfile(profile.id, { executable: event.target.value })
                                }
                                placeholder="/bin/zsh"
                                spellCheck={false}
                                aria-invalid={Boolean(errors[`profiles.${i}.executable`])}
                                aria-describedby={`profile-${i}-executable-error`}
                              />
                              <FieldError
                                id={`profile-${i}-executable-error`}
                                message={errors[`profiles.${i}.executable`]}
                              />
                            </label>
                          </div>
                          <label className="settings-field">
                            <span>
                              啟動參數 <small>JSON 字串陣列</small>
                            </span>
                            <textarea
                              rows={3}
                              value={jsonFields[profile.id]?.args ?? '[]'}
                              onChange={(event) =>
                                setJsonFields((current) => ({
                                  ...current,
                                  [profile.id]: {
                                    ...current[profile.id],
                                    args: event.target.value,
                                  },
                                }))
                              }
                              placeholder={'["-l"]'}
                              spellCheck={false}
                              aria-invalid={Boolean(errors[`profiles.${i}.args`])}
                              aria-describedby={`profile-${i}-args-error`}
                            />
                            <FieldError
                              id={`profile-${i}-args-error`}
                              message={errors[`profiles.${i}.args`]}
                            />
                          </label>
                          <label className="settings-field">
                            <span>
                              環境變數 <small>JSON 物件</small>
                            </span>
                            <textarea
                              rows={4}
                              value={jsonFields[profile.id]?.env ?? '{}'}
                              onChange={(event) =>
                                setJsonFields((current) => ({
                                  ...current,
                                  [profile.id]: { ...current[profile.id], env: event.target.value },
                                }))
                              }
                              placeholder={'{"LANG":"zh_TW.UTF-8"}'}
                              spellCheck={false}
                              aria-invalid={Boolean(errors[`profiles.${i}.env`])}
                              aria-describedby={`profile-${i}-env-error`}
                            />
                            <FieldError
                              id={`profile-${i}-env-error`}
                              message={errors[`profiles.${i}.env`]}
                            />
                            <span className="settings-help">
                              設定會以明文保存在本機；登入與憑證請交由原本的 CLI 管理。
                            </span>
                          </label>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {section === 'appearance' && (
                  <>
                    <div className="settings-section-heading">
                      <div>
                        <h3>外觀</h3>
                        <p>選一個適合專注工作的環境。</p>
                      </div>
                    </div>
                    <p className="settings-help theme-quick-help">立即預覽整個工作台與所有終端；儲存後保留，取消並捨棄則還原。</p>
                    <div className="settings-field settings-section-space">
                      <label id="app-zoom-label" htmlFor="app-zoom">工作台縮放 <small>%</small></label>
                      <input id="app-zoom" type="number" min={50} max={200} step={10} aria-labelledby="app-zoom-label"
                        value={Number.isFinite(draft.appZoom ?? 100) ? (draft.appZoom ?? 100) : ''}
                        onChange={(event) => update('appZoom', event.target.value === '' ? Number.NaN : Number(event.target.value))}
                        aria-invalid={Boolean(errors.appZoom)} aria-describedby="app-zoom-error app-zoom-help" />
                      <FieldError id="app-zoom-error" message={errors.appZoom} />
                      <p className="settings-help" id="app-zoom-help">{workspaceZoomShortcutHelp} 儲存保留、取消捨棄還原；終端基準字級不變。</p>
                      <button className="secondary" type="button" onClick={() => update('appZoom', 100)}>還原工作台縮放 100%</button>
                    </div>
                    <ThemeControls value={appearanceOf(draft)} disabled={locked}
                      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
                    <FieldError id="theme-error" message={errors.theme || errors.themePalette} />
                    <FieldError id="terminal-theme-error" message={errors.terminalTheme} />
                    <div className="settings-two-columns settings-section-space">
                      <label className="settings-field">
                        <span>
                          終端字型大小 <small>px</small>
                        </span>
                        <input
                          type="number"
                          min={9}
                          max={32}
                          step={1}
                          value={Number.isFinite(draft.fontSize) ? draft.fontSize : ''}
                          onChange={(event) =>
                            update(
                              'fontSize',
                              event.target.value === '' ? Number.NaN : Number(event.target.value),
                            )
                          }
                          aria-invalid={Boolean(errors.fontSize)}
                          aria-describedby="font-size-error"
                        />
                        <FieldError id="font-size-error" message={errors.fontSize} />
                        <p className="settings-help">終端的基準字級；全工作台縮放另外作用於介面與終端，不會改寫此數值。此欄位立即預覽，儲存保留、取消捨棄還原。</p>
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>終端字型</span>
                      <input
                        value={draft.fontFamily}
                        onChange={(event) => update('fontFamily', event.target.value)}
                        placeholder="JetBrains Mono, SFMono-Regular, monospace"
                        spellCheck={false}
                        aria-invalid={Boolean(errors.fontFamily)}
                        aria-describedby="font-family-error"
                      />
                      <FieldError id="font-family-error" message={errors.fontFamily} />
                      <span className="settings-help">
                        使用這台電腦已安裝的字型，可用逗號指定備用字型。
                      </span>
                    </label>
                    <TerminalPreview value={appearanceOf(draft)} />
                    <div className="settings-section-heading settings-section-space" id="settings-history-sources">
                      <div>
                        <h3>開始新工作時</h3>
                        <p>既有面板不會因變更預設值而重新啟動。</p>
                      </div>
                    </div>
                    <div className="settings-two-columns">
                      <label className="settings-field">
                        <span>預設 Agent</span>
                        <Select aria-label="預設 Agent" value={draft.defaultAgent} disabled={locked}
                          onChange={(value) => update('defaultAgent', value as AgentKind)}
                          options={agentKinds.map((kind) => ({ value: kind, label: agentNames[kind], icon: <AgentIcon kind={kind} />, description: isAgentEnabled(draft, kind) ? undefined : '已停用，啟動時改用其他已啟用 Agent' }))} />
                        <FieldError id="default-agent-error" message={errors.defaultAgent} />
                      </label>
                      <label className="settings-field">
                        <span>預設 Shell Profile</span>
                        <Select aria-label="預設 Shell Profile" value={draft.defaultProfileId} disabled={locked}
                          onChange={(value) => update('defaultProfileId', value)}
                          options={draft.profiles.map((profile) => ({ value: profile.id, label: profile.name || '未命名 Profile', icon: <Terminal size={14} />, description: profile.executable }))} />
                        <FieldError id="default-profile-error" message={errors.defaultProfileId} />
                      </label>
                    </div>
                  </>
                )}

                {section === 'shortcuts' && (
                  <>
                    <div className="settings-section-heading">
                      <div>
                        <h3>鍵盤快捷鍵</h3>
                        <p>使用 Mod 表示 macOS 的 ⌘，或 Linux 的 Ctrl。</p>
                      </div>
                    </div>
                    <div className="settings-shortcut-notice">
                      <Keyboard size={17} />
                      <p>
                        例如
                        Mod+Shift+T。留空可停用快捷鍵。衝突會顯示在下方；請避開終端程式與作業系統常用組合。
                      </p>
                    </div>
                    <p className="settings-help">{workspaceTabShortcutHelp} 這些應用保留組合不會傳送至終端；組字期間或對話框內不攔截。舊版「下一個面板」預設改為 Mod+Alt+ArrowDown。</p>
                    {!Object.keys(draft.shortcuts).length && (
                      <div className="settings-empty">
                        <Keyboard size={24} />
                        <strong>目前使用應用程式預設快捷鍵</strong>
                        <p>尚無可自訂的快捷鍵設定。</p>
                      </div>
                    )}
                    <FieldError id="shortcuts-error" message={errors.shortcuts} />
                    <div className="settings-shortcuts">
                      {Object.entries(draft.shortcuts).map(([action, binding]) => (
                        <label className="settings-shortcut-row" key={action}>
                          <span>
                            <strong>{shortcutNames[action] ?? action}</strong>
                            <small>{action}</small>
                          </span>
                          <span>
                            <input
                              value={binding}
                              onChange={(event) =>
                                update('shortcuts', {
                                  ...draft.shortcuts,
                                  [action]: event.target.value,
                                })
                              }
                              spellCheck={false}
                              aria-invalid={Boolean(errors[`shortcuts.${action}`])}
                              aria-describedby={`shortcut-${action}-error`}
                            />
                            <FieldError
                              id={`shortcut-${action}-error`}
                              message={errors[`shortcuts.${action}`]}
                            />
                          </span>
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </fieldset>
            </div>
          </div>
          <footer className="settings-footer">
            <div className="settings-footer-status" role={operationError ? 'alert' : 'status'}>
              {operationError ? (
                <span className="settings-field-error">
                  <CircleAlert size={15} />
                  {operationError}
                </span>
              ) : showErrors && Object.keys(prepared.errors).length ? (
                <span className="settings-field-error">
                  <CircleAlert size={15} />
                  請修正標示的欄位後再儲存。
                </span>
              ) : (
                <span>
                  {onboarding
                    ? '之後隨時可以回到設定調整。'
                    : dirty
                      ? '有尚未儲存的變更'
                      : '所有設定儲存在本機'}
                </span>
              )}
            </div>
            <button
              type="button"
              className="settings-button secondary"
              onClick={close}
              disabled={locked}
            >
              {onboarding ? '稍後設定' : '取消'}
            </button>
            <button type="submit" className="settings-button primary" disabled={locked}>
              {locked ? (
                <LoaderCircle size={16} className="settings-spinning" />
              ) : onboarding ? (
                <ChevronRight size={16} />
              ) : (
                <Check size={16} />
              )}
              {locked ? '處理中…' : onboarding ? '儲存並開始掃描' : '儲存設定'}
            </button>
          </footer>
        </form>
        {confirmation && (
          <div className="settings-confirm-backdrop">
            <div
              className="settings-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="settings-confirm-title"
              aria-describedby="settings-confirm-description"
            >
              <div className="settings-confirm-icon">
                <CircleAlert size={24} />
              </div>
              <h3 id="settings-confirm-title">
                {confirmation === 'clear' ? '清除本機搜尋索引？' : '捨棄尚未儲存的變更？'}
              </h3>
              <p id="settings-confirm-description">
                {confirmation === 'clear'
                  ? '只會刪除 Session Bay 建立的衍生索引。原始 Agent 對話、來源檔案、專案與設定都不會被修改；資源回收筒也會保留；之後可以重新掃描建立索引。'
                  : '剛才編輯的設定將不會保留。你可以返回繼續編輯。'}
              </p>
              <div className="settings-confirm-actions">
                <button
                  type="button"
                  className="settings-button secondary"
                  onClick={() => setConfirmation(null)}
                >
                  返回
                </button>
                <button
                  type="button"
                  className="settings-button danger-fill"
                  disabled={locked || (confirmation === 'clear' && index.running)}
                  onClick={() => {
                    if (confirmation === 'discard') {
                      setConfirmation(null);
                      onClose();
                    } else if (!index.running) {
                      setConfirmation(null);
                      void run(onClearIndex);
                    }
                  }}
                >
                  {confirmation === 'clear' ? '確定清除索引' : '捨棄變更'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default SettingsPanel;
