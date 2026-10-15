/**
 * xterm 5.5 treats CapsLock as a composition interruption and can send the same
 * preedit both on keydown and compositionend. Skip only that semantic key in
 * xterm; do not cancel the DOM event, OS input-source switch, or final commit.
 * Upstream now exempts keyCode 20 in CompositionHelper.keydown:
 * https://github.com/xtermjs/xterm.js/blob/master/src/browser/input/CompositionHelper.ts
 */
export function shouldHandleTerminalKey(event: KeyboardEvent): boolean {
  const capsLock = event.key === 'CapsLock' ||
    ((!event.key || event.key === 'Unidentified') && event.keyCode === 20);
  return !(event.type === 'keydown' && capsLock);
}
