import { t } from './i18n';
/** Match the catalog's Unicode character limit without changing identity or paths. */
export function displayNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) return t('Enter a name; it cannot be only spaces.');
  if (Array.from(name).length > 200) return t('Names can be at most 200 characters.');
  if (Array.from(value).some((char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  })) return t('Names cannot contain line breaks or control characters.');
  return undefined;
}

/** Catalog titles are display text, never launch arguments or paths. */
export function resumedTabName(title: string | null | undefined): string | undefined {
  // Match rename validation: flatten line breaks/control characters and cap by
  // Unicode code points so truncation cannot leave half of a surrogate pair.
  const name = Array.from(title ?? '').map(char => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) ? ' ' : char;
  }).join('').trim();
  return Array.from(name).slice(0, 200).join('').trim() || undefined;
}
