import { describe, expect, it, vi } from 'vitest';
import { fileInputChangesPrompt, fileLimits, filePasteText, fileProvider, fileUnsupportedReason, insertFiles, validateFiles, FileInputError, hasDirectory, clipboardFileName, displayFileName, type FileInputApi } from './file-input';
const file = (size = 20, name = 'synthetic.png', type = 'image/png') => ({ name, type, size, slice: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(Math.min(end, size) - start).buffer }) }) as File;
function fixture() {
  const api: FileInputApi = {
    beginFile: vi.fn().mockResolvedValue('owned-id'), appendFile: vi.fn().mockResolvedValue(undefined),
    finishFile: vi.fn().mockResolvedValue({ id: 'owned-id', path: '/private/files/file-abc.png', originalName: 'synthetic.png', name: 'synthetic.png' }),
    retainFile: vi.fn().mockResolvedValue(undefined), discardFile: vi.fn().mockResolvedValue(undefined),
  };
  return { files: [file()], kind: 'codex' as const, runtimeId: 'runtime', api, isCurrent: vi.fn(() => true), paste: vi.fn() };
}
describe('file input adapters and bounded staging', () => {
  it('distinguishes manual submit/interrupt from printable and intact multiline paste input', () => {
    for (const data of ['\r', '\n', '\x03', '\x04', '\x1a', '\x1c']) expect(fileInputChangesPrompt(data)).toBe(true);
    for (const data of ['caption', '\x1b[A', '\x1b[200~line one\rline two\x1b[201~']) expect(fileInputChangesPrompt(data)).toBe(false);
    expect(fileInputChangesPrompt('\x1b[200~partial\r')).toBe(true);
    expect(fileInputChangesPrompt('\x1b[200~nested\x1b[200~\r\x1b[201~')).toBe(true);
  });
  it.each(['codex', 'grok', 'opencode'] as const)('%s uses percent-encoded file URL without Enter', (provider) => {
    expect(filePasteText(provider, '/private/專案 alpha/file-a.png')).toBe('file:///private/%E5%B0%88%E6%A1%88%20alpha/file-a.png ');
    expect(filePasteText(provider, 'C:\\Users\\Name Surname\\file.png')).toBe('file:///C:/Users/Name%20Surname/file.png ');
    expect(filePasteText(provider, '\\\\?\\C:\\Users\\a\\file.png')).toBe('file:///C:/Users/a/file.png ');
  });
  it('Claude inserts a plain path reference and unsupported kinds fail explicitly', () => {
    expect(filePasteText('claude', '/private/專案 alpha/file.png')).toBe('"/private/專案 alpha/file.png" ');
    expect(fileProvider('antigravity')).toBeNull();
    expect(fileUnsupportedReason('antigravity')).toContain('尚未驗證');
    expect(fileProvider('shell')).toBeNull();
  });
  it.each(['/tmp/a\n.png', '/tmp/a\r.png', '/tmp/a\x1b.png', '/tmp/$(touch hacked).png', '/tmp/a".png', '/tmp/a\'.png', '../escape.png', '//server/a.png', '\\\\server\\a.png', '/tmp/' + 'a'.repeat(513)])('rejects unsafe paths: %s', (path) => {
    expect(() => filePasteText('codex', path)).toThrow();
  });
  it('validates type, count and bytes before any reads', () => {
    expect(() => validateFiles([file(0)])).not.toThrow();
    expect(() => validateFiles([file(fileLimits.perFile + 1)])).toThrow();
    expect(() => validateFiles(Array.from({ length: 5 }, () => file()))).toThrow();
    expect(() => validateFiles(Array.from({ length: 3 }, () => file(fileLimits.perFile)))).toThrow();
    expect(() => validateFiles([file(20, 'bad.svg', 'image/svg+xml')])).not.toThrow();
    expect(() => validateFiles([file(20, 'bad.jpg', 'application/pdf')])).not.toThrow();
    expect(() => validateFiles([file(20, 'copy.png', '')])).not.toThrow();
  });
  it('chunks bytes and sends the original filename only to the staging service', async () => {
    const o = fixture();
    o.files = [file(fileLimits.chunk + 3, '../../$(id)\n\x1b.png')];
    expect(await insertFiles(o)).toBe(1);
    expect(o.api.beginFile).toHaveBeenCalledWith('runtime', '../../$(id)\n\x1b.png', fileLimits.chunk + 3);
    expect(o.api.appendFile).toHaveBeenNthCalledWith(1, 'runtime', 'owned-id', 0, expect.any(Array));
    expect(vi.mocked(o.api.appendFile).mock.calls[0][3]).toHaveLength(fileLimits.chunk);
    expect(vi.mocked(o.api.appendFile).mock.calls[1][3]).toHaveLength(3);
    expect(o.paste).toHaveBeenCalledExactlyOnceWith('file:///private/files/file-abc.png ', expect.any(Function));
    expect(o.api.discardFile).not.toHaveBeenCalled();
    expect(vi.mocked(o.api.retainFile).mock.invocationCallOrder[0]).toBeLessThan(o.paste.mock.invocationCallOrder[0]);
  });
  it.each(['beginFile', 'appendFile', 'finishFile', 'retainFile'] as const)('does not write into a changed target after %s', async (method) => {
    const o = fixture();
    let current = true;
    o.isCurrent.mockImplementation(() => current);
    const original = o.api[method];
    vi.mocked(o.api[method]).mockImplementation((async (...args: unknown[]) => {
      current = false;
      if (method === 'beginFile') return 'owned-id';
      if (method === 'finishFile') return { id: 'owned-id', path: '/private/files/file-abc.png', originalName: 'synthetic.png', name: 'synthetic.png' };
      void args; void original;
    }) as never);
    await expect(insertFiles(o)).rejects.toThrow('已取消');
    expect(o.paste).not.toHaveBeenCalled();
    if (method === 'retainFile') expect(o.api.discardFile).not.toHaveBeenCalled();
    else expect(o.api.discardFile).toHaveBeenCalledExactlyOnceWith('runtime', 'owned-id');
  });
  it('failed finish cleans pending file and never auto retries or submits', async () => {
    const o = fixture();
    vi.mocked(o.api.finishFile).mockRejectedValue(new Error('damaged PNG'));
    await expect(insertFiles(o)).rejects.toThrow('damaged PNG');
    expect(o.api.beginFile).toHaveBeenCalledTimes(1);
    expect(o.api.discardFile).toHaveBeenCalledTimes(1);
    expect(o.paste).not.toHaveBeenCalled();
  });
  it('uncertain retain/write never deletes the file', async () => {
    const o = fixture();
    vi.mocked(o.api.retainFile).mockRejectedValue(new Error('lost response'));
    await expect(insertFiles(o)).rejects.toThrow('lost response');
    expect(o.api.discardFile).not.toHaveBeenCalled();
    expect(o.paste).not.toHaveBeenCalled();
  });
  it('batch is validated before inserting; each file gets one distinct paste', async () => {
    const o = fixture();
    o.files = [file(), file()];
    vi.mocked(o.api.beginFile).mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    vi.mocked(o.api.finishFile).mockResolvedValueOnce({ id: 'a', path: '/private/a.png', originalName: 'a.png', name: 'a.png' }).mockResolvedValueOnce({ id: 'b', path: '/private/b.png', originalName: 'b.png', name: 'b.png' });
    expect(await insertFiles(o)).toBe(2);
    expect(o.paste.mock.calls.map((call) => call[0])).toEqual(['file:///private/a.png ', 'file:///private/b.png ']);
    expect(vi.mocked(o.api.finishFile).mock.invocationCallOrder[1]).toBeLessThan(o.paste.mock.invocationCallOrder[0]);
  });
  it('rejects unsupported provider before reading or staging', async () => {
    const o = fixture();
    await expect(insertFiles({ ...o, kind: 'antigravity' })).rejects.toThrow('尚未驗證');
    expect(o.api.beginFile).not.toHaveBeenCalled();
  });
});

describe('general file behavior', () => {
  it.each(['notes.txt', 'report.pdf', 'data.csv', 'archive.zip', 'README', 'image.svg', 'script.exe'])('accepts %s, including empty files', async (name) => {
    const o = fixture();
    o.files = [file(0, name, '')];
    await expect(insertFiles(o)).resolves.toBe(1);
    expect(o.api.beginFile).toHaveBeenCalledWith('runtime', name, 0);
    expect(o.api.appendFile).not.toHaveBeenCalled();
    expect(o.api.finishFile).toHaveBeenCalledTimes(1);
  });
  it('notifies when the staging service cleans the original name without pasting that name', async () => {
    const o = fixture();
    const onRenamed = vi.fn();
    vi.mocked(o.api.finishFile).mockResolvedValue({ id: 'owned-id', path: '/private/safe.txt', originalName: '../unsafe.txt', name: 'safe.txt' });
    await insertFiles({ ...o, onRenamed });
    expect(onRenamed).toHaveBeenCalledWith('../unsafe.txt', 'safe.txt');
    expect(o.paste.mock.calls[0][0]).toBe('file:///private/safe.txt ');
  });
  it('recognizes directories even in mixed drops', () => {
    const items = [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }) }, { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] as unknown as DataTransferItem[];
    expect(hasDirectory(items)).toBe(true);
    expect(hasDirectory(items.slice(0, 1))).toBe(false);
    expect(hasDirectory([{ kind: 'file' } as DataTransferItem])).toBe(false);
  });
  it('does not warn about duplicate insertion when retain or preflight fails before any paste', async () => {
    const o = fixture();
    vi.mocked(o.api.retainFile).mockRejectedValueOnce(new Error('retain failed'));
    await expect(insertFiles(o)).rejects.toMatchObject({ mayHaveInserted: false });
    o.paste.mockImplementation(() => { throw new Error('queue full'); });
    await expect(insertFiles(o)).rejects.toMatchObject({ mayHaveInserted: false });
  });
  it('flags uncertain terminal writes and never discards retained files', async () => {
    const o = fixture();
    o.paste.mockImplementation((_text: string, markAttempted: () => void) => { markAttempted(); throw new Error('write failed'); });
    await expect(insertFiles(o)).rejects.toMatchObject({ mayHaveInserted: true });
    expect(o.api.discardFile).not.toHaveBeenCalled();
  });
  it('flags partial insertion when a later retain fails', async () => {
    const o = fixture();
    o.files = [file(), file()];
    vi.mocked(o.api.retainFile).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('retain failed'));
    await expect(insertFiles(o)).rejects.toMatchObject({ mayHaveInserted: true });
    expect(o.paste).toHaveBeenCalledTimes(1);
  });
  it('preserves insertion uncertainty even when cleanup also fails', async () => {
    const o = fixture();
    o.files = [file(), file()];
    o.paste.mockImplementation((_text: string, markAttempted: () => void) => { markAttempted(); throw new Error('write failed'); });
    vi.mocked(o.api.discardFile).mockRejectedValue(new Error('cleanup failed'));
    await expect(insertFiles(o)).rejects.toBeInstanceOf(FileInputError);
    await expect(insertFiles(o)).rejects.toMatchObject({ mayHaveInserted: true });
  });
});

describe('safe file name display and binary clipboard names', () => {
  it.each([['image/png', 'clipboard.png'], ['image/jpeg', 'clipboard.jpg'], ['image/svg+xml', 'clipboard.svg'], ['image/webp', 'clipboard.webp'], ['application/pdf', 'clipboard.pdf'], ['application/x-unknown', 'clipboard.bin']])('names %s blobs', (mime, name) => {
    expect(clipboardFileName(mime)).toBe(name);
  });
  it('escapes C0/C1 controls, bidi and formatting characters instead of rendering them', () => {
    const display = displayFileName('name\n\u001b\u0085\u202e\u2066\u200b.txt');
    expect(display).toBe('"name\\u000a\\u001b\\u0085\\u202e\\u2066\\u200b.txt"');
    expect(/[\p{Cc}\p{Cf}]/u.test(display)).toBe(false);
  });
  it('bounds long display names while retaining their suffix and complete escape sequences', () => {
    const display = displayFileName('長'.repeat(4000) + '\u202e.txt');
    expect(display.length).toBeLessThanOrEqual(100);
    expect(display).toContain('…');
    expect(display).toContain('\\u202e.txt"');
    expect(displayFileName('normal.csv')).toBe('"normal.csv"');
  });
});
