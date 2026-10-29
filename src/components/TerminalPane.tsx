import { followTerminalResize } from '../terminal-resize-follow';
import { ResponsiveControls } from './ResponsiveControls';
import { isAgentHooksEnabled } from '../settings';
import { fitTerminal } from '../terminal-fit';
import { useRuntimeActivity } from './RuntimeActivity';
import { bufferTail, registerTerminalTail } from '../terminal-tail';
import { PaneRuntimeStatus } from './PaneRuntimeStatus';
import { agentLifecycleText, isAgentPane } from '../agent-status';
import './agent-status.css';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  Copy,
  FileText,
  Pencil,
  Maximize2,
  Minimize2,
  Play,
  Search,
  Square,
  TerminalSquare,
  X,
  ClipboardPaste,
  SplitSquareHorizontal,
  SplitSquareVertical,
  GitBranch,
  Undo2,
} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { api, errorMessage } from '../api';
import { confirmAction } from '../confirmation';
import { TerminalInputQueue } from '../terminal-queue';
import { workspaceZoomEvent } from '../workspace-zoom';
import { fileInputChangesPrompt, fileLimits, fileProvider, fileUnsupportedReason, fileInputGuidance, insertFiles, hasDirectory, FileInputError, clipboardFileName, displayFileName } from '../file-input';
import { embeddedLinkLabel, fileLinkModifier, terminalFileLinkProvider, type TerminalFileOpen } from '../terminal-file-links';
import { handleTerminalKey } from '../terminal-keyboard';
import { TerminalImeCommitGuard } from '../terminal-ime';
import type { Pane, RuntimeInfo, Settings, TerminalEvent } from '../types';
interface Attachment {
  lease: string;
  id?: string;
  retry: number;
  ended: boolean;
  failed: boolean;
  ready: boolean;
  disconnected: boolean;
  lastSequence: number;
  lastAcknowledged: number;
  info?: RuntimeInfo;
}
import { effectiveTerminalTheme } from '../themes';
import { useResolvedColorMode } from '../use-ui-theme';

import { RenameDialog } from './RenameDialog';
import { hasBlockingDialog } from '../dialog-focus';
import { t } from '../i18n';
export function TerminalPane({
  pane,
  projectAvailable = true,
  settings,
  visible,
  activityVisible = visible,
  focused,
  maximized,
  onPatch,
  onFocus,
  onStart,
  onClose,
  onMaximize,
  onSplit,
  onAlreadyOpen,
  onOpenFileLink,
  identity,
  onMoveHome,
}: {
  pane: Pane;
  projectAvailable?: boolean;
  settings: Settings;
  visible: boolean;
  activityVisible?: boolean;
  focused: boolean;
  maximized: boolean;
  onPatch: (id: string, patch: Partial<Pane>) => void;
  onFocus: () => void;
  onStart: () => void;
  onClose: () => void;
  onMaximize: () => void;
  onSplit: (axis: 'horizontal' | 'vertical') => void;
  onAlreadyOpen: (runtime: RuntimeInfo) => void;
  onOpenFileLink?: (request: TerminalFileOpen) => void;
  /** Shown in mixed tabs: the pane's own project, always visible regardless of width. */
  identity?: { initials: string; name: string; color: string; branch?: string };
  onMoveHome?: () => void;
}) {
  const paneElement = useRef<HTMLElement>(null);
  const [minimalChrome, setMinimalChrome] = useState(false);
  const restoreChromeFocus = useRef(false);
  useLayoutEffect(() => {
    const element = paneElement.current;
    if (!element) return;
    const measure = () => {
      if (element.clientHeight > 0) {
        const next = element.clientHeight < 180;
        if (next !== element.classList.contains('minimal-chrome') &&
            document.activeElement instanceof Element && document.activeElement.closest('.pane-footer') &&
            element.contains(document.activeElement)) restoreChromeFocus.current = true;
        setMinimalChrome(next);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (!restoreChromeFocus.current) return;
    restoreChromeFocus.current = false;
    const element = paneElement.current;
    const footerButton = element?.querySelector<HTMLElement>('.pane-footer button');
    if (footerButton && !footerButton.closest('[hidden]')) footerButton.focus();
    else element?.querySelector<HTMLElement>('.compact-control-heading button')?.focus();
  }, [minimalChrome]);
  const activity = useRuntimeActivity();
  const colorMode = useResolvedColorMode(settings.theme);
  // Stable preset objects: identity only changes when the effective palette does.
  const terminalColors = effectiveTerminalTheme(settings, colorMode);
  useEffect(() => { activity?.visible(pane.id, activityVisible); }, [activity, pane.id, activityVisible]);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const search = useRef<SearchAddon | null>(null);
  const runtime = useRef<string | undefined>(undefined);
  const attachment = useRef<Attachment | null>(null);
  const renderQueue = useRef<Array<(done: () => void) => void>>([]);
  const rendering = useRef(false);
  const [reconnect, setReconnect] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const launched = useRef(0);
  const mounted = useRef(false);
  const latest = useRef({ pane, onPatch, onAlreadyOpen, visible, focused, activityVisible, onOpenFileLink, projectAvailable });
  latest.current = { pane, onPatch, onAlreadyOpen, visible, focused, activityVisible, onOpenFileLink, projectAvailable };
  const inputQueue = useRef<TerminalInputQueue | null>(null);
  const resizePending = useRef<{ id: string; cols: number; rows: number } | null>(null);
  const resizing = useRef(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const [notice, setNotice] = useState('');
  const actionPending = useRef(false);
  const fileStaging = useRef(false);
  const filePasting = useRef(false);
  const fileInput = useRef<(files: File[]) => void>(() => {});
  const fileDrop = useRef<(files: File[]) => void>(() => {});
  const canDropFiles = useRef<() => boolean>(() => false);
  const [confirming, setConfirming] = useState(false);
  const actionGeneration = useRef(0);
  useEffect(() => {
    actionGeneration.current += 1;
  }, [pane.id, pane.runtimeId, pane.startToken, pane.state, visible, focused, searchOpen, renameOpen]);
  const pendingFollow = useRef<ReturnType<typeof followTerminalResize>>(null);
  const cancelFollow = useCallback(() => { pendingFollow.current?.dispose(); pendingFollow.current = null; }, []);
  const fitNow = useCallback(() => {
    if (
      !latest.current.visible ||
      !host.current?.clientWidth ||
      !host.current.clientHeight ||
      !term.current
    )
      return;
    if (attachment.current && !attachment.current.ready) return;
    try {
      const t = term.current;
      const size = fit.current?.proposeDimensions();
      if (size && (size.cols !== t.cols || size.rows !== t.rows) && !pendingFollow.current?.active)
        pendingFollow.current = followTerminalResize(t);
      if (fit.current) fitTerminal(t, fit.current);
      // Keep renderer geometry within the broker's bounded screen allocation.
      if (t.cols > 320 || t.rows > 120) t.resize(Math.min(320, t.cols), Math.min(120, t.rows));
      pendingFollow.current?.resizeComplete();
      if (runtime.current && t.cols >= 2 && t.rows >= 1) {
        resizePending.current = { id: runtime.current, cols: t.cols, rows: t.rows };
        if (!resizing.current) {
          resizing.current = true;
          void (async () => {
            try {
              while (resizePending.current) {
                const next = resizePending.current;
                resizePending.current = null;
                await api.resize(next.id, next.cols, next.rows);
              }
            } catch (error) {
              if (mounted.current) setNotice(errorMessage(error));
            } finally {
              resizing.current = false;
            }
          })();
        }
      }
    } catch {
      pendingFollow.current?.dispose();
      /* A hidden webview can briefly report zero dimensions. */
    }
  }, []);
  useEffect(() => {
    if (!host.current) return;
    mounted.current = true;
    const queuedFrames = renderQueue.current;
    const terminal = new Terminal({
      // Matches the broker scrollback cap in broker/screen.rs.
      scrollback: 10000,
      // Claim every OSC8 range in the built-in priority provider, including
      // hostile schemes. Activation only reveals its real target; never navigate.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (event, target) => { if (fileLinkModifier(event)) setNotice(t('The embedded terminal link was not opened. Actual target: {{target}}', { target: embeddedLinkLabel(target) })); },
        hover: (_event, target) => { if (host.current) host.current.title = t('Embedded link (not opened): {{target}}', { target: embeddedLinkLabel(target) }); },
        leave: () => { if (host.current) host.current.title = ''; },
      },
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      theme: terminalColors,
      cursorBlink: true,
      allowProposedApi: false,
      convertEol: false,
      overviewRuler: { width: 0 },
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    const element = host.current;
    // Capture on the host runs before xterm's textarea listeners (see terminal-ime).
    const ime = new TerminalImeCommitGuard((data) => terminal.input(data, true));
    const compositionStart = (event: Event) => { if (event.target === terminal.textarea) ime.compositionStart(); };
    const compositionEnd = (event: CompositionEvent) => {
      if (event.target === terminal.textarea && ime.compositionEnd(event)) event.stopImmediatePropagation();
    };
    const imeInput = (event: Event) => {
      if (event.target === terminal.textarea && ime.input(event as InputEvent)) event.stopImmediatePropagation();
    };
    element.addEventListener('compositionstart', compositionStart, true);
    element.addEventListener('compositionend', compositionEnd, true);
    element.addEventListener('input', imeInput, true);
    const pasteFiles = (event: ClipboardEvent) => {
      if (event.target !== terminal.textarea || !event.clipboardData) return;
      if (hasDirectory(event.clipboardData.items)) {
        event.preventDefault(); event.stopImmediatePropagation(); setNotice(t('Folders are not supported and nothing was inserted; choose individual files.')); return;
      }
      const files = Array.from(event.clipboardData.items).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => !!file);
      if (!files.length) return; // Leave ordinary text and native CLI shortcuts unchanged.
      event.preventDefault();
      event.stopImmediatePropagation(); // xterm must not also insert the text representation.
      fileInput.current(files); // File metadata text is incidental; never also paste it.
    };
    const dragFiles = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = canDropFiles.current() ? 'copy' : 'none';
    };
    const dropFiles = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer.items && hasDirectory(event.dataTransfer.items)) { setNotice(t('Folders are not supported and nothing was inserted; choose individual files.')); return; }
      fileDrop.current(Array.from(event.dataTransfer.files));
    };
    element.addEventListener('paste', pasteFiles, true);
    element.addEventListener('dragover', dragFiles, true);
    element.addEventListener('drop', dropFiles, true);
    terminal.attachCustomKeyEventHandler((event) => {
      const current = latest.current;
      const active = attachment.current;
      if (!hasBlockingDialog() && ime.suppressXtermKey(event)) return false;
      return handleTerminalKey(event, {
        composing: ime.composing,
        blocked: hasBlockingDialog(),
        canInput: mounted.current && current.visible && current.focused && document.activeElement === terminal.textarea &&
          current.pane.state === 'running' && !!runtime.current && current.pane.runtimeId === runtime.current &&
          !!active?.ready && !active.ended && !active.disconnected,
        input: (data) => terminal.input(data, true),
      });
    });
    terminal.open(element);
    const links = terminal.registerLinkProvider(terminalFileLinkProvider(terminal,
      () => JSON.stringify([latest.current.pane.id, latest.current.pane.runtimeId, latest.current.pane.startToken, attachment.current?.lease]),
      request => {
        if (!latest.current.projectAvailable) { setNotice(t('This terminal has no usable project folder, so files in its output cannot be opened.')); return; }
        latest.current.onOpenFileLink?.(request);
      },
      text => { element.title = text; },
      () => mounted.current && latest.current.visible && !!latest.current.pane.runtimeId && !hasBlockingDialog()));
    term.current = terminal;
    const unregisterTail = registerTerminalTail(pane.id, lines => bufferTail(terminal.buffer.active, lines));
    fit.current = fitAddon;
    search.current = searchAddon;
    // OSC 52 must never read or mutate the clipboard from untrusted terminal output.
    const clipboardBlock = terminal.parser.registerOscHandler(52, () => true);
    inputQueue.current = new TerminalInputQueue(api.write, (error) => {
      if (mounted.current) setNotice(errorMessage(error));
    });
    const input = terminal.onData((data) => {
      // Input/Enter remains live while staging. Cancel its old prompt target first.
      // Standard Enter, unframed multiline input, Ctrl+C/D/Z/\ interrupt the prompt.
      // Printable typing remains in the same prompt; do not buffer or replay input.
      if (actionPending.current && !filePasting.current && fileInputChangesPrompt(data)) {
        actionGeneration.current += 1;
        if (fileStaging.current) setNotice(t('File preparation was cancelled: the current input was sent or interrupted, so files not yet inserted will not be added to the next message.'));
      }
      if (runtime.current) inputQueue.current?.enqueue(runtime.current, data);
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitNow);
    });
    observer.observe(host.current);
    const zoomed = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fitNow); };
    window.addEventListener(workspaceZoomEvent, zoomed);
    fitNow();
    return () => {
      mounted.current = false;
      const current = attachment.current;
      attachment.current = null;
      if (current) activity?.remove(pane.id, current.lease);
      runtime.current = undefined;
      inputQueue.current?.cancel();
      resizePending.current = null;
      if (current?.id) void api.detach(current.id, current.lease).catch(() => undefined);
      // Any queued frames acknowledge their own obsolete lease without repainting.
      for (const frame of queuedFrames.splice(0)) frame(() => undefined);
      observer.disconnect();
      window.removeEventListener(workspaceZoomEvent, zoomed);
      cancelAnimationFrame(frame);
      input.dispose();
      element.removeEventListener('compositionstart', compositionStart, true);
      element.removeEventListener('compositionend', compositionEnd, true);
      element.removeEventListener('input', imeInput, true);
      element.removeEventListener('paste', pasteFiles, true);
      element.removeEventListener('dragover', dragFiles, true);
      element.removeEventListener('drop', dropFiles, true);
      clipboardBlock.dispose();
      links.dispose();
      cancelFollow();
      unregisterTail();
      terminal.dispose();
      term.current = null;
    };
    // Terminal instances live for the pane lifetime; appearance updates below do not remount them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const terminal = term.current;
    if (!visible || !terminal) { cancelFollow(); return; }
    let pending = true;
    // A hidden xterm renderer defers its rounded cell measurements until it
    // paints again. Reconcile once after that first ready render, rather than
    // repeatedly fitting output frames or guessing when its renderer resumes.
    const rendered = terminal.onRender(() => {
      if (!pending || !mounted.current || term.current !== terminal || !latest.current.visible ||
          !attachment.current?.ready || !host.current?.clientWidth || !host.current.clientHeight) return;
      pending = false;
      rendered.dispose(); // fit can itself render; consume the one-shot first
      fitNow();
    });
    return () => { pending = false; rendered.dispose(); };
  }, [visible, fitNow, cancelFollow]);
  useEffect(() => {
    if (term.current) {
      term.current.options.fontSize = settings.fontSize;
      term.current.options.fontFamily = settings.fontFamily;
      fitNow();
    }
  }, [settings.fontSize, settings.fontFamily, fitNow]);
  useEffect(() => {
    // Colors never resize, reset, refocus or reconnect a running terminal.
    if (term.current) term.current.options.theme = terminalColors;
  }, [terminalColors]);
  const previousHookOptIn = useRef(pane.kind !== 'shell' && isAgentHooksEnabled({ agentHooks: settings.agentHooks }, pane.kind));
  useEffect(() => {
    const enabled = pane.kind !== 'shell' && isAgentHooksEnabled({ agentHooks: settings.agentHooks }, pane.kind);
    if (previousHookOptIn.current && !enabled) activity?.revokeAgent(pane.id);
    previousHookOptIn.current = enabled;
  }, [settings.agentHooks, pane.kind, pane.id, activity]);

  useEffect(() => {
    if (visible) {
      const scheduledFrom = document.activeElement;
      const frame = requestAnimationFrame(() => {
        fitNow();
        // Do not steal focus acquired by a modal or another control after scheduling.
        if (focused && pane.state !== 'placeholder' && !hasBlockingDialog() && document.activeElement === scheduledFrom) term.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [visible, focused, fitNow, pane.state]);
  useEffect(() => {
    const token = pane.startToken ?? 0;
    // A remounted component must attach its recorded runtime, never replay an old start action.
    if (!attachment.current && pane.runtimeId) launched.current = Math.max(launched.current, token);
    const starting = token > launched.current;
    if (!term.current || (!starting && (!pane.runtimeId || pane.state === 'interrupted'))) return;
    const previous = attachment.current;
    if (!starting && previous && previous.id === pane.runtimeId && previous.retry === reconnect) return;
    if (starting) launched.current = token;
    if (previous?.id) void api.detach(previous.id, previous.lease).catch(() => undefined);
    const active: Attachment = {
      lease: crypto.randomUUID(), id: starting ? undefined : pane.runtimeId,
      retry: reconnect, ended: false, failed: !starting && pane.state === 'failed',
      ready: false, disconnected: false, lastSequence: -1, lastAcknowledged: -1,
    };
    attachment.current = active;
    activity?.begin(pane.id, active.lease, active.id, latest.current.activityVisible, starting || !['exited', 'failed', 'interrupted'].includes(pane.state));
    runtime.current = undefined;
    inputQueue.current?.cancel();
    resizePending.current = null;
    setConnecting(true);
    setConnected(false);
    setNotice('');
    const current = () => mounted.current && attachment.current === active;
    const terminal = term.current;
    const ack = (event: Extract<TerminalEvent, { sequence: number }>) => {
      void api.ack(event.runtimeId, event.sequence, active.lease).catch((error) => {
        if (current()) setNotice(errorMessage(error));
      });
    };
    const enableInput = () => {
      if (!current() || !active.ready || !active.info || active.ended || active.disconnected) return;
      if (['running', 'starting'].includes(active.info.state)) runtime.current = active.id;
      setConnecting(false);
      setConnected(true);
      fitNow();
    };
    const drain = () => {
      if (rendering.current) return;
      const next = renderQueue.current.shift();
      if (!next) return;
      rendering.current = true;
      next(() => { rendering.current = false; drain(); });
    };
    const onEvent = (event: TerminalEvent) => {
      if (!current() || (active.id && active.id !== event.runtimeId)) {
        if (event.type === 'output' || event.type === 'snapshot') ack(event);
        return;
      }
      active.id = event.runtimeId;
      activity?.bind(pane.id, active.lease, event.runtimeId);
      if (event.type === 'terminalStatus') {
        if (pane.kind !== 'shell' && (!active.ended || event.status === 'done' || event.status === 'error') && !active.disconnected) activity?.observeTerminal(pane.id, active.lease, event);
        return;
      }
      if (event.type === 'agentActivity') {
        if (pane.kind !== 'shell' && !active.ended && !active.disconnected) activity?.observe(pane.id, active.lease, event);
        return;
      }
      if (event.type === 'output' || event.type === 'snapshot') {
        if (event.sequence <= active.lastSequence) {
          if (event.sequence <= active.lastAcknowledged) ack(event);
          return;
        }
        active.lastSequence = event.sequence;
        if (event.type === 'snapshot') {
          active.ready = false;
          runtime.current = undefined;
          inputQueue.current?.cancel();
          resizePending.current = null;
          setConnected(false);
        }
        renderQueue.current.push((done) => {
          if (!current()) { ack(event); done(); return; }
          if (event.type === 'snapshot') {
            terminal.reset();
            terminal.resize(Math.min(320, Math.max(2, event.cols)), Math.min(120, Math.max(1, event.rows)));
            if (event.truncated) setNotice(t('The current terminal screen was restored; earlier output exceeded the retention limit and cannot be fully replayed.'));
          }
          terminal.write(new Uint8Array(event.data), () => {
            active.lastAcknowledged = Math.max(active.lastAcknowledged, event.sequence);
            ack(event);
            if (current() && event.type === 'output' && active.ready && !active.ended && !active.disconnected && event.data.length > 0)
              activity?.output(pane.id, active.lease, event.runtimeId, event.sequence);
            if (current() && event.type === 'snapshot') {
              activity?.ready(pane.id, active.lease);
              active.ready = true;
              setConnecting(false);
              enableInput();
            }
            done();
          });
        });
        drain();
      } else if (event.type === 'disconnected') {
        activity?.end(pane.id, active.lease);
        active.disconnected = true;
        inputQueue.current?.cancel();
        resizePending.current = null;
        runtime.current = undefined;
        active.ready = false;
        setConnecting(false);
        setConnected(false);
        setNotice(event.message);
        // A lost stream says nothing about whether the managed process is alive.
        const state = latest.current.pane.state;
        if (!active.ended && !['exited', 'failed', 'interrupted'].includes(state))
          latest.current.onPatch(pane.id, { state: 'disconnected', runtimeId: event.runtimeId });
      } else if (event.type === 'exit') {
        activity?.end(pane.id, active.lease, true);
        active.ended = true;
        inputQueue.current?.cancel();
        resizePending.current = null;
        runtime.current = undefined;
        setConnecting(false);
        setConnected(false);
        latest.current.onPatch(pane.id, { runtimeId: event.runtimeId, state: active.failed ? 'failed' : 'exited', exitCode: event.exitCode });
      } else {
        activity?.end(pane.id, active.lease);
        active.failed = true;
        active.ended = true;
        inputQueue.current?.cancel();
        resizePending.current = null;
        runtime.current = undefined;
        setConnecting(false);
        setConnected(false);
        latest.current.onPatch(pane.id, { state: 'failed', error: event.message });
      }
    };
    if (starting) {
      onPatch(pane.id, { state: 'starting', error: undefined, runtimeId: undefined, exitCode: undefined });
      fitNow();
    }
    const task = starting
      ? api.launch({ paneId: pane.id, kind: pane.kind,
        projectId: projectAvailable ? pane.projectId ?? undefined : undefined, sessionId: pane.sessionId,
        resumeId: pane.resumeId, cwd: pane.projectId === null && pane.kind === 'shell' && pane.homeDirectory === true ? undefined : pane.cwd || undefined, profileId: pane.profileId,
        cols: Math.min(320, Math.max(2, terminal.cols)), rows: Math.min(120, Math.max(1, terminal.rows)),
      }, onEvent, active.lease)
      : api.attach(pane.runtimeId!, onEvent, active.lease);
    void task.then((info) => {
      if (!current()) {
        // A duplicate-session response belongs to another pane's attachment.
        if (info.paneId === pane.id) void api.detach(info.id, active.lease).catch(() => undefined);
        return;
      }
      if (info.paneId !== pane.id) {
        activity?.end(pane.id, active.lease);
        active.ended = true;
        setConnecting(false);
        latest.current.onAlreadyOpen(info);
        return;
      }
      activity?.bind(pane.id, active.lease, info.id);
      active.id = info.id;
      active.info = info;
      if (active.disconnected) {
        const ended = ['exited', 'failed', 'interrupted'].includes(info.state);
        if (ended && !active.ended) {
          active.ended = true;
          active.failed = info.state === 'failed';
          latest.current.onPatch(pane.id, { runtimeId: info.id, state: info.state as Pane['state'], exitCode: info.exitCode });
        } else latest.current.onPatch(pane.id, { runtimeId: info.id });
      } else if (!active.ended) {
        const state = ['starting', 'running', 'exited', 'failed', 'interrupted'].includes(info.state)
          ? info.state as Pane['state'] : 'disconnected';
        active.disconnected = state === 'disconnected';
        if (active.disconnected || ['exited', 'failed', 'interrupted'].includes(state)) setConnecting(false);
        active.ended = ['exited', 'failed', 'interrupted'].includes(state);
        active.failed = state === 'failed';
        if (active.ended || active.disconnected) activity?.end(pane.id, active.lease, active.ended && !active.disconnected);
        latest.current.onPatch(pane.id, { runtimeId: info.id, state, cwd: info.cwd, exitCode: info.exitCode, error: undefined });
        enableInput();
      } else latest.current.onPatch(pane.id, { runtimeId: info.id });
    }).catch((error) => {
      if (!current()) return;
      activity?.end(pane.id, active.lease);
      active.disconnected = true;
      inputQueue.current?.cancel();
      setConnecting(false);
      setConnected(false);
      runtime.current = undefined;
      if (active.id) void api.detach(active.id, active.lease).catch(() => undefined);
      if (starting) latest.current.onPatch(pane.id, {
        state: active.id ? 'disconnected' : 'failed', runtimeId: active.id, error: errorMessage(error),
      });
      else {
        setNotice(errorMessage(error));
        if (!['exited', 'failed', 'interrupted'].includes(latest.current.pane.state))
          latest.current.onPatch(pane.id, { state: 'disconnected' });
      }
    });
  }, [pane, projectAvailable, reconnect, fitNow, onPatch, activity]);
  const live = pane.state === 'running' || pane.state === 'starting';
  const copy = async () => {
    try {
      const text = term.current?.getSelection();
      if (text) await navigator.clipboard.writeText(text);
      else setNotice(t('Select the terminal text to copy first.'));
    } catch {
      setNotice(t('Cannot access the clipboard; use the system copy shortcut.'));
    }
  };
  const captureActionTarget = (requireFocus = true) => {
    const current = latest.current;
    const active = attachment.current;
    if (hasBlockingDialog() || !active?.ready || active.ended || active.disconnected || !mounted.current || !current.visible || (requireFocus && !current.focused) || current.pane.state !== 'running' ||
      !runtime.current || !term.current || current.pane.runtimeId !== runtime.current) return null;
    return { attachment: active, lease: active.lease, terminal: term.current, runtimeId: runtime.current, paneId: current.pane.id, kind: current.pane.kind,
      startToken: current.pane.startToken, launchToken: launched.current, generation: actionGeneration.current };
  };
  const targetIsCurrent = (target: NonNullable<ReturnType<typeof captureActionTarget>>) =>
    !hasBlockingDialog() && mounted.current && attachment.current === target.attachment && target.attachment.lease === target.lease &&
    target.attachment.ready && !target.attachment.ended && !target.attachment.disconnected && latest.current.visible && latest.current.focused && latest.current.pane.state === 'running' &&
    term.current === target.terminal && runtime.current === target.runtimeId &&
    latest.current.pane.id === target.paneId && latest.current.pane.kind === target.kind && latest.current.pane.runtimeId === target.runtimeId &&
    latest.current.pane.startToken === target.startToken && launched.current === target.launchToken &&
    actionGeneration.current === target.generation;
  const finishAction = () => {
    actionPending.current = false;
    if (mounted.current) setConfirming(false);
  };
  const insertLocalFiles = async (files: File[], target: NonNullable<ReturnType<typeof captureActionTarget>>) => {
    if (!target.terminal.modes.bracketedPasteMode) throw new Error(t('The agent has not enabled safe paste mode, so no files were inserted.'));
    fileStaging.current = true;
    setNotice(t('Preparing files; nothing is sent yet. You can keep typing; pressing Enter or interrupting cancels files not yet inserted.'));
    try {
      const renamed: string[] = [];
      const count = await insertFiles({ files, kind: target.kind, runtimeId: target.runtimeId, api,
        isCurrent: () => targetIsCurrent(target) && target.terminal.modes.bracketedPasteMode, onRenamed: (originalName, name) => { renamed.push(`${displayFileName(originalName)} → ${displayFileName(name)}`); }, paste: (text, markAttempted) => {
          if (!targetIsCurrent(target) || !target.terminal.modes.bracketedPasteMode) throw new Error(t('The file input target or safe paste mode changed.'));
          const queue = inputQueue.current;
          if (!queue || queue.pending + new TextEncoder().encode(text).length + 12 > queue.limit) throw new Error(t('The terminal input queue is full; not all file paths were inserted.'));
          filePasting.current = true;
          try { markAttempted(); target.terminal.paste(text); } finally { filePasting.current = false; }
        } });
      if (targetIsCurrent(target)) {
        setNotice(t('Added {{count}} file paths, not sent yet. ', { count }) + fileInputGuidance(fileProvider(target.kind)!, files.map((file) => file.name)) + (renamed.length ? t('File names were cleaned up (original → stored; long names are shortened): {{names}}.', { names: renamed.join(t('; ')) }) : ''));
        target.terminal.focus();
      }
    } finally { fileStaging.current = false; }
  };
  fileInput.current = (files) => {
    if (!fileProvider(latest.current.pane.kind)) { setNotice(fileUnsupportedReason(latest.current.pane.kind)); return; }
    const target = captureActionTarget();
    if (!target) { setNotice(t('Focus a connected agent pane before dropping or pasting files.')); return; }
    if (actionPending.current) { setNotice(t('A file or paste action is still in progress; please wait.')); return; }
    actionPending.current = true;
    setConfirming(true);
    void insertLocalFiles(files, target).catch((error) => {
      if (mounted.current) setNotice(`${errorMessage(error)}${error instanceof FileInputError && error.mayHaveInserted ? t(' Check the agent\'s input area to avoid adding things twice.') : ''}`);
    }).finally(finishAction);
  };
  canDropFiles.current = () => !!fileProvider(latest.current.pane.kind) && !!captureActionTarget(false) &&
    !!term.current?.modes.bracketedPasteMode && !actionPending.current;
  fileDrop.current = (files) => {
    if (!canDropFiles.current()) { fileInput.current(files); return; }
    const dropped = captureActionTarget(false);
    if (!dropped) return;
    // A drop explicitly selects this pane. Finish the React focus update before
    // capturing a new generation, without staging against an unfocused lease.
    if (!latest.current.focused) flushSync(() => onFocus());
    const selected = captureActionTarget();
    if (!selected || selected.paneId !== dropped.paneId || selected.runtimeId !== dropped.runtimeId ||
      selected.kind !== dropped.kind || selected.terminal !== dropped.terminal ||
      selected.attachment !== dropped.attachment || selected.lease !== dropped.lease ||
      selected.startToken !== dropped.startToken || selected.launchToken !== dropped.launchToken) {
      setNotice(t('The drop target is not focused or the connection changed, so no files were inserted. Focus this pane and try again.'));
      return;
    }
    selected.terminal.focus();
    fileInput.current(files);
  };
  const paste = async () => {
    const target = captureActionTarget();
    if (!target || actionPending.current) return;
    actionPending.current = true;
    setConfirming(true);
    try {
      let text: string;
      if (latest.current.pane.kind !== 'shell' && typeof navigator.clipboard.read === 'function') {
        const items = await navigator.clipboard.read();
        if (!targetIsCurrent(target)) return;
        const files: File[] = [];
        const textParts: string[] = [];
        let fileBytes = 0;
        const clipboardHasFiles = items.some((item) => item.types.some((type) => !type.startsWith('text/')));
        for (const item of items) {
          const mime = item.types.find((type) => !type.startsWith('text/'));
          if (mime) {
            if (!fileProvider(target.kind)) throw new Error(fileUnsupportedReason(target.kind));
            if (files.length >= fileLimits.count) throw new Error(t('You can add up to 4 files at a time.'));
            const blob = await item.getType(mime);
            if (!targetIsCurrent(target)) return;
            fileBytes += blob.size;
            if (blob.size > fileLimits.perFile || fileBytes > fileLimits.total) throw new Error(t('Each file can be at most 10 MiB, and 20 MiB in total.'));
            files.push(new File([blob], clipboardFileName(mime), { type: mime }));
          }
          if (!clipboardHasFiles && item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            if (!targetIsCurrent(target)) return;
            textParts.push(await blob.text());
            if (!targetIsCurrent(target)) return;
          }
        }
        if (files.length) {
          await insertLocalFiles(files, target);
          return;
        }
        text = textParts.join('');
      } else {
        text = await navigator.clipboard.readText();
      }
      if (!targetIsCurrent(target)) return;
      if (/[\r\n]/.test(text) && !await confirmAction(t('The pasted text has multiple lines and may run commands immediately. Paste anyway?'))) return;
      if (!targetIsCurrent(target)) return;
      target.terminal.paste(text);
      target.terminal.focus();
    } catch (error) {
      if (mounted.current) setNotice(`${errorMessage(error)}${error instanceof FileInputError && error.mayHaveInserted ? t(' Check the agent\'s input area to avoid adding things twice.') : ''}`);
    } finally {
      finishAction();
    }
  };
  const stop = async () => {
    const target = captureActionTarget();
    if (!target || actionPending.current) return;
    actionPending.current = true;
    setConfirming(true);
    try {
      if (!await confirmAction(t('End the managed process of "{{title}}"? The last screen is kept.', { title: latest.current.pane.title }))) return;
      if (!targetIsCurrent(target)) return;
      await api.stop(target.runtimeId);
    } catch (error) {
      if (targetIsCurrent(target)) setNotice(errorMessage(error));
    } finally {
      finishAction();
    }
  };
  const paneMetadata = (<div className="pane-meta">
        <span title={pane.cwd}>{pane.cwd || t('No folder specified')}</span>
        <PaneRuntimeStatus pane={pane} connecting={connecting} />
      </div>);
  const paneFooter = (pane.state !== 'placeholder' && (
        <div className="pane-footer">
          <span>
            {pane.sessionId
              ? `Session ${pane.sessionId.slice(-12)}`
              : pane.kind === 'shell'
                ? t('Plain shell · not linked to an agent')
                : t('New agent work')}
          </span>
          {pane.state === 'disconnected' ? (
            <button disabled={connecting} onClick={() => setReconnect((value) => value + 1)}>{t('Reconnect')}</button>
          ) : live ? (
            <button
              disabled={pane.state === 'starting' || !connected || confirming}
              onClick={() => void stop()}
            >
              <Square size={11} />
              {t('Stop')}
            </button>
          ) : (
            <button onClick={onStart}>
              <Play size={12} />
              {t('Restart')}
            </button>
          )}
        </div>
      ));
  return (
    <section ref={paneElement}
      className={`terminal-pane ${focused ? 'focused' : ''}${minimalChrome ? ' minimal-chrome' : ''}${identity ? ' mixed-pane' : ''}`}
      style={identity ? { ['--pane-project' as string]: identity.color } : undefined}
      aria-label={identity ? t('{{project}} · {{title}} terminal pane', { project: identity.name, title: pane.title }) : t('{{title}} terminal pane', { title: pane.title })}
      onWheelCapture={cancelFollow}
      onKeyDownCapture={event => {
        if (event.shiftKey && ['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) cancelFollow();
      }}
      onPointerDown={event => {
        if (event.target instanceof Element && event.target.closest('.scrollbar')) cancelFollow();
        onFocus();
      }}
      onFocusCapture={(event) => {
        // Keyboard navigation into xterm must own the pane just like a pointer click.
        if (!focused && visible && mounted.current && !hasBlockingDialog() && event.target === term.current?.textarea) onFocus();
      }}
    >
      <div className="pane-toolbar">
        <div className="pane-title">
          {identity ? <span className="pane-identity" title={`${identity.name}${identity.branch ? ` · ${identity.branch}` : ''}`}>
            <span className="project-initials" aria-hidden="true">{identity.initials}</span>
            <span className="pane-project">{identity.name}</span>
            {identity.branch && <span className="pane-branch"><GitBranch size={11} aria-hidden="true" />{identity.branch}</span>}
          </span> : <TerminalSquare size={14} />}
          <strong title={pane.title}>{pane.title}</strong>
          {/* Reserve the badge slot so pointerdown focus cannot move toolbar actions before click. */}
          <span className="focus-label" style={{ visibility: focused ? undefined : 'hidden' }} aria-hidden={!focused}>{t('Focus')}</span>
          <span className={`runtime-dot ${pane.state}`} />
          {minimalChrome && <PaneRuntimeStatus pane={pane} connecting={connecting} />}
          {isAgentPane(pane) && pane.state !== 'running' && <span className={`agent-lifecycle ${pane.state}`} title={agentLifecycleText(pane.state)}>{agentLifecycleText(pane.state)}</span>}
        </div>
        <ResponsiveControls label={t('Pane options {{title}}', { title: pane.title })} narrowWidth={600} forceCompact={minimalChrome} closeOnAction>
        <div className="pane-actions">
          {onMoveHome && identity && <button className="icon-button" title={t('Move back to {{project}}', { project: identity.name })} aria-label={t('Move back to {{project}}: {{title}}', { project: identity.name, title: pane.title })}
            onClick={onMoveHome}><Undo2 size={14} /></button>}
          <button className="icon-button" title={t('Rename pane')} aria-label={t('Rename pane {{title}}', { title: pane.title })} onClick={(event) => { event.currentTarget.focus(); setRenameOpen(true); }}><Pencil size={14} /></button>
          <button
            className="icon-button"
            title={t('Search terminal text')}
            aria-label={t('Search terminal text')}
            onClick={() => { cancelFollow(); setSearchOpen(!searchOpen); }}
          >
            <Search size={14} />
          </button>
          <button
            className="icon-button"
            title={t('Copy selected text')}
            aria-label={t('Copy selected text')}
            onClick={() => void copy()}
          >
            <Copy size={14} />
          </button>
          <button className="icon-button" title={t('Open the selected file path, or type a path')} aria-label={t('Open terminal file path')}
            disabled={!onOpenFileLink || !pane.runtimeId || !projectAvailable}
            onClick={() => { if (!hasBlockingDialog()) onOpenFileLink?.({ text: term.current?.getSelection() ?? '', autoResolve: false }); }}><FileText size={14} /></button>
          <button
            className="icon-button"
            title={t('Paste')}
            aria-label={t('Paste')}
            disabled={!live || !connected || confirming}
            onClick={() => void paste()}
          >
            <ClipboardPaste size={14} />
          </button>
          <button
            className="icon-button"
            title={t('Split left and right')}
            aria-label={t('Split left and right')}
            onClick={() => onSplit('horizontal')}
          >
            <SplitSquareHorizontal size={14} />
          </button>
          <button
            className="icon-button"
            title={t('Split top and bottom')}
            aria-label={t('Split top and bottom')}
            onClick={() => onSplit('vertical')}
          >
            <SplitSquareVertical size={14} />
          </button>
          <button
            className="icon-button"
            title={maximized ? t('Restore pane') : t('Maximize pane')}
            aria-label={maximized ? t('Restore pane') : t('Maximize pane')}
            onClick={() => {
              // A restored narrow toolbar must not reopen solely to retain this action's focus.
              term.current?.focus();
              onMaximize();
            }}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-button" title={t('Close pane')} aria-label={t('Close pane')} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {minimalChrome && <>{paneMetadata}{paneFooter}</>}
        </ResponsiveControls>
      </div>
      {!minimalChrome && paneMetadata}
      {renameOpen && <RenameDialog title={t('Rename pane')} name={pane.title}
        description={t('Only changes the pane\'s display name; the running process, terminal output and working directory are kept.')}
        onClose={() => setRenameOpen(false)} onSave={(title) => onPatch(pane.id, { title })} />}
      {searchOpen && (
        <form
          className="terminal-search search-field"
          onSubmit={(event) => {
            event.preventDefault();
            cancelFollow(); search.current?.findNext(needle);
          }}
        >
          <Search size={14} />
          <input
            aria-label={t('Terminal search')}
            autoFocus
            value={needle}
            onChange={(event) => {
              cancelFollow();
              setNeedle(event.target.value);
              search.current?.findNext(event.target.value, { incremental: true });
            }}
          />
          <button type="button" onClick={() => { cancelFollow(); search.current?.findPrevious(needle); }}>
            {t('Previous')}
          </button>
          <button type="submit">{t('Next')}</button>
          <button type="button" aria-label={t('Close terminal search')} onClick={() => { setSearchOpen(false); term.current?.focus(); }}>
            <X size={14} />
          </button>
        </form>
      )}
      {(pane.error || notice) && (
        <div className="pane-error" role="alert">
          {pane.error || notice}
          <button onClick={() => setNotice('')} aria-label={t('Close notice')}>
            <X size={12} />
          </button>
        </div>
      )}
      <div className="terminal-body" style={{ backgroundColor: terminalColors.background }}>
        <div className="xterm-host" ref={host} />
        {pane.state === 'placeholder' && (
          <div className="terminal-placeholder">
            <TerminalSquare size={30} />
            <h3>{t('Workspace ready')}</h3>
            <p>{t('Your last layout was restored. Processes start only when you choose to continue.')}</p>
            <button className="primary" onClick={onStart}>
              <Play size={15} />
              {pane.kind === 'shell'
                ? t('Reopen shell')
                : pane.sessionId
                  ? t('Resume session')
                  : t('Start agent work')}
            </button>
          </div>
        )}
      </div>
      {!minimalChrome && paneFooter}
    </section>
  );
}
