// Source strings are English and double as lookup keys. zh-TW.json maps them to
// Traditional Chinese; en.json only holds English plural forms (`<key>_one`).
// The Rust core reads the same zh-TW.json, so keys must match byte for byte.
// Changing the language reloads the window (terminals reattach through the
// broker), so module-level constants may call t() safely.
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';

export type Locale = 'en' | 'zh-TW';
export type LocalePreference = 'system' | Locale;
export type TranslationValues = Record<string, string | number>;

const STORAGE_KEY = 'sessionbay.language';
const catalogs: Record<Locale, Record<string, string>> = { en, 'zh-TW': zhTW };

export function systemLocale(language = globalThis.navigator?.language ?? 'en'): Locale {
  return /^zh(?:-|$)/i.test(language) ? 'zh-TW' : 'en';
}

export function readLocalePreference(): LocalePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === 'en' || value === 'zh-TW' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function saveLocalePreference(preference: LocalePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Storage may be unavailable; the choice then lasts for this window only.
  }
}

function resolve(preference: LocalePreference): Locale {
  return preference === 'system' ? systemLocale() : preference;
}

let current: Locale = resolve(readLocalePreference());

export function locale(): Locale {
  return current;
}

export function setLocale(next: Locale) {
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
}

export function t(key: string, values?: TranslationValues): string {
  const catalog = catalogs[current];
  const plural = values?.count === 1 ? catalog[`${key}_one`] : undefined;
  const text = plural ?? catalog[key] ?? key;
  if (!values) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

setLocale(current);
