import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api';
import { gitApi } from './git-api';
import type { ProjectGit, RepoStatus } from './types';

export const SELECTED_POLL_MS = 3000;
export const BACKGROUND_POLL_MS = 15000;

/**
 * Discovery and per-repo status for one project. Polling only runs while the
 * Git tool is visible, and every response is checked against a generation so
 * a late answer never overwrites a newer refresh.
 */
export function useGitProject(projectId: string, enabled: boolean) {
  const [project, setProject] = useState<ProjectGit | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [statuses, setStatuses] = useState<Record<string, RepoStatus>>({});
  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const discoveryGeneration = useRef(0);
  const statusGeneration = useRef<Record<string, number>>({});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const refreshStatus = useCallback(async (repoId: string) => {
    const generation = (statusGeneration.current[repoId] ?? 0) + 1;
    statusGeneration.current[repoId] = generation;
    try {
      const status = await gitApi.status(projectId, repoId);
      if (!mounted.current || statusGeneration.current[repoId] !== generation) return;
      setStatuses(previous => previous[repoId]?.revision === status.revision ? previous : { ...previous, [repoId]: status });
      setStatusErrors(previous => {
        if (!(repoId in previous)) return previous;
        const next = { ...previous }; delete next[repoId]; return next;
      });
    } catch (error) {
      if (!mounted.current || statusGeneration.current[repoId] !== generation) return;
      setStatusErrors(previous => ({ ...previous, [repoId]: errorMessage(error) }));
    }
  }, [projectId]);

  const discover = useCallback(async (extended = false) => {
    const generation = ++discoveryGeneration.current;
    setDiscovering(true);
    setDiscoveryError('');
    try {
      const found = await gitApi.discover(projectId, extended);
      if (!mounted.current || generation !== discoveryGeneration.current) return;
      setProject(found);
      if (found.state === 'ready') {
        setSelectedId(previous => previous && found.repos.some(repo => repo.id === previous) ? previous : found.repos[0]?.id ?? null);
        setStatuses(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => found.repos.some(repo => repo.id === id))));
        await Promise.all(found.repos.map(repo => refreshStatus(repo.id)));
      }
    } catch (error) {
      if (mounted.current && generation === discoveryGeneration.current) setDiscoveryError(errorMessage(error));
    } finally {
      if (mounted.current && generation === discoveryGeneration.current) setDiscovering(false);
    }
  }, [projectId, refreshStatus]);

  /** Adds the repo of an opened file (deeper than the subfolder scan). */
  const includePath = useCallback(async (path: string) => {
    try {
      const found = await gitApi.includePath(projectId, path);
      if (!mounted.current || found.state !== 'ready') return;
      setProject(previous => {
        if (previous?.state !== 'ready') return previous;
        const added = found.repos.filter(repo => !previous.repos.some(known => known.id === repo.id));
        return added.length ? { ...previous, repos: [...previous.repos, ...added] } : previous;
      });
      for (const repo of found.repos) void refreshStatus(repo.id);
    } catch { /* An unreadable or removed file simply adds nothing. */ }
  }, [projectId, refreshStatus]);

  const cancelDiscovery = useCallback(() => { void gitApi.cancelDiscovery(projectId).catch(() => undefined); }, [projectId]);

  const started = useRef(false);
  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void discover();
  }, [enabled, discover]);

  const repos = project?.state === 'ready' ? project.repos : [];
  const repoIds = repos.map(repo => repo.id).join('\n');
  useEffect(() => {
    if (!enabled || !repoIds) return;
    const ids = repoIds.split('\n');
    const visible = () => document.visibilityState !== 'hidden';
    const selected = window.setInterval(() => {
      if (visible() && selectedId) void refreshStatus(selectedId);
    }, SELECTED_POLL_MS);
    const background = window.setInterval(() => {
      if (visible()) for (const id of ids) if (id !== selectedId) void refreshStatus(id);
    }, BACKGROUND_POLL_MS);
    // External edits by Agents or editors show up when the user returns.
    const focus = () => { for (const id of ids) void refreshStatus(id); };
    window.addEventListener('focus', focus);
    return () => { window.clearInterval(selected); window.clearInterval(background); window.removeEventListener('focus', focus); };
  }, [enabled, repoIds, selectedId, refreshStatus]);

  return {
    project, discovering, discoveryError, statuses, statusErrors, selectedId, setSelectedId,
    discover, cancelDiscovery, refreshStatus, includePath, repos,
    selectedRepo: repos.find(repo => repo.id === selectedId) ?? null,
    selectedStatus: selectedId ? statuses[selectedId] ?? null : null,
  };
}
export type GitProjectState = ReturnType<typeof useGitProject>;
