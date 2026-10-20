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

/**
 * Commit-only IME input: with WebKitGTK + fcitx5 (chewing observed) the preedit
 * stays in the IME, so the page only sees `keydown(229)` →
 * `input(insertFromComposition)` → `compositionend`, with no `compositionstart`.
 * xterm 6's CompositionHelper then sends the commit twice: the 229 keydown
 * diffs the whole helper textarea (`newValue.replace(oldValue, '')`), and the
 * orphan compositionend sends `textarea.value.substring(stale start + already
 * sent length)`. The textarea keeps earlier spaces/commits until Enter, so any
 * existing text before the cursor makes those offsets overlap (duplicated last
 * character, or WebKit's NBSP-normalised spaces resent with the commit).
 *
 * SessionBay owns only this commit-only path: xterm never diffs a 229 keydown
 * outside a real composition, and an orphan compositionend sends its `data`
 * exactly once. Compositions that do start (`compositionstart`) remain owned
 * by xterm, including Backspace/selection inside the preedit.
 */
export class TerminalImeCommitGuard {
  private composingNow = false;
  private pendingImeKey = false;

  constructor(private readonly send: (data: string) => void) {}

  get composing(): boolean { return this.composingNow; }

  compositionStart(): void {
    this.composingNow = true;
    this.pendingImeKey = false;
  }

  /** Returns true when SessionBay consumed the event; xterm must not see it. */
  compositionEnd(event: Pick<CompositionEvent, 'data'>): boolean {
    if (this.composingNow) {
      this.composingNow = false;
      return false;
    }
    this.pendingImeKey = false;
    if (event.data) this.send(event.data);
    return true;
  }

  /** Returns true when xterm must skip this key event (its 229 textarea diff). */
  suppressXtermKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return false;
    if (this.composingNow || event.isComposing || event.keyCode !== 229) {
      if (!this.composingNow && event.keyCode !== 229) this.pendingImeKey = false;
      return false;
    }
    this.pendingImeKey = true;
    return true;
  }

  /**
   * Plain text an IME inserts after a suppressed 229 keydown without any
   * composition (e.g. punctuation/digits). xterm ignores composed insertText
   * after a keydown, so this is the only sender. Returns true when consumed.
   */
  input(event: Pick<InputEvent, 'inputType' | 'data'>): boolean {
    if (!this.pendingImeKey || this.composingNow) return false;
    if (event.inputType !== 'insertText' || !event.data) return false;
    this.pendingImeKey = false;
    this.send(event.data);
    return true;
  }
}
