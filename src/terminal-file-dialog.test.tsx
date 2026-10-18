import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from './api';
import { TerminalFileDialog } from './components/TerminalFileDialog';
import type { TerminalFileResolution } from './types';
vi.mock('./api', () => ({ api: { resolveTerminalFile: vi.fn() }, errorMessage: String }));
const candidate = { path: 'src/file.ts', version: 'version', fromLaunchDirectory: true };
const result: TerminalFileResolution = { absolute: false, launchDirectory: 'src', candidates: [candidate], truncated: false };
const pane = { id: 'pane', runtimeId: 'runtime', projectId: 'project', cwd: '/synthetic/project', title: 'Shell', kind: 'shell' as const, state: 'running' as const };
beforeEach(() => { vi.mocked(api.resolveTerminalFile).mockResolvedValue(result); });
it('requires explicit choice for a single relative match and prevents duplicate activation', async () => {
  const open = vi.fn(); render(<TerminalFileDialog pane={pane} request={{ text: 'file.ts:2:3', autoResolve: true }} valid={() => true} onOpen={open} onClose={vi.fn()} />);
  const button = await screen.findByRole('button', { name: /src\/file.ts/ });
  expect(api.resolveTerminalFile).toHaveBeenCalledWith('project', 'pane', 'runtime', 'file.ts');
  expect(open).not.toHaveBeenCalled(); fireEvent.click(button); fireEvent.click(button);
  expect(open).toHaveBeenCalledExactlyOnceWith(candidate, { path: 'file.ts', line: 2, column: 3 });
});
it('opens a scoped absolute result with its inspected version', async () => {
  vi.mocked(api.resolveTerminalFile).mockResolvedValue({ ...result, absolute: true });
  const open = vi.fn(); render(<TerminalFileDialog pane={pane} request={{ text: '/synthetic/project/src/file.ts:4', autoResolve: true }} valid={() => true} onOpen={open} onClose={vi.fn()} />);
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(candidate, { path: '/synthetic/project/src/file.ts', line: 4 }));
});
it('ignores late resolver responses after navigation or unmount', async () => {
  let finish!: (result: TerminalFileResolution) => void;
  vi.mocked(api.resolveTerminalFile).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  let valid = true; const open = vi.fn();
  const view = render(<TerminalFileDialog pane={pane} request={{ text: '/synthetic/project/src/file.ts', autoResolve: true }} valid={() => valid} onOpen={open} onClose={vi.fn()} />);
  valid = false; view.unmount(); await act(async () => finish({ ...result, absolute: true }));
  expect(open).not.toHaveBeenCalled();
});
it('editing input cancels the old intent and errors remain readable without opening', async () => {
  let finish!: (result: TerminalFileResolution) => void;
  vi.mocked(api.resolveTerminalFile).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const open = vi.fn(); render(<TerminalFileDialog pane={pane} request={{ text: '/synthetic/project/src/file.ts', autoResolve: true }} valid={() => true} onOpen={open} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('檔案路徑（可含 :行:欄）'), { target: { value: 'https://evil.test/file.ts' } });
  await act(async () => finish({ ...result, absolute: true }));
  expect(open).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '尋找專案檔案' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('網址');
  expect(api.resolveTerminalFile).toHaveBeenCalledTimes(1);
});

it('ambiguous unquoted absolute output still requires confirming the full target', async () => {
  vi.mocked(api.resolveTerminalFile).mockResolvedValue({ ...result, absolute: true });
  const open = vi.fn(); render(<TerminalFileDialog pane={pane} request={{ text: '/synthetic/project/src/file.ts', autoResolve: true, confirmAbsolute: true }} valid={() => true} onOpen={open} onClose={vi.fn()} />);
  const choice = await screen.findByRole('button', { name: /src\/file.ts/ });
  expect(open).not.toHaveBeenCalled(); fireEvent.click(choice);
  expect(open).toHaveBeenCalledTimes(1);
});
