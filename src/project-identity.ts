// Stable per-project identity: a palette slot plus initials, so color is never
// the only cue. The slot derives from the project ID and survives renames.
export const PROJECT_COLOR_COUNT = 8;

export function projectColorIndex(projectId: string | null): number {
  if (projectId === null) return -1;
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash % PROJECT_COLOR_COUNT;
}

/**
 * Distinct slots for up to PROJECT_COLOR_COUNT projects: each starts at its hash
 * slot and probes forward on collision, in ID order so the result is deterministic.
 */
export function projectColorSlots(projectIds: readonly string[]): Map<string, number> {
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  for (const id of [...new Set(projectIds)].sort()) {
    let slot = projectColorIndex(id);
    if (taken.size < PROJECT_COLOR_COUNT) while (taken.has(slot)) slot = (slot + 1) % PROJECT_COLOR_COUNT;
    taken.add(slot);
    slots.set(id, slot);
  }
  return slots;
}

export function projectColor(projectId: string | null, slots?: Map<string, number>): string {
  const index = projectId === null ? -1 : slots?.get(projectId) ?? projectColorIndex(projectId);
  return index < 0 ? 'var(--muted)' : `var(--project-${index})`;
}

/** Up to two initials: CJK names use their first character, others the first letters of words. */
export function projectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const first = [...trimmed][0];
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(first)) return first;
  const words = trimmed.split(/[\s._-]+/u).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[1]].map(word => [...word][0]) : [...words[0]].slice(0, 2);
  return letters.join('').toUpperCase();
}
