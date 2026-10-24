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

/** The first candidate that actually publishes the index. */
export async function pickGateway(opts: PickOptions): Promise<PickedGateway> {
  if (opts.choice !== 'auto') {
    const gw = opts.choice.trim().replace(/\/+$/, '');
    if (!gw) throw new Error('type the gateway URL');
    return { gateway: gw, auto: false, tried: [], publication: null };
  }
  const tried: string[] = [];
  for (const c of opts.candidates ?? KNOWN_PUBLISHERS) {
    tried.push(hostOf(c));
    try {
      const fo: { timeoutMs: number; fetch?: typeof fetch } = { timeoutMs: opts.timeoutMs ?? 6000 };
      if (opts.fetch) fo.fetch = opts.fetch;
      const pub = await fetchPublication(c, fo);
      const offers =
        opts.offers ?? ((d: Publication) => d.indexes.some((i) => i.name === opts.indexName));
      if (offers(pub.doc)) return { gateway: pub.gateway, auto: true, tried, publication: pub };
    } catch {
      /* unreachable, or no index here: try the next */
    }
  }
  throw new Error(`none of these publish an ${opts.indexName} index: ${tried.join(', ')}`);
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
