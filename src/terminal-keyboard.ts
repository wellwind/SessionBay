import { shouldHandleTerminalKey } from './terminal-ime';

export const shiftEnterSequence = '\x1b[13;2u';

/** One-key compatibility binding; do not advertise Kitty/modifyOtherKeys support. */
export function handleTerminalKey(event: KeyboardEvent, options: {
  composing: boolean;
  canInput: boolean;
  blocked: boolean;
  input: (data: string) => void;
}): boolean {
  if (!shouldHandleTerminalKey(event)) return false;
  if (options.blocked || event.defaultPrevented) return false;
  // Follow the principle in pending upstream xterm PR #6191: a browser-marked
  // composing key must not prematurely finalize preedit merely because its
  // legacy keyCode differs from 229. Use the public hook, not private helpers.
  // This is not a claim that #6191 is merged, nor byte-for-byte upstream logic:
  // xterm sets _keyDownSeen before this hook and skips its scroll branch here.
  // Native composition/input events retain ownership of the final text.
  if (options.composing && event.type === 'keydown' && event.isComposing) return false;
  if (options.composing || event.isComposing || event.keyCode === 229) return true;
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
  // Consume every phase, but emit only on keydown; no fallback CR on keypress.
  event.preventDefault();
  if (event.type === 'keydown' && options.canInput) options.input(shiftEnterSequence);
  return false;
}
