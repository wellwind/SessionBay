import { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Dialog } from './Dialog';
import { describeDraft, draftProblem } from '../terminal-draft';

export interface DraftDestination {
  title: string;
  cwd: string;
  runtimeId: string;
}

export function TerminalDraftDialog({ text, target, available, busy, result, onChange, onPaste, onClose, onNew, onRestoreFocus }: {
  text: string;
  target: DraftDestination;
  available: boolean;
  busy: boolean;
  result: string;
  onChange: (text: string) => void;
  onPaste: () => void;
  onClose: () => void;
  onNew: () => void;
  onRestoreFocus: () => void;
}) {
  const id = useId();
  const composing = useRef(false);
  const problem = draftProblem(text);
  return createPortal(
    <Dialog title="多行草稿" wide onClose={onClose} onRestoreFocus={onRestoreFocus}>
      <div className="terminal-draft"
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => {
          // IME Escape belongs to composition, not the surrounding dialog.
          if (event.key === 'Escape' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229))
            event.stopPropagation();
        }}>
        <p id={`${id}-help`} className="dialog-description">
          在這裡按 Enter 或 Shift+Enter 都只換行。草稿不會讀取終端目前已輸入的文字，也不會自動送出。
          關閉後保留於此面板，關閉面板或應用程式後不保留。
        </p>
        <div className="terminal-draft-target">
          <strong>貼上目標：{target.title}</strong>
          <span>{target.cwd || '未指定目錄'}</span>
          <span>Runtime：{target.runtimeId}</span>
        </div>
        <label className="field-label" htmlFor={id}>草稿內容</label>
        <textarea id={id} aria-describedby={`${id}-help ${id}-summary ${id}-warning`}
          value={text} readOnly={busy} onChange={(event) => onChange(event.target.value)} spellCheck={false} rows={10} />
        <p id={`${id}-summary`} className="terminal-draft-summary">{describeDraft(text)}</p>
        <p id={`${id}-warning`} className="terminal-draft-warning">
          貼上多行或末尾換行可能立即執行指令或送出提示。會使用終端原有的貼上機制，且不額外加入 Enter；實際結果由前景程式決定。
        </p>
        {!available && <p role="alert">原目標已退出、斷線或重新連接，這份草稿不能貼上。可先複製文字，再為目前終端另開草稿。</p>}
        {text && problem && <p role="alert">{problem}</p>}
        {result && <p role="status">{result}</p>}
        <div className="dialog-actions">
          {!available && <button type="button" onClick={onNew} disabled={busy}>另開目前終端草稿</button>}
          <button type="button" onClick={onClose}>取消並保留草稿</button>
          <button type="button" className="primary" disabled={!available || busy || !!problem} onClick={onPaste}>
            {busy ? '正在貼上…' : '確認貼上…'}
          </button>
        </div>
      </div>
    </Dialog>, document.body,
  );
}
