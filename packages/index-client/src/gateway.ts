/**
 * Which gateway to read from. The page is served by a gateway, so that one
 * comes first when it publishes the index; then the known publishers. The
 * registry is read through a different gateway from the data, so the signing
 * key never comes from the server that signed.
 */
import { fetchPublication, type FetchedPublication, type Publication } from './publication.js';
import { hostOf } from './util/fetch.js';

/**
 * Gateways consulted for the registry. Each must serve /ar-io/peers from the
 * current registry: ar.io has no such route, ardrive.net is turbo's own fleet,
 * and some gateways still report keys from before the registry moved, so only
 * these qualify (2026-10-10).
 */
export const REGISTRY_GATEWAYS = ['https://turbo-gateway.com', 'https://vilenarios.com'];

/** Tried in order when the gateway is left on Auto, after the page's own origin. */
export const KNOWN_PUBLISHERS = ['https://turbo-gateway.com', 'https://vilenarios.com'];

/**
 * Other gateways a range read may fall back to. Safe because nothing they
 * send is used unless it matches the hash tree this publication pins; a
 * gateway without the same bytes simply answers 404 and is skipped.
 */
export const mirrorsOf = (
  gw: string | null,
  publishers: readonly string[] = KNOWN_PUBLISHERS,
): string[] => publishers.filter((g) => !gw || hostOf(g) !== hostOf(gw));

/**
 * Hosts that serve a page but are not gateways: ar.io resolves ArNS names
 * without publishing indexes, and a local copy has no gateway behind it.
 */
export const NOT_GATEWAYS = /(^|\.)ar\.io$|^localhost$|^127\.|^\[?::1\]?$/;

/** The gateways Auto tries, in order, from the page's own location. */
export function autoCandidates(
  loc: { protocol: string; hostname: string; origin: string },
  publishers: readonly string[] = KNOWN_PUBLISHERS,
): string[] {
  const out: string[] = [];
  const host = loc.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  if ((loc.protocol === 'https:' || loc.protocol === 'http:') && !NOT_GATEWAYS.test(host)) {
    out.push(loc.origin);
    // A sandbox subdomain serves the data routes while the gateway itself is
    // the registrable domain, so try that too. Never for a bare IP or
    // localhost, where chopping labels invents a host that does not exist.
    const parts = host.split('.');
    if (!isIp && host !== 'localhost' && parts.length > 2) {
      out.push(`${loc.protocol}//${parts.slice(-2).join('.')}`);
    }
  }
  for (const g of publishers) out.push(g);
  return [...new Set(out)];
}

export interface PickedGateway {
  gateway: string;
  auto: boolean;
  tried: string[];
  /** The publication already read, so it is fetched once, not twice. */
  publication: FetchedPublication | null;
}

export interface PickOptions {
  /** 'auto', or a gateway origin. */
  choice: string;
  indexName: string;
  /** Whether a publication offers what the page reads: by default, an index named `indexName`. */
  offers?: (doc: Publication) => boolean;
  candidates?: string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Why a gateway gave no publication, in words: it could not be reached, it
 * did not answer in time, or what it answered.
 */
export function unreachedWhy(e: unknown): string {
  if (e instanceof Error && e.name === 'AbortError') return 'did not answer in time';
  if (e instanceof TypeError) return 'could not be reached';
  return e instanceof Error ? e.message : String(e);
}

/** No candidate offered the index; `reasons` says why, per host. */
export class NoGatewayError extends Error {
  constructor(
    public readonly reasons: readonly { host: string; why: string }[],
    indexName: string,
  ) {
    super(noGatewayText(reasons, indexName));
    this.name = 'NoGatewayError';
  }

  /** Whether no candidate answered at all (offline, or every gateway down). */
  get unreachable(): boolean {
    return this.reasons.every(
      (r) => r.why === 'could not be reached' || r.why === 'did not answer in time',
    );
  }
}

const NO_INDEX = 'answered without the index';
const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

function noGatewayText(
  reasons: readonly { host: string; why: string }[],
  indexName: string,
): string {
  const hosts = reasons.map((r) => r.host);
  const list = (xs: string[]) =>
    xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
  if (!reasons.length) return `no gateway to ask for ${article(indexName)} ${indexName} index`;
  if (reasons.every((r) => r.why === 'could not be reached' || r.why === 'did not answer in time'))
    return `could not reach ${list(hosts)}: the network may be down, or the gateways are`;
  if (reasons.every((r) => r.why === NO_INDEX))
    return `none of these publish ${article(indexName)} ${indexName} index: ${hosts.join(', ')}`;
  return `no gateway offered ${article(indexName)} ${indexName} index: ${reasons.map((r) => `${r.host} ${r.why}`).join('; ')}`;
}

/** The first candidate that actually publishes the index. */
export async function pickGateway(opts: PickOptions): Promise<PickedGateway> {
  if (opts.choice !== 'auto') {
    const gw = opts.choice.trim().replace(/\/+$/, '');
    if (!gw) throw new Error('type the gateway URL');
    return { gateway: gw, auto: false, tried: [], publication: null };
  }
  const tried: string[] = [];
  const reasons: { host: string; why: string }[] = [];
  for (const c of opts.candidates ?? KNOWN_PUBLISHERS) {
    const host = hostOf(c);
    tried.push(host);
    try {
      const fo: { timeoutMs: number; fetch?: typeof fetch } = { timeoutMs: opts.timeoutMs ?? 6000 };
      if (opts.fetch) fo.fetch = opts.fetch;
      const pub = await fetchPublication(c, fo);
      const offers =
        opts.offers ?? ((d: Publication) => d.indexes.some((i) => i.name === opts.indexName));
      if (offers(pub.doc)) return { gateway: pub.gateway, auto: true, tried, publication: pub };
      reasons.push({ host, why: NO_INDEX });
    } catch (e) {
      // Unreachable, slow, or not a publication: said per host, then the next is tried.
      reasons.push({ host, why: unreachedWhy(e) });
    }
  }
  throw new NoGatewayError(reasons, opts.indexName);
}

/**
 * Block heights mean little to a reader, so label everything with dates. One
 * aliased GraphQL request covers every band boundary at once; failing it is
 * cosmetic, so the caller carries on with heights alone.
 */
export async function fetchBandDates(
  gateways: readonly string[],
  heights: readonly number[],
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<Map<number, number>> {
  const uniq = [...new Set(heights)].sort((a, b) => a - b);
  const query =
    '{' +
    uniq
      .map(
        (h) => `h${h}: blocks(height:{min:${h},max:${h}},first:1){edges{node{height timestamp}}}`,
      )
      .join(' ') +
    '}';
  const out = new Map<number, number>();
  for (const g of gateways) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10000);
      const res = await (opts.fetch ?? fetch)(g.replace(/\/+$/, '') + '/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: ac.signal,
      }).finally(() => clearTimeout(timer));
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?: Record<string, { edges?: { node?: { height: number; timestamp: number } }[] }>;
      };
      for (const v of Object.values(body.data ?? {})) {
        const n = v?.edges?.[0]?.node;
        if (n && typeof n.height === 'number' && typeof n.timestamp === 'number')
          out.set(n.height, n.timestamp);
      }
      if (out.size) return out;
    } catch {
      /* next */
    }
  }
  return out;
}
