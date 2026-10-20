/** What the page and the range reader (service worker) agree on. */

export const RANGE_VERSION = 1;
export const RANGE_PREFIX = '/__bt__/';
export const RANGE_CHANNEL = 'ar-io-index-range';
export const CACHE_PREFIX = 'ar-io-index-';

/** Everything the worker needs to serve one file, put in its URL by the page after the publication verified. */
export interface RangeSpec {
  v: number;
  /** The signed infohashV2 of the band's torrent. */
  ih: string;
  /** The file's path inside the torrent. */
  f: string;
  /** The file's signed size. */
  n: number;
  /** For messages: "tags.parquet for blocks 1,000–2,000". */
  label: string;
  /** Sources for the file's bytes, in order. */
  u: string[];
  /** Sources for the band's `.torrent`, in order. */
  t: string[];
}

export interface RangeTotals {
  originBytes: number;
  originRequests: number;
  verified: number;
  memHits: number;
  diskHits: number;
  retries: number;
  failovers: number;
}

export type RangeEvent =
  | ({ type: 'progress' } & RangeTotals)
  | { type: 'fail'; code: string; msg: string }
  | { type: 'note'; msg: string };

export type WorkerRequest =
  | { type: 'cancel' }
  | { type: 'resume' }
  | { type: 'stats' }
  | { type: 'clear' }
  | { type: 'keepalive' }
  | { type: 'claim' };

export const emptyTotals = (): RangeTotals => ({
  originBytes: 0,
  originRequests: 0,
  verified: 0,
  memHits: 0,
  diskHits: 0,
  retries: 0,
  failovers: 0,
});

export function encodeSpec(spec: RangeSpec): string {
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  let bin = '';
  for (const x of bytes) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSpec(s: string): RangeSpec {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const spec = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))),
  ) as RangeSpec;
  if (
    spec.v !== RANGE_VERSION ||
    !/^[0-9a-f]{64}$/.test(spec.ih) ||
    !Array.isArray(spec.u) ||
    !spec.u.length ||
    !Array.isArray(spec.t) ||
    !spec.t.length ||
    typeof spec.f !== 'string'
  )
    throw new Error('bad spec');
  spec.label = spec.label || spec.f;
  return spec;
}
