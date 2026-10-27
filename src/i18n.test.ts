import { afterEach, describe, expect, it } from 'vitest';
import en from './locales/en.json';
import zhTW from './locales/zh-TW.json';
import { locale, setLocale, systemLocale, t } from './i18n';

const uiSources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./test/**'], { query: '?raw', import: 'default', eager: true });
const rustSources = import.meta.glob<string>('../src-tauri/src/**/*.rs', { query: '?raw', import: 'default', eager: true });

// Literal t('...') / t("...") keys in a source file. Template-literal keys are not allowed.
function keys(source: string) {
  const found = new Set<string>();
  for (const match of source.matchAll(/(?<![\w.$])t\(\s*(['"])((?:\\.|(?!\1).)*)\1/g)) {
    found.add(match[2].replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n'));
  }
  return found;
}

function rustKeys(source: string) {
  return [...source.matchAll(/\btr!?\(\s*"((?:\\.|[^"\\])*)"/g)].map((match) => match[1].replace(/\\(["\\])/g, '$1').replace(/\\n/g, '\n'));
}

afterEach(() => setLocale('zh-TW'));

describe('i18n catalogs', () => {
  it('translates every literal key used by the UI and the Rust core', () => {
    const catalog = zhTW as Record<string, string>;
    const missing = new Set<string>();
    expect(Object.keys(uiSources).length).toBeGreaterThan(50);
    for (const source of Object.values(uiSources)) for (const key of keys(source)) if (!(key in catalog)) missing.add(key);
    // i18n.rs itself only holds example keys in its docs and tests.
    let rustKeyCount = 0;
    for (const [path, source] of Object.entries(rustSources)) if (!path.endsWith('/i18n.rs'))
      for (const key of rustKeys(source)) { rustKeyCount++; if (!(key in catalog)) missing.add(key); }
    expect(rustKeyCount).toBeGreaterThan(300);
    expect([...missing]).toEqual([]);
  });

  it('keeps placeholders identical in both languages', () => {
    const names = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
    for (const [key, value] of Object.entries(zhTW as Record<string, string>)) expect(names(value), key).toEqual(names(key));
    for (const [key, value] of Object.entries(en as Record<string, string>)) expect(names(value), key).toEqual(names(key.replace(/_one$/, '')));
  });

  it('falls back to the English source text and handles plurals', () => {
    setLocale('en');
    expect(locale()).toBe('en');
    expect(t('Cancel')).toBe('Cancel');
    expect(t('{{count}} panes', { count: 1 })).toBe('1 pane');
    expect(t('{{count}} panes', { count: 3 })).toBe('3 panes');
    setLocale('zh-TW');
    expect(t('Cancel')).toBe('取消');
    expect(t('{{count}} panes', { count: 1 })).toBe('1 個面板');
  });

  it('maps any Chinese system language to Traditional Chinese', () => {
    expect(systemLocale('zh-TW')).toBe('zh-TW');
    expect(systemLocale('zh-Hans-CN')).toBe('zh-TW');
    expect(systemLocale('en-US')).toBe('en');
    expect(systemLocale('ja')).toBe('en');
  });
});
