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
    fireEvent.click(screen.getByRole('button', { name: '下移 b' }));
    expect(onReorder).toHaveBeenLastCalledWith('b', 'c', true);
    fireEvent.click(screen.getByRole('button', { name: '上移 a' })); expect(onReorder).toHaveBeenCalledTimes(2);
  });
  it('handles internal drops, cancelled drags and rejects external drags', () => {
    const { onReorder } = setup();
    const transfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    const source = screen.getByRole('button', { name: '排序 a' });
    const target = screen.getByRole('button', { name: '排序 c' }).parentElement!;
    fireEvent.drop(target, { dataTransfer: transfer, clientY: 100 }); expect(onReorder).not.toHaveBeenCalled();
    fireEvent.dragStart(source, { dataTransfer: transfer }); fireEvent.dragOver(target, { dataTransfer: transfer });
    const drop = new Event('drop', { bubbles: true, cancelable: true }); Object.assign(drop, { dataTransfer: transfer, clientY: 100 });
    fireEvent(target, drop); expect(onReorder).toHaveBeenCalledWith('a', 'c', true);
    fireEvent.dragStart(source, { dataTransfer: transfer }); fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.drop(target, { dataTransfer: transfer }); expect(onReorder).toHaveBeenCalledTimes(1);
  });
  it('leaves discovery directories without reorder controls', () => {
    setup(false); expect(screen.queryByRole('button', { name: /排序|上移|下移/ })).not.toBeInTheDocument();
  });
});
