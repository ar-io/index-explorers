/**
 * ArDrive's file preview, standalone: give it the file's URL on a gateway,
 * what it is, its name and its size. Styles in `file-preview.css`, over the
 * ArDrive tokens. Used by the ArDrive explorer's details panel.
 *
 * A public file, previewed at the top of its details: an image, a video, a
 * sound, or the start of a text. It loads when the reader selects the file,
 * which is their asking; past PREVIEW_AUTO it waits for a button. The bytes
 * come from the gateway at the data id the file's record names, and the
 * record is outside the signature, so the preview says so.
 *
 * Never framed: a page or a PDF would run in this one's frame under its
 * Verified chip, so those open in a tab of their own instead.
 */
import { useEffect, useState } from 'preact/hooks';

/** A size as a file browser writes one (1.5 MB); kept here so the component stands alone. */
export function sizeText(n: number | null | undefined): string {
  const v = Number(n);
  if (!(v >= 0)) return '';
  if (v < 1024) return `${v} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1073741824) return `${(v / 1048576).toFixed(1)} MB`;
  return `${(v / 1073741824).toFixed(2)} GB`;
}

/** Loaded on selection up to this size; past it, a button says the size first. */
export const PREVIEW_AUTO = 20e6;
/** A text's first bytes, which is all a panel shows. */
const TEXT_BYTES = 65536;

export type PreviewKind = 'image' | 'video' | 'audio' | 'text';

/** What a file can be previewed as, from its record's type, else its name; null for none. */
export function previewKind(
  type: string | null | undefined,
  name: string | null | undefined,
): PreviewKind | null {
  const t = (type || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/.test(t)) return 'image';
  if (/^video\/(mp4|webm|ogg|quicktime)$/.test(t)) return 'video';
  if (/^audio\/(mpeg|mp3|mp4|aac|ogg|wav|x-wav|webm|flac)$/.test(t)) return 'audio';
  if (/^text\/|^application\/(json|xml|javascript|x-sh|yaml|x-yaml|toml|csv)$/.test(t))
    return 'text';
  if (!t || t === 'application/octet-stream') {
    if (/\.(png|jpe?g|gif|webp|avif)$/.test(n)) return 'image';
    if (/\.(mp4|webm|mov)$/.test(n)) return 'video';
    if (/\.(mp3|m4a|aac|ogg|wav|flac)$/.test(n)) return 'audio';
    if (/\.(txt|md|csv|json|xml|ya?ml|toml|js|ts|css|html?|sh|py|sql|log)$/.test(n)) return 'text';
  }
  return null;
}

/** The start of a text file, as text: a Range read, decoded leniently; null when it reads as binary. */
function TextPreview({ url, size }: { url: string; size: number | null }) {
  const [state, setState] = useState<{ text: string | null; failed: string | null }>({
    text: null,
    failed: null,
  });
  useEffect(() => {
    const ctl = new AbortController();
    fetch(url, { headers: { Range: `bytes=0-${TEXT_BYTES - 1}` }, signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`the gateway answered ${r.status}`);
        const buf = new Uint8Array(await r.arrayBuffer()).subarray(0, TEXT_BYTES);
        if (buf.includes(0)) throw new Error('it is not text');
        setState({ text: new TextDecoder('utf-8').decode(buf), failed: null });
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted)
          setState({ text: null, failed: e instanceof Error ? e.message : String(e) });
      });
    return () => ctl.abort();
  }, [url]);
  if (state.failed) return <p class="pv-note">No preview: {state.failed}.</p>;
  if (state.text === null) return <div class="pv-wait" aria-label="Loading the preview" />;
  return (
    <>
      <pre class="pv-text" tabIndex={0} aria-label="The start of the file">
        {state.text}
      </pre>
      {size !== null && size > TEXT_BYTES ? (
        <p class="pv-note">
          The first {sizeText(TEXT_BYTES)} of {sizeText(size)}.
        </p>
      ) : null}
    </>
  );
}

export function FilePreview({
  url,
  kind,
  name,
  size,
  caption = "From the gateway, at the data id the file's record names.",
}: {
  url: string;
  kind: PreviewKind;
  name: string;
  size: number | null;
  /** Where the bytes come from, said under the preview. */
  caption?: string;
}) {
  // Text reads only its first bytes, so its size never asks first.
  const [go, setGo] = useState(kind === 'text' || size === null || size <= PREVIEW_AUTO);
  const [failed, setFailed] = useState(false);
  return (
    <figure class={`pv is-${kind}`} id="preview">
      {!go ? (
        <button type="button" class="secondary compact" onClick={() => setGo(true)}>
          Load preview ({sizeText(size)})
        </button>
      ) : failed ? (
        <p class="pv-note">The gateway did not serve a preview of this file.</p>
      ) : kind === 'image' ? (
        <img src={url} alt={`Preview of ${name}`} onError={() => setFailed(true)} />
      ) : kind === 'video' ? (
        <video src={url} controls preload="metadata" playsInline onError={() => setFailed(true)} />
      ) : kind === 'audio' ? (
        <audio src={url} controls preload="metadata" onError={() => setFailed(true)} />
      ) : (
        <TextPreview url={url} size={size} />
      )}
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
