import { describe, expect, it } from 'vitest';
import { interruptedOutcome, interruptedPlan, interruptedResumeId } from './interrupted-resume';
import type { Pane, Workspace } from './types';

const pane = (patch: Partial<Pane> = {}): Pane => ({
  id: 'pane-a', kind: 'claude', title: 'Synthetic agent', projectId: 'project-a',
  cwd: '/synthetic/project', state: 'interrupted', ...patch,
});

describe('interruptedResumeId', () => {
  it('reuses the hook-reported conversation of interrupted new agent work', () => {
    expect(interruptedResumeId(pane({ providerSessionId: 'synthetic-provider' }))).toBe('synthetic-provider');
  });
  it('keeps indexed sessions, manual resume IDs and shells on their existing path', () => {
    expect(interruptedResumeId(pane({ providerSessionId: 'p', sessionId: 'indexed' }))).toBeUndefined();
    expect(interruptedResumeId(pane({ providerSessionId: 'p', resumeId: 'manual' }))).toBeUndefined();
    expect(interruptedResumeId(pane({ providerSessionId: 'p', kind: 'shell' }))).toBeUndefined();
  });
  it('never applies to panes that ended normally or have no recorded conversation', () => {
    expect(interruptedResumeId(pane({ providerSessionId: 'p', state: 'exited' }))).toBeUndefined();
    expect(interruptedResumeId(pane({ providerSessionId: 'p', state: 'failed' }))).toBeUndefined();
    expect(interruptedResumeId(pane({ providerSessionId: '  ' }))).toBeUndefined();
    expect(interruptedResumeId(pane({ providerSessionId: null }))).toBeUndefined();
  });
});

describe('interruptedPlan', () => {
  it('lists interrupted panes in tab order with what restarting will do', () => {
    const workspace: Workspace = {
      version: 1,
      activeTabByProject: {},
      tabs: [
        { id: 'tab-1', projectId: 'project-a', name: 'One', focusedPaneId: 'b',
          layout: { kind: 'split', id: 's', axis: 'horizontal', ratio: 0.5,
            first: { kind: 'pane', paneId: 'b' }, second: { kind: 'pane', paneId: 'a' } } },
        { id: 'tab-2', projectId: 'project-a', name: 'Two', focusedPaneId: 'c', layout: { kind: 'pane', paneId: 'c' } },
        { id: 'tab-3', projectId: 'project-a', name: 'Three', focusedPaneId: 'd', layout: { kind: 'pane', paneId: 'd' } },
      ],
      panes: {
        a: pane({ id: 'a', providerSessionId: 'provider-a' }),
        b: pane({ id: 'b', kind: 'shell' }),
        c: pane({ id: 'c', kind: 'grok' }),
        d: pane({ id: 'd', state: 'running' }),
      },
    };
    expect(interruptedPlan(workspace).map(({ pane, outcome }) => [pane.id, outcome]))
      .toEqual([['b', 'shell'], ['a', 'resume'], ['c', 'new']]);
  });
  it('treats indexed and manual resumes as continuing the conversation', () => {
    expect(interruptedOutcome(pane({ sessionId: 'indexed' }))).toBe('resume');
    expect(interruptedOutcome(pane({ resumeId: 'manual' }))).toBe('resume');
  });
});
