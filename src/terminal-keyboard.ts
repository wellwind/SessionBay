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
  if (options.composing || event.isComposing || event.keyCode === 229) return true;
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
  // Consume every phase, but emit only on keydown; no fallback CR on keypress.
  event.preventDefault();
  if (event.type === 'keydown' && options.canInput) options.input(shiftEnterSequence);
  return false;
}
