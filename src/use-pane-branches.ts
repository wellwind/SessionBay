import { useEffect, useState } from 'react';
import { gitApi } from './git/git-api';
import { branchLabel, type RepoInfo } from './git/types';

const BRANCH_TTL_MS = 30_000;
interface Cached { at: number; repos: Promise<RepoInfo[]> }
const discoveries = new Map<string, Cached>();

function repos(projectId: string): Promise<RepoInfo[]> {
  const cached = discoveries.get(projectId);
  if (cached && performance.now() - cached.at < BRANCH_TTL_MS) return cached.repos;
  const next = gitApi.discover(projectId)
    .then(result => result.state === 'ready' ? result.repos : [])
    .catch(() => []);
  discoveries.set(projectId, { at: performance.now(), repos: next });
  return next;
}

const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');
/** The deepest repository whose root contains the pane's cwd. */
export function repoForCwd(list: RepoInfo[], cwd: string): RepoInfo | undefined {
  const target = normalize(cwd);
  return list
    .filter(repo => target === normalize(repo.root) || target.startsWith(`${normalize(repo.root)}/`))
    .sort((a, b) => normalize(b.root).length - normalize(a.root).length)[0];
}

/** Branch label per pane, read only while the overview is visible; failures show no branch. */
export function usePaneBranches(panes: { paneId: string; projectId: string | null; cwd: string }[], visible: boolean) {
  const [branches, setBranches] = useState<Record<string, string>>({});
  const key = panes.map(pane => `${pane.paneId}\u0000${pane.projectId}\u0000${pane.cwd}`).join('\u0001');
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const read = async () => {
      const next: Record<string, string> = {};
      const statuses = new Map<string, Promise<string | null>>();
      await Promise.all(panes.map(async pane => {
        if (pane.projectId === null) return;
        const projectId = pane.projectId;
        const repo = repoForCwd(await repos(projectId), pane.cwd);
        if (!repo) return;
        const id = `${projectId}\u0000${repo.id}`;
        if (!statuses.has(id)) statuses.set(id, gitApi.status(projectId, repo.id).then(status => branchLabel(status.branch)).catch(() => null));
        const label = await statuses.get(id);
        if (label) next[pane.paneId] = label;
      }));
      if (!cancelled) setBranches(next);
    };
    void read();
    const timer = setInterval(() => void read(), BRANCH_TTL_MS);
    return () => { cancelled = true; clearInterval(timer); };
    // The key captures every input that changes the lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, visible]);
  return branches;
}
