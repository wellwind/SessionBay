import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidebarProjectList } from './components/SidebarProjectList';
import type { Project } from './types';
const projects: Project[] = ['a', 'b', 'c'].map(id => ({ id, name: id, path: '/synthetic/' + id, launchPath: null, exists: true, curated: true, pinned: false, sessionCount: 0, updatedAt: null, agents: [] }));
function setup(reorderable = true) {
  const onReorder = vi.fn(), onSelect = vi.fn();
  render(<SidebarProjectList projects={projects} selectedId="a" label="專案" reorderable={reorderable} onReorder={onReorder} onSelect={onSelect} empty="Empty" />);
  return { onReorder, onSelect };
}
describe('sidebar project sorting', () => {
  it('separates click selection from keyboard and single-pointer ordering', () => {
    const { onReorder, onSelect } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'b /synthetic/b 0' })); expect(onSelect).toHaveBeenCalledWith(projects[1]);
    const handle = screen.getByRole('button', { name: '排序 b' }); handle.focus();
    fireEvent.keyDown(handle, { key: 'ArrowUp', altKey: true });
    expect(onReorder).toHaveBeenLastCalledWith('b', 'a', false); expect(handle).toHaveFocus();
    fireEvent.keyDown(handle, { key: 'ArrowDown', altKey: true });
    expect(onReorder).toHaveBeenLastCalledWith('b', 'c', true);
    expect(screen.queryByRole('button', { name: /上移|下移/ })).not.toBeInTheDocument();
  });
  it('previews pointer movement, commits on release and cancels outside or Escape', () => {
    const { onReorder, onSelect } = setup();
    const list = screen.getByRole('navigation');
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 250, top: 0, bottom: 150 } as DOMRect);
    for (const [index, id] of ['a', 'b', 'c'].entries()) {
      const row = screen.getByRole('button', { name: `排序 ${id}` }).parentElement!;
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 250, top: index * 50, bottom: index * 50 + 46, width: 250, height: 46 } as DOMRect);
    }
    const source = screen.getByRole('button', { name: '排序 a' });
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const pointer = (type: string, y: number) => {
      const event = new Event(type, { bubbles: true });
      Object.assign(event, { clientX: 10, clientY: y, button: 0, pointerId: 1, isPrimary: true }); fireEvent(source, event);
    };
    for (const cancel of ['outside', 'escape', 'pointercancel', 'blur']) {
      pointer('pointerdown', 10); pointer('pointermove', 130);
      expect(onReorder).not.toHaveBeenCalled();
      expect(source.parentElement).toHaveClass('reorder-dragging');
      expect(screen.getByRole('button', { name: '排序 b' }).parentElement).toHaveStyle({ transform: 'translateY(-50px)' });
      if (cancel === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      if (cancel === 'pointercancel') pointer('pointercancel', 130);
      if (cancel === 'blur') fireEvent.blur(window);
      pointer('pointerup', cancel === 'outside' ? 200 : 130);
      expect(onReorder).not.toHaveBeenCalled();
    }
    pointer('pointerdown', 10); pointer('pointermove', 130); pointer('pointerup', 130);
    expect(onReorder).toHaveBeenCalledExactlyOnceWith('a', 'c', true);
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('leaves discovery directories without reorder controls', () => {
    setup(false); expect(screen.queryByRole('button', { name: /排序|上移|下移/ })).not.toBeInTheDocument();
  });
});
