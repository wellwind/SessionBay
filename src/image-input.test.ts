import { describe, expect, it, vi } from 'vitest';
import { imageInputChangesPrompt, imageLimits, imagePasteText, imageProvider, imageUnsupportedReason, insertImageFiles, validateImageFiles, type ImageInputApi } from './image-input';
const file = (size = 20, name = 'synthetic.png', type = 'image/png') => ({ name, type, size, slice: (start: number, end: number) => ({ arrayBuffer: async () => new Uint8Array(Math.min(end, size) - start).buffer }) }) as File;
function fixture() {
  const api: ImageInputApi = {
    beginImage: vi.fn().mockResolvedValue('owned-id'), appendImage: vi.fn().mockResolvedValue(undefined),
    finishImage: vi.fn().mockResolvedValue({ id: 'owned-id', path: '/private/images/image-abc.png' }),
    retainImage: vi.fn().mockResolvedValue(undefined), discardImage: vi.fn().mockResolvedValue(undefined),
  };
  return { files: [file()], kind: 'codex' as const, runtimeId: 'runtime', api, isCurrent: vi.fn(() => true), paste: vi.fn() };
}
describe('image input adapters and bounded staging', () => {
  it('distinguishes manual submit/interrupt from printable and intact multiline paste input', () => {
    for (const data of ['\r', '\n', '\x03', '\x04', '\x1a', '\x1c']) expect(imageInputChangesPrompt(data)).toBe(true);
    for (const data of ['caption', '\x1b[A', '\x1b[200~line one\rline two\x1b[201~']) expect(imageInputChangesPrompt(data)).toBe(false);
    expect(imageInputChangesPrompt('\x1b[200~partial\r')).toBe(true);
    expect(imageInputChangesPrompt('\x1b[200~nested\x1b[200~\r\x1b[201~')).toBe(true);
  });
  it.each(['codex', 'grok', 'opencode'] as const)('%s uses percent-encoded file URL without Enter', (provider) => {
    expect(imagePasteText(provider, '/private/專案 alpha/image-a.png')).toBe('file:///private/%E5%B0%88%E6%A1%88%20alpha/image-a.png');
    expect(imagePasteText(provider, 'C:\\Users\\Name Surname\\image.png')).toBe('file:///C:/Users/Name%20Surname/image.png');
    expect(imagePasteText(provider, '\\\\?\\C:\\Users\\a\\image.png')).toBe('file:///C:/Users/a/image.png');
  });
  it('Claude inserts a plain path reference and unsupported kinds fail explicitly', () => {
    expect(imagePasteText('claude', '/private/專案 alpha/image.png')).toBe('"/private/專案 alpha/image.png" ');
    expect(imageProvider('antigravity')).toBeNull();
    expect(imageUnsupportedReason('antigravity')).toContain('尚未驗證');
    expect(imageProvider('shell')).toBeNull();
  });
  it.each(['/tmp/a\n.png', '/tmp/a\r.png', '/tmp/a\x1b.png', '/tmp/$(touch hacked).png', '/tmp/a".png', '/tmp/a\'.png', '../escape.png', '//server/a.png', '\\\\server\\a.png', '/tmp/' + 'a'.repeat(513)])('rejects unsafe paths: %s', (path) => {
    expect(() => imagePasteText('codex', path)).toThrow();
  });
  it('validates type, count and bytes before any reads', () => {
    expect(() => validateImageFiles([file(0)])).toThrow();
    expect(() => validateImageFiles([file(imageLimits.perFile + 1)])).toThrow();
    expect(() => validateImageFiles(Array.from({ length: 5 }, () => file()))).toThrow();
    expect(() => validateImageFiles(Array.from({ length: 3 }, () => file(imageLimits.perFile)))).toThrow();
    expect(() => validateImageFiles([file(20, 'bad.svg', 'image/svg+xml')])).toThrow();
    expect(() => validateImageFiles([file(20, 'bad.jpg', 'image/png')])).toThrow();
    expect(() => validateImageFiles([file(20, 'copy.png', '')])).not.toThrow();
  });
  it('chunks only file bytes; malicious original filename never reaches IPC or PTY', async () => {
    const o = fixture();
    o.files = [file(imageLimits.chunk + 3, '../../$(id)\n\x1b.png')];
    expect(await insertImageFiles(o)).toBe(1);
    expect(o.api.appendImage).toHaveBeenNthCalledWith(1, 'runtime', 'owned-id', 0, expect.any(Array));
    expect(vi.mocked(o.api.appendImage).mock.calls[0][3]).toHaveLength(imageLimits.chunk);
    expect(vi.mocked(o.api.appendImage).mock.calls[1][3]).toHaveLength(3);
    expect(o.paste).toHaveBeenCalledExactlyOnceWith('file:///private/images/image-abc.png');
    expect(o.api.discardImage).not.toHaveBeenCalled();
    expect(vi.mocked(o.api.retainImage).mock.invocationCallOrder[0]).toBeLessThan(o.paste.mock.invocationCallOrder[0]);
  });
  it.each(['beginImage', 'appendImage', 'finishImage', 'retainImage'] as const)('does not write into a changed target after %s', async (method) => {
    const o = fixture();
    let current = true;
    o.isCurrent.mockImplementation(() => current);
    const original = o.api[method];
    vi.mocked(o.api[method]).mockImplementation((async (...args: unknown[]) => {
      current = false;
      if (method === 'beginImage') return 'owned-id';
      if (method === 'finishImage') return { id: 'owned-id', path: '/private/images/image-abc.png' };
      void args; void original;
    }) as never);
    await expect(insertImageFiles(o)).rejects.toThrow('已取消');
    expect(o.paste).not.toHaveBeenCalled();
    if (method === 'retainImage') expect(o.api.discardImage).not.toHaveBeenCalled();
    else expect(o.api.discardImage).toHaveBeenCalledExactlyOnceWith('runtime', 'owned-id');
  });
  it('failed finish cleans pending file and never auto retries or submits', async () => {
    const o = fixture();
    vi.mocked(o.api.finishImage).mockRejectedValue(new Error('damaged PNG'));
    await expect(insertImageFiles(o)).rejects.toThrow('damaged PNG');
    expect(o.api.beginImage).toHaveBeenCalledTimes(1);
    expect(o.api.discardImage).toHaveBeenCalledTimes(1);
    expect(o.paste).not.toHaveBeenCalled();
  });
  it('uncertain retain/write never deletes the file', async () => {
    const o = fixture();
    vi.mocked(o.api.retainImage).mockRejectedValue(new Error('lost response'));
    await expect(insertImageFiles(o)).rejects.toThrow('lost response');
    expect(o.api.discardImage).not.toHaveBeenCalled();
    expect(o.paste).not.toHaveBeenCalled();
  });
  it('batch is validated before inserting; each image gets one distinct paste', async () => {
    const o = fixture();
    o.files = [file(), file()];
    vi.mocked(o.api.beginImage).mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    vi.mocked(o.api.finishImage).mockResolvedValueOnce({ id: 'a', path: '/private/a.png' }).mockResolvedValueOnce({ id: 'b', path: '/private/b.png' });
    expect(await insertImageFiles(o)).toBe(2);
    expect(o.paste.mock.calls).toEqual([['file:///private/a.png'], ['file:///private/b.png']]);
    expect(vi.mocked(o.api.finishImage).mock.invocationCallOrder[1]).toBeLessThan(o.paste.mock.invocationCallOrder[0]);
  });
  it('rejects unsupported provider before reading or staging', async () => {
    const o = fixture();
    await expect(insertImageFiles({ ...o, kind: 'antigravity' })).rejects.toThrow('尚未驗證');
    expect(o.api.beginImage).not.toHaveBeenCalled();
  });
});
