import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  Copy,
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
} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { api, errorMessage } from '../api';
import { confirmAction } from '../confirmation';
import { TerminalInputQueue } from '../terminal-queue';
import { shouldHandleTerminalKey } from '../terminal-ime';
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
import { workspaceZoomEvent } from '../workspace-zoom';
import { terminalTheme } from '../themes';

import { RenameDialog } from './RenameDialog';
import { hasBlockingDialog } from '../dialog-focus';
export function TerminalPane({
  pane,
  projectAvailable = true,
  settings,
  visible,
  focused,
  maximized,
  onPatch,
  onFocus,
  onStart,
  onClose,
  onMaximize,
  onSplit,
  onAlreadyOpen,
}: {
  pane: Pane;
  projectAvailable?: boolean;
  settings: Settings;
  visible: boolean;
  focused: boolean;
  maximized: boolean;
  onPatch: (id: string, patch: Partial<Pane>) => void;
  onFocus: () => void;
  onStart: () => void;
  onClose: () => void;
  onMaximize: () => void;
  onSplit: (axis: 'horizontal' | 'vertical') => void;
  onAlreadyOpen: (runtime: RuntimeInfo) => void;
}) {
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
  const latest = useRef({ pane, onPatch, onAlreadyOpen, visible, focused });
  latest.current = { pane, onPatch, onAlreadyOpen, visible, focused };
  const inputQueue = useRef<TerminalInputQueue | null>(null);
  const resizePending = useRef<{ id: string; cols: number; rows: number } | null>(null);
  const resizing = useRef(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const [notice, setNotice] = useState('');
  const actionPending = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const actionGeneration = useRef(0);
  useEffect(() => {
    actionGeneration.current += 1;
  }, [pane.id, pane.runtimeId, pane.startToken, pane.state, visible, focused]);
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
      fit.current?.fit();
      const t = term.current;
      // Keep renderer geometry within the broker's bounded screen allocation.
      if (t.cols > 320 || t.rows > 120) t.resize(Math.min(320, t.cols), Math.min(120, t.rows));
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
      /* A hidden webview can briefly report zero dimensions. */
    }
  }, []);
  useEffect(() => {
    if (!host.current) return;
    mounted.current = true;
    const queuedFrames = renderQueue.current;
    const terminal = new Terminal({
      scrollback: 5000,
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      theme: terminalTheme(settings.terminalTheme),
      cursorBlink: true,
      allowProposedApi: false,
      convertEol: false,
      overviewRulerWidth: 0,
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.attachCustomKeyEventHandler(shouldHandleTerminalKey);
    terminal.open(host.current);
    term.current = terminal;
    fit.current = fitAddon;
    search.current = searchAddon;
    // OSC 52 must never read or mutate the clipboard from untrusted terminal output.
    const clipboardBlock = terminal.parser.registerOscHandler(52, () => true);
    inputQueue.current = new TerminalInputQueue(api.write, (error) => {
      if (mounted.current) setNotice(errorMessage(error));
    });
    const input = terminal.onData((data) => {
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
      clipboardBlock.dispose();
      terminal.dispose();
      term.current = null;
    };
    // Terminal instances live for the pane lifetime; appearance updates below do not remount them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (term.current) {
      term.current.options.fontSize = settings.fontSize;
      term.current.options.fontFamily = settings.fontFamily;
      fitNow();
    }
  }, [settings.fontSize, settings.fontFamily, fitNow]);
  useEffect(() => {
    // Colors never resize, reset, refocus or reconnect a running terminal.
    if (term.current) term.current.options.theme = terminalTheme(settings.terminalTheme);
  }, [settings.terminalTheme]);
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
            if (event.truncated) setNotice('已恢復目前終端畫面；較早輸出超過保留上限，無法完整回放。');
          }
          terminal.write(new Uint8Array(event.data), () => {
            active.lastAcknowledged = Math.max(active.lastAcknowledged, event.sequence);
            ack(event);
            if (current() && event.type === 'snapshot') {
              active.ready = true;
              setConnecting(false);
              enableInput();
            }
            done();
          });
        });
        drain();
      } else if (event.type === 'disconnected') {
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
        active.ended = true;
        inputQueue.current?.cancel();
        resizePending.current = null;
        runtime.current = undefined;
        setConnecting(false);
        setConnected(false);
        latest.current.onPatch(pane.id, { state: active.failed ? 'failed' : 'exited', exitCode: event.exitCode });
      } else {
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
        active.ended = true;
        setConnecting(false);
        latest.current.onAlreadyOpen(info);
        return;
      }
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
        latest.current.onPatch(pane.id, { runtimeId: info.id, state, cwd: info.cwd, exitCode: info.exitCode, error: undefined });
        enableInput();
      } else latest.current.onPatch(pane.id, { runtimeId: info.id });
    }).catch((error) => {
      if (!current()) return;
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
  }, [pane, projectAvailable, reconnect, fitNow, onPatch]);
  const live = pane.state === 'running' || pane.state === 'starting';
  const copy = async () => {
    try {
      const text = term.current?.getSelection();
      if (text) await navigator.clipboard.writeText(text);
      else setNotice('請先選取要複製的終端文字。');
    } catch {
      setNotice('無法存取剪貼簿，請使用系統複製快捷鍵。');
    }
  };
  const captureActionTarget = () => {
    const current = latest.current;
    const active = attachment.current;
    if (!active?.ready || active.ended || active.disconnected || !mounted.current || !current.visible || !current.focused || current.pane.state !== 'running' ||
      !runtime.current || !term.current || current.pane.runtimeId !== runtime.current) return null;
    return { attachment: active, lease: active.lease, terminal: term.current, runtimeId: runtime.current, paneId: current.pane.id,
      startToken: current.pane.startToken, launchToken: launched.current, generation: actionGeneration.current };
  };
  const targetIsCurrent = (target: NonNullable<ReturnType<typeof captureActionTarget>>) =>
    mounted.current && attachment.current === target.attachment && target.attachment.lease === target.lease &&
    target.attachment.ready && !target.attachment.ended && !target.attachment.disconnected && latest.current.visible && latest.current.focused && latest.current.pane.state === 'running' &&
    term.current === target.terminal && runtime.current === target.runtimeId &&
    latest.current.pane.id === target.paneId && latest.current.pane.runtimeId === target.runtimeId &&
    latest.current.pane.startToken === target.startToken && launched.current === target.launchToken &&
    actionGeneration.current === target.generation;
  const finishAction = () => {
    actionPending.current = false;
    if (mounted.current) setConfirming(false);
  };
  const paste = async () => {
    const target = captureActionTarget();
    if (!target || actionPending.current) return;
    actionPending.current = true;
    setConfirming(true);
    try {
      const text = await navigator.clipboard.readText();
      if (!targetIsCurrent(target)) return;
      if (/[\r\n]/.test(text) && !await confirmAction('貼上的內容含多行，可能立即執行指令。確定貼上？')) return;
      if (!targetIsCurrent(target)) return;
      target.terminal.paste(text);
      target.terminal.focus();
    } catch {
      if (targetIsCurrent(target)) setNotice('無法讀取剪貼簿，請使用系統貼上快捷鍵。');
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
      if (!await confirmAction(`結束「${latest.current.pane.title}」的受管程序？最後畫面將保留。`)) return;
      if (!targetIsCurrent(target)) return;
      await api.stop(target.runtimeId);
    } catch (error) {
      if (targetIsCurrent(target)) setNotice(errorMessage(error));
    } finally {
      finishAction();
    }
  };
  return (
    <section
      className={`terminal-pane ${focused ? 'focused' : ''}`}
      aria-label={`${pane.title} 終端面板`}
      onPointerDown={onFocus}
    >
      <div className="pane-toolbar">
        <div className="pane-title">
          <TerminalSquare size={14} />
          <strong title={pane.title}>{pane.title}</strong>
          {focused && <span className="focus-label">焦點</span>}
          <span className={`runtime-dot ${pane.state}`} />
        </div>
        <div className="pane-actions">
          <button className="icon-button" title="重新命名面板" aria-label={`重新命名面板 ${pane.title}`} onClick={(event) => { event.currentTarget.focus(); setRenameOpen(true); }}><Pencil size={14} /></button>
          <button
            className="icon-button"
            title="搜尋終端文字"
            aria-label="搜尋終端文字"
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <Search size={14} />
          </button>
          <button
            className="icon-button"
            title="複製選取文字"
            aria-label="複製選取文字"
            onClick={() => void copy()}
          >
            <Copy size={14} />
          </button>
          <button
            className="icon-button"
            title="貼上"
            aria-label="貼上"
            disabled={!live || !connected || confirming}
            onClick={() => void paste()}
          >
            <ClipboardPaste size={14} />
          </button>
          <button
            className="icon-button"
            title="左右分割"
            aria-label="左右分割"
            onClick={() => onSplit('horizontal')}
          >
            <SplitSquareHorizontal size={14} />
          </button>
          <button
            className="icon-button"
            title="上下分割"
            aria-label="上下分割"
            onClick={() => onSplit('vertical')}
          >
            <SplitSquareVertical size={14} />
          </button>
          <button
            className="icon-button"
            title={maximized ? '還原面板' : '最大化面板'}
            aria-label={maximized ? '還原面板' : '最大化面板'}
            onClick={onMaximize}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button className="icon-button" title="關閉面板" aria-label="關閉面板" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="pane-meta">
        <span title={pane.cwd}>{pane.cwd || '未指定目錄'}</span>
        <span>
          {connecting ? (pane.state === 'starting' ? '正在啟動終端…' : '正在重新附接終端…') : pane.state === 'disconnected' ? '連線中斷 · 程序狀態待確認' : pane.state === 'interrupted' ? '背景程序已中斷' : pane.state === 'running'
            ? pane.sessionId
              ? '已啟動，待確認 Session'
              : '執行中'
            : pane.state === 'starting'
              ? '啟動中…'
              : pane.state === 'exited'
                ? `已退出 · ${pane.exitCode ?? '未知結束碼'}`
                : pane.state === 'failed'
                  ? '啟動／執行失敗'
                  : '已還原布局'}
        </span>
      </div>
      {renameOpen && <RenameDialog title="重新命名面板" name={pane.title}
        description="只修改面板顯示名稱，保留執行中的程序、終端輸出與工作目錄。"
        onClose={() => setRenameOpen(false)} onSave={(title) => onPatch(pane.id, { title })} />}
      {searchOpen && (
        <form
          className="terminal-search search-field"
          onSubmit={(event) => {
            event.preventDefault();
            search.current?.findNext(needle);
          }}
        >
          <Search size={14} />
          <input
            aria-label="終端搜尋"
            autoFocus
            value={needle}
            onChange={(event) => {
              setNeedle(event.target.value);
              search.current?.findNext(event.target.value, { incremental: true });
            }}
          />
          <button type="button" onClick={() => search.current?.findPrevious(needle)}>
            上一個
          </button>
          <button type="submit">下一個</button>
          <button type="button" aria-label="關閉終端搜尋" onClick={() => setSearchOpen(false)}>
            <X size={14} />
          </button>
        </form>
      )}
      {(pane.error || notice) && (
        <div className="pane-error" role="alert">
          {pane.error || notice}
          <button onClick={() => setNotice('')} aria-label="關閉通知">
            <X size={12} />
          </button>
        </div>
      )}
      <div className="terminal-body">
        <div className="xterm-host" ref={host} />
        {pane.state === 'placeholder' && (
          <div className="terminal-placeholder">
            <TerminalSquare size={30} />
            <h3>工作區已就位</h3>
            <p>上次布局已還原。選擇接續後才會啟動程序。</p>
            <button className="primary" onClick={onStart}>
              <Play size={15} />
              {pane.kind === 'shell'
                ? '重新開啟 Shell'
                : pane.sessionId
                  ? '接續 Session'
                  : '開始 Agent 工作'}
            </button>
          </div>
        )}
      </div>
      {pane.state !== 'placeholder' && (
        <div className="pane-footer">
          <span>
            {pane.sessionId
              ? `Session ${pane.sessionId.slice(-12)}`
              : pane.kind === 'shell'
                ? '普通 Shell · 不自動關聯 Agent'
                : '新的 Agent 工作'}
          </span>
          {pane.state === 'disconnected' ? (
            <button disabled={connecting} onClick={() => setReconnect((value) => value + 1)}>重新連線</button>
          ) : live ? (
            <button
              disabled={pane.state === 'starting' || !connected || confirming}
              onClick={() => void stop()}
            >
              <Square size={11} />
              停止
            </button>
          ) : (
            <button onClick={onStart}>
              <Play size={12} />
              重新啟動
            </button>
          )}
        </div>
      )}
    </section>
  );
}
