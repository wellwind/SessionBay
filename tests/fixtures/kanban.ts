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
    sessions: [{ session: { ...session, trashIdentity: session.trashIdentity ?? 'synthetic-' + session.id }, branch: index === 0 ? 'feature/rate-limit-with-a-long-branch-name' : null }],
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

export function createFixtureCard(board: KanbanBoard, columnId: string, title: string, notes: string) {
  let sequence = board.cards.length;
  while (board.cards.some(card => card.id === 'created-' + sequence)) sequence++;
  const card: KanbanCard = { id: 'created-' + sequence, projectId: board.projectId, columnId, title, notes, sessions: [], archived: false,
    createdAt: '2026-10-28T09:00:00Z', updatedAt: '2026-10-28T10:00:00Z',
    position: board.cards.filter(card => card.columnId === columnId).length };
  board.cards.push(card);
  return structuredClone(card);
}
export function mergeFixtureCards(board: KanbanBoard, sourceId: string, targetId: string) {
  const source = board.cards.find(card => card.id === sourceId)!, target = board.cards.find(card => card.id === targetId)!;
  target.sessions.push(...source.sessions);
  target.notes = [target.notes, source.title, source.notes].filter(Boolean).join('\n\n');
  board.cards = board.cards.filter(card => card.id !== sourceId);
  return structuredClone(target);
}
export function splitFixtureSession(board: KanbanBoard, cardId: string, sessionId: string) {
  const source = board.cards.find(card => card.id === cardId)!, link = source.sessions.find(link => link.session.id === sessionId)!;
  const created = createFixtureCard(board, source.columnId, link.session.title, '');
  board.cards.find(card => card.id === created.id)!.sessions = [link];
  source.sessions = source.sessions.filter(item => item.session.id !== sessionId);
  return structuredClone(board.cards.find(card => card.id === created.id)!);
}
export function deleteFixtureCard(board: KanbanBoard, id: string, disposition: string) {
  const card = board.cards.find(card => card.id === id)!;
  board.cards = board.cards.filter(card => card.id !== id);
  if (disposition === 'unsorted') for (const link of card.sessions) {
    const created = createFixtureCard(board, board.columns.find(column => column.systemRole === 'unsorted')!.id, link.session.title, '');
    board.cards.find(card => card.id === created.id)!.sessions = [link];
  }
}
