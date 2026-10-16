import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canPickDirectory, pickDirectory } from './directory-picker';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => true) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
beforeEach(() => { vi.mocked(isTauri).mockReturnValue(true); vi.mocked(open).mockReset(); });

describe('native directory dialog adapter', () => {
  it.each(['/tmp/a folder/繁體中文', 'C:\\Users\\Tester\\My project', '\\\\server\\share\\folder', '/home/test/.codex'])('returns the selected path unchanged: %s', async (path) => {
    vi.mocked(open).mockResolvedValue(path);
    await expect(pickDirectory('選擇目錄', '  /original  ')).resolves.toBe(path);
    expect(open).toHaveBeenCalledExactlyOnceWith({ title: '選擇目錄', directory: true, multiple: false, recursive: false, defaultPath: '/original' });
  });
  it('omits an empty starting path and returns null for cancellation', async () => {
    vi.mocked(open).mockResolvedValue(null);
    await expect(pickDirectory('選擇目錄', ' ')).resolves.toBeNull();
    expect(open).toHaveBeenCalledExactlyOnceWith({ title: '選擇目錄', directory: true, multiple: false, recursive: false });
  });
  it('does not invoke native IPC in browser preview', async () => {
    vi.mocked(isTauri).mockReturnValue(false);
    expect(canPickDirectory()).toBe(false);
    await expect(pickDirectory('選擇目錄', '')).rejects.toThrow('桌面應用程式');
    expect(open).not.toHaveBeenCalled();
  });
  it('serializes native dialogs across fields, including after navigation, and releases the lock', async () => {
    let resolve!: (path: null) => void;
    vi.mocked(open).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const first = pickDirectory('One', '');
    await expect(pickDirectory('Two', '')).rejects.toThrow('已有資料夾選擇視窗');
    expect(open).toHaveBeenCalledTimes(1);
    resolve(null);
    await first;
    vi.mocked(open).mockResolvedValue('/new');
    await expect(pickDirectory('Two', '')).resolves.toBe('/new');
  });
  it('releases the native lock after a permission/plugin error so the user can retry', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('dialog.open not allowed')).mockResolvedValueOnce('/new');
    await expect(pickDirectory('One', '')).rejects.toThrow('not allowed');
    await expect(pickDirectory('One', '')).resolves.toBe('/new');
  });
  it.each([{ result: [] }, { result: ['/first', '/second'] }, { result: '' }])('rejects an invalid single-directory result: $result', async ({ result }) => {
    vi.mocked(open).mockResolvedValue(result as never);
    await expect(pickDirectory('One', '')).rejects.toThrow('未收到有效的目錄路徑');
  });
});
