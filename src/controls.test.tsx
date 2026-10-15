import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatePicker, Select } from './components/controls';
import type { DatePickerProps, SelectOption, SelectProps } from './components/controls';
import { Dialog } from './components/Dialog';

const options: SelectOption[] = [
  { value: 'alpha', label: 'Alpha', description: 'First choice', icon: <span>A</span> },
  { value: 'bravo', label: 'Bravo', disabled: true },
  { value: 'charlie', label: 'Charlie' },
  { value: 'delta', label: 'Delta' },
  { value: 'dog', label: 'Dog' },
];
function SelectHarness({ onChange = vi.fn(), ...props }: Partial<SelectProps> = {}) {
  const [value, setValue] = useState(props.value ?? 'alpha');
  return <><label htmlFor="chosen">Agent</label><Select id="chosen" options={options} {...props} value={value}
    onChange={(next) => { setValue(next); onChange(next); }} /><button>Next field</button></>;
}
function DateHarness({ onChange = vi.fn(), ...props }: Partial<DatePickerProps> = {}) {
  const [value, setValue] = useState(props.value ?? '2026-10-15');
  return <><label htmlFor="date">開始日期</label><DatePicker id="date" aria-label="開始日期" {...props} value={value}
    onChange={(next) => { setValue(next); onChange(next); }} /><output data-testid="date-value">{value}</output><button>Next field</button></>;
}
function openCalendar() {
  fireEvent.click(screen.getByRole('button', { name: '開始日期，開啟日曆' }));
  return screen.getByRole('dialog', { name: '選擇開始日期' });
}
function day(date: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[data-date="${date}"]`);
  if (!button) throw new Error(`Missing calendar date ${date}`);
  return button;
}
afterEach(() => { vi.unstubAllEnvs(); });

describe('accessible Select', () => {
  it('associates its label, description, invalid state, and selected option', () => {
    render(<><span id="help">Choose an installed agent</span><SelectHarness aria-describedby="help" aria-invalid="true" /></>);
    const trigger = screen.getByRole('combobox', { name: 'Agent' });
    expect(trigger).toHaveTextContent('Alpha');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-describedby', 'help');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(trigger);
    const list = screen.getByRole('listbox');
    expect(trigger).toHaveAttribute('aria-controls', list.id);
    expect(within(list).getByRole('option', { name: /Alpha/ })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByText('First choice')).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: 'Bravo' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('keeps trigger focus and skips disabled options with arrows before committing Enter', () => {
    const onChange = vi.fn();
    render(<SelectHarness onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Agent' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const charlie = screen.getByRole('option', { name: 'Charlie' });
    expect(trigger).toHaveAttribute('aria-activedescendant', charlie.id);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('charlie');
    expect(trigger).toHaveTextContent('Charlie');
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('supports Home, End, ArrowUp wrapping, and Space selection', () => {
    const onChange = vi.fn();
    render(<SelectHarness onChange={onChange} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'End' });
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Dog' }).id);
    fireEvent.keyDown(trigger, { key: 'Home' });
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /Alpha/ }).id);
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    fireEvent.keyDown(trigger, { key: ' ' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('dog');
  });
  it('supports multi-character typeahead and repeated-letter cycling', () => {
    render(<SelectHarness />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'd' });
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Delta' }).id);
    fireEvent.keyDown(trigger, { key: 'd' });
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Dog' }).id);
    fireEvent.keyDown(trigger, { key: 'o' });
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Dog' }).id);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(trigger).toHaveTextContent('Dog');
  });
  it('starts typeahead at the first matching option when no value is selected and expires an old prefix', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    render(<SelectHarness value="missing" options={[{ value: 'first', label: 'Alpha first' }, { value: 'second', label: 'Alpha second' }, { value: 'beta', label: 'Beta' }]} />);
    const trigger = screen.getByRole('combobox');
    fireEvent.keyDown(trigger, { key: 'a' });
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Alpha first' }).id);
    now = 800;
    fireEvent.keyDown(trigger, { key: 'b' });
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Beta' }).id);
  });
  it('repairs its active descendant if options change while the menu is open', () => {
    const onChange = vi.fn();
    const view = render(<Select value="charlie" options={options} onChange={onChange} aria-label="Agent" />);
    const trigger = screen.getByRole('combobox');
    fireEvent.click(trigger);
    view.rerender(<Select value="missing" options={[{ value: 'first', label: 'Remaining' }]} onChange={onChange} aria-label="Agent" />);
    expect(trigger).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Remaining' }).id);
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('first');
  });
  it('dismisses Escape without selecting and returns focus without closing its parent dialog', () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(<Dialog title="Settings" onClose={onClose}><SelectHarness onChange={onChange} /></Dialog>);
    const trigger = screen.getByRole('combobox');
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'End' });
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('dismisses outside pointer interactions without changing focus or value', () => {
    const onChange = vi.fn();
    render(<SelectHarness onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    const next = screen.getByRole('button', { name: 'Next field' });
    next.focus();
    fireEvent.pointerDown(next);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(next).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('allows Tab to leave the control and close the menu', async () => {
    const user = userEvent.setup();
    render(<SelectHarness />);
    const trigger = screen.getByRole('combobox');
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Next field' })).toHaveFocus();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
  it('commits pointer selection once and ignores disabled options', () => {
    const onChange = vi.fn();
    render(<SelectHarness onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: 'Bravo' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'Charlie' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('charlie');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });
  it('does not open when disabled and closes if it becomes disabled while open', () => {
    const onChange = vi.fn();
    const view = render(<Select value="alpha" onChange={onChange} options={options} disabled aria-label="Agent" />);
    const trigger = screen.getByRole('combobox', { name: 'Agent' });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    view.rerender(<Select value="alpha" onChange={onChange} options={options} aria-label="Agent" />);
    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    view.rerender(<Select value="alpha" onChange={onChange} options={options} disabled aria-label="Agent" />);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('handles empty and entirely disabled option sets without emitting invalid values', () => {
    const onChange = vi.fn();
    const view = render(<Select value="missing" onChange={onChange} options={[]} aria-label="Agent" />);
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('請選擇');
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<Select value="missing" onChange={onChange} options={[{ value: 'blocked', label: 'Blocked', disabled: true }]} aria-label="Agent" />);
    fireEvent.keyDown(trigger, { key: 'End' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('local-date DatePicker', () => {
  it.each(['C', 'POSIX', 'C.UTF-8', 'en_US.UTF-8', '', 'not_a_locale'])('survives a non-BCP47 native locale %s with the app-language fallback', (locale) => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(locale);
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue([locale]);
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    expect(screen.getByRole('textbox', { name: '開始日期' })).toHaveValue('2026/10/15');
    expect(within(openCalendar()).getByRole('grid')).toHaveAccessibleName('2026年10月');
    fireEvent.click(day('2026-10-16'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-10-16');
  });
  it('uses the next supported browser language when the primary preference is invalid', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('C');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['C', 'en-GB']);
    render(<DateHarness />);
    expect(screen.getByRole('textbox', { name: '開始日期' })).toHaveValue('15/10/2026');
    openCalendar();
    fireEvent.keyDown(day('2026-10-15'), { key: 'Home' });
    expect(day('2026-10-12')).toHaveFocus();
  });
  it('renders a locale-formatted date and an accessible calendar grid', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    render(<DateHarness />);
    expect(screen.getByRole('textbox', { name: '開始日期' })).toHaveValue('10/15/2026');
    const calendar = openCalendar();
    expect(within(calendar).getByRole('grid')).toHaveAccessibleName('October 2026');
    expect(within(calendar).getAllByRole('columnheader')).toHaveLength(7);
    expect(within(calendar).getAllByRole('gridcell')).toHaveLength(42);
    expect(day('2026-10-15')).toHaveFocus();
    expect(day('2026-10-15')).toHaveAccessibleName('Thursday, October 15, 2026');
    expect(day('2026-10-15').parentElement).toHaveAttribute('aria-selected', 'true');
  });
  it.each(['Pacific/Kiritimati', 'America/Los_Angeles'])('emits the exact chosen local ISO date in %s', (timezone) => {
    vi.stubEnv('TZ', timezone);
    const onChange = vi.fn();
    render(<DateHarness value="2026-03-07" onChange={onChange} />);
    openCalendar();
    fireEvent.click(day('2026-03-08'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-03-08');
    expect(screen.getByTestId('date-value')).toHaveTextContent('2026-03-08');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '開始日期，開啟日曆' })).toHaveFocus();
  });
  it('moves across month boundaries with arrows and selects by Enter', () => {
    const onChange = vi.fn();
    render(<DateHarness value="2026-10-31" onChange={onChange} />);
    openCalendar();
    fireEvent.keyDown(day('2026-10-31'), { key: 'ArrowRight' });
    expect(day('2026-11-01')).toHaveFocus();
    fireEvent.keyDown(day('2026-11-01'), { key: 'ArrowDown' });
    expect(day('2026-11-08')).toHaveFocus();
    fireEvent.keyDown(day('2026-11-08'), { key: 'ArrowUp' });
    fireEvent.keyDown(day('2026-11-01'), { key: 'ArrowLeft' });
    expect(day('2026-10-31')).toHaveFocus();
    fireEvent.keyDown(day('2026-10-31'), { key: 'ArrowLeft' });
    fireEvent.keyDown(day('2026-10-30'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-10-30');
  });
  it('uses locale week boundaries for Home and End', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-GB');
    render(<DateHarness value="2026-10-15" />);
    openCalendar();
    fireEvent.keyDown(day('2026-10-15'), { key: 'Home' });
    expect(day('2026-10-12')).toHaveFocus();
    fireEvent.keyDown(day('2026-10-12'), { key: 'End' });
    expect(day('2026-10-18')).toHaveFocus();
  });
  it('clamps month and year navigation to valid dates including leap years', () => {
    render(<DateHarness value="2024-01-31" />);
    openCalendar();
    fireEvent.keyDown(day('2024-01-31'), { key: 'PageDown' });
    expect(day('2024-02-29')).toHaveFocus();
    fireEvent.keyDown(day('2024-02-29'), { key: 'PageDown', shiftKey: true });
    expect(day('2025-02-28')).toHaveFocus();
    fireEvent.keyDown(day('2025-02-28'), { key: 'PageUp' });
    expect(day('2025-01-28')).toHaveFocus();
  });
  it('navigates month controls and clears a selected date', () => {
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const calendar = openCalendar();
    fireEvent.click(within(calendar).getByRole('button', { name: '下一個月' }));
    expect(day('2026-11-15')).toHaveFocus();
    fireEvent.click(within(calendar).getByRole('button', { name: '上一個月' }));
    expect(day('2026-10-15')).toHaveFocus();
    fireEvent.click(within(calendar).getByRole('button', { name: '清除日期' }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('');
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('accepts complete ISO input, rejects invalid days, and allows correction', () => {
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const input = screen.getByRole('textbox', { name: '開始日期' });
    fireEvent.focus(input);
    expect(input).toHaveValue('2026-10-15');
    fireEvent.change(input, { target: { value: '2026-02-30' } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('YYYY-MM-DD');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '2026-02-28' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-02-28');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
  });
  it.each(['2026-13-01', '2026-00-10', '2025-02-29', '2026-04-31', '0000-01-01', 'not-a-date'])('does not emit invalid input %s', (value) => {
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });
  it('supports keyboard opening, Escape dismissal, and return focus inside a parent dialog', () => {
    const onClose = vi.fn();
    render(<Dialog title="Filters" onClose={onClose}><DateHarness /></Dialog>);
    const input = screen.getByRole('textbox');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('dialog', { name: '選擇開始日期' })).toBeInTheDocument();
    fireEvent.keyDown(day('2026-10-15'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '選擇開始日期' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '開始日期，開啟日曆' })).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('dismisses outside clicks without restoring focus to the date field', () => {
    render(<DateHarness />);
    openCalendar();
    const next = screen.getByRole('button', { name: 'Next field' });
    next.focus();
    fireEvent.pointerDown(next);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(next).toHaveFocus();
  });
  it('makes every calendar action reachable by keyboard without escaping its parent modal', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Dialog title="Filters" onClose={onClose}><DateHarness /></Dialog>);
    const calendar = openCalendar();
    expect(screen.getByRole('dialog', { name: 'Filters' })).toContainElement(calendar);
    await user.tab();
    expect(within(calendar).getByRole('button', { name: '清除日期' })).toHaveFocus();
    await user.tab();
    expect(within(calendar).getByRole('button', { name: '今天' })).toHaveFocus();
    await user.tab();
    expect(within(calendar).getByRole('button', { name: '上一個月' })).toHaveFocus();
    await user.tab();
    expect(within(calendar).getByRole('button', { name: '下一個月' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '開始日期，開啟日曆' })).toHaveFocus();
  });
  it('discards invalid drafts after external value changes or an explicit same-value reset', () => {
    const onChange = vi.fn();
    const view = render(<DatePicker aria-label="Date" value="2026-10-15" onChange={onChange} resetKey={0} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '2026-02-30' } });
    fireEvent.blur(input);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    view.rerender(<DatePicker aria-label="Date" value="" onChange={onChange} resetKey={0} />);
    expect(input).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'invalid' } });
    fireEvent.blur(input);
    view.rerender(<DatePicker aria-label="Date" value="" onChange={onChange} resetKey={1} />);
    expect(input).toHaveValue('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('does not open or mutate when disabled', () => {
    const onChange = vi.fn();
    render(<DateHarness disabled onChange={onChange} />);
    expect(screen.getByRole('textbox')).toBeDisabled();
    const trigger = screen.getByRole('button', { name: '開始日期，開啟日曆' });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('shows an empty field for malformed external values without throwing', () => {
    render(<DateHarness value="2026-02-30" />);
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(openCalendar()).toBeInTheDocument();
  });
});

describe('shared semantic checkbox', () => {
  it('keeps native label, Space, focus, and disabled behavior with its visual class', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<><label><input type="checkbox" className="checkbox" onChange={onChange} />Include branches</label><label><input type="checkbox" className="checkbox" disabled />Disabled</label></>);
    const checkbox = screen.getByRole('checkbox', { name: 'Include branches' });
    act(() => checkbox.focus());
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveFocus();
    expect(onChange).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('checkbox', { name: 'Disabled' }));
    expect(screen.getByRole('checkbox', { name: 'Disabled' })).not.toBeChecked();
    expect(onChange).toHaveBeenCalledOnce();
  });
});
