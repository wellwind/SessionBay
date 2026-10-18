import { useLayoutEffect, useRef } from 'react';

/** Reveal only on selection or viewport resize; output and manual scrolling do not reset it. */
export function useActiveTabVisibility(activeKey?: string) {
  const selected = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const tab = selected.current;
    const strip = tab?.closest<HTMLElement>('.workspace-tabs');
    if (!activeKey || !tab || !strip) return;
    const reveal = () => {
      const viewport = strip.getBoundingClientRect();
      const target = tab.getBoundingClientRect();
      // Bounding rects include CSS zoom; scrollLeft is in unscaled layout pixels.
      const scale = strip.offsetWidth ? viewport.width / strip.offsetWidth : 1;
      if (!scale || !viewport.width) return;
      const left = viewport.left + strip.clientLeft * scale;
      const right = left + strip.clientWidth * scale;
      const delta = target.width > right - left || target.left < left
        ? target.left - left : target.right > right ? target.right - right : 0;
      if (Math.abs(delta) > 0.5) strip.scrollLeft += delta / scale;
    };
    reveal();
    let width = strip.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      const next = strip.getBoundingClientRect().width;
      if (next !== width) { width = next; reveal(); }
    });
    observer?.observe(strip);
    return () => observer?.disconnect();
  }, [activeKey]);
  return selected;
}
