import { useId, useState } from 'react';
import type { Refs } from './types';

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
    <label className="git-field">基準（base）<input list={list} value={base} placeholder={current} onChange={event => setBase(event.target.value)} /></label>
    <label className="git-field">目標（head）<input list={list} value={head} placeholder="HEAD" onChange={event => setHead(event.target.value)} /></label>
    <fieldset className="git-radio-row"><legend>比較方式</legend>
      <label><input type="radio" checked={!mergeBase} onChange={() => setMergeBase(false)} />直接比較兩端</label>
      <label><input type="radio" checked={mergeBase} onChange={() => setMergeBase(true)} />自 merge-base（head 新增的內容）</label>
    </fieldset>
    <button type="submit">開啟比較</button>
  </form>;
}
