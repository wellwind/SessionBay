import { useLayoutEffect } from 'react';
import type { Appearance } from './themes';
import { uiTokens } from './themes';

/** Restore only the CSS tokens this owner installed when it leaves the screen. */
export function useUiTheme(appearance: Appearance | undefined) {
  const theme = appearance?.theme;
  const palette = appearance?.themePalette;
  useLayoutEffect(() => {
    if (!theme) return;
    const root = document.documentElement;
    const previousTheme = root.dataset.theme;
    const previousPalette = root.dataset.themePalette;
    const tokens = Object.keys(uiTokens());
    const previousTokens = tokens.map((token) => [token, root.style.getPropertyValue(`--${token}`)]);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      const mode = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      root.dataset.theme = mode;
      root.dataset.themePalette = palette ?? 'bay';
      Object.entries(uiTokens(palette, mode)).forEach(([token, value]) => root.style.setProperty(`--${token}`, value));
    };
    update();
    media.addEventListener('change', update);
    return () => {
      media.removeEventListener('change', update);
      if (previousTheme === undefined) delete root.dataset.theme; else root.dataset.theme = previousTheme;
      if (previousPalette === undefined) delete root.dataset.themePalette; else root.dataset.themePalette = previousPalette;
      previousTokens.forEach(([token, value]) => {
        if (value) root.style.setProperty(`--${token}`, value); else root.style.removeProperty(`--${token}`);
      });
    };
  }, [theme, palette]);
}
