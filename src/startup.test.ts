/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import observerSource from '../public/startup-diagnostics.js?raw';
import './startup';

function harness(smokeEnabled = false) {
  const doc = document.implementation.createHTMLDocument('Session Bay startup test');
  doc.body.innerHTML = '<div id="startup-status" role="status">Starting</div><div id="root"></div>';
  const events = new Map<string, (event: Record<string, unknown>) => void>();
  const frames: FrameRequestCallback[] = [];
  const invoke = vi.fn().mockResolvedValue(smokeEnabled);
  const probe = vi.fn().mockResolvedValue(undefined);
  const win = {
    __TAURI_INTERNALS__: { invoke },
    addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => events.set(name, handler),
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
    SessionBaySmokeProbe: probe,
  } as unknown as Window;
  vi.spyOn(doc, 'addEventListener').mockImplementation((name, handler) => {
    events.set(name, handler as unknown as (event: Record<string, unknown>) => void);
  });
  // Evaluate the exact dependency-free script shipped before the main module graph.
  new Function('window', 'document', 'navigator', 'console', observerSource)(
    win, doc, { userAgent: 'Synthetic WebView' }, { info: vi.fn(), error: vi.fn() },
  );
  const phases = () => invoke.mock.calls.map((call) => call[1].phase);
  const paint = async () => {
    while (frames.length) frames.shift()!(0);
    await Promise.resolve();
    await Promise.resolve();
  };
  const shell = (backendReady = true, width = 1200) => {
    doc.getElementById('root')!.innerHTML = `<div data-app-shell data-backend-ready="${backendReady}"><header>Session Bay</header><button>Settings</button></div>`;
    const element = doc.querySelector<HTMLElement>('[data-app-shell]')!;
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ width, height: 800 } as DOMRect);
  };
  return { win, doc, events, invoke, probe, phases, paint, shell };
}

describe('pre-module startup observer', () => {
  it('captures missing module resources before main evaluates and shows an actionable fallback', async () => {
    const h = harness();
    const script = h.doc.createElement('script');
    script.src = 'http://tauri.localhost/assets/missing.js';
    h.events.get('error')!({ target: script });
    h.shell();
    h.win.SessionBayStartup!.ready();
    await h.paint();
    expect(h.phases()).toEqual(['observer', 'error']);
    expect(h.doc.querySelector('[role="alert"]')?.textContent).toContain('Resource failed to load');
    expect(h.doc.documentElement.dataset.sessionbayReady).toBe('false');
  });

  it('captures import-time JavaScript errors with module/line information', () => {
    const h = harness();
    h.events.get('error')!({ target: h.win, message: 'Unexpected token', filename: '/assets/main.js', lineno: 3, colno: 7 });
    expect(h.invoke.mock.calls.at(-1)![1].message).toContain('Unexpected token at /assets/main.js:3:7');
    expect(h.phases()).not.toContain('module-loaded');
  });

  it('captures unhandled rejections and content security policy failures', () => {
    const h = harness();
    h.events.get('unhandledrejection')!({ reason: new Error('IPC unavailable') });
    h.events.get('securitypolicyviolation')!({ violatedDirective: 'script-src', blockedURI: '/assets/blocked.js' });
    expect(h.phases()).toEqual(['observer', 'error', 'error']);
    expect(h.doc.querySelector('[role="alert"]')?.textContent).toContain('Content Security Policy blocked script-src');
  });

  it.each([['missing backend state', false, 1200], ['zero-layout shell', true, 0]] as const)(
    'rejects readiness for %s', async (_name, bootReady, width) => {
      const h = harness();
      h.shell(bootReady, width);
      h.win.SessionBayStartup!.ready();
      await h.paint();
      expect(h.phases()).toEqual(['observer', 'error']);
      expect(h.probe).not.toHaveBeenCalled();
    },
  );

  it('requires committed backend-ready DOM and animation frames, without production auto-actions', async () => {
    const h = harness();
    h.shell();
    h.win.SessionBayStartup!.moduleLoaded();
    h.win.SessionBayStartup!.mounted();
    h.win.SessionBayStartup!.ready();
    expect(h.phases()).toEqual(['observer', 'module-loaded', 'mounted']);
    await h.paint();
    expect(h.phases()).toContain('ready');
    expect(h.doc.documentElement.dataset.sessionbayReady).toBe('true');
    expect(h.doc.getElementById('startup-status')?.hasAttribute('hidden')).toBe(true);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('runs interaction only after the backend confirms smoke mode, and reports failures', async () => {
    const h = harness(true);
    h.probe.mockRejectedValueOnce(new Error('Settings failed to open'));
    h.shell();
    h.win.SessionBayStartup!.ready();
    await h.paint();
    await Promise.resolve();
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.phases()).toEqual(['observer', 'ready', 'error']);
    expect(h.doc.documentElement.dataset.sessionbayReady).toBe('false');
  });

  it('reports recoverable bootstrap errors without blocking a successful retry', async () => {
    const h = harness();
    h.win.SessionBayStartup!.mounted();
    h.win.SessionBayStartup!.backendError('Temporary bootstrap failure');
    expect(h.doc.getElementById('startup-status')?.hasAttribute('hidden')).toBe(true);
    h.shell();
    h.win.SessionBayStartup!.ready();
    await h.paint();
    expect(h.phases()).toEqual(['observer', 'mounted', 'error', 'ready']);
    expect(h.doc.documentElement.dataset.sessionbayReady).toBe('true');
    expect(h.doc.querySelector('[role="alert"]')).toBeNull();
  });

  it('bounds reporting and never treats error HTML as markup', () => {
    const h = harness();
    for (let i = 0; i < 50; i++) h.win.SessionBayStartup!.error('<img src=x onerror=alert(1)>' + 'x'.repeat(5000));
    expect(h.invoke).toHaveBeenCalledTimes(32);
    expect(h.invoke.mock.calls[1][1].message.length).toBe(2048);
    expect(h.doc.querySelector('#startup-status img')).toBeNull();
  });
});
