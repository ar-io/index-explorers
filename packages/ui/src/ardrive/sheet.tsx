/**
 * The design system's bottom sheet: what a dialog or a panel becomes on a
 * phone (section 4, under 834 px). The sheet rises from the bottom edge over
 * the scrim, with the same title, padding and actions, and scrolls inside
 * itself. Escape or the scrim closes it. Focus goes in when it opens, and back
 * to whatever had it when it closes. Styles in `sheet.css`.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export function Sheet({
  label,
  onClose,
  children,
  id,
}: {
  /** Names the sheet for a screen reader. */
  label: string;
  onClose: () => void;
  children: ComponentChildren;
  id?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', esc);
    // The page under a sheet holds still.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', esc);
      document.body.style.overflow = overflow;
      if (before && before.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div class="sheet-layer">
      <div class="sheet-scrim" onClick={onClose} />
      <div
        class="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={panel}
        {...(id ? { id } : {})}
      >
        <span class="sheet-grip" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}
