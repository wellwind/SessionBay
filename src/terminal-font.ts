/** Keep these aligned with the Settings/catalog validation and default. */
export const terminalFontMin = 9;
export const terminalFontMax = 32;
export const terminalFontDefault = 14;
export type TerminalFontAction = 'increase' | 'decrease' | 'reset';
export const terminalFontShortcutHelp = '終端字級（所有面板）：macOS ⌘＋／⌘＝、⌘−、⌘0；Linux Ctrl＋／Ctrl＝、Ctrl−、Ctrl0。每次 1 px，範圍 9–32 px，還原 14 px；立即套用並儲存，不改介面字級。輸入欄位、對話框及組字期間不處理。';
export function terminalFontShortcut(event: KeyboardEvent, mac = /Mac|iPhone|iPad/.test(navigator.platform)): TerminalFontAction | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.metaKey !== mac || event.ctrlKey !== !mac) return null;
  if (event.key === '+' || event.key === '=') return 'increase';
  if (event.key === '-') return 'decrease';
  if (event.key === '0') return 'reset';
  return null;
}
export function nextTerminalFontSize(size: number, action: TerminalFontAction): number {
  const current = Number.isInteger(size) ? size : terminalFontDefault;
  return action === 'reset' ? terminalFontDefault : Math.max(terminalFontMin, Math.min(terminalFontMax, current + (action === 'increase' ? 1 : -1)));
}
export function acceptsTerminalFontShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  // xterm's hidden textarea is the terminal input, not a settings/search field.
  if (target.matches('textarea.xterm-helper-textarea') && target.closest('.terminal-pane')) return true;
  return !target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}
