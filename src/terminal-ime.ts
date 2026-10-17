/**
 * Keep the semantic CapsLock guard: xterm 6.0 includes upstream #5282 for
 * keyCode 20, while this also recognizes a correctly named CapsLock event.
 * Only skip xterm key processing; never cancel the native DOM/IME event.
 */
export function shouldHandleTerminalKey(event: KeyboardEvent): boolean {
  const capsLock = event.key === 'CapsLock' ||
    ((!event.key || event.key === 'Unidentified') && event.keyCode === 20);
  return !(event.type === 'keydown' && capsLock);
}
