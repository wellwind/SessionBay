import { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Folder } from 'lucide-react';
import { ActivityShell } from './components/ActivityShell';
import type { ActivityContribution } from './components/ActivityShell';

afterEach(() => vi.restoreAllMocks());
const ids = ['sessions', 'files', 'search', 'synthetic'];
function Harness({ entries }: { entries: ActivityContribution[] }) {
  const [active, setActive] = useState<string | null>('sessions');
  return <ActivityShell contributions={entries} activeId={active} onActiveChange={setActive} />;
}
const entries = (): ActivityContribution[] => ids.map(id => ({ id, label: id, icon: Folder,
  renderSidebar: () => <input aria-label={`${id} value`} defaultValue={id} /> }));

describe('generic activity contributions', () => {
  it('registers a fourth feature without shell changes and lazily retains panel state', () => {
    const mounted = vi.fn(); const unmounted = vi.fn();
    function StatefulPanel() {
      useEffect(() => { mounted(); return unmounted; }, []);
      return <input aria-label="synthetic value" defaultValue="initial" />;
    }
    const contributions = entries();
    contributions[3].renderSidebar = () => <StatefulPanel />;
    render(<Harness entries={contributions} />);
    const nav = screen.getByRole('navigation', { name: '工作區功能' });
    expect(within(nav).getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(ids);
    expect(screen.queryByLabelText('synthetic value')).not.toBeInTheDocument();
    const sessionsPanel = document.getElementById('activity-sessions-panel')!;
    expect(sessionsPanel.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'sessions' })).toHaveAttribute('aria-controls', sessionsPanel.id);
    fireEvent.click(within(nav).getByRole('button', { name: 'synthetic' }));
    const input = screen.getByLabelText('synthetic value');
    fireEvent.change(input, { target: { value: 'retained' } });
    fireEvent.click(within(nav).getByRole('button', { name: 'files' }));
    expect(input).not.toBeVisible();
    fireEvent.click(within(nav).getByRole('button', { name: 'synthetic' }));
    expect(screen.getByLabelText('synthetic value')).toBe(input);
    expect(input).toHaveValue('retained');
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    fireEvent.click(within(nav).getByRole('button', { name: 'synthetic' }));
    expect(input).not.toBeVisible();
    expect(within(nav).getByRole('button', { name: 'synthetic' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('supports availability, badges, activation hooks and arrow-key navigation', () => {
    const contributions = entries();
    contributions[1].available = false;
    contributions[3].badge = 4;
    contributions[3].onActivate = vi.fn();
    render(<Harness entries={contributions} />);
    const nav = screen.getByRole('navigation', { name: '工作區功能' });
    const first = within(nav).getByRole('button', { name: 'sessions' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(within(nav).getByRole('button', { name: 'search' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    const synthetic = within(nav).getByRole('button', { name: 'synthetic' });
    expect(synthetic).toHaveFocus();
    expect(within(synthetic).getByLabelText('synthetic：4')).toHaveTextContent('4');
    fireEvent.click(synthetic);
    fireEvent.click(synthetic);
    expect(contributions[3].onActivate).toHaveBeenCalledTimes(1);
    expect(within(nav).getByRole('button', { name: 'files' })).toBeDisabled();
  });

  it('puts extra contributions in a keyboard-operable overflow menu on short rails', () => {
    let height = 132;
    let resize = () => {};
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {} disconnect() {}
    });
    try {
      render(<Harness entries={entries()} />);
      const nav = screen.getByRole('navigation', { name: '工作區功能' });
      expect(within(nav).getAllByRole('button')).toHaveLength(3);
      const more = within(nav).getByRole('button', { name: '更多功能' });
      fireEvent.click(more);
      const menu = screen.getByRole('menu', { name: '更多工作區功能' });
      expect(within(menu).getByRole('menuitemradio', { name: 'search' })).toHaveFocus();
      fireEvent.keyDown(document.activeElement!, { key: 'End' });
      const synthetic = within(menu).getByRole('menuitemradio', { name: 'synthetic' });
      expect(synthetic).toHaveFocus();
      fireEvent.click(synthetic);
      expect(screen.getByLabelText('synthetic value')).toBeVisible();
      expect(more).toHaveAttribute('aria-pressed', 'true');
      expect(more).toHaveFocus();
      fireEvent.click(more);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      height = 400;
      act(() => resize());
      expect(within(nav).queryByRole('button', { name: '更多功能' })).not.toBeInTheDocument();
      expect(within(nav).getByRole('button', { name: 'synthetic' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByLabelText('synthetic value')).toBeVisible();
      expect(within(nav).getByRole('button', { name: 'synthetic' })).toHaveFocus();
      height = 132;
      act(() => resize());
      expect(within(nav).getByRole('button', { name: '更多功能' })).toHaveFocus();
      const content = screen.getByLabelText('synthetic value');
      content.focus();
      height = 400;
      act(() => resize());
      expect(content).toHaveFocus();
    } finally { vi.unstubAllGlobals(); }
  });
});
