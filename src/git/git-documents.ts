import type { DiffSource, RepoPath } from './types';
import { pathKey, sourceKey } from './types';

/** Central Git views. Keys include the repo identity and comparison source,
 *  so equal file names, branches or PR numbers never collide. */
export type DocumentSpec =
  | { kind: 'diff'; path: RepoPath; oldPath: RepoPath | null; source: DiffSource; untracked: boolean }
  | { kind: 'comparison'; source: DiffSource }
  | { kind: 'graph' }
  | { kind: 'blame'; path: RepoPath; rev: string | null }
  | { kind: 'fileHistory'; path: RepoPath }
  | { kind: 'conflict'; path: RepoPath }
  | { kind: 'pullRequest'; connectionId: string; project: string; number: number };

export interface GitDocument { key: string; repoId: string; repoName: string; spec: DocumentSpec }
export interface GitDocuments { documents: GitDocument[]; active: string | null }
export const emptyDocuments: GitDocuments = { documents: [], active: null };

export function documentKey(repoId: string, spec: DocumentSpec): string {
  switch (spec.kind) {
    case 'diff': return `${repoId}|diff|${pathKey(spec.path)}|${sourceKey(spec.source)}`;
    case 'comparison': return `${repoId}|comparison|${sourceKey(spec.source)}`;
    case 'graph': return `${repoId}|graph`;
    case 'blame': return `${repoId}|blame|${pathKey(spec.path)}|${spec.rev ?? 'HEAD'}`;
    case 'fileHistory': return `${repoId}|history|${pathKey(spec.path)}`;
    case 'conflict': return `${repoId}|conflict|${pathKey(spec.path)}`;
    case 'pullRequest': return `${repoId}|pr|${spec.connectionId}|${spec.project}|${spec.number}`;
  }
}

const fileName = (path: RepoPath) => path.path.split('/').pop() || path.path;
export function documentTitle(document: GitDocument): string {
  const spec = document.spec;
  switch (spec.kind) {
    case 'diff': return fileName(spec.path);
    case 'comparison': return spec.source.kind === 'commit' ? `commit ${spec.source.commit.slice(0, 7)}`
      : spec.source.kind === 'compare' ? `${spec.source.base}${spec.source.mergeBase ? '...' : '..'}${spec.source.head}` : '比較';
    case 'graph': return `歷史 · ${document.repoName}`;
    case 'blame': return `blame ${fileName(spec.path)}`;
    case 'fileHistory': return `歷史 ${fileName(spec.path)}`;
    case 'conflict': return `衝突 ${fileName(spec.path)}`;
    case 'pullRequest': return `#${spec.number}`;
  }
}

export type DocumentAction =
  | { type: 'open'; repoId: string; repoName: string; spec: DocumentSpec }
  | { type: 'replace'; key: string; spec: DocumentSpec }
  | { type: 'activate'; key: string }
  | { type: 'close'; key: string }
  | { type: 'closeRepo'; repoIds: string[] };

export function documentsReducer(state: GitDocuments, action: DocumentAction): GitDocuments {
  switch (action.type) {
    case 'open': {
      const key = documentKey(action.repoId, action.spec);
      if (state.documents.some(document => document.key === key)) return { ...state, active: key };
      return { documents: [...state.documents, { key, repoId: action.repoId, repoName: action.repoName, spec: action.spec }], active: key };
    }
    case 'replace': {
      const current = state.documents.find(document => document.key === action.key);
      if (!current) return state;
      const key = documentKey(current.repoId, action.spec);
      // Switching to an already open view focuses it instead of duplicating.
      if (key !== action.key && state.documents.some(document => document.key === key))
        return { documents: state.documents.filter(document => document.key !== action.key), active: key };
      return {
        documents: state.documents.map(document => document.key === action.key ? { ...document, key, spec: action.spec } : document),
        active: state.active === action.key ? key : state.active,
      };
    }
    case 'activate': return state.documents.some(document => document.key === action.key) ? { ...state, active: action.key } : state;
    case 'close': {
      const index = state.documents.findIndex(document => document.key === action.key);
      if (index < 0) return state;
      const documents = state.documents.filter(document => document.key !== action.key);
      const active = state.active !== action.key ? state.active : documents[Math.min(index, documents.length - 1)]?.key ?? null;
      return { documents, active };
    }
    case 'closeRepo': {
      const documents = state.documents.filter(document => !action.repoIds.includes(document.repoId));
      return { documents, active: documents.some(document => document.key === state.active) ? state.active : documents[0]?.key ?? null };
    }
  }
}
