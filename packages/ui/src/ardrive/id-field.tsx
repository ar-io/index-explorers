/**
 * The design system's copy field for an id or an address: the id shortened
 * in Roboto Mono (XAm3iZ…Kxs8), the whole of it on hover and to a screen
 * reader, and a Copy link beside it (an action, so a button). Given `onOpen`, the id is also a
 * link to its own view. Styles in `id-field.css`.
 */
import { useEffect, useState } from 'preact/hooks';

export const shortened = (id: string): string =>
  id.length > 16 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;

export function IdField({
  id,
  label = 'id',
  onOpen,
  full = false,
}: {
  id: string;
  /** What the id is, for the Copy link's name ("Copy the owner's address"). */
  label?: string;
  onOpen?: () => void;
  /** Shown whole, where there is room for it. */
  full?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const text = full ? id : shortened(id);
  return (
    <span class="idfield">
      {onOpen ? (
        <button type="button" class="rowlink mono" title={id} aria-label={id} onClick={onOpen}>
          {text}
        </button>
      ) : (
        <span class="mono" title={id} aria-label={id}>
          {text}
        </span>
      )}
      <button
        type="button"
        class="linkbtn idcopy"
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        onClick={() =>
          void navigator.clipboard.writeText(id).then(
            () => setCopied(true),
            () => setCopied(false),
          )
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  );
}
