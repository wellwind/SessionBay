import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { installCapsLockCommitGuard, shouldHandleTerminalKey } from '../../src/terminal-ime';

// Synthetic data only. This tests the shipped bundle, not a native IME.
const terminal = new Terminal({ cols: 80, rows: 24 });
const host = document.querySelector<HTMLElement>('#terminal')!;
terminal.attachCustomKeyEventHandler(shouldHandleTerminalKey);
terminal.open(host);
terminal.focus();
const sent: string[] = [];
terminal.onData((data) => sent.push(data));
if (!new URLSearchParams(location.search).has('baseline')) installCapsLockCommitGuard(host, terminal);
const textarea = terminal.textarea!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function start(text: string) {
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  textarea.value += text;
  textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
}
function caps() {
  for (const type of ['keydown', 'keyup']) {
    textarea.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'CapsLock', code: 'CapsLock', keyCode: 20 }));
  }
}
function end() { textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); }
function input(text: string) {
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
}
(window as unknown as { imeScenario: (scenario: string) => Promise<string[]> }).imeScenario = async (scenario) => {
  start('中文'); await tick();
  if (!['pending-restart', 'ordinary-restart'].includes(scenario)) caps();
  if (scenario === 'cancel') textarea.value = '';
  end();
  if (!['cancel', 'pending-restart', 'ordinary-restart'].includes(scenario)) input('中文');
  if (scenario === 'blur') textarea.blur();
  if (scenario === 'enter') textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
  if (['consumed-restart', 'pending-restart', 'ordinary-restart'].includes(scenario)) {
    start('中文');
    if (scenario === 'pending-restart') caps();
    end();
    if (scenario === 'pending-restart') input('中文');
  }
  await tick();
  if (scenario === 'repeat') {
    start('中文'); await tick(); caps(); end(); input('中文'); await tick();
  }
  return sent;
};
