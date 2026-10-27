import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DirectoryOverview } from './components/DirectoryOverview';
import { setLocale } from './i18n';

beforeEach(() => setLocale('en'));
afterEach(() => setLocale('zh-TW'));

it('renders the interface in English', () => {
  render(<DirectoryOverview page="projects" projects={[]} searching={false} busy={false}
    onSelect={() => undefined} onMembership={async () => undefined} onAdd={() => undefined} onDirectories={() => undefined} />);
  expect(screen.getByRole('heading', { name: 'My projects' })).toBeInTheDocument();
  expect(screen.getByText('0 projects')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Pick from all directories/ })).toBeInTheDocument();
  expect(document.documentElement.lang).toBe('en');
});
