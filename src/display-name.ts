/** Match the catalog's Unicode character limit without changing identity or paths. */
export function displayNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) return '請輸入名稱，不能只有空白。';
  if (Array.from(name).length > 200) return '名稱最多 200 個字元。';
  if (Array.from(value).some((char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159);
  })) return '名稱不能包含換行或控制字元。';
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
