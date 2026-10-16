import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { ProjectDialog } from './components/ProjectDialog';
import { canPickDirectory, pickDirectory } from './directory-picker';
vi.mock('./directory-picker', () => ({ canPickDirectory: vi.fn(() => false), pickDirectory: vi.fn() }));
import type { Project } from './types';

vi.mock('./api', () => ({
  api: { addProject: vi.fn(), createProject: vi.fn() },
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));
const project: Project = {
  id: 'chosen-project', name: 'Chosen project', path: '/synthetic/chosen', launchPath: null,
  exists: true, pinned: false, curated: true, sessionCount: 0, updatedAt: null, agents: [],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const onSaved = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const view = render(<ProjectDialog onSaved={onSaved} onClose={onClose} />);
  return { ...view, onSaved, onClose };
}
async function submit(name: string) {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
}
beforeEach(() => {
  vi.mocked(canPickDirectory).mockReturnValue(false);
  vi.mocked(pickDirectory).mockReset();
  vi.mocked(api.addProject).mockReset().mockResolvedValue(project);
  vi.mocked(api.createProject).mockReset().mockResolvedValue(project);
});

describe('project dialog mutations', () => {
  it.each([
    { name: '', expected: undefined },
    { name: '  My chosen workspace  ', expected: 'My chosen workspace' },
  ])('adds an existing directory with optional name $expected', async ({ name, expected }) => {
    const { onSaved } = setup();
    expect(screen.getByRole('button', { name: '加入專案' })).toBeDisabled();
    expect(screen.getByLabelText('目錄路徑')).toHaveFocus();
    fireEvent.change(screen.getByLabelText('目錄路徑'), { target: { value: '  /synthetic/chosen  ' } });
    fireEvent.change(screen.getByLabelText('專案名稱（選填）'), { target: { value: name } });
    await submit('加入專案');
    expect(api.addProject).toHaveBeenCalledExactlyOnceWith('/synthetic/chosen', expected);
    expect(api.createProject).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(project);
  });
  it('requires a parent and name before creating a new directory', async () => {
    const { onSaved } = setup();
    fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
    expect(screen.getByRole('button', { name: '建立並加入' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('上層目錄路徑'), { target: { value: '  /synthetic  ' } });
    expect(screen.getByRole('button', { name: '建立並加入' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('專案名稱（新資料夾名稱）'), { target: { value: '  chosen  ' } });
    await submit('建立並加入');
    expect(api.createProject).toHaveBeenCalledExactlyOnceWith('/synthetic', 'chosen');
    expect(api.addProject).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(project);
  });
  it('guards repeated submit and all dismissal paths while saving', async () => {
    const pending = deferred<Project>();
    vi.mocked(api.addProject).mockReturnValueOnce(pending.promise);
    const { container, onClose, onSaved } = setup();
    fireEvent.change(screen.getByLabelText('目錄路徑'), { target: { value: '/synthetic/chosen' } });
    const form = container.querySelector('form')!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(api.addProject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '儲存中…' })).toBeDisabled();
    expect(screen.getByLabelText('目錄路徑')).toBeDisabled();
    expect(screen.getByRole('button', { name: '建立新專案' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '關閉對話框' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(container.querySelector('.dialog-backdrop')!);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(project); });
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(project);
  });
  it.each(['existing', 'create'] as const)('retries refresh without repeating a successful %s mutation', async (mode) => {
    const { onSaved } = setup();
    onSaved.mockRejectedValueOnce(new Error('Refresh unavailable'));
    if (mode === 'create') fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
    fireEvent.change(screen.getByLabelText(mode === 'create' ? '上層目錄路徑' : '目錄路徑'), { target: { value: '/synthetic/chosen' } });
    fireEvent.change(screen.getByLabelText(mode === 'create' ? '專案名稱（新資料夾名稱）' : '專案名稱（選填）'), { target: { value: 'chosen' } });
    await submit(mode === 'create' ? '建立並加入' : '加入專案');
    expect(screen.getByRole('alert')).toHaveTextContent('Refresh unavailable');
    expect(screen.getByRole('button', { name: '建立新專案' })).toBeDisabled();
    expect(screen.getByLabelText(mode === 'create' ? '上層目錄路徑' : '目錄路徑')).toBeDisabled();
    await submit('重新整理專案');
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenLastCalledWith(project);
    expect(mode === 'create' ? api.createProject : api.addProject).toHaveBeenCalledTimes(1);
    expect(mode === 'create' ? api.addProject : api.createProject).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('keeps inputs editable after a mutation failure and permits a corrected retry', async () => {
    vi.mocked(api.addProject).mockRejectedValueOnce(new Error('Directory does not exist'));
    const { onSaved } = setup();
    fireEvent.change(screen.getByLabelText('目錄路徑'), { target: { value: '/missing' } });
    await submit('加入專案');
    expect(screen.getByRole('alert')).toHaveTextContent('Directory does not exist');
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText('目錄路徑')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('目錄路徑'), { target: { value: '/synthetic/chosen' } });
    await submit('加入專案');
    expect(api.addProject).toHaveBeenLastCalledWith('/synthetic/chosen', undefined);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(project);
  });
  it.each(['cancel', 'escape', 'close'] as const)('dismisses by %s without any mutation', (method) => {
    const { onClose, onSaved } = setup();
    fireEvent.change(screen.getByLabelText('目錄路徑'), { target: { value: '/synthetic/chosen' } });
    if (method === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
    else fireEvent.click(screen.getByRole('button', { name: method === 'cancel' ? '取消' : '關閉對話框' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
  });
});


describe('project directory selection', () => {
  beforeEach(() => { vi.mocked(canPickDirectory).mockReturnValue(true); });
  it.each(['existing', 'create'] as const)('fills only the %s path draft until explicit submit', async (mode) => {
    vi.mocked(pickDirectory).mockResolvedValue('/synthetic/picked');
    const { onSaved } = setup();
    if (mode === 'create') fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
    const label = mode === 'create' ? '上層目錄路徑' : '目錄路徑';
    await submit(`選擇${label}`);
    expect(screen.getByLabelText(label)).toHaveValue('/synthetic/picked');
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    if (mode === 'create') fireEvent.change(screen.getByLabelText('專案名稱（新資料夾名稱）'), { target: { value: 'new-project' } });
    await submit(mode === 'create' ? '建立並加入' : '加入專案');
    if (mode === 'create') expect(api.createProject).toHaveBeenCalledExactlyOnceWith('/synthetic/picked', 'new-project');
    else expect(api.addProject).toHaveBeenCalledExactlyOnceWith('/synthetic/picked', undefined);
  });
  it('ignores an old selection after switching between existing and create modes', async () => {
    const pending = deferred<string | null>();
    vi.mocked(pickDirectory).mockReturnValueOnce(pending.promise);
    setup();
    fireEvent.click(screen.getByRole('button', { name: '選擇目錄路徑' }));
    fireEvent.click(screen.getByRole('button', { name: '建立新專案' }));
    await act(async () => pending.resolve('/old-selection'));
    expect(screen.getByLabelText('上層目錄路徑')).toHaveValue('');
    expect(api.addProject).not.toHaveBeenCalled();
    expect(api.createProject).not.toHaveBeenCalled();
  });
  it('retains backend validation when a selected directory becomes inaccessible', async () => {
    vi.mocked(pickDirectory).mockResolvedValue('/unavailable');
    vi.mocked(api.addProject).mockRejectedValueOnce(new Error('Directory does not exist'));
    setup();
    await submit('選擇目錄路徑');
    await submit('加入專案');
    expect(screen.getByRole('alert')).toHaveTextContent('Directory does not exist');
    expect(screen.getByLabelText('目錄路徑')).toHaveValue('/unavailable');
    expect(screen.getByRole('button', { name: '選擇目錄路徑' })).toBeEnabled();
  });
});
