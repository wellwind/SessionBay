import type { Pane } from './types';

export const imageLimits = { perFile: 10 * 1024 * 1024, total: 20 * 1024 * 1024, count: 4, chunk: 64 * 1024 };
export type ImageProvider = 'codex' | 'claude' | 'grok' | 'opencode';
export function imageProvider(kind: string): ImageProvider | null {
  return ['codex', 'claude', 'grok', 'opencode'].includes(kind) ? kind as ImageProvider : null;
}
export function imageUnsupportedReason(kind: string): string {
  return kind === 'antigravity'
    ? 'Antigravity 的圖片路徑附件尚未驗證，請在原生 CLI 使用圖片貼上。'
    : '圖片輸入僅支援本機 Codex、Claude Code、Grok Build 與 OpenCode；Shell、SSH／WSL 包裝程式尚未支援。';
}
/** xterm emits an intact bracketed paste as one event; its newlines are prompt text.
 * Split/nested frames and nonstandard key bindings cannot be inferred reliably. */
export function imageInputChangesPrompt(data: string): boolean {
  const start = '\x1b[200~', end = '\x1b[201~';
  const body = data.slice(start.length, -end.length);
  if (data.startsWith(start) && data.endsWith(end) && !body.includes(start) && !body.includes(end)) return false;
  // eslint-disable-next-line no-control-regex -- Standard Enter and prompt interruption bytes.
  return /[\r\n\x03\x04\x1a\x1c]/.test(data);
}

export interface ImageInputApi {
  beginImage: (runtimeId: string, mime: string, size: number) => Promise<string>;
  appendImage: (runtimeId: string, id: string, offset: number, bytes: number[]) => Promise<void>;
  finishImage: (runtimeId: string, id: string) => Promise<{ id: string; path: string }>;
  retainImage: (runtimeId: string, id: string) => Promise<void>;
  discardImage: (runtimeId: string, id: string) => Promise<void>;
}
export function imageMime(file: Pick<File, 'name' | 'type'>): string {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const extension = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : null;
  if (!extension || (file.type && file.type !== extension)) throw new Error('僅接受副檔名與格式一致的 PNG、JPEG 圖片。');
  return extension;
}
export function validateImageFiles(files: readonly File[]): void {
  if (!files.length || files.length > imageLimits.count) throw new Error('一次最多加入 4 張圖片。');
  let total = 0;
  for (const file of files) {
    imageMime(file);
    if (!file.size || file.size > imageLimits.perFile) throw new Error('每張圖片須介於 1 byte 與 10 MiB。');
    total += file.size;
  }
  if (total > imageLimits.total) throw new Error('一次加入的圖片合計不得超過 20 MiB。');
}

/** File URL percent-encoding is recognized by these three pinned provider parsers.
 * Claude's documented fallback is an ordinary image path reference, not a native attachment claim. */
export function imagePasteText(provider: ImageProvider, path: string): string {
  // eslint-disable-next-line no-control-regex -- Reject terminal control bytes before insertion.
  if (!path || /[\x00-\x1f\x7f'"`$;|&<>()]/.test(path)) throw new Error('圖片路徑含不安全字元。');
  // Reject device/UNC namespaces, including canonical Win32 extended paths except a local drive.
  const local = path.replace(/^\\\\\?\\([A-Za-z]:\\)/, '$1');
  const windows = /^[A-Za-z]:[\\/]/.test(local);
  if (!windows && !local.startsWith('/')) throw new Error('圖片路徑必須是本機絕對路徑。');
  if (local.startsWith('//') || local.startsWith('\\')) throw new Error('網路圖片路徑尚未支援。');
  if (new TextEncoder().encode(local).length > 512) throw new Error('圖片暫存路徑過長。');
  if (provider === 'claude') return `"${local}" `;
  const slashPath = windows ? `/${local.replaceAll('\\', '/')}` : local;
  const encoded = slashPath.split('/').map((part, index) => windows && index === 1 ? part : encodeURIComponent(part)).join('/');
  if (encoded.length > 512) throw new Error('圖片暫存路徑編碼後過長。');
  return `file://${encoded}`;
}

/** No provider process is started and no bytes are written to the PTY here. */
export async function insertImageFiles(options: {
  files: readonly File[]; kind: Pane['kind']; runtimeId: string; api: ImageInputApi;
  isCurrent: () => boolean; paste: (text: string) => void;
}): Promise<number> {
  const provider = imageProvider(options.kind);
  if (!provider) throw new Error(imageUnsupportedReason(options.kind));
  validateImageFiles(options.files);
  const staged: Array<{ id: string; path: string; retainAttempted: boolean }> = [];
  let pending: string | undefined;
  let failure: unknown;
  let inserted = 0;
  const check = () => { if (!options.isCurrent()) throw new Error('圖片輸入已取消：目標面板、連線或目前輸入已變更。'); };
  try {
    // Verify the whole batch before inserting any image. Each read/IPC is bounded and ordered.
    for (const file of options.files) {
      check();
      pending = await options.api.beginImage(options.runtimeId, imageMime(file), file.size);
      check();
      for (let offset = 0; offset < file.size; offset += imageLimits.chunk) {
        const bytes = await file.slice(offset, offset + imageLimits.chunk).arrayBuffer();
        check();
        await options.api.appendImage(options.runtimeId, pending, offset, Array.from(new Uint8Array(bytes)));
        check();
      }
      const image = await options.api.finishImage(options.runtimeId, pending);
      check();
      if (image.id !== pending) throw new Error('圖片暫存識別不符。');
      imagePasteText(provider, image.path); // Validate before retaining anything.
      staged.push({ ...image, retainAttempted: false });
      pending = undefined;
    }
    for (const image of staged) {
      check();
      // Never remove a file following an uncertain retain/terminal write.
      image.retainAttempted = true;
      await options.api.retainImage(options.runtimeId, image.id);
      check();
      options.paste(imagePasteText(provider, image.path));
      inserted += 1;
    }
  } catch (error) {
    failure = error;
  }
  {
    const unused = [...staged.filter((image) => !image.retainAttempted).map((image) => image.id), ...(pending ? [pending] : [])];
    const cleanup = await Promise.allSettled(unused.map((id) => options.api.discardImage(options.runtimeId, id)));
    if (cleanup.some((result) => result.status === 'rejected')) {
      failure = new Error('未插入的圖片暫存清理失敗，請重新開啟應用程式後檢查暫存空間。');
    }
  }
  if (failure) throw failure;
  return inserted;
}
