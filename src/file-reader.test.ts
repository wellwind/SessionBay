import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import {
  clearFileCache, fileCacheBytes, FULL_FILE_BYTES, NORMAL_FILE_BYTES,
  RANGE_BYTES, RangeRequired, readWorkspaceText,
} from './components/file-reader';
import type { WorkspaceFileChunk, WorkspaceFileInfo } from './types';

vi.mock('./api', () => ({ api: { readWorkspaceFileChunk: vi.fn() } }));
const readChunk = vi.mocked(api.readWorkspaceFileChunk);
const CHUNK_BYTES = 256 * 1024;
const encoder = new TextEncoder();

function serve(source: string | number[] | Uint8Array, overrides: Partial<WorkspaceFileInfo> = {}, shortRead?: number): WorkspaceFileInfo {
  const bytes = typeof source === 'string' ? encoder.encode(source) : Uint8Array.from(source);
  readChunk.mockImplementation(async (_project, _path, _version, offset, length) => {
    const chunk = bytes.subarray(offset, offset + Math.min(length, shortRead ?? length));
    return { bytes: Array.from(chunk), eof: offset + chunk.length === bytes.length };
  });
  return { path: 'sample.txt', sizeBytes: bytes.length, version: 'version-1', kind: 'text', ...overrides };
}
const read = (info: WorkspaceFileInfo, rangeStart?: number, project = 'project') =>
  readWorkspaceText(project, info, new AbortController().signal, vi.fn(), rangeStart);

beforeEach(() => { clearFileCache(); readChunk.mockReset(); });

describe('bounded workspace text reading', () => {
  it('reads files beyond the old 256 KiB cap sequentially and reports progress', async () => {
    const text = 'a'.repeat(CHUNK_BYTES * 2 + 17);
    const info = serve(text);
    const progress = vi.fn();
    let active = 0, maxActive = 0;
    const implementation = readChunk.getMockImplementation()!;
    readChunk.mockImplementation(async (...args) => {
      active++; maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      const result = await implementation(...args);
      active--; return result;
    });
    expect(await readWorkspaceText('project', info, new AbortController().signal, progress)).toMatchObject({
      text, start: 0, end: info.sizeBytes, partial: false, lightweight: true, lines: 1, longestLine: text.length,
    });
    expect(maxActive).toBe(1);
    expect(readChunk.mock.calls).toEqual([
      ['project', info.path, info.version, 0, CHUNK_BYTES],
      ['project', info.path, info.version, CHUNK_BYTES, CHUNK_BYTES],
      ['project', info.path, info.version, CHUNK_BYTES * 2, 17],
    ]);
    expect(progress.mock.calls.map(([bytes]) => bytes)).toEqual([CHUNK_BYTES, CHUNK_BYTES * 2, text.length]);
  });

  it('accepts a zero-byte text file and an empty range at EOF without requesting bytes', async () => {
    expect(await read(serve(''))).toEqual({ text: '', lines: 1, longestLine: 0, start: 0, end: 0, partial: false, lightweight: false });
    expect(await read(serve('abc'), 3)).toMatchObject({ text: '', start: 3, end: 3, partial: true, lightweight: true });
    expect(readChunk).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe file size %s before IPC', async sizeBytes => {
    await expect(read(serve('a', { sizeBytes }))).rejects.toThrow('檔案大小');
    expect(readChunk).not.toHaveBeenCalled();
  });

  it('rejects binary content and missing version metadata before IPC', async () => {
    await expect(read(serve('a', { kind: 'binary' }))).rejects.toThrow('UTF-8');
    await expect(read(serve('a', { version: '' }))).rejects.toThrow('版本');
    expect(readChunk).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, 4, NaN, Infinity])('rejects invalid range position %s', async rangeStart => {
    await expect(read(serve('abc'), rangeStart)).rejects.toThrow('閱讀位置');
    expect(readChunk).not.toHaveBeenCalled();
  });

  it('requires ranges beyond 64 MiB, but permits a bounded range in a huge file', async () => {
    const info = serve('', { sizeBytes: FULL_FILE_BYTES + 1 });
    await expect(read(info)).rejects.toBeInstanceOf(RangeRequired);
    expect(readChunk).not.toHaveBeenCalled();
    readChunk.mockImplementation(async (_project, _path, _version, _offset, length) => ({ bytes: new Array<number>(length).fill(97), eof: false }));
    expect(await read(info, 0)).toMatchObject({ start: 0, end: RANGE_BYTES, partial: true, text: 'a'.repeat(RANGE_BYTES) });
    expect(readChunk).toHaveBeenCalledTimes(4);
    expect(fileCacheBytes()).toBe(0);
  });

  it('allows the exact full-read size boundary to reach IPC', async () => {
    const info = serve('', { sizeBytes: FULL_FILE_BYTES });
    const failure = new Error('stop after checking the first bounded request');
    readChunk.mockRejectedValue(failure);
    await expect(read(info)).rejects.toBe(failure);
    expect(readChunk).toHaveBeenCalledExactlyOnceWith('project', info.path, info.version, 0, CHUNK_BYTES);
  });

  it('uses lightweight mode for an accepted file over 20 MiB even with short lines', async () => {
    const text = `${'a'.repeat(1023)}\n`.repeat(NORMAL_FILE_BYTES / 1024 + 1);
    const value = await read(serve(text));
    expect(value).toMatchObject({ lightweight: true, longestLine: 1023, end: text.length, partial: false });
    expect(fileCacheBytes()).toBe(0);
  });

  it.each([20000, 20001])('uses lightweight mode only above a 20,000-unit longest line (%s)', async length => {
    expect(await read(serve('a'.repeat(length)))).toMatchObject({ longestLine: length, lightweight: length > 20000 });
  });

  it('counts CRLF as one newline, including across IPC boundaries, and counts lone CR', async () => {
    const value = await read(serve('ab\r\nc\rd\n', {}, 1));
    expect(value).toMatchObject({ lines: 4, longestLine: 2, text: 'ab\r\nc\rd\n' });
  });

  it.each(['\n', '\r', '\r\n'])('requires ranges above 300,000 lines for %j newlines', async newline => {
    await expect(read(serve(newline.repeat(300000)))).rejects.toBeInstanceOf(RangeRequired);
    expect(fileCacheBytes()).toBe(0);
  });

  it('allows exactly 300,000 lines and bounds line-dense partial windows at the same cap', async () => {
    expect(await read(serve('\n'.repeat(299999)))).toMatchObject({ lines: 300000, partial: false });
    clearFileCache();
    const info = serve('\n'.repeat(RANGE_BYTES));
    const parts: string[] = [];
    let next = 0;
    while (next < info.sizeBytes) {
      const page = await read(info, next);
      expect(page.lines).toBeLessThanOrEqual(300000);
      expect(page.end).toBeGreaterThan(next);
      expect(page.start).toBe(next);
      expect(page.partial).toBe(true);
      expect(page.lightweight).toBe(true);
      parts.push(page.text); next = page.end;
    }
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('\n'.repeat(299999));
    expect(parts.join('')).toBe('\n'.repeat(RANGE_BYTES));
    expect(fileCacheBytes()).toBe(0);
  });

  it.each(['\r', '\r\n'])('preserves %j newline boundaries at the partial line cap, including split IPC reads', async newline => {
    const firstText = `${newline.repeat(299999)}中😀`;
    const source = `${firstText}${newline}next`;
    const info = serve(source, {}, CHUNK_BYTES - 1);
    const first = await read(info, 0);
    expect(first).toMatchObject({ text: firstText, lines: 300000, longestLine: 3, end: encoder.encode(firstText).length });
    const second = await read(info, first.end);
    expect(second).toMatchObject({ text: `${newline}next`, lines: 2, start: first.end, end: info.sizeBytes });
    expect(first.text + second.text).toBe(source);
  });

  it('accounts for UTF-8 suffixes, a leading BOM, and a pending decoder character at a line-limited range end', async () => {
    const firstText = `${'\n'.repeat(299999)}é中😀`;
    const prefix = `\ufeff${firstText}\n`;
    // The second IPC chunk ends after the lead byte of the final emoji. It
    // must be excluded along with the decoded suffix when locating page end.
    const source = `${prefix}${'b'.repeat(CHUNK_BYTES * 2 - 1 - encoder.encode(prefix).length)}😀end`;
    const info = serve(source);
    const first = await read(info, 0);
    expect(first).toMatchObject({ text: firstText, lines: 300000, end: encoder.encode(`\ufeff${firstText}`).length });
    expect(readChunk).toHaveBeenCalledTimes(2);
    const second = await read(info, first.end);
    expect(second.start).toBe(first.end);
    expect(second.end).toBe(info.sizeBytes);
    expect(first.text + second.text).toBe(source.slice(1));
  });

  it('preserves exact byte positions when a line-limited range starts inside a UTF-8 sequence', async () => {
    const firstText = `${'\n'.repeat(299999)}é尾`;
    const source = `😀${firstText}\nnext`;
    const info = serve(source);
    const first = await read(info, 1);
    expect(first).toMatchObject({ text: firstText, start: 4, end: 4 + encoder.encode(firstText).length, lines: 300000 });
    const second = await read(info, first.end);
    expect(first.text + second.text).toBe(source.slice(2));
    expect(second.end).toBe(info.sizeBytes);
  });

  it('does not truncate the final line of an exactly 300,000-line partial file', async () => {
    const source = `${'\n'.repeat(299999)}last中😀`;
    const info = serve(source);
    expect(await read(info, 0)).toMatchObject({ text: source, lines: 300000, end: info.sizeBytes });
  });
});

describe('UTF-8 and text validation', () => {
  it.each(['é', '中', '😀'])('preserves %s split over IPC chunks', async character => {
    const text = `${'a'.repeat(CHUNK_BYTES - 1)}${character}tail`;
    expect((await read(serve(text))).text).toBe(text);
  });

  it.each([
    ['é', 1], ['中', 1], ['中', 2], ['😀', 1], ['😀', 2], ['😀', 3],
  ] as const)('does not lose %s when the range ends after %s of its bytes', async (character, consumed) => {
    const prefix = 'a'.repeat(RANGE_BYTES - consumed);
    const info = serve(`${prefix}${character}tail`);
    const first = await read(info, 0);
    expect(first).toMatchObject({ text: prefix, start: 0, end: prefix.length });
    const second = await read(info, first.end);
    expect(second).toMatchObject({ text: `${character}tail`, start: prefix.length, end: info.sizeBytes });
    expect(first.text + second.text).toBe(`${prefix}${character}tail`);
    expect(fileCacheBytes()).toBe(0);
  });

  it('tracks unfinished range-end characters across short IPC reads', async () => {
    const prefix = 'a'.repeat(RANGE_BYTES - 2);
    const info = serve(`${prefix}😀tail`);
    const implementation = readChunk.getMockImplementation()!;
    readChunk.mockImplementation((project, path, version, offset, length) =>
      implementation(project, path, version, offset, offset === CHUNK_BYTES * 3 ? length - 1 : length));
    const first = await read(info, 0);
    expect(first).toMatchObject({ text: prefix, end: prefix.length });
    expect((await read(info, first.end)).text).toBe('😀tail');
    expect(readChunk.mock.calls.some(([, , , offset, length]) => offset === RANGE_BYTES - 1 && length === 1)).toBe(true);
  });

  it('aligns an arbitrary range start, even when its continuation bytes arrive separately', async () => {
    const info = serve('😀hello', {}, 1);
    expect(await read(info, 1)).toMatchObject({ text: 'hello', start: 4, end: info.sizeBytes });
  });

  it('skips no more than three initial continuation bytes', async () => {
    await expect(read(serve([97, 0x80, 0x80, 0x80, 0x80, 98], {}, 1), 1)).rejects.toThrow();
  });

  it('strips only the file-leading BOM and retains interior BOMs at chunk and range starts', async () => {
    const info = serve('\ufeffa\ufeffb', {}, 1);
    expect((await read(info)).text).toBe('a\ufeffb');
    expect((await read(info, 4)).text).toBe('\ufeffb');
  });

  it.each([
    [0xff], [0x80], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82],
  ])('rejects invalid or truncated UTF-8 bytes %j at EOF', async (...bytes) => {
    await expect(read(serve(bytes))).rejects.toThrow();
    expect(fileCacheBytes()).toBe(0);
  });

  it('rejects invalid UTF-8 prefixes instead of silently trimming them at a range boundary', async () => {
    const bytes = new Uint8Array(RANGE_BYTES + 1).fill(97);
    bytes.set([0xf4, 0x90, 0x80], RANGE_BYTES - 2);
    await expect(read(serve(bytes), 0)).rejects.toThrow();
  });

  it.each([0, 1, 8, 11, 12, 31, 127])('rejects non-text control byte %s', async byte => {
    await expect(read(serve([97, byte, 98]))).rejects.toThrow('控制字元');
    expect(fileCacheBytes()).toBe(0);
  });

  it('accepts tabs and normal line endings', async () => {
    expect((await read(serve('a\tb\r\nc\rd\n'))).text).toBe('a\tb\r\nc\rd\n');
  });
});

describe('cancellation and protocol consistency', () => {
  it('does not read or return cached data for an already aborted request', async () => {
    const info = serve('abc');
    await read(info);
    const controller = new AbortController(); controller.abort();
    await expect(readWorkspaceText('project', info, controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(readChunk).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight result after cancellation and issues no subsequent request', async () => {
    const info = serve('a'.repeat(CHUNK_BYTES + 1));
    let resolve!: (result: WorkspaceFileChunk) => void;
    readChunk.mockImplementationOnce(() => new Promise<WorkspaceFileChunk>(done => { resolve = done; }));
    const controller = new AbortController(), progress = vi.fn();
    const pending = readWorkspaceText('project', info, controller.signal, progress);
    expect(readChunk).toHaveBeenCalledTimes(1);
    controller.abort();
    resolve({ bytes: new Array<number>(CHUNK_BYTES).fill(97), eof: false });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(readChunk).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
    expect(fileCacheBytes()).toBe(0);
  });

  it('checks cancellation after progress callbacks before reading again or caching', async () => {
    const controller = new AbortController();
    await expect(readWorkspaceText('project', serve('a'.repeat(CHUNK_BYTES + 1)), controller.signal, () => controller.abort()))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(readChunk).toHaveBeenCalledTimes(1);
    expect(fileCacheBytes()).toBe(0);
  });

  it.each([
    { bytes: [], eof: false },
    { bytes: [97], eof: true },
    { bytes: [97, 98], eof: false },
    { bytes: [97, 98, 99], eof: true },
    { bytes: [256, 98], eof: true },
    { bytes: [-1, 98], eof: true },
    { bytes: [1.5, 98], eof: true },
    { bytes: [NaN, 98], eof: true },
  ])('rejects malformed chunk metadata or bytes: %j', async chunk => {
    const info = serve('ab'); readChunk.mockResolvedValue(chunk);
    await expect(read(info)).rejects.toThrow('讀取不完整');
    expect(readChunk).toHaveBeenCalledTimes(1);
    expect(fileCacheBytes()).toBe(0);
  });

  it('propagates a version-change rejection and does not cache the partial result', async () => {
    const info = serve('a'.repeat(CHUNK_BYTES + 1));
    const implementation = readChunk.getMockImplementation()!;
    const changed = new Error('The file changed; inspect again');
    readChunk.mockImplementationOnce(implementation).mockRejectedValueOnce(changed);
    await expect(read(info)).rejects.toBe(changed);
    expect(readChunk).toHaveBeenCalledTimes(2);
    expect(fileCacheBytes()).toBe(0);
  });
});

describe('shared bounded text cache', () => {
  it('keys cached text by project, path, version, and size metadata', async () => {
    const info = serve('abc');
    await read(info); await read(info);
    expect(readChunk).toHaveBeenCalledTimes(1);
    await read({ ...info, version: 'version-2' });
    await read({ ...info, path: 'another.txt' });
    await read(info, undefined, 'another-project');
    const changedSize = serve('abcd');
    await read(changedSize);
    expect(readChunk).toHaveBeenCalledTimes(5);
    expect(fileCacheBytes()).toBe(4 * 6 + 8);
  });

  it('does not cache partial reads or entries over the 1 MiB UTF-16 payload cap', async () => {
    const partial = serve('abc');
    await read(partial, 0); await read(partial, 0);
    expect(fileCacheBytes()).toBe(0);
    const large = serve('a'.repeat(512 * 1024 + 1));
    await read(large); await read(large);
    expect(fileCacheBytes()).toBe(0);
    expect(readChunk).toHaveBeenCalledTimes(8);
  });

  it('shares the 8 MiB UTF-16 budget across projects and evicts least recently used entries', async () => {
    const info = serve('a'.repeat(512 * 1024));
    for (let index = 0; index < 8; index++) await read(info, undefined, `project-${index}`);
    expect(fileCacheBytes()).toBe(8 * 1024 * 1024);
    expect(readChunk).toHaveBeenCalledTimes(16);
    await read(info, undefined, 'project-0');
    await read(info, undefined, 'project-8');
    expect(readChunk).toHaveBeenCalledTimes(18);
    expect(fileCacheBytes()).toBe(8 * 1024 * 1024);
    await read(info, undefined, 'project-0');
    expect(readChunk).toHaveBeenCalledTimes(18);
    await read(info, undefined, 'project-1');
    expect(readChunk).toHaveBeenCalledTimes(20);
    expect(fileCacheBytes()).toBe(8 * 1024 * 1024);
  });

  it('bounds empty-file entries as well as the text payload', async () => {
    const populated = serve('abc'); await read(populated);
    for (let index = 0; index < 64; index++) await read({ ...populated, sizeBytes: 0, path: `empty-${index}.txt` });
    expect(fileCacheBytes()).toBe(0);
    await read(populated);
    expect(readChunk).toHaveBeenCalledTimes(2);
  });

  it('clears one project without clearing other cached workspaces', async () => {
    const info = serve('abc'); await read(info); await read(info, undefined, 'other');
    clearFileCache('project');
    expect(fileCacheBytes()).toBe(6);
    await read(info, undefined, 'other');
    expect(readChunk).toHaveBeenCalledTimes(2);
    await read(info);
    expect(readChunk).toHaveBeenCalledTimes(3);
    clearFileCache(); expect(fileCacheBytes()).toBe(0);
  });
});
