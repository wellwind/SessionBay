import type { Pane } from './types';
import { t } from './i18n';

export const imageLimits = { perFile: 10 * 1024 * 1024, total: 20 * 1024 * 1024, count: 4, chunk: 64 * 1024 };
export type ImageProvider = 'codex' | 'claude' | 'grok' | 'opencode';
export function imageProvider(kind: string): ImageProvider | null {
  return ['codex', 'claude', 'grok', 'opencode'].includes(kind) ? kind as ImageProvider : null;
}
export function imageUnsupportedReason(kind: string): string {
  return kind === 'antigravity'
    ? t('Image path attachments are not verified for Antigravity yet; paste images in the native CLI instead.')
    : t('Image input only supports local Codex, Claude Code, Grok Build and OpenCode; shells and SSH / WSL wrappers are not supported yet.');
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
  if (!extension || (file.type && file.type !== extension)) throw new Error(t('Only PNG and JPEG images whose extension matches their format are accepted.'));
  return extension;
}
export function validateImageFiles(files: readonly File[]): void {
  if (!files.length || files.length > imageLimits.count) throw new Error(t('You can add up to 4 images at a time.'));
  let total = 0;
  for (const file of files) {
    imageMime(file);
    if (!file.size || file.size > imageLimits.perFile) throw new Error(t('Each image must be between 1 byte and 10 MiB.'));
    total += file.size;
  }
  if (total > imageLimits.total) throw new Error(t('Images added at once cannot exceed 20 MiB in total.'));
}

/** File URL percent-encoding is recognized by these three pinned provider parsers.
 * Claude's documented fallback is an ordinary image path reference, not a native attachment claim. */
export function imagePasteText(provider: ImageProvider, path: string): string {
  // eslint-disable-next-line no-control-regex -- Reject terminal control bytes before insertion.
  if (!path || /[\x00-\x1f\x7f'"`$;|&<>()]/.test(path)) throw new Error(t('The image path contains unsafe characters.'));
  // Reject device/UNC namespaces, including canonical Win32 extended paths except a local drive.
  const local = path.replace(/^\\\\\?\\([A-Za-z]:\\)/, '$1');
  const windows = /^[A-Za-z]:[\\/]/.test(local);
  if (!windows && !local.startsWith('/')) throw new Error(t('The image path must be a local absolute path.'));
  if (local.startsWith('//') || local.startsWith('\\')) throw new Error(t('Network image paths are not supported yet.'));
  if (new TextEncoder().encode(local).length > 512) throw new Error(t('The temporary image path is too long.'));
  if (provider === 'claude') return `"${local}" `;
  const slashPath = windows ? `/${local.replaceAll('\\', '/')}` : local;
  const encoded = slashPath.split('/').map((part, index) => windows && index === 1 ? part : encodeURIComponent(part)).join('/');
  if (encoded.length > 512) throw new Error(t('The temporary image path is too long once encoded.'));
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
  const check = () => { if (!options.isCurrent()) throw new Error(t('Image input was cancelled: the target pane, connection or current input changed.')); };
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
      if (image.id !== pending) throw new Error(t('The temporary image ID does not match.'));
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
      failure = new Error(t('Could not clean up temporary images that were not inserted. Reopen the app and check the temporary storage.'));
    }
  }
  if (failure) throw failure;
  return inserted;
}
