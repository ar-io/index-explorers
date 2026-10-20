/** Fetch helpers: timeouts, stall detection, status text a reader can act on. */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Turns a status into something a reader can act on. */
export function describeStatus(status: number, what: string): string {
  if (status === 402) {
    return `${what} needs payment: this gateway meters these bytes and the free allowance for your address is spent. Pick another gateway, or wait for it to refill.`;
  }
  if (status === 429)
    return `${what} was rate limited by this gateway. Wait a moment, or pick another gateway.`;
  if (status === 404) return `${what} is not on this gateway (404).`;
  if (status === 503)
    return `${what} is temporarily unavailable; the publisher may be replacing a band.`;
  if (status >= 500) return `${what} failed: the gateway returned ${status}.`;
  return `${what} failed: HTTP ${status}.`;
}

/** A probe must never stall the page: an unreachable host should fail fast. */
export async function fetchWithTimeout(
  url: string,
  ms: number,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const outer = init.signal;
  if (outer) {
    if (outer.aborted) ac.abort();
    else outer.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export const withTimeout = <T>(p: Promise<T>, ms: number, why: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(why)), ms))]);

export interface ProgressReport {
  got: number;
  total: number;
  label: string;
}

/** How long a download may go without a byte before it counts as stalled. */
export const STALL_MS = 30000;

/**
 * Reads a body in chunks so the download can be reported while it happens.
 * `expectedSize` is the decompressed length when it is known from something
 * trustworthy (a pinned constant, or a size inside the signed publication);
 * Content-Length is only used when the body is not content-encoded, because
 * otherwise it counts compressed bytes the stream never yields. With the
 * exact size known the bytes go straight into one buffer, and a file longer
 * or shorter than its signed size is refused before it is hashed.
 */
export async function fetchWithProgress(
  url: string,
  label: string,
  expectedSize: number | undefined,
  onProgress?: (p: ProgressReport) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const ac = new AbortController();
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
    const res = await fetchImpl(url, { signal: ac.signal });
    kick();
    if (!res.ok) throw new HttpError(res.status, describeStatus(res.status, label));
    const encoded = (res.headers.get('content-encoding') || '').trim() !== '';
    const header = Number(res.headers.get('content-length'));
    const total = expectedSize || (!encoded && header > 0 ? header : 0);
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    const exact = expectedSize && expectedSize > 0 ? new Uint8Array(expectedSize) : null;
    const parts: Uint8Array[] = [];
    let got = 0;
    let painted = 0;
    onProgress?.({ got: 0, total, label });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      kick();
      if (exact) {
        if (got + value.length > exact.length)
          throw new Error(`${label} is longer than its signed size`);
        exact.set(value, got);
      } else parts.push(value);
      got += value.length;
      const now = performance.now();
      if (now - painted > 100) {
        painted = now;
        onProgress?.({ got, total, label });
      }
    }
    onProgress?.({ got, total: total || got, label });
    if (exact) {
      if (got !== exact.length)
        throw new Error(`${label} ended at ${got} bytes, short of its signed ${exact.length}`);
      return exact;
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  } catch (e) {
    if (stalled)
      throw new Error(
        `${label} stopped arriving for ${STALL_MS / 1000} seconds. The gateway may be overloaded; try again, or pick another.`,
      );
    if (e instanceof TypeError)
      throw new Error(`${label} could not be fetched: the gateway did not answer.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const hostOf = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
