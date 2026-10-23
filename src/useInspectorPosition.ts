import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const PANEL_WIDTH = 344;
const MARGIN = 12;

export function useInspectorPosition(nodeId: string) {
  const ref = useRef<HTMLElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden', right: 'auto' });

  useLayoutEffect(() => {
    const panel = ref.current;
    const canvas = panel?.closest('main');
    if (!panel || !canvas) return;
    let frame = 0;
    let disposed = false;

    const measure = () => {
      frame = 0;
      if (disposed) return;
      const bounds = canvas.getBoundingClientRect();
      const toolbar = canvas.querySelector('.canvas-command-bar')?.getBoundingClientRect();
      const width = Math.min(PANEL_WIDTH, Math.max(0, bounds.width - MARGIN * 2));
      const topLimit = (toolbar?.bottom ?? bounds.top) + MARGIN;
      const bottomLimit = Math.max(topLimit, bounds.bottom - MARGIN);
      const maxHeight = Math.max(0, bottomLimit - topLimit);
      const next: CSSProperties = {
        left: 'auto',
        top: Math.round(topLimit - bounds.top),
        width: Math.round(width),
        maxHeight: Math.round(maxHeight),
        right: MARGIN,
        visibility: 'visible',
      };
      setStyle((previous) =>
        Object.keys(next).every(
          (key) => previous[key as keyof CSSProperties] === next[key as keyof CSSProperties],
        )
          ? previous
          : next,
      );
    };
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(canvas);
    resizeObserver.observe(panel);
    const scroll = panel.querySelector('.inspector-scroll');
    if (scroll) {
      resizeObserver.observe(scroll);
      for (const child of scroll.children) resizeObserver.observe(child);
    }
    const toolbar = canvas.querySelector('.canvas-command-bar');
    if (toolbar) resizeObserver.observe(toolbar);
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(panel, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [nodeId]);

  return { ref, style };
}
