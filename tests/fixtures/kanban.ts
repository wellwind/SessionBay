import type { KanbanBoard, KanbanCard, Session } from '../../src/types';

/** Catalog-shaped synthetic data shared by component and browser tests. */
export function kanbanFixture(projectId: string, sessions: Session[]): KanbanBoard {
  const names = ['Unsorted', 'Todo', 'In progress', 'Review', 'Done'] as const;
  const stages = ['unsorted', 'todo', 'doing', 'review', 'done'] as const;
  const columns = names.map((defaultName, position) => ({
    id: `column-${position}`, projectId, name: null, defaultName, stage: stages[position], position,
    systemRole: position === 0 ? 'unsorted' as const : position === 4 ? 'done' as const : null,
  }));
  const cards: KanbanCard[] = sessions.map((session, index) => ({
    id: `card-${index}`, projectId, columnId: columns[index % columns.length].id,
    title: session.title, notes: index === 0 ? 'Synthetic planning notes: token bucket' : '', position: Math.floor(index / columns.length),
    archived: false, createdAt: '2026-10-28T09:00:00Z', updatedAt: session.updatedAt,
    sessions: [{ session, branch: index === 0 ? 'feature/rate-limit-with-a-long-branch-name' : null }],
  }));
  cards.push({ id: 'empty-task', projectId, columnId: 'column-1', title: '', notes: '', position: 10, archived: false,
    sessions: [], createdAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T10:00:00Z' });
  return { projectId, enabled: true, enabledAt: '2026-10-28T09:00:00Z', columns, cards };
}

export function moveFixtureCard(board: KanbanBoard, cardId: string, columnId: string, position: number) {
  const card = board.cards.find(card => card.id === cardId)!;
  const previous = card.columnId;
  const target = board.cards.filter(item => item.columnId === columnId && item.id !== cardId).sort((a, b) => a.position - b.position);
  target.splice(position, 0, card);
  card.columnId = columnId;
  target.forEach((item, index) => { item.position = index; });
  if (previous !== columnId) board.cards.filter(item => item.columnId === previous).sort((a, b) => a.position - b.position)
    .forEach((item, index) => { item.position = index; });
  return card;
}
