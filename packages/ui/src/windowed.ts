import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

/**
 * Windowed rendering: `chunk` rows at a time, more as a sentinel scrolls into
 * view, so a folder of ten thousand files is never ten thousand rows. The
 * window resets whenever `resetKey` changes (a new folder, sort or filter).
 */
export function useWindowed(total: number, chunk: number, resetKey: unknown) {
  const [rendered, setRendered] = useState(chunk);
  const sentinel = useRef<HTMLElement | null>(null);
  const root = useRef<HTMLElement | null>(null);
  useEffect(() => setRendered(chunk), [resetKey, chunk]);
  const shown = Math.min(rendered, total);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || shown >= total) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          setRendered((n) => n + chunk);
        }
      },
      { root: root.current },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, total, chunk]);
  const setSentinel = useCallback((el: HTMLElement | null) => {
    sentinel.current = el;
  }, []);
  const setRoot = useCallback((el: HTMLElement | null) => {
    root.current = el;
  }, []);
  return { shown, setSentinel, setRoot, more: shown < total };
}
