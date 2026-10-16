import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { displayNameError } from './display-name';
import { RenameDialog } from './components/RenameDialog';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { patchWorkspacePane, renameWorkspaceTab, reorderWorkspaceTab, restoreWorkspace, serializeWorkspace } from './workspace';
import { workspaceTabIndex } from './commands';
import type { Workspace } from './types';

function fixture(): Workspace {
  return { version: 1, tabs: ['a', 'foreign', 'b', 'c'].map((id) => ({ id, name: id, projectId: id === 'foreign' ? 'other' : 'project',
    focusedPaneId: id, layout: { kind: 'pane', paneId: id } })),
  panes: Object.fromEntries(['a', 'foreign', 'b', 'c'].map((id) => [id, { id, title: id, kind: 'shell', projectId: id === 'foreign' ? 'other' : 'project',
    cwd: '/synthetic', state: 'running', runtimeId: `runtime-${id}`, startToken: 4 }])), activeTabByProject: { project: 'b', other: 'foreign' } };
}

describe('workspace organization transformations', () => {
  it('renames a tab without changing identities, runtime objects, or the active tab', () => {
    const original = fixture();
    const next = renameWorkspaceTab(original, 'b', '  同名中文  ');
    expect(next.tabs[2].name).toBe('同名中文');
    expect(next.panes).toBe(original.panes);
    expect(next.activeTabByProject).toBe(original.activeTabByProject);
    expect(next.tabs[2].layout).toBe(original.tabs[2].layout);
    expect(renameWorkspaceTab(next, 'a', '同名中文').tabs[0].name).toBe('同名中文');
    expect(renameWorkspaceTab(original, 'missing', 'name')).toBe(original);
    expect(renameWorkspaceTab(original, 'a', '   ')).toBe(original);
  });
  it('preserves runtime state when only the pane display title is patched', () => {
    const original = fixture();
    const next = patchWorkspacePane(original, 'b', { title: 'Console' });
    expect(next.panes.b).toEqual({ ...original.panes.b, title: 'Console' });
    expect(next.tabs).toBe(original.tabs);
    expect(next.panes.a).toBe(original.panes.a);
  });
  it('moves before or after a sibling and leaves other projects, layout and selection unchanged', () => {
    const original = fixture();
    const next = reorderWorkspaceTab(original, 'a', 'c', true);
    expect(next.tabs.map((tab) => tab.id)).toEqual(['b', 'foreign', 'c', 'a']);
    expect(next.panes).toBe(original.panes);
    expect(next.activeTabByProject).toBe(original.activeTabByProject);
    expect(next.tabs[1]).toBe(original.tabs[1]);
    expect(reorderWorkspaceTab(next, 'a', 'b').tabs.map((tab) => tab.id)).toEqual(original.tabs.map((tab) => tab.id));
    for (const [id, target] of [['a', 'a'], ['a', 'foreign'], ['a', 'missing'], ['missing', 'a']]) {
      expect(reorderWorkspaceTab(original, id, target)).toBe(original);
    }
  });
  it('round-trips labels and order under the existing safe workspace schema and numeric shortcuts', () => {
    let next = renameWorkspaceTab(fixture(), 'a', 'Saved tab');
    next = patchWorkspacePane(next, 'a', { title: 'Saved pane' });
    next = reorderWorkspaceTab(next, 'a', 'c', true);
    const restored = restoreWorkspace(serializeWorkspace(next));
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['b', 'foreign', 'c', 'a']);
    expect(restored.tabs[3].name).toBe('Saved tab');
    expect(restored.panes.a.title).toBe('Saved pane');
    expect(restored.panes.a.runtimeId).toBeUndefined();
    expect(restored.panes.a.startToken).toBeUndefined();
    const tabs = restored.tabs.filter((tab) => tab.projectId === 'project');
    const index = workspaceTabIndex(new KeyboardEvent('keydown', { key: '1', ctrlKey: true }), tabs.length, 0, false);
    expect(tabs[index!].id).toBe('b');
  });
});

describe('display names and transactional rename dialog', () => {
  it('validates blank, control and long names by Unicode character count', () => {
    for (const value of ['', '  ', 'a\nb', 'x\u007fy', 'a'.repeat(201), '😀'.repeat(201)]) expect(displayNameError(value)).toBeTruthy();
    for (const value of ['你好', '😀'.repeat(200), 'a'.repeat(200), '  same name  ']) expect(displayNameError(value)).toBeUndefined();
  });
  it('cancels without saving, validates inline, and trims a valid submitted label', async () => {
    const save = vi.fn(); const close = vi.fn();
    render(<RenameDialog title="Rename" name="Old" description="Only a label" onSave={save} onClose={close} />);
    const input = screen.getByLabelText('顯示名稱');
    fireEvent.change(input, { target: { value: '  ' } });
    expect(screen.getByRole('button', { name: '儲存名稱' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(close).toHaveBeenCalledOnce(); expect(save).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '  New  ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '儲存名稱' })); });
    expect(save).toHaveBeenCalledExactlyOnceWith('New');
  });
  it('locks double submit and cancellation while saving, keeps the draft after error for retry', async () => {
    let reject!: (reason: Error) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((_, rejectPromise) => { reject = rejectPromise; })).mockResolvedValueOnce(undefined);
    const close = vi.fn();
    render(<RenameDialog title="Rename" name="Old" description="Only a label" onSave={save} onClose={close} />);
    fireEvent.change(screen.getByLabelText('顯示名稱'), { target: { value: 'New' } });
    await act(async () => { fireEvent.submit(screen.getByRole('button', { name: '儲存名稱' }).closest('form')!); });
    fireEvent.submit(screen.getByRole('button', { name: '儲存中…' }).closest('form')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled(); expect(save).toHaveBeenCalledOnce();
    await act(async () => reject(new Error('Save failed')));
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed');
    expect(screen.getByLabelText('顯示名稱')).toHaveValue('New');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '儲存名稱' })));
    expect(save).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce();
  });
});

function TabsHarness({ changed = vi.fn() }: { changed?: (id: string, targetId: string, after: boolean) => void }) {
  const [workspace, setWorkspace] = useState(fixture());
  return <div data-testid="tabs"><WorkspaceTabs tabs={workspace.tabs.filter((tab) => tab.projectId === 'project')} activeId="b"
    onSelect={vi.fn()} onRename={vi.fn()} onClose={vi.fn()} onReorder={(id, target, after) => { changed(id, target, after); setWorkspace((w) => reorderWorkspaceTab(w, id, target, after)); }} /></div>;
}
const tabButton = (name: string) => screen.getByRole('button', { name: `${name} 1` });
const transfer = () => ({ effectAllowed: '', dropEffect: '', setData: vi.fn() });

describe('tab reordering controls', () => {
  it('supports keyboard moves, keeps focus and announces position without moving across a boundary', () => {
    const changed = vi.fn(); render(<TabsHarness changed={changed} />);
    const button = tabButton('b'); button.focus();
    fireEvent.keyDown(button, { key: 'ArrowLeft', altKey: true });
    expect(changed).toHaveBeenCalledExactlyOnceWith('b', 'a', false);
    expect(button).toHaveFocus(); expect(screen.getByRole('status')).toHaveTextContent('第 1 個');
    fireEvent.keyDown(button, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(button, { key: 'ArrowRight', altKey: true, isComposing: true });
    expect(changed).toHaveBeenCalledOnce();
    expect(within(screen.getByTestId('tabs')).getAllByRole('button').filter((el) => el.draggable).map((el) => el.textContent)).toEqual(['b1', 'a1', 'c1']);
  });
  it('commits drag only on drop, ignores outside payloads, and cancels on Escape or dragend', () => {
    const changed = vi.fn(); render(<TabsHarness changed={changed} />);
    const dataTransfer = transfer();
    const target = tabButton('c').parentElement!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 100, width: 100 } as DOMRect);
    fireEvent.drop(target, { dataTransfer, clientX: 180 });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.dragStart(tabButton('a'), { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientX: 180 });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.drop(target, { dataTransfer, clientX: 180 });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.dragStart(tabButton('a'), { dataTransfer });
    fireEvent.dragEnd(tabButton('a'), { dataTransfer });
    fireEvent.drop(target, { dataTransfer, clientX: 180 });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.dragStart(tabButton('a'), { dataTransfer });
    const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperties(dropEvent, { clientX: { value: 180 }, dataTransfer: { value: dataTransfer } });
    fireEvent(target, dropEvent);
    expect(changed).toHaveBeenCalledExactlyOnceWith('a', 'c', true);
    expect(screen.getByRole('status')).toHaveTextContent('第 3 個');
  });
});


it('regression: rename dialog returns focus to its invoking button after cancel', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Rename trigger</button>{open && <RenameDialog title="Rename" name="Old" description="Only a label" onSave={vi.fn()} onClose={() => setOpen(false)} />}</>;
  }
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: 'Rename trigger' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByLabelText('顯示名稱')).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(trigger).toHaveFocus();
});

it('regression: Escape while composing a display name should not close rename', () => {
  const close = vi.fn();
  render(<RenameDialog title="Rename" name="Old" description="Only a label" onSave={vi.fn()} onClose={close} />);
  const input = screen.getByLabelText('顯示名稱');
  fireEvent.compositionStart(input);
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true, keyCode: 229 });
  expect(close).not.toHaveBeenCalled();
});
