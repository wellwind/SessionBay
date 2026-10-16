import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  Copy,
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
import { TerminalInputQueue } from '../terminal-queue';
import { shouldHandleTerminalKey } from '../terminal-ime';
import type { Pane, RuntimeInfo, Settings } from '../types';
import { terminalTheme } from '../themes';

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
  const runtime = useRef<string | undefined>(pane.runtimeId);
  const launched = useRef(0);
  const mounted = useRef(false);
  const ended = useRef(false);
  const latest = useRef({ pane, onPatch, onAlreadyOpen, visible });
  latest.current = { pane, onPatch, onAlreadyOpen, visible };
  const inputQueue = useRef<TerminalInputQueue | null>(null);
  const resizePending = useRef<{ id: string; cols: number; rows: number } | null>(null);
  const resizing = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const [notice, setNotice] = useState('');
  const fitNow = useCallback(() => {
    if (
      !latest.current.visible ||
      !host.current?.clientWidth ||
      !host.current.clientHeight ||
      !term.current
    )
      return;
    try {
      fit.current?.fit();
      const t = term.current;
      if (runtime.current && t.cols >= 2 && t.rows >= 2) {
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
    fitNow();
    return () => {
      mounted.current = false;
      const id = runtime.current;
      runtime.current = undefined;
      if (id) void api.stop(id).catch(() => undefined);
      observer.disconnect();
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
      const frame = requestAnimationFrame(() => {
        fitNow();
        if (focused && pane.state !== 'placeholder') term.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [visible, focused, fitNow, pane.state]);
  useEffect(() => {
    const token = pane.startToken ?? 0;
    if (!token || token === launched.current || !term.current) return;
    launched.current = token;
    ended.current = false;
    runtime.current = undefined;
    setNotice('');
    term.current.reset();
    onPatch(pane.id, {
      state: 'starting',
      error: undefined,
      runtimeId: undefined,
      exitCode: undefined,
    });
    fitNow();
    const terminal = term.current;
    let failed = false;
    void api
      .launch(
        {
          paneId: pane.id,
          kind: pane.kind,
          projectId: projectAvailable ? pane.projectId : undefined,
          sessionId: pane.sessionId,
          resumeId: pane.resumeId,
          cwd: pane.cwd || undefined,
          profileId: pane.profileId,
          cols: Math.max(2, terminal.cols),
          rows: Math.max(2, terminal.rows),
        },
        (event) => {
          if (token !== launched.current) {
            if (event.type === 'output') void api.ack(event.runtimeId, event.sequence).catch(() => undefined);
            return;
          }
          if (event.type === 'output') {
            if (!mounted.current) {
              void api.ack(event.runtimeId, event.sequence).catch(() => undefined);
              return;
            }
            terminal.write(new Uint8Array(event.data), () => {
              void api.ack(event.runtimeId, event.sequence).catch((error) => {
                if (mounted.current) setNotice(errorMessage(error));
              });
            });
          } else if (event.type === 'exit') {
            ended.current = true;
            runtime.current = undefined;
            if (mounted.current)
              latest.current.onPatch(pane.id, { state: failed ? 'failed' : 'exited', exitCode: event.exitCode });
          } else if (mounted.current) {
            failed = true;
            ended.current = true;
            latest.current.onPatch(pane.id, { state: 'failed', error: event.message });
          }
        },
      )
      .then((info) => {
        if (!mounted.current || token !== launched.current) {
          // A duplicate-session response belongs to another pane; never stop its runtime.
          if (info.paneId === pane.id) void api.stop(info.id).catch(() => undefined);
          return;
        }
        if (info.paneId !== pane.id) {
          latest.current.onAlreadyOpen(info);
          return;
        }
        if (!ended.current) {
          runtime.current = info.id;
          latest.current.onPatch(pane.id, {
            runtimeId: info.id,
            state: info.state === 'exited' ? 'exited' : 'running',
            cwd: info.cwd,
            exitCode: info.exitCode,
          });
          fitNow();
        } else latest.current.onPatch(pane.id, { runtimeId: info.id });
      })
      .catch((error) => {
        if (mounted.current && token === launched.current)
          latest.current.onPatch(pane.id, { state: 'failed', error: errorMessage(error) });
      });
    // Start only for an explicit monotonically increasing user action token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.startToken]);
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
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (/[\r\n]/.test(text) && !window.confirm('貼上的內容含多行，可能立即執行指令。確定貼上？'))
        return;
      term.current?.paste(text);
      term.current?.focus();
    } catch {
      setNotice('無法讀取剪貼簿，請使用系統貼上快捷鍵。');
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
          <strong>{pane.title}</strong>
          {focused && <span className="focus-label">焦點</span>}
          <span className={`runtime-dot ${pane.state}`} />
        </div>
        <div className="pane-actions">
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
            disabled={!live}
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
          {pane.state === 'running'
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
          {live ? (
            <button
              disabled={pane.state === 'starting'}
              onClick={() => {
                if (
                  pane.runtimeId &&
                  window.confirm(`結束「${pane.title}」的受管程序？最後畫面將保留。`)
                )
                  void api.stop(pane.runtimeId).catch((error) => setNotice(errorMessage(error)));
              }}
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
