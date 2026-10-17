export type AgentKind = 'codex' | 'claude' | 'grok' | 'antigravity' | 'opencode';
export interface AgentOptions { extraArgs: string[]; bypassPermissions: boolean; }
export interface HistorySource {
  id: string;
  kind: AgentKind;
  root: string;
  enabled: boolean;
}
export interface HistorySourceCandidate {
  kind: AgentKind;
  root: string;
  status: 'found' | 'missing' | 'permissionDenied' | 'checkFailed';
  message?: string | null;
  configured: boolean;
  configuredSourceIds: string[];
}
export interface HistorySourceDiscovery {
  kind: AgentKind;
  supported: boolean;
  candidates: HistorySourceCandidate[];
  message?: string | null;
}
export interface ShellCandidate {
  name: string;
  executable: string;
}
export interface Installation {
  status?: 'missing' | 'available' | 'versionCheckFailed';
  loginStatus?: 'unknown';
  kind: AgentKind;
  executable: string | null;
  version: string | null;
  available: boolean;
  error: string | null;
}
export interface SourceHealth {
  sourceId: string;
  status: string;
  message: string | null;
  files: number;
}
export interface Project {
  workspaceOnly?: boolean;
  id: string;
  name: string;
  path: string | null;
  launchPath: string | null;
  exists: boolean;
  pinned: boolean;
  curated: boolean;
  sessionCount: number;
  updatedAt: string | null;
  agents: AgentKind[];
}
export interface Session {
  id: string;
  trashIdentity?: string | null;
  sourceId: string;
  kind: AgentKind;
  externalId: string;
  resumeDisabledReason?: string | null;
  projectId: string;
  title: string;
  cwd: string | null;
  updatedAt: string;
  timeSource: 'event' | 'mtime';
  archived: boolean;
  parentId: string | null;
  partial: boolean;
  snippet: string | null;
}
export interface SessionQuery {
  projectId?: string;
  kind?: AgentKind;
  query?: string;
  archived?: boolean;
  includeChildren?: boolean;
  after?: string;
  before?: string;
  offset?: number;
  limit?: number;
}
export interface SessionPage {
  items: Session[];
  total: number;
}
export interface TranscriptMessage {
  role: string;
  text: string;
  timestamp: string | null;
  line: number;
}
export interface TranscriptPage {
  snapshotId?: string | null;
  messages: TranscriptMessage[];
  hasMore: boolean;
  beforeLine: number | null;
  stale: boolean;
  warning: string | null;
}
export interface IndexStatus {
  revision?: number;
  running: boolean;
  processed: number;
  total: number;
  cancelled: boolean;
  errors: string[];
  sources: SourceHealth[];
}
export interface ShellProfile {
  id: string;
  name: string;
  executable: string;
  args: string[];
  env: Record<string, string>;
}
export interface Settings {
  version: 1;
  theme: 'dark' | 'light' | 'system';
  /** Optional for pre-palette version 1 settings; omitted means Bay. */
  themePalette?: string;
  terminalTheme: string;
  fontFamily: string;
  fontSize: number;
  /** Percentage; absent in older version 1 settings means 100. */
  appZoom?: number;
  /** Missing providers remain enabled; unknown keys survive settings round trips. */
  agentEnabled?: Record<string, boolean>;
  defaultAgent: AgentKind;
  defaultProfileId: string;
  profiles: ShellProfile[];
  sources: HistorySource[];
  executables: Record<AgentKind, string>;
  agentOptions: Record<AgentKind, AgentOptions>;
  shortcuts: Record<string, string>;
  onboardingComplete: boolean;
}
export interface Bootstrap {
  runtimes: RuntimeRecord[];
  settings: Settings;
  projects: Project[];
  installations: Installation[];
  index: IndexStatus;
  workspace: unknown;
  warnings: string[];
}
export interface LaunchRequest {
  paneId: string;
  kind: 'shell' | AgentKind;
  projectId?: string;
  sessionId?: string;
  resumeId?: string;
  cwd?: string;
  profileId?: string;
  cols: number;
  rows: number;
}
export interface LaunchPreview { executable: string; args: string[]; cwd: string; }
export interface RuntimeInfo {
  id: string;
  paneId: string;
  sessionId: string | null;
  state: string;
  cwd: string;
  exitCode: number | null;
}
export interface RuntimeRecord extends RuntimeInfo {
  /** Immutable broker launch provenance, never inferred from later session association. */
  resumedLaunch?: boolean;
  kind: 'shell' | AgentKind;
  projectId: string | null;
  profileId: string | null;
  resumeId: string | null;
  /** Broker-derived launch policy; absent on older explicit-cwd runtimes. */
  homeDirectory?: boolean;
}
export type TerminalEvent =
  | { type: 'snapshot'; runtimeId: string; sequence: number; data: number[]; cols: number; rows: number; truncated: boolean }
  | { type: 'disconnected'; runtimeId: string; message: string }
  | { type: 'output'; runtimeId: string; sequence: number; data: number[] }
  | { type: 'exit'; runtimeId: string; exitCode: number | null }
  | { type: 'error'; runtimeId: string; message: string };
export type PaneState = 'placeholder' | 'starting' | 'running' | 'exited' | 'failed' | 'disconnected' | 'interrupted';
export interface Pane {
  /** Current runtime launch provenance; intentionally not restored from saved layouts. */
  resumedLaunch?: boolean;
  id: string;
  kind: 'shell' | AgentKind;
  title: string;
  projectId: string | null;
  cwd: string;
  homeDirectory?: boolean;
  /** Comparison token only; never grants runtime attachment authority. */
  homePolicyRuntimeId?: string;
  sessionId?: string;
  resumeId?: string;
  profileId?: string;
  runtimeId?: string;
  state: PaneState;
  error?: string;
  exitCode?: number | null;
  startToken?: number;
}
export type LayoutNode =
  | { kind: 'pane'; paneId: string }
  | {
      kind: 'split';
      id: string;
      axis: 'horizontal' | 'vertical';
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
export interface WorkspaceTab {
  id: string;
  projectId: string | null;
  name: string;
  layout: LayoutNode;
  focusedPaneId: string;
}
export interface Workspace {
  version: 1;
  tabs: WorkspaceTab[];
  panes: Record<string, Pane>;
  activeTabByProject: Record<string, string>;
  activeTemporaryTabId?: string;
}

export interface TrashedSession {
  id: string;
  session: Session;
  sourceRoot: string;
  deletedAt: string;
  unavailableReason: string | null;
}
export interface TrashPage {
  items: TrashedSession[];
  total: number;
}
