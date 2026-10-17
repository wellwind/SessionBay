import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { shouldHandleTerminalKey } from '../../src/terminal-ime';
import { handleTerminalKey } from '../../src/terminal-keyboard';

// Synthetic data only: actual shipped xterm bundle, never a native IME claim.
const terminal = new Terminal({ cols: 80, rows: 24 });
const host = document.querySelector<HTMLElement>('#terminal')!;
let composing = false;
host.addEventListener('compositionstart', () => { composing = true; }, true);
host.addEventListener('compositionend', () => { composing = false; }, true);
const baseline = new URLSearchParams(location.search).has('baseline');
terminal.attachCustomKeyEventHandler(baseline ? shouldHandleTerminalKey : (event) => handleTerminalKey(event, {
  composing, blocked: false, canInput: true, input: (data) => terminal.input(data, true),
}));
terminal.open(host); terminal.focus();
const sent: string[] = [];
terminal.onData((data) => sent.push(data));
const textarea = terminal.textarea!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
function start(text: string) {
  textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  textarea.value += text;
  textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
}
function key(type: string, init: KeyboardEventInit) {
  textarea.dispatchEvent(new KeyboardEvent(type, { bubbles: true, composed: true, cancelable: true, ...init }));
}
function end() { textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); }
function input(inputType: string, data: string | null) {
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data }));
}
function nativeCommit(legacyCode = 0) {
  key('keydown', { key: 'CapsLock', keyCode: 20, isComposing: true });
  key('keydown', { key: 'Unidentified', keyCode: legacyCode, isComposing: true });
  textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'deleteCompositionText' }));
  textarea.value = ''; input('deleteCompositionText', null);
  textarea.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertFromComposition', data: '中文' }));
  textarea.value = '中文'; input('insertFromComposition', '中文'); end();
  key('keyup', { key: 'CapsLock', keyCode: 20 });
}
(window as unknown as { imeScenario: (scenario: string) => Promise<string[]> }).imeScenario = async (scenario) => {
  start('中文'); await tick();
  if (scenario === 'cancel') { textarea.value = ''; end(); }
  else if (scenario === 'dispose') { end(); terminal.dispose(); }
  else if (scenario === 'composition-enter' || scenario === 'composition-shift-enter') {
    key('keydown', { key: 'Enter', keyCode: 13, isComposing: true, shiftKey: scenario === 'composition-shift-enter' });
    input('insertFromComposition', '中文'); end();
  } else nativeCommit(scenario === 'legacy229' ? 229 : 0);
  await tick();
  if (scenario === 'blur') textarea.blur();
  if (scenario === 'enter') key('keydown', { key: 'Enter', keyCode: 13 });
  if (scenario === 'ctrl-c') key('keydown', { key: 'c', keyCode: 67, ctrlKey: true });
  if (scenario === 'shift-enter') key('keydown', { key: 'Enter', keyCode: 13, shiftKey: true });
  if (scenario === 'repeat') {
    textarea.value = ''; start('中文'); await tick(); nativeCommit(); await tick();
  }
  return sent;
};

(window as unknown as { imeAddons: () => Promise<boolean> }).imeAddons = async () => {
  const fit = new FitAddon(); const search = new SearchAddon();
  terminal.loadAddon(fit); terminal.loadAddon(search); fit.fit();
  await new Promise<void>((resolve) => terminal.write('synthetic 中文 marker', resolve));
  const found = search.findNext('中文');
  search.clearDecorations(); fit.dispose(); search.dispose();
  return found && terminal.cols > 0 && terminal.rows > 0;
};
