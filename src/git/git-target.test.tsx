import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DangerDialog } from './DangerDialog';
import { GitTargetContext } from './git-target';

describe('destructive Git confirmations', () => {
  const dialog = () => <DangerDialog title="Reset" impact="Discards local changes" recovery={null}
    confirmLabel="Reset" acknowledge="I understand" onConfirm={vi.fn()} onClose={vi.fn()} />;

  it('names the target project at the top, so mixed tabs never hide which project is affected', () => {
    render(<GitTargetContext.Provider value="Second project">{dialog()}</GitTargetContext.Provider>);
    const target = screen.getByText('目標專案：', { exact: false });
    expect(target).toHaveTextContent('目標專案：Second project');
    expect(target.compareDocumentPosition(screen.getByText('影響範圍')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('omits the line when no project context is provided', () => {
    render(dialog());
    expect(screen.queryByText('目標專案：', { exact: false })).toBeNull();
  });
});
