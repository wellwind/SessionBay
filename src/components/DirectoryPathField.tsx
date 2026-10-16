import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { FolderOpen, LoaderCircle } from 'lucide-react';
import { canPickDirectory, pickDirectory } from '../directory-picker';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'children'> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  children?: ReactNode;
};

/** Keep manual input and existing save/validation flows authoritative. */
export function DirectoryPathField({ label, value, onChange, className = 'field-label', children,
  disabled = false, id, 'aria-describedby': describedBy, ...inputProps }: Props) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const feedbackId = `${inputId}-picker-feedback`;
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const revision = useRef(0);
  const inFlight = useRef(false);
  const latest = useRef({ value, disabled, onChange });
  latest.current = { value, disabled, onChange };
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const available = canPickDirectory();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; revision.current += 1; };
  }, []);
  useEffect(() => { revision.current += 1; }, [value, disabled]);

  const browse = async () => {
    if (disabled || !available || inFlight.current) return;
    inFlight.current = true;
    const request = revision.current;
    const original = value;
    const current = () => mounted.current && revision.current === request &&
      !latest.current.disabled && latest.current.value === original;
    setPicking(true);
    setError('');
    try {
      const selected = await pickDirectory(`選擇${label}`, original);
      if (current() && selected !== null) latest.current.onChange(selected);
    } catch (reason) {
      if (current()) setError(`無法開啟資料夾選擇器：${reason instanceof Error ? reason.message : String(reason)} 可直接輸入路徑。`);
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setPicking(false);
        // Returning from a native dialog must not steal focus from newer navigation.
        if (current() && (document.activeElement === button.current || document.activeElement === document.body)) input.current?.focus();
      }
    }
  };

  return (
    <div className={`${className} directory-path-field`}>
      <label htmlFor={inputId}>{label}</label>
      <div className="directory-path-controls">
        <input {...inputProps} id={inputId} ref={input} value={value} disabled={disabled}
          spellCheck={false} aria-describedby={[describedBy, error || !available ? feedbackId : ''].filter(Boolean).join(' ') || undefined}
          onChange={(event) => {
            revision.current += 1;
            setError('');
            onChange(event.target.value);
          }} />
        <button ref={button} type="button" className="secondary directory-picker-button"
          disabled={disabled || picking || !available} aria-label={`選擇${label}`} aria-busy={picking}
          aria-describedby={!available ? feedbackId : undefined} onClick={() => { void browse(); }}>
          {picking ? <LoaderCircle size={15} aria-hidden="true" /> : <FolderOpen size={15} aria-hidden="true" />}
          {picking ? '選擇中…' : '選擇資料夾'}
        </button>
      </div>
      {error ? <span id={feedbackId} className="inline-warning" role="alert">{error}</span> :
        !available && <span id={feedbackId} className="small-muted">桌面應用程式可選擇資料夾；目前請直接輸入路徑。</span>}
      {children}
    </div>
  );
}
