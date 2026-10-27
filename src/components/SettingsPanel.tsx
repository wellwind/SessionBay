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
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { AgentKind, HistorySourceDiscovery, IndexStatus, Installation, Settings, ShellCandidate, ShellProfile } from '../types';
import { normalizedShortcut, normalizeLegacyShortcuts, reservedWorkspaceShortcut, shortcutDefaults, workspaceTabShortcutHelp } from '../commands';
import { agentCapabilities, agentKinds, historyAgentKinds, agentNames, executableDefaults, bypassFlags, installationState, normalizedAgentOptions, isAgentEnabled } from '../agents';
import type { HistoryAgentKind } from '../agents';
import { isAgentHooksEnabled, normalizedAgentHooks } from '../settings';
import { isAbsoluteFilesystemPath } from '../paths';
import { Select, SearchableSelect } from './controls';
import { AgentIcon } from './AgentIcon';
import { ThemeControls, TerminalPreview } from './ThemeControls';
import { appearanceOf, validThemeId } from '../themes';
import type { Appearance } from '../themes';
import './settings.css';
import { readLocalePreference, saveLocalePreference, t, type LocalePreference } from '../i18n';

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
  'project-quick-open': t('Quick open project tabs, sessions and files'),
  'toggle-project-sessions': t('Show / hide project sessions'),
  'toggle-project-files': t('Show / hide project files'),
  'toggle-project-git': t('Show / hide project Git'),
  'new-terminal': t('Open a terminal'),
  'new-agent': t('Start agent work'),
  'search-sessions': t('Search sessions'),
  'split-right': t('Split left and right'),
  'split-down': t('Split top and bottom'),
  'next-pane': t('Next pane'),
  'maximize-pane': t('Maximize / restore pane'),
  'close-pane': t('Close pane'),
  'command-palette': t('Command palette'),
  'toggle-sidebar': t('Show / hide the sidebar'),
  'toggle-focus-mode': t('Enter / exit focus mode (Zen Mode)'),
};
const sections = [
  { id: 'sources' as const, label: t('Sources and tools'), icon: Folder },
  { id: 'profiles' as const, label: 'Shell Profiles', icon: Terminal },
  { id: 'appearance' as const, label: t('Appearance and defaults'), icon: Palette },
  { id: 'shortcuts' as const, label: t('Keyboard shortcuts'), icon: Keyboard },
];

function cloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    agentHooks: normalizedAgentHooks(settings),
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
        error: t('Enter a string array such as ["-l"]: up to 64 arguments of up to 8192 bytes each, with no null characters.'),
      };
    }
    return { value: value as string[] };
  } catch {
    return { error: t('Arguments must be a valid JSON string array.') };
  }
}

export function parseAgentArgs(text: string): { value?: string[]; error?: string } {
  const parsed = parseProfileArgs(text);
  if (parsed.value?.some((arg) => arg.length === 0)) return { error: t('Agent arguments cannot contain empty strings.') };
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
      return { error: t('Environment variables must be a JSON object with up to 64 entries, such as {"LANG":"en_US.UTF-8"}.') };
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
            t('Variable names may only use letters, digits and underscores (up to 128 bytes); values must be strings without null characters (up to 8192 bytes).'),
        };
      }
    }
    return { value: value as Record<string, string> };
  } catch {
    return { error: t('Environment variables must be a valid JSON object.') };
  }
}

/** Client-side checks complement, but do not replace, backend validation. */
export function validateSettings(settings: Settings): ValidationErrors {
  const errors: ValidationErrors = {};
  if (settings.version !== 1) errors.version = t('Unsupported settings version.');
  if (!['dark', 'light', 'system'].includes(settings.theme))
    errors.theme = t('Choose a valid interface theme.');
  if (!validThemeId(settings.themePalette ?? 'bay'))
    errors.themePalette = t('Choose a valid interface palette.');
  if (!validThemeId(settings.terminalTheme))
    errors.terminalTheme = t('Choose valid terminal colors.');
  if (!validText(settings.fontFamily, 256))
    errors.fontFamily = t('Enter a valid font name of up to 256 bytes.');
  if (!Number.isInteger(settings.fontSize) || settings.fontSize < 9 || settings.fontSize > 32)
    errors.fontSize = t('Font size must be a whole number from 9 to 32.');
  if (!Number.isInteger(settings.appZoom ?? 100) || (settings.appZoom ?? 100) < 50 || (settings.appZoom ?? 100) > 200)
    errors.appZoom = t('Enter a workbench zoom as a whole percentage from 50 to 200.');
  if (!agentKinds.includes(settings.defaultAgent))
    errors.defaultAgent = t('Choose a default agent.');
  if (!settings.profiles.length || settings.profiles.length > 32)
    errors.profiles = t('Keep 1 to 32 shell profiles.');
  if (settings.sources.length > 32) errors.sources = t('You can add up to 32 sources.');
  if (!settings.profiles.some((profile) => profile.id === settings.defaultProfileId))
    errors.defaultProfileId = t('Choose a valid default shell profile.');
  if (settings.agentEnabled && Object.values(settings.agentEnabled).some((enabled) => typeof enabled !== 'boolean'))
    errors.agentEnabled = t('Agent enable settings must be on/off values.');
  const profileIds = new Set<string>();
  settings.profiles.forEach((profile, i) => {
    if (!validText(profile.id, 128) || profileIds.has(profile.id))
      errors[`profiles.${i}.id`] = t('Profile IDs must be unique.');
    profileIds.add(profile.id);
    if (!validText(profile.name, 128))
      errors[`profiles.${i}.name`] = t('Enter a profile name of up to 128 bytes.');
    if (!validText(profile.executable, 4096))
      errors[`profiles.${i}.executable`] = t('Enter the shell executable path or name.');
    if (
      profile.args.length > 64 ||
      profile.args.some(
        (arg) => typeof arg !== 'string' || containsNull(arg) || byteLength(arg) > 8192,
      )
    )
      errors[`profiles.${i}.args`] = t('Arguments must be strings without null characters.');
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
      errors[`profiles.${i}.env`] = t('Check the environment variable names and values.');
  });
  const sourceIds = new Set<string>();
  const sourceRoots = new Set<string>();
  settings.sources.forEach((source, i) => {
    if (!validText(source.id, 128) || sourceIds.has(source.id))
      errors[`sources.${i}.id`] = t('Source IDs must be unique.');
    sourceIds.add(source.id);
    if (!(historyAgentKinds as readonly string[]).includes(source.kind))
      errors[`sources.${i}.kind`] = t('Choose a supported agent type.');
    if (!validText(source.root, 4096) || !isAbsoluteFilesystemPath(source.root))
      errors[`sources.${i}.root`] = t('Enter the full folder path for this platform, such as C:\\\\Users\\\\you\\\\.codex or /Users/you/.codex.');
    const rootKey = `${source.kind}:${source.root.trim().replace(/[\\/]+$/, '')}`;
    if (sourceRoots.has(rootKey)) errors[`sources.${i}.root`] = t('This data folder is already added for this agent.');
    sourceRoots.add(rootKey);
  });
  agentKinds.forEach((kind) => {
    if (!validText(settings.executables[kind], 4096))
      errors[`executables.${kind}`] = t('Enter the executable path, or {{kind}} to find it on PATH.', { kind });
  });
  for (const kind of agentKinds) {
    const options = settings.agentOptions?.[kind];
    if (!options) continue; // Older settings are normalized before editing/saving.
    const parsed = parseAgentArgs(JSON.stringify(options.extraArgs));
    if (parsed.error) errors[`agentOptions.${kind}`] = parsed.error;
    if (typeof options.bypassPermissions !== 'boolean') errors[`agentOptions.${kind}`] = t('Check the tool permission settings.');
    if (!options.bypassPermissions && options.extraArgs.some((arg) =>
      /^(--auto|--yolo|--always-approve|--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--allow-dangerously-skip-permissions)(=|$)/.test(arg)))
      errors[`agentOptions.${kind}`] = t('High-risk arguments require checking the skip-permission option below first.');
  }
  const bindings = new Map<string, string[]>();
  if (Object.keys(settings.shortcuts).length > 32) errors.shortcuts = t('You can set up to 32 shortcuts.');
  for (const [action, binding] of Object.entries({ ...shortcutDefaults, ...settings.shortcuts })) {
    if (!validText(action, 64) || byteLength(binding) > 64 || containsNull(binding)) {
      errors[`shortcuts.${action}`] = t('Shortcut names and combinations can be at most 64 bytes, with no null characters.');
      continue;
    }
    if (!binding.trim()) continue;
    if (reservedWorkspaceShortcut(binding)) errors[`shortcuts.${action}`] = t('This combination is reserved for workspace tab switching, workbench zoom or terminal Shift+Enter; choose another shortcut.');
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
      errors[`shortcuts.${action}`] = t('Use modifier keys plus a key, such as Mod+Shift+T.');
    }
    const canonical = normalizeShortcut(binding);
    bindings.set(canonical, [...(bindings.get(canonical) ?? []), action]);
  }
  for (const actions of bindings.values()) {
    if (actions.length < 2) continue;
    actions.forEach((action) => {
      errors[`shortcuts.${action}`] = t('Conflicts with "{{actions}}".', { actions: actions
        .filter((other) => other !== action)
        .map((other) => shortcutNames[other] ?? other)
        .join(t(', ')) });
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
  const composing = useRef(false);
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
    (panelRef.current?.querySelector<HTMLElement>('[role="alertdialog"] [data-dialog-confirm]:not(:disabled)') ??
      panelRef.current?.querySelector<HTMLElement>('[role="alertdialog"] button:not(:disabled)'))?.focus();
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
        // Any explicit save completes onboarding, including from the gear after "Set up later".
        onboardingComplete: true,
      });
      onClose();
    });
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
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
      return { text: t('Not applied yet'), className: 'neutral', detail: t('The new source settings are used after you save.') };
    if (!enabled)
      return { text: t('Disabled'), className: 'neutral', detail: t('This source is skipped in the next scan.') };
    const health = index.sources.find((source) => source.sourceId === sourceId);
    if (index.running)
      return { text: t('Indexing'), className: 'neutral', detail: t('Scanning enabled sources; results update when it finishes.') };
    if (!health)
      return { text: t('Not scanned yet'), className: 'neutral', detail: t('It is not known yet whether there is history; scan first.') };
    const state = health.status.toLowerCase();
    if (state === 'empty')
      return { text: t('No history yet'), className: 'neutral', detail: health.message || t('Scan finished; no supported history found.') };
    if (state === 'missing')
      return { text: t('Source folder not found'), className: 'warning', detail: health.message || t('Check the full path of the history folder.') };
    if (['error', 'failed', 'invalid', 'unavailable'].includes(state))
      return { text: t('Source read error'), className: 'warning', detail: health.message || t('Check the path and read permissions, then scan again.') };
    if (['ok', 'ready', 'healthy', 'scanned', 'complete'].includes(state))
      return { text: t('Readable · {{count}} files', { count: health.files }), className: 'success', detail: health.message };
    if (state === 'partial')
      return { text: t('Partly readable · {{count}} files', { count: health.files }), className: 'warning', detail: health.message || t('Some history could not be read completely; see the scan warnings.') };
    if (state === 'cancelled')
      return { text: t('Scan cancelled'), className: 'neutral', detail: health.message || t('Results may be incomplete; scan again.') };
    if (state === 'disabled' || state === 'paused')
      return { text: t('Waiting for a rescan'), className: 'neutral', detail: t('The source is enabled, but there are no new scan results yet.') };
    return { text: t('Source status unconfirmed'), className: 'neutral', detail: health.message || t('Unconfirmed scan status: {{status}}', { status: health.status }) };
  };

  return (
    <div className="settings-backdrop">
      <div
        className={`settings-panel${onboarding ? ' settings-onboarding' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby={onboarding ? "settings-description" : undefined}
        tabIndex={-1}
        ref={panelRef}
        onCompositionStartCapture={() => { composing.current = true; }}
        onCompositionEndCapture={() => { composing.current = false; }}
        onBlurCapture={() => { composing.current = false; }}
        onKeyDownCapture={event => {
          if (confirmation && event.key === 'Enter' &&
              (event.nativeEvent.isComposing || composing.current || event.keyCode === 229 || event.repeat)) {
            event.preventDefault(); event.stopPropagation();
          }
        }}
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
            <h2 id="settings-title">{onboarding ? t('Bring your work back to one place.') : t('Workbench settings')}</h2>
            {onboarding && <p id="settings-description">{t('Connect your local agent history and set up the environment you like.')}</p>}
          </div>
          <button
            type="button"
            className="settings-icon-button settings-close"
            onClick={close}
            disabled={locked}
            aria-label={onboarding ? t('Set up later') : t('Close settings')}
          >
            <X size={19} />
          </button>
        </header>
        <form onSubmit={save} className="settings-form" noValidate inert={Boolean(confirmation)}>
          <div className="settings-layout">
            <nav className="settings-nav" aria-label={t('Settings sections')}>
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
                    <span className="settings-error-dot" aria-label={t('Some fields need fixing')} />
                  )}
                  {section === id && <ChevronRight size={14} aria-hidden="true" />}
                </button>
              ))}
            </nav>
            <div className="settings-content">
              <fieldset className="settings-fieldset" disabled={locked}>
                {section === 'sources' && (
                  <>
                    <div className="settings-agent-picker">
                      <label className="settings-field"><span>{t('Search agents')}</span>
                        <SearchableSelect aria-label={t('Search agents')} value={selectedAgent} disabled={locked}
                          query={agentSearch} onQueryChange={setAgentSearch} onChange={(value) => setSelectedAgent(value as AgentKind)}
                          options={agentKinds.map((kind) => ({ value: kind, label: agentNames[kind], icon: <AgentIcon kind={kind} />,
                            description: `${isAgentEnabled(draft, kind) ? t('Enabled') : t('Disabled')} · ${installationState(installations.find((item) => item.kind === kind), draft.executables[kind] !== (settings.executables[kind] ?? executableDefaults[kind])).text}`,
                          }))} />
                      </label>
                    </div>
                    <div className="settings-section-heading"><div><h3>{t('Enabled and install status')}</h3><p>{t('Settings apply only after you save.')}</p></div></div>
                    <div className="settings-agent-enabled">
                      <label className="settings-toggle-label">
                        <input className="checkbox" type="checkbox" aria-label={t('Enable {{agent}}', { agent: agentNames[selectedAgent] })}
                          checked={isAgentEnabled(draft, selectedAgent)}
                          onChange={(event) => update('agentEnabled', { ...draft.agentEnabled, [selectedAgent]: event.target.checked })} />
                        <strong>{t('Enable {{agent}}', { agent: agentNames[selectedAgent] })}</strong>
                      </label>
                      {[selectedAgent].map((kind) => {
                        const installation = installations.find((item) => item.kind === kind);
                        const binary = installationState(installation, draft.executables[kind] !== (settings.executables[kind] ?? executableDefaults[kind]));
                        return <div className="settings-agent-health" key={kind}>
                            <div className="settings-installation-top">
                              <AgentIcon kind={kind} />
                              <strong>{agentNames[kind]}</strong>
                              <span className={`settings-status ${binary.className}`}>
                                {binary.className === 'success' && <Check size={12} />}{binary.text}
                              </span>
                            </div>
                            <p className="settings-help">{t('Login status: not verified; the CLI\'s own login is used.')}</p>
                            <p className="settings-version">
                              {installation?.available
                                ? installation.version || t('Executable found')
                                : agentCapabilities[kind].history.supported ? t('Existing history can still be browsed') : t('Supports launching and resuming by conversation ID; history is not indexed yet')}
                            </p>
                        </div>;
                      })}
                      {!isAgentEnabled(draft, selectedAgent) && <p className="settings-subtle-warning">{t('This agent is disabled. You can still change its settings; it works again once re-enabled.')}</p>}
                    </div>
                    <div className="settings-section-heading" id="settings-agent-tools">
                      <div>
                        <h3>{t('Launch settings')}</h3>
                      </div>
                      <button
                        type="button"
                        className="settings-button secondary compact"
                        onClick={() => void run(onDetect)}
                        disabled={dirty}
                      >
                        <RefreshCw size={14} />
                        {t('Detect again')}
                      </button>
                    </div>
                    <div className="settings-installations">
                      {[selectedAgent].map((kind) => {
                        const installation = installations.find((item) => item.kind === kind);
                        const parsedArgs = parseAgentArgs(agentJson[kind]);
                        const argumentSummary = parsedArgs.error ? t('Arguments need fixing') : parsedArgs.value?.length ? t('Custom arguments set') : t('Using safe defaults');
                        return (
                          <div className="settings-installation" key={kind}>
                            <label className="settings-field">
                              <span>{t('Executable path')}</span>
                              <input
                                aria-label={t('{{agent}} executable path', { agent: agentNames[kind] })}
                                value={draft.executables[kind]}
                                placeholder={t('{{default}} or the full executable path', { default: executableDefaults[kind] })}
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
                                <span className="settings-detected-label">{t('Current: ')}</span><span className="settings-detected-value">{installation.executable}</span>
                              </p>
                            )}
                            {installation?.error && (
                              <p className="settings-subtle-warning">{installation.error}</p>
                            )}
                            {!agentCapabilities[kind].history.supported && <p className="settings-help">{t('Supports launching and resuming by conversation ID; history is not indexed yet.')}</p>}
                            {(kind === 'codex' || kind === 'claude' || kind === 'opencode' || kind === 'grok' || kind === 'antigravity') && <>
                              <label className="settings-field">
                                <span><input className="checkbox" type="checkbox"
                                  aria-label={t('{{agent}} activity hooks', { agent: agentNames[kind] })}
                                  checked={isAgentHooksEnabled(draft, kind)}
                                  onChange={(event) => update('agentHooks', { ...draft.agentHooks, [kind]: event.target.checked })} /> {t('Enable activity hooks')}</span>
                              </label>
                            </>}
                            <details className="settings-agent-advanced" open={draft.agentOptions[kind].bypassPermissions || !!errors[`agentOptions.${kind}`] || undefined}>
                              <summary aria-label={t('{{agent}} arguments and permissions', { agent: agentNames[kind] })}>
                                <span>{t('Arguments and permissions')}</span><span>{draft.agentOptions[kind].bypassPermissions ? t('High-risk mode is on') : argumentSummary}</span>
                              </summary>
                              <div className="settings-agent-advanced-body">
                            <label className="settings-field">
                              <span>{t('Custom launch arguments')} <small>{t('JSON string array')}</small></span>
                              <textarea rows={3} aria-label={t('{{agent}} custom launch arguments', { agent: agentNames[kind] })}
                                value={agentJson[kind]} spellCheck={false}
                                onChange={(event) => setAgentJson((current) => ({ ...current, [kind]: event.target.value }))}
                                aria-invalid={Boolean(errors[`agentOptions.${kind}`])} />
                              <FieldError id={`settings-${kind}-args-error`} message={errors[`agentOptions.${kind}`]} />
                            </label>
                            <p className="settings-help">{t('For example ["--model", "model-name"]. Each item is one argument with no shell quoting; arguments that override the working directory, source or session are not accepted. Stored locally in plain text, so never enter passwords or keys.')}</p>
                            <label className="settings-risk-toggle">
                              <input className="checkbox" type="checkbox" checked={draft.agentOptions[kind].bypassPermissions}
                                aria-label={t('{{agent}} skip permission prompts', { agent: agentNames[kind] })}
                                onChange={(event) => update('agentOptions', { ...draft.agentOptions,
                                  [kind]: { ...draft.agentOptions[kind], bypassPermissions: event.target.checked } })} />
                              <span>{t('I understand the risk; skip tool permission prompts for {{agent}}', { agent: agentNames[kind] })}</span>
                            </label>
                            <p className="settings-subtle-warning">{t('Adds {{flag}} by default; the launch preview shows custom permission options. The agent may run commands and read, write or delete files without asking.', { flag: bypassFlags[kind] })}{kind === 'codex'
                              ? t('In this mode Codex also disables its sandbox.')
                              : t('This does not disable the sandbox; isolation still follows the tool\'s own settings.')}{t('Use it only in trusted folders. After saving, it applies to new launches and resumes; running processes are unchanged.')}</p>
                              </div>
                            </details>
                          </div>
                        );
                      })}
                    </div>
                    {dirty && (
                      <p className="settings-help">{t('After changing settings, save first, then detect or scan again.')}</p>
                    )}
                    <div className="settings-section-heading settings-section-space" id="settings-history-sources">
                      <div>
                        <h3>{t('History sources')} <span className="settings-count">{draft.sources.filter((source) => source.kind === selectedAgent).length}</span></h3>
                        <p>{t('Manage this agent\'s data folders; reading history does not require the CLI to be installed.')}</p>
                      </div>
                    </div>
                    <FieldError id="sources-error" message={errors.sources} />
                    <div className="settings-history-providers">
                      {[selectedAgent].map((kind) => {
                        const capability = agentCapabilities[kind];
                        const sources = draft.sources.map((source, i) => ({ source, i })).filter(({ source }) => source.kind === kind);
                        return (
                          <section className="settings-history-provider" key={kind} aria-label={t('{{agent}} history sources', { agent: capability.name })}>
                            <div className="settings-history-provider-top">
                              <AgentIcon kind={kind} />
                              <h4>{capability.name}</h4>
                            </div>
                            {kind !== 'codex' && <p className="settings-help">{t(capability.history.description)}</p>}
                            <button type="button" className="settings-button secondary compact"
                              disabled={!capability.history.supported || !onDetectHistorySources}
                              aria-label={t('Detect {{agent}} history sources', { agent: capability.name })}
                              onClick={() => void run(async () => {
                                const result = await onDetectHistorySources!(kind);
                                setSourceDiscoveries((previous) => ({ ...previous, [kind]: result }));
                              })}><Search size={14} />{t('Detect history sources')}</button>
                            {sourceDiscoveries[kind] && <div className="settings-source-discovery" aria-live="polite">
                              <p className="settings-help">{t('Only checks officially known locations and never starts the agent. A found folder does not mean there is history; save and scan after adding it.')}</p>
                              {sourceDiscoveries[kind]!.message && <p className="settings-help">{sourceDiscoveries[kind]!.message}</p>}
                              {sourceDiscoveries[kind]!.candidates.map((candidate) => {
                                const configured = (candidate.configuredSourceIds ?? []).some((id) => {
                                  const saved = settings.sources.find((source) => source.id === id);
                                  return saved && draft.sources.some((source) => source.id === id && source.kind === kind && source.root === saved.root);
                                }) || draft.sources.some((source) => source.kind === kind && source.root.trim().replace(/\/+$/, '') === candidate.root.replace(/\/+$/, ''));
                                const status = { found: t('Readable folder found'), missing: t('Folder does not exist'), permissionDenied: t('No permission to read'), checkFailed: t('Check failed') }[candidate.status];
                                return <div className="settings-source-candidate" key={candidate.root}>
                                  <span className={`settings-status ${candidate.status === 'found' ? 'neutral' : 'warning'}`}>{status}</span>
                                  <code>{candidate.root}</code>
                                  {candidate.message && <p className="settings-help">{candidate.message}</p>}
                                  {candidate.status === 'found' && <button type="button" className="settings-button secondary compact"
                                    disabled={configured || draft.sources.length >= 32}
                                    aria-label={t('Add detected {{agent}} source {{root}}', { agent: capability.name, root: candidate.root })}
                                    onClick={() => addSource(kind as HistoryAgentKind, candidate.root)}><Plus size={14} />{configured ? t('Already added') : t('Add this source')}</button>}
                                </div>;
                              })}
                            </div>}
                            {!capability.history.supported ? <>
                              <span className="settings-status neutral">{t('History not supported yet')}</span>
                              <p className="settings-help">{t(capability.resume.description)}</p>
                            </> : <>
                              {!sources.length && <div className="settings-history-unconfigured">
                                <span className="settings-status neutral">{t('No source set up')}</span>
                                <p className="settings-help">{t('Specify the full data folder that has history. Until it is scanned, it is unknown whether there are conversations.')}</p>
                              </div>}
                              <div className="settings-source-list">
                                {sources.map(({ source, i }) => {
                                  const saved = settings.sources.find((item) => item.id === source.id);
                                  const status = !isAgentEnabled(draft, kind) ? { className: 'neutral', text: t('Agent disabled · scanning paused'), detail: t('This source\'s own switch and indexed history are kept.') } : sourceStatus(source.id, source.enabled, !saved || saved.root !== source.root || saved.kind !== source.kind || saved.enabled !== source.enabled);
                                  return (
                                    <div className={`settings-source${source.enabled ? '' : ' is-disabled'}`} key={source.id}>
                                      <div className="settings-source-top">
                                        <label className="settings-toggle-label">
                                          <input className="checkbox" type="checkbox" checked={source.enabled} aria-label={t('Enable source {{number}}', { number: i + 1 })}
                                            onChange={(event) => update('sources', draft.sources.map((item) => item.id === source.id ? { ...item, enabled: event.target.checked } : item))} />
                                          <span>{t('Source {{number}}', { number: String(i + 1).padStart(2, '0') })}</span>
                                        </label>
                                        <span className={`settings-status ${status.className}`}>{status.text}</span>
                                        <button type="button" className="settings-icon-button danger" aria-label={t('Remove source {{number}}', { number: i + 1 })}
                                          onClick={() => update('sources', draft.sources.filter((item) => item.id !== source.id))}>
                                          <Trash2 size={15} />
                                        </button>
                                      </div>
                                      <div className="settings-source-fields">
                                        <label className="settings-field">
                                          <span>{t('Agent type')}</span>
                                          <Select aria-label={t('Agent type')} value={source.kind} disabled={locked}
                                            onChange={(value) => { update('sources', draft.sources.map((item) => item.id === source.id ? { ...item, kind: value as AgentKind } : item)); setSelectedAgent(value as AgentKind); setAgentSearch(''); }}
                                            options={historyAgentKinds.map((option) => ({ value: option, label: agentNames[option], icon: <AgentIcon kind={option} /> }))} />
                                        </label>
                                        <DirectoryPathField key={`${source.id}:${source.kind}`} className="settings-field"
                                          label={t('{{name}} data folder', { name: capability.history.sourceEnv || capability.name })}
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
                                <Plus size={14} />{sources.length ? t('Add {{agent}} history source', { agent: capability.name }) : t('Set up {{agent}} history source', { agent: capability.name })}
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
                            <h3>{t('Local search index')}</h3>
                            <p aria-live="polite">
                              {index.running
                                ? t('Scanning · {{processed}} / {{total}} files processed', { processed: index.processed, total: index.total })
                                : index.cancelled
                                  ? t('The last scan was cancelled; you can scan again any time.')
                                  : t('{{count}} files processed', { count: index.processed })}
                            </p>
                          </div>
                          {index.running && (
                            <LoaderCircle
                              size={17}
                              className="settings-spinning"
                              aria-label={t('Scan in progress')}
                            />
                          )}
                        </div>
                        {index.running && (
                          <progress
                            max={Math.max(index.total, 1)}
                            value={index.processed}
                            aria-label={t('Index scan progress')}
                          />
                        )}
                        <div className="settings-index-actions">
                          {index.running ? (
                            <button
                              type="button"
                              className="settings-button secondary"
                              onClick={() => void run(onCancelScan)}
                            >
                              {t('Cancel scan')}
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
                                {t('Rescan')}
                              </button>
                              <button
                                type="button"
                                className="settings-button secondary"
                                disabled={dirty}
                                onClick={() => void run(() => onScan(true))}
                              >
                                {t('Rebuild index')}
                              </button>
                              <button
                                type="button"
                                className="settings-button danger-text"
                                onClick={() => setConfirmation('clear')}
                              >
                                {t('Clear index')}
                              </button>
                            </>
                          )}
                        </div>
                        {index.errors.length > 0 && (
                          <details className="settings-index-errors">
                            <summary>{t('View {{count}} scan warnings', { count: index.errors.length })}</summary>
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
                        <h3>{t('Your shell profiles')}</h3>
                      </div>
                      <button
                        type="button"
                        className="settings-button secondary compact"
                        disabled={draft.profiles.length >= 32}
                        onClick={() => {
                          const profile: ShellProfile = {
                            id: newId('profile'),
                            name: t('New profile'),
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
                        {t('Add profile')}
                      </button>
                    </div>
                    <div className="settings-shell-discovery">
                      <div className="settings-section-heading">
                        <div><h4>{t('Available shells')}</h4><p>{t('Detection only reads local executable info; a profile is created only when you add it.')}</p></div>
                        <button type="button" className="settings-button secondary compact" disabled={!onDetectShells}
                          onClick={() => void run(async () => {
                            setShellCandidates(null);
                            setShellCandidates(await onDetectShells!());
                          })}>
                          <RefreshCw size={14} />{t('Detect shells again')}
                        </button>
                      </div>
                      {shellCandidates !== null && <div role="region" aria-label={t('Detected shells')} className="settings-shell-candidates">
                        {shellCandidates.length === 0 && <p className="settings-help">{t('No new shells to add. Shells already set up are excluded; you can still add a full executable path manually.')}</p>}
                        {shellCandidates.map((candidate) => {
                          const added = draft.profiles.some((profile) => profile.executable === candidate.executable);
                          return <div className="settings-shell-candidate" key={candidate.executable}>
                            <div><strong>{candidate.name}</strong><p>{candidate.executable}</p></div>
                            <button type="button" className="settings-button secondary compact" disabled={added || draft.profiles.length >= 32}
                              aria-label={added ? t('{{name}} already has a profile', { name: candidate.name }) : t('Add {{name}} profile', { name: candidate.name })}
                              onClick={() => {
                                const profile: ShellProfile = { id: newId('profile'), name: candidate.name, executable: candidate.executable, args: [], env: {} };
                                update('profiles', [...draft.profiles, profile]);
                                setJsonFields((current) => ({ ...current, [profile.id]: { args: '[]', env: '{}' } }));
                              }}>
                              {added ? t('Has a profile') : t('Add as profile')}
                            </button>
                          </div>;
                        })}
                      </div>}
                      <p className="settings-help">{t('Existing profile names, arguments, environment variables and the default choice are never replaced. New arguments and environment variables start empty for you to edit.')}</p>
                    </div>
                    <FieldError id="profiles-error" message={errors.profiles} />
                    <div className="settings-profile-list">
                      {draft.profiles.map((profile, i) => (
                        <div className="settings-profile" key={profile.id}>
                          <div className="settings-profile-title">
                            <Terminal size={17} aria-hidden="true" />
                            <strong>{profile.name || t('Untitled profile')}</strong>
                            {draft.defaultProfileId === profile.id && (
                              <span className="settings-status success">{t('Default')}</span>
                            )}
                            <button
                              type="button"
                              className="settings-icon-button danger"
                              aria-label={t('Remove {{name}}', { name: profile.name || t('Untitled profile') })}
                              disabled={draft.profiles.length === 1}
                              title={
                                draft.profiles.length === 1
                                  ? t('At least one profile is required')
                                  : t('Remove profile')
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
                              <span>{t('Name')}</span>
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
                              <span>{t('Shell executable')}</span>
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
                              {t('Launch arguments')} <small>{t('JSON string array')}</small>
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
                              {t('Environment variables')} <small>{t('JSON object')}</small>
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
                        <h3>{t('Appearance')}</h3>
                      </div>
                    </div>
                    <label className="settings-field settings-section-space">
                      <span>{t('Language')}</span>
                      <Select aria-label={t('Language')} value={readLocalePreference()} disabled={locked}
                        onChange={(value) => {
                          saveLocalePreference(value as LocalePreference);
                          // The window reloads to apply the language; terminals reattach through the broker.
                          void (window.SessionBayReload?.() ?? Promise.resolve(window.location.reload())).catch(() => undefined);
                        }}
                        options={[{ value: 'system', label: t('Follow system language') }, { value: 'en', label: 'English' }, { value: 'zh-TW', label: '繁體中文' }]} />
                      <small className="settings-help">{t('Changing the language reloads the window; running terminals reconnect. Unsaved settings changes are discarded.')}</small>
                    </label>
                    <div className="settings-field settings-section-space">
                      <label id="app-zoom-label" htmlFor="app-zoom">{t('Workbench zoom')} <small>%</small></label>
                      <input id="app-zoom" type="number" min={50} max={200} step={10} aria-labelledby="app-zoom-label"
                        value={Number.isFinite(draft.appZoom ?? 100) ? (draft.appZoom ?? 100) : ''}
                        onChange={(event) => update('appZoom', event.target.value === '' ? Number.NaN : Number(event.target.value))}
                        aria-invalid={Boolean(errors.appZoom)} aria-describedby="app-zoom-error app-zoom-help" />
                      <FieldError id="app-zoom-error" message={errors.appZoom} />
                      <p className="settings-help" id="app-zoom-help">{workspaceZoomShortcutHelp}</p>
                      <button className="secondary" type="button" onClick={() => update('appZoom', 100)}>{t('Reset workbench zoom to 100%')}</button>
                    </div>
                    <ThemeControls value={appearanceOf(draft)} disabled={locked}
                      onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
                    <FieldError id="theme-error" message={errors.theme || errors.themePalette} />
                    <FieldError id="terminal-theme-error" message={errors.terminalTheme} />
                    <div className="settings-two-columns settings-section-space">
                      <label className="settings-field">
                        <span>
                          {t('Terminal font size')} <small>px</small>
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
                      </label>
                    </div>
                    <label className="settings-field">
                      <span>{t('Terminal font')}</span>
                      <input
                        value={draft.fontFamily}
                        onChange={(event) => update('fontFamily', event.target.value)}
                        placeholder="JetBrains Mono Variable, SFMono-Regular, monospace"
                        spellCheck={false}
                        aria-invalid={Boolean(errors.fontFamily)}
                        aria-describedby="font-family-error"
                      />
                      <FieldError id="font-family-error" message={errors.fontFamily} />
                      <span className="settings-help">
                        {t('Uses fonts installed on this computer; separate fallback fonts with commas.')}
                      </span>
                    </label>
                    <TerminalPreview value={appearanceOf(draft)} />
                    <div className="settings-section-heading settings-section-space" id="settings-history-sources">
                      <div>
                        <h3>{t('When starting new work')}</h3>
                      </div>
                    </div>
                    <div className="settings-two-columns">
                      <label className="settings-field">
                        <span>{t('Default agent')}</span>
                        <Select aria-label={t('Default agent')} value={draft.defaultAgent} disabled={locked}
                          onChange={(value) => update('defaultAgent', value as AgentKind)}
                          options={agentKinds.map((kind) => ({ value: kind, label: agentNames[kind], icon: <AgentIcon kind={kind} />, description: isAgentEnabled(draft, kind) ? undefined : t('Disabled; another enabled agent is used instead') }))} />
                        <FieldError id="default-agent-error" message={errors.defaultAgent} />
                      </label>
                      <label className="settings-field">
                        <span>{t('Default shell profile')}</span>
                        <Select aria-label={t('Default shell profile')} value={draft.defaultProfileId} disabled={locked}
                          onChange={(value) => update('defaultProfileId', value)}
                          options={draft.profiles.map((profile) => ({ value: profile.id, label: profile.name || t('Untitled profile'), icon: <Terminal size={14} />, description: profile.executable }))} />
                        <FieldError id="default-profile-error" message={errors.defaultProfileId} />
                      </label>
                    </div>
                    <div className="settings-section-heading settings-section-space">
                      <div>
                        <h3>{t('System notifications')}</h3>
                      </div>
                    </div>
                    <label className="settings-check">
                      <input type="checkbox" className="checkbox" checked={draft.systemNotifications !== false} disabled={locked}
                        onChange={(event) => update('systemNotifications', event.currentTarget.checked)} />
                      <span>{t('Send a system notification when an agent needs attention')}</span>
                      <small>{t('Only notifies when the work is not on screen or the window is in the background: when it waits for input or permission, finishes or fails.')}</small>
                    </label>
                    <div className="settings-section-heading settings-section-space">
                      <div>
                        <h3>{t('Updates')}</h3>
                      </div>
                    </div>
                    <label className="settings-check">
                      <input type="checkbox" className="checkbox" checked={draft.updateChecks !== false} disabled={locked}
                        onChange={(event) => update('updateChecks', event.currentTarget.checked)} />
                      <span>{t('Check GitHub for new versions')}</span>
                      <small>{t('Asks GitHub Releases for the newest version at startup and once a day, and shows a notice when one is available. No personal data is sent; updates are never installed automatically.')}</small>
                    </label>
                  </>
                )}

                {section === 'shortcuts' && (
                  <>
                    <div className="settings-section-heading">
                      <div>
                        <h3>{t('Keyboard shortcuts')}</h3>
                        <p>{t('Mod means ⌘ on macOS and Ctrl on Linux.')}</p>
                      </div>
                    </div>
                    <div className="settings-shortcut-notice">
                      <Keyboard size={17} />
                      <p>
                        {t('For example Mod+Shift+T. Leave it empty to disable a shortcut. Conflicts show below; avoid combinations used by terminal programs and the OS.')}
                      </p>
                    </div>
                    <p className="settings-help">{workspaceTabShortcutHelp} {t('These reserved combinations are not sent to the terminal, and are not captured while composing text or inside dialogs. The old "Next pane" default is now Mod+Alt+ArrowDown.')}</p>
                    {!Object.keys(draft.shortcuts).length && (
                      <div className="settings-empty">
                        <Keyboard size={24} />
                        <strong>{t('Using the app\'s default shortcuts')}</strong>
                        <p>{t('No custom shortcuts yet.')}</p>
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
            {(operationError || (showErrors && Object.keys(prepared.errors).length > 0) || onboarding || dirty) && <div className="settings-footer-status" role={operationError ? 'alert' : 'status'}>
              {operationError ? (
                <span className="settings-field-error">
                  <CircleAlert size={15} />
                  {operationError}
                </span>
              ) : showErrors && Object.keys(prepared.errors).length ? (
                <span className="settings-field-error">
                  <CircleAlert size={15} />
                  {t('Fix the marked fields before saving.')}
                </span>
              ) : (
                <span>
                  {onboarding
                    ? t('You can come back to Settings any time.')
                    : t('You have unsaved changes')}
                </span>
              )}
            </div>}
            <button
              type="button"
              className="settings-button secondary"
              onClick={close}
              disabled={locked}
            >
              {onboarding ? t('Set up later') : t('Cancel')}
            </button>
            <button type="submit" className="settings-button primary" disabled={locked}>
              {locked ? (
                <LoaderCircle size={16} className="settings-spinning" />
              ) : onboarding ? (
                <ChevronRight size={16} />
              ) : (
                <Check size={16} />
              )}
              {locked ? t('Working…') : onboarding ? t('Save and start scanning') : t('Save settings')}
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
                {confirmation === 'clear' ? t('Clear the local search index?') : t('Discard unsaved changes?')}
              </h3>
              <p id="settings-confirm-description">
                {confirmation === 'clear'
                  ? t('Only the index that Session Bay built is deleted. Original agent conversations, source files, projects and settings are not modified, and the recycle bin is kept. You can rescan to rebuild the index.')
                  : t('The settings you just edited will not be kept. You can go back and keep editing.')}
              </p>
              <div className="settings-confirm-actions">
                <button
                  type="button"
                  className="settings-button secondary"
                  onClick={() => setConfirmation(null)}
                >
                  {t('Back')}
                </button>
                <button
                  type="button"
                  className="settings-button danger-fill"
                  data-dialog-confirm
                  disabled={locked || (confirmation === 'clear' && index.running)}
                  onClick={() => {
                    if (locked || operationInFlight.current) return;
                    if (confirmation === 'discard') {
                      setConfirmation(null);
                      onClose();
                    } else if (!index.running) {
                      setConfirmation(null);
                      void run(onClearIndex);
                    }
                  }}
                >
                  {confirmation === 'clear' ? t('Yes, clear index') : t('Discard changes')}
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
