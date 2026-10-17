import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { displayNameError } from './display-name';
import { RenameDialog } from './components/RenameDialog';
import { WorkspaceTabs } from './components/WorkspaceTabs';
import { ProjectRuntimeTabs } from './components/ProjectRuntimeTabs';
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
function pointer(target: HTMLElement, type: string, x = 180, y = 10) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, button: { value: 0 }, pointerId: { value: 1 }, isPrimary: { value: true } });
  fireEvent(target, event);
}

describe('tab reordering controls', () => {
  it.each(['工作分頁', '很長的合成分頁名稱'.repeat(20)])('shows only the complete tab name in native tooltips: %s', name => {
    const ws = fixture();
    const tab = { ...ws.tabs[0], name };
    render(<><WorkspaceTabs tabs={[tab]} panes={ws.panes}
      onSelect={vi.fn()} onRename={vi.fn()} onClose={vi.fn()} onReorder={vi.fn()} />
      <ProjectRuntimeTabs tabs={[tab]} panes={ws.panes} projectName="Project" onFocus={vi.fn()} /></>);
    const workspaceButton = screen.getByRole('button', { name: `${name} 1` });
    const sidebarButton = screen.getByRole('button', { name: `開啟工作區 Project ${name}` });
    for (const button of [workspaceButton, sidebarButton]) {
      expect(button).toHaveAttribute('title', name);
      expect(button.title).not.toMatch(/第 \d+ 個分頁|拖曳|排序/);
      expect(button).toHaveTextContent(name);
    }
    expect(workspaceButton).toHaveAccessibleDescription(/可拖曳分頁排序/);
    expect(workspaceButton).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
    expect(sidebarButton).toHaveAccessibleDescription('已開啟');
  });
  it('supports keyboard moves, keeps focus and announces position without moving across a boundary', () => {
    const changed = vi.fn(); render(<TabsHarness changed={changed} />);
    const button = tabButton('b'); button.focus();
    fireEvent.keyDown(button, { key: 'ArrowLeft', altKey: true });
    expect(changed).toHaveBeenCalledExactlyOnceWith('b', 'a', false);
    expect(button).toHaveFocus(); expect(screen.getByRole('status')).toHaveTextContent('第 1 個');
    fireEvent.keyDown(button, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(button, { key: 'ArrowRight', altKey: true, isComposing: true });
    expect(changed).toHaveBeenCalledOnce();
    expect(within(screen.getByTestId('tabs')).getAllByRole('button').filter((el) => el.classList.contains('workspace-tab-select')).map((el) => el.textContent)).toEqual(['b1', 'a1', 'c1']);
  });
  it('does not select after dragging, but preserves the next click and action buttons', () => {
    const selected = vi.fn(); const renamed = vi.fn(); const closed = vi.fn(); const reordered = vi.fn();
    render(<WorkspaceTabs tabs={fixture().tabs.filter(tab => tab.projectId === 'project')} activeId="b"
      onSelect={selected} onRename={renamed} onClose={closed} onReorder={reordered} />);
    const source = tabButton('a');
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    vi.spyOn(tabButton('c').parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 200, top: 0, bottom: 30, width: 100 } as DOMRect);
    pointer(source, 'pointerdown', 0); pointer(source, 'pointermove'); pointer(source, 'pointerup');
    fireEvent.click(source, { detail: 1 });
    expect(selected).not.toHaveBeenCalled(); expect(closed).not.toHaveBeenCalled(); expect(renamed).not.toHaveBeenCalled();
    expect(reordered).toHaveBeenCalledExactlyOnceWith('a', 'c', true);
    pointer(source, 'pointerdown', 0); pointer(source, 'pointerup', 0); fireEvent.click(source, { detail: 1 });
    expect(selected).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: '重新命名分頁 c' }));
    expect(renamed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'c' }));
    fireEvent.click(screen.getByRole('button', { name: '關閉分頁 c' }));
    expect(closed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'c' }));
    expect(reordered).toHaveBeenCalledOnce();
  });
  it('commits pointer drag only on release and cancels Escape, lost capture, or outside drops', () => {
    const changed = vi.fn(); render(<TabsHarness changed={changed} />);
    const source = tabButton('a');
    source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
    const target = tabButton('c').parentElement!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 200, top: 0, bottom: 30, width: 100 } as DOMRect);
    pointer(source, 'pointerup');
    expect(changed).not.toHaveBeenCalled();
    for (const interrupt of ['escape', 'pointercancel', 'lostpointercapture', 'blur', 'outside']) {
      pointer(source, 'pointerdown', 0);
      pointer(source, 'pointermove');
      expect(changed).not.toHaveBeenCalled();
      if (interrupt === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
      else if (interrupt === 'blur') fireEvent.blur(window);
      else if (interrupt !== 'outside') pointer(source, interrupt);
      pointer(source, 'pointerup', interrupt === 'outside' ? 900 : 180);
      expect(changed).not.toHaveBeenCalled();
    }
    pointer(source, 'pointerdown', 0);
    pointer(source, 'pointermove', 3);
    pointer(source, 'pointerup', 3);
    expect(changed).not.toHaveBeenCalled();
    pointer(source, 'pointerdown', 0);
    pointer(source, 'pointermove');
    expect(source.parentElement).toHaveClass('reorder-dragging');
    pointer(source, 'pointerup');
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

it('regression: rejects offscreen tab geometry outside the visible scrolled strip', () => {
  const changed = vi.fn(); render(<TabsHarness changed={changed} />);
  const strip = screen.getByTestId('tabs');
  strip.classList.add('workspace-tabs');
  vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 300, top: 0, bottom: 30, width: 200 } as DOMRect);
  const source = tabButton('a');
  source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
  vi.spyOn(source.parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 150, right: 250, top: 0, bottom: 30, width: 100 } as DOMRect);
  // A scrolled-off tab still has layout geometry extending into the sidebar.
  vi.spyOn(tabButton('c').parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 100, top: 0, bottom: 30, width: 100 } as DOMRect);
  for (const [x, y] of [[50, 10], [180, -10], [180, 40]]) {
    pointer(source, 'pointerdown', 180); pointer(source, 'pointermove', x, y); pointer(source, 'pointerup', x, y);
    expect(changed).not.toHaveBeenCalled();
  }
});

it.each(['overlay', 'outside', 'null'])('rejects %s hit targets rather than reordering an obscured tab', kind => {
  const changed = vi.fn(); render(<TabsHarness changed={changed} />);
  const strip = screen.getByTestId('tabs'); strip.classList.add('workspace-tabs');
  vi.spyOn(strip, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 300, top: 0, bottom: 44, width: 300 } as DOMRect);
  const source = tabButton('a'); source.setPointerCapture = vi.fn(); source.hasPointerCapture = vi.fn(() => false);
  vi.spyOn(source.parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 100, top: 0, bottom: 44, width: 100 } as DOMRect);
  vi.spyOn(tabButton('c').parentElement!, 'getBoundingClientRect').mockReturnValue({ left: 200, right: 330, top: 0, bottom: 44, width: 130 } as DOMRect);
  const exit = document.createElement('button'); exit.className = 'focus-mode-toggle'; exit.textContent = '退出專注'; strip.append(exit);
  vi.spyOn(exit, 'getBoundingClientRect').mockReturnValue({ left: 230, right: 300, top: 0, bottom: 44, width: 70 } as DOMRect);
  const previous = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => kind === 'null' ? null : kind === 'outside' ? document.body : exit });
  try {
    pointer(source, 'pointerdown', 50); pointer(source, 'pointermove', 280); pointer(source, 'pointerup', 280);
    expect(changed).not.toHaveBeenCalled();
    // A real visible tab remains reorderable with hit testing enabled.
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => tabButton('c') });
    pointer(source, 'pointerdown', 50); pointer(source, 'pointermove', 280); pointer(source, 'pointerup', 280);
    expect(changed).toHaveBeenCalledOnce();
  } finally {
    if (previous) Object.defineProperty(document, 'elementFromPoint', previous);
    else Reflect.deleteProperty(document, 'elementFromPoint');
  }
});
