import { useId, useState } from 'react';
import type { Refs } from './types';
import { t } from '../i18n';

/** Picks any two commits, branches or tags; direct vs merge-base is explicit. */
export function CompareForm({ refs, onCompare }: { refs: Refs | null; onCompare: (base: string, head: string, mergeBase: boolean) => void }) {
  const current = refs?.branches.find(branch => branch.current)?.name ?? 'HEAD';
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [mergeBase, setMergeBase] = useState(false);
  const list = useId();
  const names = refs ? [...refs.branches.map(branch => branch.name), ...refs.tags.map(tag => tag.name)] : [];
  return <form className="git-form" onSubmit={event => {
    event.preventDefault();
    onCompare(base.trim() || current, head.trim() || 'HEAD', mergeBase);
  }}>
    <datalist id={list}>{names.map(name => <option key={name} value={name} />)}</datalist>
    <label className="git-field">{t('Base')}<input list={list} value={base} placeholder={current} onChange={event => setBase(event.target.value)} /></label>
    <label className="git-field">{t('Target (head)')}<input list={list} value={head} placeholder="HEAD" onChange={event => setHead(event.target.value)} /></label>
    <fieldset className="git-radio-row"><legend>{t('Comparison')}</legend>
      <label><input type="radio" checked={!mergeBase} onChange={() => setMergeBase(false)} />{t('Compare both ends directly')}</label>
      <label><input type="radio" checked={mergeBase} onChange={() => setMergeBase(true)} />{t('From merge-base (what head adds)')}</label>
    </fieldset>
    <button type="submit">{t('Open comparison')}</button>
  </form>;
}
