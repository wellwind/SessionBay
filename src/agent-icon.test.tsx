import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentIcon } from './components/AgentIcon';
import { agentKinds } from './agents';

describe('registry icon fallbacks', () => {
  it('provides a decorative monogram for every registered provider', () => {
    for (const kind of agentKinds) {
      const { container, unmount } = render(<AgentIcon kind={kind} />);
      expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
      expect(container.firstElementChild?.textContent?.trim()).toBeTruthy();
      unmount();
    }
  });
  it('degrades to a named initial without inventing a brand logo', () => {
    const { container } = render(<AgentIcon kind="future-provider" name="New tool" />);
    expect(container.firstElementChild).toHaveTextContent('N');
    expect(container.firstElementChild).toHaveAttribute('data-agent', 'unknown');
  });
});
