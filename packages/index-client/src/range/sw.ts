/*
 * Verified range reads: the service worker.
 *
 * DuckDB asks for byte ranges of band files. This worker answers only with
 * bytes it has checked against the file's BitTorrent v2 (BEP 52) Merkle
 * tree, and it trusts that tree only through the infohash the publisher
 * signed (see torrent.ts). The page puts every parameter in the request URL
 * after verifying the publication, so the worker keeps no trust state of its
 * own: no worker, no such URL, and a read fails closed at the gateway (which
 * has no /__bt__/ route).
 *
 * Anything that is not a verified answer is an error: a piece that does not
 * match, a torrent that does not match its infohash, a gateway that sends
 * the wrong length. Another source is tried when one is listed; the answer
 * is never assembled from unchecked bytes.
 *
 * Built as its own script (sw.js) by the apps' Vite config; it imports only
 * pure modules.
 */
import { checkTorrent, type FileTree, pieceOk, pieceSize, Refusal } from './torrent.js';
import {
  CACHE_PREFIX,
  decodeSpec,
  emptyTotals,
  RANGE_CHANNEL,
  RANGE_PREFIX,
  RANGE_VERSION,
  type RangeSpec,
  type WorkerRequest,
} from './protocol.js';

declare const self: ServiceWorkerGlobalScope;

// How long an origin may go without sending a byte before the read counts as stalled.
const STALL_MS = 15000;
// The most fetched in one request: coalescing makes few large requests, but
// one slow giant request is worse than a few retried ones.
const MAX_FETCH = 8 * 1024 * 1024;
// About 52 bytes a piece: 16 MiB covers bands far larger than any published.
const MAX_TORRENT = 16 * 1024 * 1024;
// A gateway that ignores Range and answers 200 is still usable for a small file.
const MAX_WHOLE_FALLBACK = 16 * 1024 * 1024;
const RETRIES = 3;
// Verified pieces kept in memory, and across visits in Cache Storage.
const MEM_CAP = 96 * 1024 * 1024;
const DISK_CAP = 768 * 1024 * 1024;
const META_CACHE = CACHE_PREFIX + 'meta-v1';
const META_KEY = 'https://ar-io-index.invalid/meta';
const TORRENT_CACHE = CACHE_PREFIX + 'torrents-v1';
const PIECE_PREFIX = CACHE_PREFIX + 'pieces-v1:';

const channel = new BroadcastChannel(RANGE_CHANNEL);
const totals = emptyTotals();
let lastSent = 0;
let sendTimer: ReturnType<typeof setTimeout> | null = null;
function progress(): void {
  const now = Date.now();
  if (now - lastSent > 150) {
    lastSent = now;
    channel.postMessage({ type: 'progress', ...totals });
    return;
  }
  if (!sendTimer)
    sendTimer = setTimeout(() => {
      sendTimer = null;
      lastSent = Date.now();
      channel.postMessage({ type: 'progress', ...totals });
    }, 160);
}
const note = (msg: string) => channel.postMessage({ type: 'note', msg });
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- cancel ---------------------------------------------------------------
// The page cancels a question by bumping the epoch: every origin read in
// flight is aborted, and the request it served fails, which ends the query.
let epoch = 0;
const inflightAborts = new Set<AbortController>();
// Aborting what is in flight is not enough: the engine's next read would
// carry on. So reads are refused from a cancel until the page says a new
// question is starting, or briefly at most, should the page go away.
let refuseUntil = 0;
const refusing = () => Date.now() < refuseUntil;

self.addEventListener('message', (e: ExtendableMessageEvent) => {
  const d = (e.data || {}) as WorkerRequest;
  const reply = (v: unknown) => e.ports && e.ports[0] && e.ports[0].postMessage(v);
  if (d.type === 'cancel') {
    epoch += 1;
    refuseUntil = Date.now() + 20000;
    for (const ac of inflightAborts) ac.abort();
    inflightAborts.clear();
    reply({ ok: true, epoch });
  } else if (d.type === 'resume') {
    refuseUntil = 0;
    reply({ ok: true });
  } else if (d.type === 'stats') {
    reply({ ...totals, version: RANGE_VERSION });
  } else if (d.type === 'clear') {
    e.waitUntil(clearDisk().then(() => reply({ ok: true })));
  } else if (d.type === 'keepalive') {
    reply({ ok: true });
  } else if (d.type === 'claim') {
    // A hard reload leaves the page uncontrolled; claiming takes it back.
    e.waitUntil(self.clients.claim());
  }
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      // Drop caches of other versions: their layout is not this one's.
      for (const name of await caches.keys()) {
        const ours = name === META_CACHE || name === TORRENT_CACHE || name.startsWith(PIECE_PREFIX);
        if (!ours && name.startsWith(CACHE_PREFIX)) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  ),
);

// ---- fetching -------------------------------------------------------------

interface FetchOpts {
  what: string;
  expect: (status: number) => boolean;
  maxBytes?: number;
  retries?: number;
}

/**
 * Fetch with a stall timer, cancel, and retries on what is worth retrying.
 * Returns the body, or throws a Refusal naming what went wrong in words.
 */
async function fetchBytes(
  url: string,
  init: RequestInit,
  { what, expect, maxBytes, retries = RETRIES }: FetchOpts,
): Promise<{ status: number; body: Uint8Array; headers: Headers }> {
  let lastErr: Refusal | null = null;
  const myEpoch = epoch; // once, so a Stop during a backoff is noticed
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      totals.retries += 1;
      await sleep(Math.min(8000, 500 * 3 ** (attempt - 1)));
      if (epoch !== myEpoch || refusing()) throw new Refusal('cancelled', 'Stopped.');
    }
    const ac = new AbortController();
    inflightAborts.add(ac);
    let stalled = false;
    let timer = setTimeout(() => {
      stalled = true;
      ac.abort();
    }, STALL_MS);
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        ac.abort();
      }, STALL_MS);
    };
    try {
      const res = await fetch(url, {
        ...init,
        signal: ac.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
      });
      kick();
      totals.originRequests += 1;
      if (!expect(res.status)) {
        const retryable = [408, 425, 429, 500, 502, 503, 504].includes(res.status);
        const after = Number(res.headers.get('retry-after'));
        lastErr = new Refusal(
          res.status === 402
            ? 'payment'
            : res.status === 429
              ? 'rate'
              : res.status >= 500
                ? 'server'
                : 'status',
          describe(res.status, what, url),
        );
        try {
          await res.body?.cancel();
        } catch {
          /* nothing to drain */
        }
        if (!retryable) throw lastErr;
        if (after > 0 && after <= 10) await sleep(after * 1000);
        if (epoch !== myEpoch || refusing()) throw new Refusal('cancelled', 'Stopped.');
        continue;
      }
      const len = Number(res.headers.get('content-length'));
      if (maxBytes && len > maxBytes) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new Refusal('size', `${what} is larger than expected`);
      }
      if (!res.body) throw new Refusal('network', `${hostOf(url)} sent no body for ${what}`);
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        kick();
        got += value.length;
        totals.originBytes += value.length;
        if (maxBytes && got > maxBytes) {
          ac.abort();
          throw new Refusal('size', `${what} is larger than expected`);
        }
        parts.push(value);
      }
      progress();
      const out = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        out.set(p, o);
        o += p.length;
      }
      return { status: res.status, body: out, headers: res.headers };
    } catch (e) {
      if (epoch !== myEpoch) throw new Refusal('cancelled', 'Stopped.');
      if (e instanceof Refusal) throw e;
      lastErr = new Refusal(
        'network',
        stalled
          ? `${hostOf(url)} stopped sending ${what} for ${STALL_MS / 1000} seconds`
          : `${hostOf(url)} could not be reached for ${what}`,
      );
    } finally {
      clearTimeout(timer);
      inflightAborts.delete(ac);
    }
  }
  throw lastErr ?? new Refusal('network', `${hostOf(url)} could not be reached for ${what}`);
}

function describe(status: number, what: string, url: string): string {
  const host = hostOf(url);
  if (status === 402)
    return `${host} wants payment for ${what}: its free allowance for your address is spent`;
  if (status === 429) return `${host} is rate limiting reads of ${what}`;
  if (status === 404) return `${host} does not have ${what}`;
  if (status === 416) return `${host} refused the byte range asked of ${what}`;
  if (status >= 500) return `${host} failed to serve ${what} (HTTP ${status})`;
  return `${host} answered ${what} with HTTP ${status}`;
}

// ---- torrents and trees ---------------------------------------------------
// One promise per infohash, resolving to every file's checked tree. A
// torrent is accepted only whole (see checkTorrent). A torrent that passes
// the first check but not the second is never cached, and the next source is
// tried, so one bad copy cannot block a band.
const torrents = new Map<string, Promise<Map<string, FileTree>>>();

function verifiedTorrent(spec: RangeSpec): Promise<Map<string, FileTree>> {
  const have = torrents.get(spec.ih);
  if (have) return have;
  const p = (async () => {
    const key = `https://ar-io-index.invalid/torrent/${spec.ih}`;
    try {
      const cache = await caches.open(TORRENT_CACHE);
      const hit = await cache.match(key);
      if (hit) {
        // A cache is storage, not a source of truth: checked like a download.
        try {
          return await checkTorrent(new Uint8Array(await hit.arrayBuffer()), spec.ih);
        } catch {
          await cache.delete(key);
        }
      }
    } catch {
      /* no Cache Storage here: fetch it */
    }
    const errors: Refusal[] = [];
    const last = spec.t[spec.t.length - 1];
    for (const t of spec.t) {
      try {
        const { body } = await fetchBytes(
          t,
          {},
          {
            what: 'the band’s torrent',
            expect: (s) => s === 200,
            maxBytes: MAX_TORRENT,
            retries: t === last ? RETRIES : 1,
          },
        );
        let files: Map<string, FileTree>;
        try {
          files = await checkTorrent(body, spec.ih);
        } catch (e) {
          const r = e as Refusal;
          throw new Refusal(
            r.code,
            `the torrent from ${hostOf(t)} ${r.code === 'integrity' ? r.message : 'is unusable: ' + r.message}`,
          );
        }
        try {
          await (await caches.open(TORRENT_CACHE)).put(key, new Response(body as BodyInit));
        } catch {
          /* best effort */
        }
        return files;
      } catch (e) {
        const r = e instanceof Refusal ? e : new Refusal('error', String(e));
        if (r.code === 'cancelled') throw r;
        errors.push(r);
        if (t !== last && r.code === 'integrity') {
          totals.failovers += 1;
          note(`${r.message}. Using another gateway’s copy, checked the same way.`);
        }
      }
    }
    const rank: Record<string, number> = {
      integrity: 0,
      torrent: 1,
      payment: 2,
      rate: 3,
      server: 4,
      network: 5,
      size: 6,
      status: 7,
    };
    errors.sort((x, y) => (rank[x.code] ?? 9) - (rank[y.code] ?? 9));
    throw errors[0] || new Refusal('torrent', 'no source for the band’s torrent');
  })();
  torrents.set(spec.ih, p);
  p.catch(() => torrents.delete(spec.ih)); // a failure is retried next time
  return p;
}

async function tree(spec: RangeSpec): Promise<FileTree> {
  const files = await verifiedTorrent(spec);
  const t = files.get(spec.f);
  if (!t) throw new Refusal('torrent', `${spec.f} is not in the band’s torrent`);
  // The publication signed this size too; the two must agree.
  if (spec.n !== undefined && t.size !== spec.n) {
    throw new Refusal(
      'integrity',
      `the torrent says ${spec.f} is ${t.size} bytes; the publication signed ${spec.n}`,
    );
  }
  return t;
}

// ---- verified piece store -------------------------------------------------
// Memory: insertion-ordered Map as an LRU. Disk: one cache per file root, so
// eviction drops whole files, with a small index of their sizes and last use.
const mem = new Map<string, Uint8Array>();
let memBytes = 0;
function memPut(key: string, bytes: Uint8Array): void {
  if (mem.has(key)) return;
  mem.set(key, bytes);
  memBytes += bytes.length;
  for (const [k, v] of mem) {
    if (memBytes <= MEM_CAP) break;
    mem.delete(k);
    memBytes -= v.length;
  }
}
function memGet(key: string): Uint8Array | undefined {
  const v = mem.get(key);
  if (v) {
    mem.delete(key);
    mem.set(key, v);
  }
  return v;
}

interface Meta {
  roots: Record<string, { bytes: number; used: number }>;
}
let metaChain: Promise<void> = Promise.resolve();
const withMeta = (fn: (meta: Meta) => Promise<boolean>) =>
  (metaChain = metaChain.then(async () => {
    try {
      const c = await caches.open(META_CACHE);
      const r = await c.match(META_KEY);
      const meta: Meta = r ? ((await r.json()) as Meta) : { roots: {} };
      const changed = await fn(meta);
      if (changed) await c.put(META_KEY, new Response(JSON.stringify(meta)));
    } catch {
      /* storage unavailable or full: memory still works */
    }
  }));

let pendingDisk = new Map<string, number>(); // cache name -> bytes written since the last index update
const cacheNameOf = (t: FileTree) => PIECE_PREFIX + t.rootHex + ':' + t.pieceLength;
function diskPut(t: FileTree, k: number, bytes: Uint8Array): void {
  const name = cacheNameOf(t);
  caches
    .open(name)
    .then((c) => c.put(`https://ar-io-index.invalid/p/${k}`, new Response(bytes as BodyInit)))
    .then(() => {
      pendingDisk.set(name, (pendingDisk.get(name) || 0) + bytes.length);
      scheduleIndex();
    })
    .catch(() => {
      /* quota or private mode: skip the disk */
    });
}
let indexTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleIndex(): void {
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    const batch = pendingDisk;
    pendingDisk = new Map();
    withMeta(async (meta) => {
      const now = Date.now();
      for (const [name, n] of batch) {
        const e = meta.roots[name] || (meta.roots[name] = { bytes: 0, used: now });
        e.bytes += n;
        e.used = now;
      }
      let total = Object.values(meta.roots).reduce((a, e) => a + e.bytes, 0);
      const order = Object.entries(meta.roots).sort((a, b) => a[1].used - b[1].used);
      for (const [name, e] of order) {
        if (total <= DISK_CAP) break;
        if (batch.has(name)) continue; // never the file being read right now
        await caches.delete(name);
        total -= e.bytes;
        delete meta.roots[name];
      }
      return true;
    });
  }, 2000);
}
async function diskGet(t: FileTree, k: number): Promise<Uint8Array | null> {
  try {
    const name = cacheNameOf(t);
    if (!(await caches.has(name))) return null;
    const r = await (await caches.open(name)).match(`https://ar-io-index.invalid/p/${k}`);
    if (!r) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    // Checked again on the way out: a cache is storage, not a source of truth.
    return (await pieceOk(t, k, bytes)) ? bytes : null;
  } catch {
    return null;
  }
}
async function clearDisk(): Promise<void> {
  for (const name of await caches.keys())
    if (name.startsWith(CACHE_PREFIX)) await caches.delete(name);
  mem.clear();
  memBytes = 0;
}

// ---- reading pieces ---------------------------------------------------------
const sourceDown = new Map<string, string>(); // host -> why it was set aside this session
const inflight = new Map<string, Promise<Uint8Array>>(); // piece key -> bytes

const pieceKey = (t: FileTree, k: number) => `${t.rootHex}:${t.pieceLength}:${t.size}:${k}`;

/** Pieces first..last, verified, fetching what is not stored in as few requests as possible. */
async function readPieces(
  spec: RangeSpec,
  t: FileTree,
  first: number,
  last: number,
): Promise<Map<number, Uint8Array>> {
  const out = new Map<number, Uint8Array | Promise<Uint8Array>>();
  const missing: number[] = [];
  for (let k = first; k <= last; k++) {
    const key = pieceKey(t, k);
    const m = memGet(key);
    if (m) {
      totals.memHits += 1;
      out.set(k, m);
      continue;
    }
    const f = inflight.get(key);
    if (f) {
      out.set(k, f);
      continue;
    }
    missing.push(k);
  }
  // Disk lookups in parallel; whatever is still missing is fetched.
  const fromDisk = await Promise.all(missing.map((k) => diskGet(t, k)));
  const toFetch: number[] = [];
  missing.forEach((k, i) => {
    const d = fromDisk[i];
    if (d) {
      totals.diskHits += 1;
      memPut(pieceKey(t, k), d);
      out.set(k, d);
    } else toFetch.push(k);
  });
  // Contiguous runs, each capped at MAX_FETCH.
  const perReq = Math.max(1, Math.floor(MAX_FETCH / t.pieceLength));
  const runs: [number, number][] = [];
  for (const k of toFetch) {
    const r = runs[runs.length - 1];
    if (r && k === r[1] + 1 && k - r[0] < perReq) r[1] = k;
    else runs.push([k, k]);
  }
  if (runs.length && refusing()) throw new Refusal('cancelled', 'Stopped.');
  for (const [a, b] of runs) {
    const p = fetchRun(spec, t, a, b);
    for (let k = a; k <= b; k++) {
      const key = pieceKey(t, k);
      const one = p.then((m) => m.get(k)!);
      one.catch(() => {}); // awaited below; this only marks it handled
      inflight.set(key, one);
      one.finally(() => inflight.delete(key)).catch(() => {});
      out.set(k, one);
    }
  }
  const done = new Map<number, Uint8Array>();
  // Settle everything before failing, so no rejection is left unobserved.
  const keys = [...out.keys()];
  const settled = await Promise.allSettled([...out.values()]);
  const bad = settled.find((r) => r.status === 'rejected');
  if (bad) throw (bad as PromiseRejectedResult).reason;
  keys.forEach((k, i) => done.set(k, (settled[i] as PromiseFulfilledResult<Uint8Array>).value));
  progress();
  return done;
}

const status200Cap = (t: FileTree, n: number) =>
  Math.max(n, t.size <= MAX_WHOLE_FALLBACK ? t.size : n);

/** One run of pieces from the first source that serves it with bytes that verify. */
async function fetchRun(
  spec: RangeSpec,
  t: FileTree,
  a: number,
  b: number,
): Promise<Map<number, Uint8Array>> {
  const P = t.pieceLength;
  const start = a * P;
  const end = Math.min((b + 1) * P, t.size) - 1;
  // Sources that failed earlier are tried last, never skipped: one hiccup
  // must not cost a file that only that source has.
  const sources = [
    ...spec.u.filter((u) => !sourceDown.has(hostOf(u))),
    ...spec.u.filter((u) => sourceDown.has(hostOf(u))),
  ];
  // Each source once, quickly, while another remains; the last one patiently.
  const plan = sources.map((u, i) => ({ u, retries: i === sources.length - 1 ? RETRIES : 0 }));
  const errors: Refusal[] = [];
  let gaveFirstAnotherGo = false;
  for (let i = 0; i < plan.length; i++) {
    const { u, retries } = plan[i]!;
    if (refusing()) throw new Refusal('cancelled', 'Stopped.');
    try {
      const { status, body } = await fetchBytes(
        u,
        { headers: { Range: `bytes=${start}-${end}` } },
        {
          what: spec.label,
          expect: (s) => s === 206 || (s === 200 && t.size <= MAX_WHOLE_FALLBACK),
          maxBytes: status200Cap(t, end - start + 1),
          retries,
        },
      );
      let bytes = body;
      if (status === 200) {
        if (body.length !== t.size)
          throw new Refusal(
            'integrity',
            `${hostOf(u)} sent ${body.length} bytes of ${spec.label}, which is ${t.size}`,
          );
        bytes = body.subarray(start, end + 1);
      } else if (bytes.length !== end - start + 1) {
        throw new Refusal(
          'integrity',
          `${hostOf(u)} sent ${bytes.length} bytes for a ${end - start + 1}-byte range of ${spec.label}`,
        );
      }
      const got = new Map<number, Uint8Array>();
      for (let k = a; k <= b; k++) {
        const piece = bytes.slice((k - a) * P, Math.min((k - a + 1) * P, bytes.length));
        if (!(await pieceOk(t, k, piece))) {
          throw new Refusal(
            'integrity',
            `${hostOf(u)} sent bytes of ${spec.label} that do not match the torrent the publisher signed (piece ${k})`,
          );
        }
        totals.verified += 1;
        got.set(k, piece);
        memPut(pieceKey(t, k), piece);
        diskPut(t, k, piece);
      }
      return got;
    } catch (e) {
      const r = e instanceof Refusal ? e : new Refusal('error', String(e));
      if (r.code === 'cancelled') throw r;
      errors.push(r);
      // Set aside for this session: a gateway that lied or failed is tried
      // last from now on. A missing file (404) is not the gateway's fault.
      if (r.code !== 'status') sourceDown.set(hostOf(u), r.message);
      // Everything else failed too: the first source, if it only stumbled
      // (a timeout, a 5xx, a rate limit), gets one patient retry. One that
      // sent bad bytes or asked for payment does not.
      if (
        i === plan.length - 1 &&
        plan.length > 1 &&
        !gaveFirstAnotherGo &&
        ['network', 'server', 'rate'].includes(errors[0]!.code)
      ) {
        gaveFirstAnotherGo = true;
        plan.push({ u: plan[0]!.u, retries: RETRIES });
      }
      if (i < plan.length - 1) {
        totals.failovers += 1;
        note(`${r.message}. Trying another source; every byte is still checked.`);
      }
    }
  }
  // Report the failure that matters most: a gateway that sent forged bytes
  // outranks one that merely lacked the file.
  const rank: Record<string, number> = {
    integrity: 0,
    payment: 1,
    rate: 2,
    server: 3,
    network: 4,
    size: 5,
    status: 6,
  };
  errors.sort((x, y) => (rank[x.code] ?? 9) - (rank[y.code] ?? 9));
  const worst = errors[0]!;
  throw errors.length > 1
    ? new Refusal(worst.code, `${worst.message}, and no other gateway had a good copy`)
    : worst;
}

// ---- the route ----------------------------------------------------------------
self.addEventListener('fetch', (e: FetchEvent) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const at = url.pathname.indexOf(RANGE_PREFIX);
  if (at < 0) return;
  const rest = url.pathname.slice(at + RANGE_PREFIX.length);
  if (rest === 'ping') {
    e.respondWith(
      new Response(JSON.stringify({ ok: true, version: RANGE_VERSION }), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }),
    );
    return;
  }
  let spec: RangeSpec;
  try {
    spec = decodeSpec(rest);
  } catch {
    e.respondWith(
      refuse(
        new Refusal('request', 'this page and its reader are different versions; reload the page'),
      ),
    );
    return;
  }
  e.respondWith(serve(e.request, spec));
});

function refuse(err: Refusal): Response {
  channel.postMessage({ type: 'fail', code: err.code || 'error', msg: err.message });
  // 409 for a cancel, so nothing retries it; 502 for everything else.
  return new Response(err.message, {
    status: err.code === 'cancelled' ? 409 : 502,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function serve(req: Request, spec: RangeSpec): Promise<Response> {
  try {
    if (refusing()) throw new Refusal('cancelled', 'Stopped.');
    const t = await tree(spec);
    const range = req.headers.get('Range');
    const base: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    if (req.method === 'HEAD' && t.size === 0) {
      return new Response(null, { status: 200, headers: { ...base, 'Content-Length': '0' } });
    }
    if (req.method === 'HEAD') {
      // DuckDB opens a file with a plain HEAD, then one with Range: bytes=0-
      // that must come back 206 with the whole length.
      return new Response(null, {
        status: range ? 206 : 200,
        headers: {
          ...base,
          'Content-Length': String(t.size),
          ...(range ? { 'Content-Range': `bytes 0-${t.size - 1}/${t.size}` } : {}),
        },
      });
    }
    if (req.method !== 'GET') return refuse(new Refusal('request', 'only reads are served'));
    if (t.size === 0)
      return new Response(new Uint8Array(0), {
        status: 200,
        headers: { ...base, 'Content-Length': '0' },
      });
    let start = 0;
    let end = t.size - 1;
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
      if (!m) return refuse(new Refusal('request', `unsupported range ${range}`));
      start = Number(m[1]);
      end = m[2] === '' ? t.size - 1 : Math.min(Number(m[2]), t.size - 1);
      if (start > end || start >= t.size) {
        return new Response(null, {
          status: 416,
          headers: { ...base, 'Content-Range': `bytes */${t.size}` },
        });
      }
    }
    const P = t.pieceLength;
    const first = Math.floor(start / P);
    const last = Math.floor(end / P);
    const got = await readPieces(spec, t, first, last);
    const out = new Uint8Array(end - start + 1);
    for (let k = first; k <= last; k++) {
      const c = got.get(k);
      const at = k * P;
      // Every piece is exactly as long as the tree says, or nothing is sent:
      // a short one would leave unchecked zeros in the answer.
      const want = pieceSize(t, k);
      if (!c || c.length !== want)
        throw new Refusal(
          'integrity',
          `piece ${k} of ${spec.label} is not the length its tree requires`,
        );
      const from = Math.max(start, at) - at;
      const to = Math.min(end, at + c.length - 1) - at;
      out.set(c.subarray(from, to + 1), Math.max(start, at) - start);
    }
    return new Response(out, {
      status: range ? 206 : 200,
      headers: {
        ...base,
        'Content-Length': String(out.length),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${t.size}` } : {}),
      },
    });
  } catch (err) {
    return refuse(
      err instanceof Refusal
        ? err
        : new Refusal('error', err instanceof Error ? err.message : String(err)),
    );
  }
}
