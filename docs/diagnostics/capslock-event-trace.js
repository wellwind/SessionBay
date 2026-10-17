// Paste into the app's Web Inspector only while testing a synthetic empty
// terminal. Records metadata/lengths, never composition data or textarea text.
// stopSessionBayImeTrace() removes listeners and returns at most 256 rows.
(() => {
  if (typeof window.stopSessionBayImeTrace === 'function') {
    throw new Error('An IME trace is already installed; stop it before replacing it.');
  }
  const events = ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input', 'focus', 'blur'];
  const rows = [];
  const started = performance.now();
  const safeKeys = new Set(['CapsLock', 'Enter', 'Escape', 'Shift', 'Control', 'Alt', 'Meta', 'Process', 'Unidentified']);
  const record = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains('xterm-helper-textarea')) return;
    if (rows.length >= 256) return;
    rows.push({
      milliseconds: +(performance.now() - started).toFixed(3),
      event: event.type, trusted: event.isTrusted, composed: event.composed,
      key: safeKeys.has(event.key) ? event.key : (typeof event.key === 'string' ? 'other' : undefined),
      composing: typeof event.isComposing === 'boolean' ? event.isComposing : undefined,
      inputType: event.inputType,
      dataLength: typeof event.data === 'string' ? event.data.length : undefined,
      textareaLength: target.value.length,
      selectionStart: target.selectionStart, selectionEnd: target.selectionEnd,
      phase: event.eventPhase,
    });
  };
  events.forEach((name) => document.addEventListener(name, record, true));
  window.stopSessionBayImeTrace = () => {
    events.forEach((name) => document.removeEventListener(name, record, true));
    delete window.stopSessionBayImeTrace;
    return rows.slice();
  };
  return 'Trace installed. Enter only synthetic sample text, reproduce once, then run stopSessionBayImeTrace().';
})();
