import { Tag } from 'lucide-react';
import type { RefLabel } from './types';
import { t } from '../i18n';

const kindLabel: Record<RefLabel['kind'], string> = { branch: t('Local branch'), remote: t('Remote branch'), tag: 'tag', other: 'ref', head: 'HEAD' };

/** Branch, remote and tag labels; kind is in text, not color alone. */
export function RefChips({ refs }: { refs: RefLabel[] }) {
  return <>{refs.filter(ref => ref.kind !== 'head').map(ref =>
    <span key={`${ref.kind}:${ref.name}`} className={`git-ref ${ref.kind}${ref.current ? ' current' : ''}`}
      title={`${kindLabel[ref.kind]}${ref.current ? t(' (current HEAD)') : ''}`}>
      {ref.kind === 'tag' && <Tag size={10} aria-label="tag" />}{ref.name}</span>)}</>;
}
