import { api } from '../api';
import type { WorkspaceFileInfo } from '../types';

export const NORMAL_FILE_BYTES = 20 * 1024 * 1024;
export const FULL_FILE_BYTES = 64 * 1024 * 1024;
export const RANGE_BYTES = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const MAX_LINES = 300000;
const CACHE_BYTES = 8 * 1024 * 1024;
const CACHE_ENTRY_BYTES = 1024 * 1024;
const CACHE_ENTRIES = 64;
export class RangeRequired extends Error {}
export interface ReadText {
  text: string; lines: number; longestLine: number;
  start: number; end: number; partial: boolean; lightweight: boolean;
}

// Shared across projects, including hidden workspaces. Budget estimates UTF-16
// payload; the entry limit also bounds metadata and empty-file entries. Models
// exist only for the visible document and are never cached here.
const cache = new Map<string, { value: ReadText; bytes: number }>();
let cachedBytes = 0;
const keyFor = (project: string, info: WorkspaceFileInfo) => JSON.stringify([project, info.path, info.version, info.sizeBytes]);
export function clearFileCache(project?: string): void {
  for (const [key, entry] of cache) {
    if (project === undefined || (JSON.parse(key) as unknown[])[0] === project) {
      cachedBytes -= entry.bytes; cache.delete(key);
    }
  }
}
export function fileCacheBytes(): number { return cachedBytes; }
function remember(key: string, value: ReadText): void {
  const bytes = value.text.length * 2;
  if (value.partial || bytes > CACHE_ENTRY_BYTES) return;
  const previous = cache.get(key);
  if (previous) { cachedBytes -= previous.bytes; cache.delete(key); }
  while ((cachedBytes + bytes > CACHE_BYTES || cache.size >= CACHE_ENTRIES) && cache.size) {
    const oldest = cache.keys().next().value!;
    cachedBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
  }
  cache.set(key, { value, bytes }); cachedBytes += bytes;
}
function check(signal: AbortSignal): void { signal.throwIfAborted(); }
// Called only after fatal streaming decoding has validated these bytes. Keep
// four raw bytes so a character spanning two short IPC chunks is counted once.
function incompleteTail(bytes: Uint8Array): number {
  let start = bytes.length - 1;
  while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start--;
  if (start < 0) return bytes.length;
  const lead = bytes[start];
  const expected = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
  return bytes.length - start < expected ? bytes.length - start : 0;
}

/** One bounded IPC request at a time. Aborting prevents subsequent reads. */
export async function readWorkspaceText(project: string, info: WorkspaceFileInfo, signal: AbortSignal,
  progress: (bytes: number) => void, rangeStart?: number): Promise<ReadText> {
  check(signal);
  if (!Number.isSafeInteger(info.sizeBytes) || info.sizeBytes < 0) throw new Error('檔案大小無法安全表示');
  if (info.kind !== 'text') throw new Error('此檔案不是支援的 UTF-8 文字');
  if (typeof info.version !== 'string' || !info.version) throw new Error('檔案版本無效，請重新整理');
  const partial = rangeStart !== undefined;
  if (!partial && info.sizeBytes > FULL_FILE_BYTES) throw new RangeRequired();
  const key = keyFor(project, info);
  const retained = !partial && cache.get(key);
  if (retained) { cache.delete(key); cache.set(key, retained); return retained.value; }
  let offset = rangeStart ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.sizeBytes) throw new Error('無效閱讀位置');
  const limit = offset + Math.min(info.sizeBytes - offset, partial ? RANGE_BYTES : FULL_FILE_BYTES);
  let start = offset;
  let end = offset;
  let lines = 1, lineLength = 0, longestLine = 0;
  let previousCR = false;
  let skipPrefix = partial && offset > 0;
  let skippedPrefix = 0;
  let tail = new Uint8Array(0);
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: offset > 0 });
  const parts: string[] = [];
  while (offset < limit) {
    check(signal);
    const length = Math.min(CHUNK_BYTES, limit - offset);
    const result = await api.readWorkspaceFileChunk(project, info.path, info.version, offset, length);
    check(signal);
    if (!result.bytes.length || result.bytes.length > length
      || result.bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
      || result.eof !== (offset + result.bytes.length === info.sizeBytes))
      throw new Error('檔案讀取不完整，請重新整理');
    let bytes = Uint8Array.from(result.bytes);
    offset += bytes.length;
    // A previous-range jump can land inside a UTF-8 sequence. Skip at most its
    // continuation prefix, even across short reads. Next-range jumps use end
    // and lose no code point.
    if (skipPrefix) {
      let skipped = 0;
      while (skipped < bytes.length && skippedPrefix < 3 && (bytes[skipped] & 0xc0) === 0x80) {
        skipped++; skippedPrefix++;
      }
      bytes = bytes.subarray(skipped); start += skipped;
      if (bytes.length || skippedPrefix === 3) skipPrefix = false;
    }
    const recent = new Uint8Array(Math.min(4, tail.length + bytes.length));
    const preceding = Math.max(0, recent.length - bytes.length);
    if (preceding) recent.set(tail.subarray(tail.length - preceding));
    recent.set(bytes.subarray(Math.max(0, bytes.length - recent.length)), preceding);
    tail = recent;
    // At a non-EOF range boundary, streaming decoding retains an unfinished
    // character instead of turning a valid split into an invalid UTF-8 error.
    // Its raw bytes are excluded from end so the next range reads them again.
    let text = decoder.decode(bytes, { stream: offset < info.sizeBytes });
    end = offset - (offset < info.sizeBytes ? incompleteTail(tail) : 0);
    let lineLimitReached = false;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127)
        throw new Error('檔案包含非文字控制字元');
      if (code === 13 || code === 10) {
        if (code === 13 || !previousCR) {
          if (lines === MAX_LINES) {
            if (!partial) throw new RangeRequired();
            // The omitted suffix starts at a complete newline/code point.
            // Account in UTF-8 bytes, including any decoder tail excluded
            // above, so the next window resumes without gaps or duplicates.
            end -= new TextEncoder().encode(text.slice(index)).length;
            text = text.slice(0, index); lineLimitReached = true;
            break;
          }
          lines++;
        }
        longestLine = Math.max(longestLine, lineLength); lineLength = 0;
      } else lineLength++;
      previousCR = code === 13;
    }
    parts.push(text); progress(offset - start);
    if (lineLimitReached) break;
  }
  longestLine = Math.max(longestLine, lineLength);
  const value = { text: parts.join(''), lines, longestLine, start, end, partial,
    lightweight: partial || info.sizeBytes > NORMAL_FILE_BYTES || longestLine > 20000 };
  check(signal); remember(key, value); return value;
}
