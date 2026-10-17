import { version as xtermVersion } from '@xterm/xterm/package.json';

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

interface PendingComposition {
  _textarea: HTMLTextAreaElement;
  _compositionView: HTMLElement;
  _finalizeComposition(waitForPropagation: boolean): void;
  _isComposing: boolean;
  _isSendingComposition: boolean;
  _compositionPosition: { start: number; end: number };
  _dataAlreadySent: string;
}

/** Pinned xterm 5.5.0 compatibility boundary. Fail open on an unknown shape. */
function compositionFor(terminal: unknown, textarea: HTMLTextAreaElement): PendingComposition | undefined {
  if (xtermVersion !== '5.5.0') return;
  const helper = (terminal as { _core?: { _compositionHelper?: Partial<PendingComposition> } })._core?._compositionHelper;
  if (!helper || helper._textarea !== textarea || !(helper._compositionView instanceof HTMLElement) || typeof helper._finalizeComposition !== 'function' || typeof helper._isComposing !== 'boolean' || typeof helper._isSendingComposition !== 'boolean' ||
    typeof helper._dataAlreadySent !== 'string' || !Number.isInteger(helper._compositionPosition?.start) ||
    !Number.isInteger(helper._compositionPosition?.end)) return;
  return helper as PendingComposition;
}

/**
 * Give xterm's propagation wait transaction identity, then reconcile CapsLock
 * insertText with that pending commit. All compositions use this finalizer so
 * an earlier non-CapsLock timer cannot steal/cancel a later CapsLock commit.
 * This adapter is pinned to xterm 5.5.0 and disposed with the terminal.
 * Its source-based tests must be revisited before upgrading that dependency.
 */
export function installCapsLockCommitGuard(host: HTMLElement, terminal: {
  textarea?: HTMLTextAreaElement;
  options?: { screenReaderMode?: boolean };
  input(data: string, wasUserInput?: boolean): void;
}): () => void {
  const textarea = terminal.textarea;
  if (!textarea) return () => {};
  const helper = compositionFor(terminal, textarea);
  if (!helper) return () => {};
  let capsLock = false;
  let disposed = false;
  const originalFinalize = helper._finalizeComposition;
  interface PendingCommit { start: number; end: number; timer: ReturnType<typeof setTimeout> }
  let pending: PendingCommit | undefined;

  // xterm 5.5 gives every deferred callback the same boolean. Clearing it is
  // not cancellation: the next compositionend can reactivate an old callback.
  // Own the existing 0ms propagation wait with a cancellable, identity-checked
  // transaction; do not introduce a debounce window or compare previous text.
  const consume = () => {
    const transaction = pending;
    if (!transaction) return;
    pending = undefined;
    clearTimeout(transaction.timer);
    helper._isSendingComposition = false;
    const start = transaction.start + helper._dataAlreadySent.length;
    const commit = helper._isComposing
      ? textarea.value.substring(start, transaction.end)
      : textarea.value.substring(start);
    if (commit) terminal.input(commit, true);
  };
  const finalize = (waitForPropagation: boolean) => {
    if (disposed) return;
    if (!waitForPropagation) {
      if (pending) {
        // A following key must observe the pending commit before its own bytes.
        consume();
        return;
      }
      originalFinalize.call(helper, false);
      return;
    }
    helper._compositionView.classList.remove('active');
    helper._isComposing = false;
    // A repeated end belongs to the same pending composition, not a new send.
    if (pending) return;
    const transaction: PendingCommit = {
      start: helper._compositionPosition.start,
      end: helper._compositionPosition.end,
      timer: setTimeout(() => {
        if (!disposed && pending === transaction) consume();
      }, 0),
    };
    pending = transaction;
    helper._isSendingComposition = true;
  };
  helper._finalizeComposition = finalize;
  const compositionStart = (event: Event) => {
    if (event.target !== textarea) return;
    // Finish the previous transaction before xterm overwrites its start and
    // already-sent offset. This event precedes the new preedit DOM insertion.
    capsLock = false;
    consume();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.target !== textarea || shouldHandleTerminalKey(event)) return;
    const helper = compositionFor(terminal, textarea);
    if (helper && (helper._isComposing || helper._isSendingComposition)) capsLock = true;
  };
  const input = (event: Event) => {
    if (!(event instanceof InputEvent) || event.target !== textarea || !capsLock ||
      event.inputType !== 'insertText' || !event.data || terminal.options?.screenReaderMode) return;
    const helper = compositionFor(terminal, textarea);
    if (!helper || helper._isComposing || !helper._isSendingComposition) return;
    if (!pending) return;
    const start = pending.start + helper._dataAlreadySent.length;
    if (start < 0 || start > textarea.value.length) return;
    const commit = textarea.value.substring(start);
    if (!commit || !commit.endsWith(event.data)) return;
    capsLock = false;
    event.stopPropagation();
    consume();
  };
  host.addEventListener('compositionstart', compositionStart, true);
  host.addEventListener('keydown', keyDown, true);
  host.addEventListener('input', input, true);
  return () => {
    disposed = true;
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
    helper._isSendingComposition = false;
    if (helper._finalizeComposition === finalize) helper._finalizeComposition = originalFinalize;
    host.removeEventListener('compositionstart', compositionStart, true);
    host.removeEventListener('keydown', keyDown, true);
    host.removeEventListener('input', input, true);
  };
}
