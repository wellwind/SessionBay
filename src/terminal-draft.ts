/** A local editor shortcut, never a terminal input encoding. */
export function isTerminalDraftKey(event: KeyboardEvent, composing = false): boolean {
  return event.type === 'keydown' && event.key === 'Enter' && event.shiftKey &&
    !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing &&
    !composing && event.keyCode !== 229;
}

export const terminalDraftShortcutHelp = '終端 Shift+Enter：開啟本機多行草稿；編輯不傳送輸入，需另外確認貼上。';
export const terminalDraftLimit = 256 * 1024 - 12; // Leave room for xterm bracketed-paste markers.

export function draftProblem(text: string): string | null {
  if (!text) return '請先輸入草稿。';
  // Do not allow an embedded ESC sequence to end bracketed paste or send control keys.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text))
    return '草稿含終端控制字元，請移除後再貼上。Tab 與換行可保留。';
  if (new TextEncoder().encode(text).byteLength > terminalDraftLimit)
    return '草稿超過 256 KiB 輸入上限，請分段貼上。';
  return null;
}

export function describeDraft(text: string): string {
  const newlines = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  const trailing = text.match(/(?:(?:\r\n)|\r|\n)+$/)?.[0].match(/\r\n|\r|\n/g)?.length ?? 0;
  return `${newlines + 1} 行 · ${trailing ? `末尾有 ${trailing} 個換行，會一併貼上` : '末尾沒有換行'}`;
}
