import type { Pane } from './types';

export const fileLimits = { perFile: 10 * 1024 * 1024, total: 20 * 1024 * 1024, count: 4, chunk: 64 * 1024 };
export type FileProvider = 'codex' | 'claude' | 'grok' | 'opencode';
export function fileProvider(kind: string): FileProvider | null {
  return ['codex', 'claude', 'grok', 'opencode'].includes(kind) ? kind as FileProvider : null;
}
export function fileUnsupportedReason(kind: string): string {
  return kind === 'antigravity'
    ? 'Antigravity 的檔案路徑輸入尚未驗證，請在原生 CLI 加入檔案。'
    : '檔案輸入僅支援本機 Codex、Claude Code、Grok Build 與 OpenCode；Shell、SSH／WSL 包裝程式尚未支援。';
}
/** xterm emits an intact bracketed paste as one event; its newlines are prompt text.
 * Split/nested frames and nonstandard key bindings cannot be inferred reliably. */
export function fileInputChangesPrompt(data: string): boolean {
  const start = '\x1b[200~', end = '\x1b[201~';
  const body = data.slice(start.length, -end.length);
  if (data.startsWith(start) && data.endsWith(end) && !body.includes(start) && !body.includes(end)) return false;
  // eslint-disable-next-line no-control-regex -- Standard Enter and prompt interruption bytes.
  return /[\r\n\x03\x04\x1a\x1c]/.test(data);
}

export interface FileInputApi {
  beginFile: (runtimeId: string, name: string, size: number) => Promise<string>;
  appendFile: (runtimeId: string, id: string, offset: number, bytes: number[]) => Promise<void>;
  finishFile: (runtimeId: string, id: string) => Promise<{ id: string; path: string; originalName: string; name: string }>;
  retainFile: (runtimeId: string, id: string) => Promise<void>;
  discardFile: (runtimeId: string, id: string) => Promise<void>;
}
export function validateFiles(files: readonly File[]): void {
  if (!files.length || files.length > fileLimits.count) throw new Error('請選擇 1 至 4 個檔案。');
  let total = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > fileLimits.perFile) throw new Error('每個檔案最多 10 MiB（支援空檔案）。');
    total += file.size;
  }
  if (total > fileLimits.total) throw new Error('一次加入的檔案合計不得超過 20 MiB。');
}

/** Native paste candidates are hints, not validation or a delivery receipt.
 * Keep other files as filesystem paths that the agent can read with its tools. */
export function filePasteMode(provider: FileProvider, path: string): 'image' | 'document' | 'svg-text' | 'reference' {
  const ext = path.split('.').pop()?.toLowerCase();
  if (provider === 'claude') return 'reference';
  if (provider === 'opencode') {
    if (ext === 'pdf') return 'document';
    if (ext === 'svg') return 'svg-text';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext ?? '')) return 'image';
  }
  if (provider === 'codex' || provider === 'grok') {
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'tif'].includes(ext ?? '')) return 'image';
  }
  return 'reference';
}

export function fileInputGuidance(provider: FileProvider, names: readonly string[]): string {
  const modes = new Set(names.map((name) => filePasteMode(provider, name)));
  const native = modes.has('image') || modes.has('document');
  if (native && (modes.has('reference') || modes.has('svg-text'))) return '請確認圖片／PDF 附件標記；其他檔案請要求 Agent 讀取路徑。';
  if (native) return '請在 Agent 確認附件標記後送出。';
  return '目前為路徑參照，請補充讀取要求後送出。';
}

/** One complete path per paste; no caption or Enter is mixed into native detection. */
export function filePasteText(provider: FileProvider, path: string): string {
  // eslint-disable-next-line no-control-regex -- Reject terminal control bytes before insertion.
  if (!path || /[\x00-\x1f\x7f'"`$;|&<>()]/.test(path)) throw new Error('檔案路徑含不安全字元。');
  // Reject device/UNC namespaces, including canonical Win32 extended paths except a local drive.
  const local = path.replace(/^\\\\\?\\([A-Za-z]:\\)/, '$1');
  const windows = /^[A-Za-z]:[\\/]/.test(local);
  if (!windows && !local.startsWith('/')) throw new Error('檔案路徑必須是本機絕對路徑。');
  if (local.startsWith('//') || local.startsWith('\\')) throw new Error('網路檔案路徑尚未支援。');
  if (new TextEncoder().encode(local).length > 512) throw new Error('檔案暫存路徑過長。');
  if (provider === 'claude' || (provider !== 'grok' && filePasteMode(provider, local) === 'reference')) return `"${local}" `;
  const slashPath = windows ? `/${local.replaceAll('\\', '/')}` : local;
  const encoded = slashPath.split('/').map((part, index) => windows && index === 1 ? part : encodeURIComponent(part)).join('/');
  if (encoded.length > 512) throw new Error('檔案暫存路徑編碼後過長。');
  return `file://${encoded} `;
}

/** Clipboard representations have no original filename. Keep their known binary format. */
export function clipboardFileName(mime: string): string {
  const extensions: Record<string, string> = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
    'image/x-icon': 'ico', 'application/pdf': 'pdf', 'application/zip': 'zip',
    'application/json': 'json', 'application/octet-stream': 'bin',
  };
  return `clipboard.${extensions[mime.toLowerCase()] ?? 'bin'}`;
}

/** Escaped, bounded display only: never echo filename controls or bidi formatting to the UI. */
export function displayFileName(name: string): string {
  const tokens = Array.from(name, (character) => {
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
      const code = character.codePointAt(0)!;
      return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
    }
    return JSON.stringify(character).slice(1, -1);
  });
  if (tokens.join('').length <= 96) return `"${tokens.join('')}"`;
  let head = '', tail = '';
  for (const token of tokens) { if (head.length + token.length > 64) break; head += token; }
  for (const token of [...tokens].reverse()) { if (tail.length + token.length > 24) break; tail = token + tail; }
  return `"${head}…${tail}"`;
}

export class FileInputError extends Error {
  constructor(message: string, readonly mayHaveInserted: boolean) { super(message); this.name = 'FileInputError'; }
}

/** Reject directories before any file is staged, including mixed file/directory drops. */
export function hasDirectory(items: ArrayLike<DataTransferItem>): boolean {
  return Array.from(items).some((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory);
}

/** No provider process is started and no bytes are written to the PTY here. */
export async function insertFiles(options: {
  files: readonly File[]; kind: Pane['kind']; runtimeId: string; api: FileInputApi;
  isCurrent: () => boolean;
  /** Call markAttempted immediately before terminal.paste, after any queue/target checks. */
  paste: (text: string, markAttempted: () => void) => void;
  onRenamed?: (originalName: string, name: string) => void;
}): Promise<number> {
  const provider = fileProvider(options.kind);
  if (!provider) throw new Error(fileUnsupportedReason(options.kind));
  validateFiles(options.files);
  const staged: Array<{ id: string; path: string; retainAttempted: boolean }> = [];
  let pending: string | undefined;
  let failure: unknown;
  let inserted = 0;
  let pasteAttempted = false;
  const check = () => { if (!options.isCurrent()) throw new Error('檔案輸入已取消：目標面板、連線或目前輸入已變更。'); };
  try {
    // Verify the whole batch before inserting any file. Each read/IPC is bounded and ordered.
    for (const file of options.files) {
      check();
      pending = await options.api.beginFile(options.runtimeId, file.name, file.size);
      check();
      for (let offset = 0; offset < file.size; offset += fileLimits.chunk) {
        const bytes = await file.slice(offset, offset + fileLimits.chunk).arrayBuffer();
        check();
        await options.api.appendFile(options.runtimeId, pending, offset, Array.from(new Uint8Array(bytes)));
        check();
      }
      const result = await options.api.finishFile(options.runtimeId, pending);
      check();
      if (result.id !== pending) throw new Error('檔案暫存識別不符。');
      filePasteText(provider, result.path); // Validate before retaining anything.
      if (result.originalName !== result.name) options.onRenamed?.(result.originalName, result.name);
      staged.push({ ...result, retainAttempted: false });
      pending = undefined;
    }
    for (const file of staged) {
      check();
      // Never remove a file following an uncertain retain/terminal write.
      file.retainAttempted = true;
      await options.api.retainFile(options.runtimeId, file.id);
      check();
      options.paste(filePasteText(provider, file.path), () => { pasteAttempted = true; });
      inserted += 1;
    }
  } catch (error) {
    failure = error;
  }
  {
    const unused = [...staged.filter((file) => !file.retainAttempted).map((file) => file.id), ...(pending ? [pending] : [])];
    const cleanup = await Promise.allSettled(unused.map((id) => options.api.discardFile(options.runtimeId, id)));
    if (cleanup.some((result) => result.status === 'rejected')) {
      failure = new Error('未插入的檔案暫存清理失敗，請重新開啟應用程式後檢查暫存空間。');
    }
  }
  if (failure) throw new FileInputError(failure instanceof Error ? failure.message : String(failure), inserted > 0 || pasteAttempted);
  return inserted;
}
