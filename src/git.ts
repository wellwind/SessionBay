import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from './api';
import type { GitDiscovery, GitProbeState, GitRepository, GitStatusSummary } from './types';

export const GIT_STATE_LABELS: Record<GitProbeState, string> = {
  repository: 'Git repository',
  notRepository: '不是 Git repository',
  bare: '裸 repository（沒有工作目錄）',
  brokenGitDir: '.git 無效或指向不存在的 gitdir',
  untrusted: 'Git 拒絕存取（safe.directory 擁有者檢查）',
  gitMissing: '找不到 Git 執行檔',
  failed: 'Git 探測失敗',
};

/** Only a discovery with at least one validated work tree offers Git tools. */
export const hasOperableRepository = (discovery: GitDiscovery | null | undefined) =>
  !!discovery && discovery.gitAvailable === true && Array.isArray(discovery.repositories) && discovery.repositories.length > 0;

/** Keep the user's selection by repository identity; otherwise prefer the repo containing the project. */
export function pickRepository(repositories: GitRepository[], previousId: string | null): string | null {
  if (previousId && repositories.some(repo => repo.id === previousId)) return previousId;
  return (repositories.find(repo => repo.containsProject) ?? repositories[0])?.id ?? null;
}

export function repositoryLocation(repo: GitRepository): string {
  if (repo.relativePath === null) return repo.worktreeRoot;
  return repo.relativePath === '' ? '專案根目錄' : repo.relativePath;
}

export const KIND_LABELS = { primary: '', linkedWorktree: 'linked worktree', submodule: 'submodule（未支援操作）' } as const;

export function branchLabel(status: GitStatusSummary): string {
  if (status.detached) return `detached ${status.oid?.slice(0, 7) ?? ''}`.trim();
  if (status.unborn) return `${status.branch ?? ''}（尚無 commit）`;
  return status.branch ?? '未知 branch';
}

export function changeCount(status: GitStatusSummary) {
  return status.staged + status.unstaged + status.untracked + status.conflicted;
}

/** Best-effort cancel; never throws (also tolerates partial api test doubles). */
function cancelDiscovery(projectId: string) {
  try { void Promise.resolve(api.cancelGitDiscovery(projectId)).catch(() => {}); } catch { /* ignore */ }
}

const FOCUS_DEBOUNCE_MS = 800;
const REDISCOVER_MIN_MS = 30_000;
const STATUS_POLL_MS = 10_000;

export interface GitWorkbenchState {
  discovery: GitDiscovery | null;
  scanning: boolean;
  error: string | null;
  statuses: Record<string, GitStatusSummary | { error: string }>;
  selectedId: string | null;
  select: (id: string) => void;
  refresh: () => void;
  cancel: () => void;
}

/**
 * Per-project Git discovery + status. Read-only; never touches Agent cwd or
 * runtimes. External changes are picked up by a debounced refresh on window
 * focus/visibility and a status poll while the Git panel is visible.
 */
export function useGitWorkbench(projectId: string | null, panelVisible: boolean): GitWorkbenchState {
  const [discovery, setDiscovery] = useState<GitDiscovery | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<GitWorkbenchState['statuses']>({});
  const [selection, setSelection] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const lastDiscovery = useRef(0);
  const discoveryRef = useRef<GitDiscovery | null>(null);

  const loadStatuses = useCallback(async (project: string, found: GitDiscovery, gen: number) => {
    for (const repo of Array.isArray(found?.repositories) ? found.repositories : []) {
      if (generation.current !== gen) return;
      let result: GitStatusSummary | { error: string };
      try { result = await api.gitStatus(project, repo.worktreeRoot); } catch (e) { result = { error: errorMessage(e) }; }
      if (generation.current !== gen) return;
      setStatuses(prev => ({ ...prev, [repo.id]: result }));
    }
  }, []);

  const discover = useCallback(async () => {
    if (!projectId) return;
    const gen = ++generation.current;
    lastDiscovery.current = Date.now();
    setScanning(true);
    try {
      const found = await api.discoverGit(projectId);
      if (generation.current !== gen) return;
      if (!found || !Array.isArray(found.repositories) || !Array.isArray(found.issues)) throw new Error('Git 探測回傳格式無效');
      discoveryRef.current = found;
      setDiscovery(found);
      setError(null);
      await loadStatuses(projectId, found, gen);
    } catch (e) {
      if (generation.current === gen) setError(errorMessage(e));
    } finally {
      if (generation.current === gen) setScanning(false);
    }
  }, [projectId, loadStatuses]);

  useEffect(() => {
    discoveryRef.current = null;
    setDiscovery(null);
    setStatuses({});
    setError(null);
    if (!projectId) { generation.current++; setScanning(false); return; }
    void discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- counter ref, not a DOM node
    return () => { generation.current++; cancelDiscovery(projectId); };
  }, [projectId, discover]);

  const refreshStatus = useCallback(() => {
    const found = discoveryRef.current;
    if (!projectId || !found) return;
    void loadStatuses(projectId, found, generation.current);
  }, [projectId, loadStatuses]);

  useEffect(() => {
    if (!projectId) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (Date.now() - lastDiscovery.current >= REDISCOVER_MIN_MS) void discover();
        else refreshStatus();
      }, FOCUS_DEBOUNCE_MS);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { clearTimeout(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [projectId, discover, refreshStatus]);

  useEffect(() => {
    if (!projectId || !panelVisible) return;
    const id = setInterval(() => { if (document.visibilityState !== 'hidden') refreshStatus(); }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [projectId, panelVisible, refreshStatus]);

  const selectedId = discovery ? pickRepository(discovery.repositories, projectId ? selection[projectId] ?? null : null) : null;
  return {
    discovery, scanning, error, statuses, selectedId,
    select: id => { if (projectId) setSelection(prev => ({ ...prev, [projectId]: id })); },
    refresh: () => { void discover(); },
    cancel: () => { if (projectId) cancelDiscovery(projectId); },
  };
}
