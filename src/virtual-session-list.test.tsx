import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { VirtualSessionList } from './components/VirtualSessionList';

const defaults = {
  items: [{ id: 'one' }], total: 1, label: 'Synthetic sessions', className: '',
  rowHeight: 100, scrollMemory: { top: 0 }, loading: false, done: true, error: '',
  loadMore: vi.fn(), retry: vi.fn(), renderRow: (item: { id: string }) => <button>{item.id}</button>,
};

describe('virtual session feed status', () => {
  it('removes the completed footer and its layout slot while preserving list metadata', () => {
    const { container } = render(<VirtualSessionList {...defaults} />);
    expect(container.querySelector('.session-feed-status')).toBeNull();
    expect(screen.queryByText(/已載入全部/)).not.toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-setsize', '1');
    expect(screen.getByRole('listitem')).toHaveAttribute('aria-posinset', '1');
  });

  it('keeps loading accessible and removes the slot on completion', () => {
    const view = render(<VirtualSessionList {...defaults} loading />);
    expect(screen.getByRole('status')).toHaveTextContent('讀取中…');
    expect(screen.getByRole('list')).toHaveAttribute('aria-busy', 'true');
    view.rerender(<VirtualSessionList {...defaults} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps error and retry controls even after a completed range', () => {
    const retry = vi.fn();
    render(<VirtualSessionList {...defaults} error="Synthetic error" retry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic error');
    fireEvent.click(screen.getByRole('button', { name: '重試載入' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('retains the manual load-more control when more results remain', () => {
    const loadMore = vi.fn();
    const items = Array.from({ length: 40 }, (_, i) => ({ id: String(i) }));
    render(<VirtualSessionList {...defaults} items={items} total={100} done={false} loadMore={loadMore} />);
    fireEvent.click(screen.getByRole('button', { name: '載入更多 Session' }));
    expect(loadMore).toHaveBeenCalledOnce();
  });
});
