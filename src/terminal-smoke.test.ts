import { afterEach, expect, it, vi } from 'vitest';
import { api, call } from './api';
import { runTerminalSmoke } from './terminal-smoke';
import type { RuntimeRecord } from './types';

vi.mock('./api', () => ({ api: { runtimes: vi.fn() }, call: vi.fn() }));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('sends input through xterm and waits for successful shell cleanup', async () => {
  document.body.innerHTML = '<button class="temporary-terminal-button">Terminal</button><div class="xterm-host"><textarea class="xterm-helper-textarea"></textarea><i class="runtime-dot running"></i><div class="pane-actions"><button>Close</button></div></div>';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100 } as DOMRect);
  const records: RuntimeRecord[] = [];
  vi.mocked(api.runtimes).mockImplementation(async () => records);
  document.querySelector('.temporary-terminal-button')!.addEventListener('click', () => {
    records.push({ kind: 'shell', state: 'running' } as RuntimeRecord);
  });
  const input = vi.fn((event: Event) => {
    expect((event as InputEvent).inputType).toBe('insertText');
    expect((event as InputEvent).data).toContain('SESSIONBAY_SMOKE_INPUT_MARKER');
    expect((event as InputEvent).data).toMatch(/exit 0\r$/);
    records.splice(0);
    document.querySelector('.xterm-host')!.remove();
  });
  document.querySelector('textarea')!.addEventListener('input', input);
  await runTerminalSmoke();
  expect(input).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledWith('frontend_diagnostic', {
    phase: 'interaction', message: 'terminal:launch-input-exit-close',
  });
});

it('refuses to launch when the broker is not empty', async () => {
  vi.mocked(api.runtimes).mockResolvedValue([{ state: 'running' } as RuntimeRecord]);
  await expect(runTerminalSmoke()).rejects.toThrow('empty isolated broker');
  expect(call).not.toHaveBeenCalled();
});
