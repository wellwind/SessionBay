// Bundled (OFL-1.1) fonts so WKWebView, WebView2 and WebKitGTK measure the same
// glyphs; system fonts stay as fallbacks. The @font-face rules are imported in
// main.tsx and served from 'self'.

export const MONO_FONT =
  "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans TC Variable', monospace";

/**
 * xterm and Monaco measure cell width once, so wait briefly for the Latin
 * faces before the first render. CJK subsets still load on demand.
 */
export function loadBundledFonts(timeoutMs = 1000): Promise<void> {
  const fonts = typeof document === 'undefined' ? undefined : document.fonts;
  if (!fonts?.load) return Promise.resolve();
  const loads = Promise.all([
    fonts.load("14px 'Inter Variable'"),
    fonts.load("14px 'JetBrains Mono Variable'"),
    fonts.load("italic 14px 'JetBrains Mono Variable'"),
  ]).then(() => undefined, () => undefined);
  return Promise.race([loads, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}
