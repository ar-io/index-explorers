/**
 * The page's side of the range reader: registering the service worker,
 * building the URLs DuckDB reads band files through, asking the worker to
 * stop or resume, and counting what a question read (the receipt).
 */
import type { Band, BandFile } from '../publication.js';
import { fetchWithTimeout, withTimeout } from '../util/fetch.js';
import { num } from '../util/format.js';
import {
  emptyTotals,
  encodeSpec,
  RANGE_CHANNEL,
  RANGE_VERSION,
  type RangeEvent,
  type RangeSpec,
  type RangeTotals,
  type WorkerRequest,
} from './protocol.js';

export interface Receipt {
  /** Bytes fetched from origins during the watch. */
  fetched: number;
  /** Pieces checked against the hash tree. */
  checked: number;
  /** Pieces served from the verified caches. */
  reused: number;
}

export interface Watch {
  label: string;
  /** The totals when the watch began. */
  before: RangeTotals;
  /** The first refusal the worker sent while watching, if any. */
  fail: { code: string; msg: string } | null;
  notes: string[];
  /** Ends the watch and returns what was read. */
  done(): Promise<Receipt>;
}

export interface RangeReaderOptions {
  /** The worker script, relative to the page. Default `./sw.js`. */
  scriptUrl?: string;
  scope?: string;
}

export interface RangeReader {
  readonly ok: boolean;
  readonly why: string | null;
  /** The registration scope: what range URLs are built under. */
  readonly base: string | null;
  /** Whether the worker still controls the page: reads through it would be served. */
  controlled(): boolean;
  url(spec: RangeSpec): string;
  ask<T = unknown>(msg: WorkerRequest, ms?: number): Promise<T>;
  cancel(): Promise<void>;
  resume(): Promise<void>;
  stats(): Promise<RangeTotals>;
  /** Starts counting for one question; the worker is resumed first. */
  watch(label: string): Promise<Watch>;
  /** The watch in progress, for a progress line. */
  readonly watching: Watch | null;
  readonly totals: RangeTotals;
  onEvent(cb: (e: RangeEvent) => void): () => void;
}

class Reader implements RangeReader {
  ok = false;
  why: string | null = 'starting';
  base: string | null = null;
  totals: RangeTotals = emptyTotals();
  watching: Watch | null = null;
  private listeners = new Set<(e: RangeEvent) => void>();

  controlled(): boolean {
    return !!(
      typeof navigator !== 'undefined' &&
      navigator.serviceWorker &&
      navigator.serviceWorker.controller
    );
  }

  url(spec: RangeSpec): string {
    if (!this.base) throw new Error('the range reader is not available');
    return new URL('__bt__/' + encodeSpec(spec), this.base).toString();
  }

  /** A request to the worker that answers on its own port. */
  ask<T = unknown>(msg: WorkerRequest, ms = 3000): Promise<T> {
    const c = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!c) return Promise.reject(new Error('no worker'));
    const ch = new MessageChannel();
    const answer = new Promise<T>((r) => {
      ch.port1.onmessage = (e) => r(e.data as T);
    });
    c.postMessage(msg, [ch.port2]);
    return withTimeout(answer, ms, 'the range reader did not answer');
  }

  async cancel(): Promise<void> {
    await this.ask({ type: 'cancel' }).catch(() => {});
  }

  async resume(): Promise<void> {
    await this.ask({ type: 'resume' }).catch(() => {});
  }

  async stats(): Promise<RangeTotals> {
    const t = await this.ask<RangeTotals>({ type: 'stats' });
    this.totals = t;
    return t;
  }

  async watch(label: string): Promise<Watch> {
    // Lift a Stop the worker may still be honouring, and wait for that before
    // the question's first read. Then a fresh baseline: the last broadcast
    // can be a moment old.
    await this.resume();
    const now = await this.stats().catch(() => null);
    if (now) this.totals = now;
    const before = { ...this.totals };
    const w: Watch = {
      label,
      before,
      fail: null,
      notes: [],
      done: async () => {
        // The last progress message can trail the query, so the final
        // counts are asked of the worker directly.
        const fresh = await this.stats().catch(() => null);
        if (fresh) this.totals = fresh;
        const t = this.totals;
        if (this.watching === w) this.watching = null;
        return {
          fetched: t.originBytes - before.originBytes,
          checked: t.verified - before.verified,
          reused: t.memHits - before.memHits + (t.diskHits - before.diskHits),
        };
      },
    };
    this.watching = w;
    return w;
  }

  onEvent(cb: (e: RangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  handle(e: RangeEvent): void {
    if (e.type === 'progress') {
      const { type: _t, ...totals } = e;
      this.totals = totals;
    } else if (e.type === 'fail') {
      if (this.watching && !this.watching.fail) this.watching.fail = { code: e.code, msg: e.msg };
    } else if (e.type === 'note') {
      if (this.watching) {
        const msg = e.msg.charAt(0).toUpperCase() + e.msg.slice(1);
        if (!this.watching.notes.includes(msg)) this.watching.notes.push(msg);
      }
    }
    for (const l of this.listeners) l(e);
  }
}

/**
 * Registers the range reader. Never throws: the result says whether range
 * reads are on and, if not, why in words a reader can act on. Call once.
 */
export async function registerRangeReader(opts: RangeReaderOptions = {}): Promise<RangeReader> {
  const r = new Reader();
  if (typeof BroadcastChannel !== 'undefined') {
    new BroadcastChannel(RANGE_CHANNEL).onmessage = (e) => r.handle((e.data || {}) as RangeEvent);
  }
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
      throw new Error('this browser has no service workers');
    if (!window.isSecureContext) throw new Error('the page is not served over https');
    const sw = navigator.serviceWorker;
    const reg = await sw.register(opts.scriptUrl ?? './sw.js', {
      scope: opts.scope ?? './',
      updateViaCache: 'none',
    });
    await withTimeout(
      sw.ready,
      6000,
      'this browser did not start the range reader; service workers may be blocked here',
    );
    if (!sw.controller) {
      // First visit: the worker claims the page as it activates. After a hard
      // reload it is asked to claim it again.
      const claimed = new Promise<void>((res) =>
        sw.addEventListener('controllerchange', () => res(), { once: true }),
      );
      if (reg.active) reg.active.postMessage({ type: 'claim' });
      await withTimeout(
        claimed,
        4000,
        'a hard reload bypasses the range reader; reload normally to turn it on',
      );
    }
    type Ping = { ok?: boolean; version?: number };
    let body: Ping | null = null;
    try {
      body = (await (
        await fetchWithTimeout(new URL('__bt__/ping', reg.scope).toString(), 5000)
      ).json()) as Ping;
    } catch {
      /* below */
    }
    if (!body || !body.ok) throw new Error('the range reader is not answering');
    if (body.version !== RANGE_VERSION) {
      reg.update().catch(() => {});
      throw new Error('the range reader is updating; reload to use it');
    }
    r.ok = true;
    r.why = null;
    r.base = reg.scope;
    // An idle worker is stopped after about 30 seconds and loses what it
    // holds in memory; a ping while the tab is in view keeps it.
    setInterval(() => {
      const c = navigator.serviceWorker.controller;
      if (r.ok && c && document.visibilityState === 'visible') c.postMessage({ type: 'keepalive' });
    }, 20000);
  } catch (e) {
    r.ok = false;
    r.why = e instanceof Error ? e.message : String(e);
    r.base = null;
  }
  return r;
}

export interface RangeUrlOptions {
  /** Other gateways whose blob route may hold the same bytes. */
  mirrors?: string[];
  label?: string;
}

/** The spec one band file is read through, carrying everything the worker checks against. */
export function rangeSpec(band: Band, file: BandFile, opts: RangeUrlOptions = {}): RangeSpec {
  if (!band.torrent)
    throw new Error(`band ${band.id} has no torrent, so it cannot be read in ranges`);
  const to = band.to === null ? 'the tip' : num(band.to);
  return {
    v: RANGE_VERSION,
    ih: band.torrent.infohashV2,
    f: file.name,
    n: file.size,
    label: opts.label ?? `${file.name} for blocks ${num(band.from)}–${to}`,
    u: [
      file.url,
      ...(opts.mirrors ?? []).map(
        (g) => `${g.replace(/\/+$/, '')}/ar-io/indexes/blob/${file.sha256}`,
      ),
    ],
    t: band.torrent.urls,
  };
}

/** Whether a band can be read in ranges: the reader is on and the publication pins a v2 infohash. */
export const rangeable = (reader: RangeReader | null, band: Band): boolean =>
  !!reader?.ok && !!band.torrent;

/**
 * A worker refusal, in words, in place of DuckDB's "HTTP GET error ... (502)".
 * `switchTo` is another publisher of the same files, when the refusal is one
 * another gateway could avoid.
 */
export function explainReadError(
  e: unknown,
  watch: Watch | null,
  mirrors: string[],
): { msg: string; stopped?: boolean; switchTo?: string; integrity?: boolean; oom?: boolean } {
  const message = e instanceof Error ? e.message : String(e);
  if (/Out of Memory/i.test(message)) {
    return {
      msg:
        'This question needs more memory than a browser tab allows over this period. ' +
        'Pick a shorter period, or add a WHERE on height, or run it with DuckDB on the command line (see the footer).',
      oom: true,
    };
  }
  const f = watch?.fail;
  if (!f) return { msg: message };
  if (f.code === 'cancelled')
    return { msg: 'Stopped. Nothing partial is shown; ask again any time.', stopped: true };
  const first = f.msg.charAt(0).toUpperCase() + f.msg.slice(1);
  const switchTo = mirrors[0];
  const out: { msg: string; switchTo?: string; integrity?: boolean } = { msg: `${first}.` };
  if (switchTo) out.switchTo = switchTo;
  if (f.code === 'integrity' || f.code === 'torrent') {
    out.msg = `${first}. Refused: nothing unverified was used. Try another gateway under Data.`;
    if (f.code === 'integrity') out.integrity = true;
    return out;
  }
  if (f.code === 'payment' || f.code === 'rate') {
    out.msg = `${first}. Wait a moment, or pick another gateway under Data.`;
    return out;
  }
  return { msg: `${first}.` };
}

/** The one-line receipt of what a listing read, and that it was checked. */
export function receiptText(read: Receipt | null, mbText: (n: number) => string): string {
  if (!read) return '';
  if (read.fetched > 0)
    return (
      `Read ${mbText(read.fetched)}, ${num(read.checked)} piece${read.checked === 1 ? '' : 's'} checked against the signed torrent` +
      (read.reused ? `, ${num(read.reused)} reused` : '') +
      '.'
    );
  if (read.reused > 0)
    return `Nothing new to fetch: ${num(read.reused)} checked piece${read.reused === 1 ? '' : 's'} reused.`;
  return 'Answered from pieces already read and checked.';
}
