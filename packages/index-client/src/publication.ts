/**
 * The signed publication: `/ar-io/indexes`, parsed, validated and verified
 * against the gateway registry. See ar-io/ar-io-node docs/index-publication.md.
 *
 * Three checks, in order, each of which can refuse the publication:
 *   1. the registry, read from an independent gateway, names a signing key
 *   2. the publication claims that same key
 *   3. the Ed25519 signature verifies over RFC 8785 canonical JSON
 * Band digests are only meaningful once this has passed, because the digests
 * live inside the document the signature covers.
 */
import canonicalize from 'canonicalize';
import * as ed from '@noble/ed25519';

import { base58Decode } from './util/base58.js';
import { fromBase64, sha256Hex, utf8 } from './util/bytes.js';
import { describeStatus, fetchWithTimeout, HttpError, hostOf } from './util/fetch.js';

export interface PublicationFile {
  name: string;
  size: number;
  sha256: string;
}

export interface PublicationTorrent {
  infohashV1?: string;
  infohashV2?: string;
  magnet?: string;
  torrentUrl?: string;
}

export interface PublicationBand {
  id: string;
  files: PublicationFile[];
  heightRange?: [number, number | null];
  records?: number;
  http?: { baseUrl?: string };
  torrent?: PublicationTorrent;
  arweave?: { manifestTxId?: string };
  metadata?: Record<string, unknown>;
}

export interface PublicationIndex {
  name: string;
  kind: string;
  filter?: unknown;
  bands: PublicationBand[];
}

export interface PublicationSignature {
  alg: string;
  keyId: string;
  sig: string;
}

export interface Publication {
  version: 1;
  publisher: string;
  sequence: number;
  previousManifestSha256: string | null;
  issuedAt: string;
  expiresAt: string;
  indexes: PublicationIndex[];
  signature: PublicationSignature;
  /** Unknown fields a publisher adds later: kept, and signed. */
  [extra: string]: unknown;
}

/** Documents larger than this are refused before parsing (the protocol's limit). */
export const PUBLICATION_MAX_BYTES = 4 * 1024 * 1024;
const MAX_INDEXES = 64;
const MAX_BANDS = 1024;
const MAX_FILES = 1024;
const NAME_RE = /^[a-z0-9-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function bad(why: string): never {
  throw new Error(`the publication is not well formed: ${why}`);
}

function safeId(v: unknown, what: string): string {
  if (typeof v !== 'string' || !ID_RE.test(v) || v === '.' || v.includes('..') || RESERVED.has(v))
    bad(`${what} ${JSON.stringify(v)} is not a valid name`);
  return v;
}

function parseFile(raw: unknown, where: string): PublicationFile {
  if (!isObject(raw)) bad(`${where}: a file is not an object`);
  const name = safeId(raw.name, `${where}: file name`);
  if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0)
    bad(`${where}/${name}: size`);
  if (typeof raw.sha256 !== 'string' || !HEX64_RE.test(raw.sha256)) bad(`${where}/${name}: sha256`);
  return { name, size: raw.size, sha256: raw.sha256 };
}

function parseBand(raw: unknown, where: string): PublicationBand {
  if (!isObject(raw)) bad(`${where}: a band is not an object`);
  const id = safeId(raw.id, `${where}: band id`);
  if (!Array.isArray(raw.files) || raw.files.length === 0 || raw.files.length > MAX_FILES)
    bad(`${where}/${id}: files`);
  const files = raw.files.map((f) => parseFile(f, `${where}/${id}`));
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.name)) bad(`${where}/${id}: file ${f.name} listed twice`);
    seen.add(f.name);
  }
  const band: PublicationBand = { id, files };
  if (raw.heightRange !== undefined) {
    const hr = raw.heightRange;
    if (
      !Array.isArray(hr) ||
      hr.length !== 2 ||
      typeof hr[0] !== 'number' ||
      !Number.isSafeInteger(hr[0]) ||
      hr[0] < 0 ||
      !(hr[1] === null || (typeof hr[1] === 'number' && Number.isSafeInteger(hr[1]) && hr[1] >= hr[0]))
    )
      bad(`${where}/${id}: heightRange`);
    band.heightRange = [hr[0], hr[1] as number | null];
  }
  if (raw.records !== undefined) {
    if (typeof raw.records !== 'number' || !Number.isSafeInteger(raw.records) || raw.records < 0)
      bad(`${where}/${id}: records`);
    band.records = raw.records;
  }
  if (raw.http !== undefined) {
    if (!isObject(raw.http)) bad(`${where}/${id}: http`);
    const h: { baseUrl?: string } = {};
    if (raw.http.baseUrl !== undefined) {
      if (typeof raw.http.baseUrl !== 'string') bad(`${where}/${id}: http.baseUrl`);
      h.baseUrl = raw.http.baseUrl;
    }
    band.http = h;
  }
  if (raw.torrent !== undefined) {
    const t0 = raw.torrent;
    if (!isObject(t0)) bad(`${where}/${id}: torrent`);
    const t: PublicationTorrent = {};
    const s = (k: keyof PublicationTorrent, re?: RegExp) => {
      const v = t0[k];
      if (v === undefined) return;
      if (typeof v !== 'string' || (re && !re.test(v))) bad(`${where}/${id}: torrent.${k}`);
      t[k] = v;
    };
    s('infohashV1', HEX40_RE);
    s('infohashV2', HEX64_RE);
    s('magnet');
    s('torrentUrl');
    band.torrent = t;
  }
  if (raw.arweave !== undefined) {
    if (!isObject(raw.arweave)) bad(`${where}/${id}: arweave`);
    const a: { manifestTxId?: string } = {};
    if (raw.arweave.manifestTxId !== undefined) {
      if (
        typeof raw.arweave.manifestTxId !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(raw.arweave.manifestTxId)
      )
        bad(`${where}/${id}: arweave.manifestTxId`);
      a.manifestTxId = raw.arweave.manifestTxId;
    }
    band.arweave = a;
  }
  if (raw.metadata !== undefined) {
    if (!isObject(raw.metadata)) bad(`${where}/${id}: metadata`);
    band.metadata = raw.metadata;
  }
  return band;
}

/**
 * Parses and validates a publication document. The object returned keeps every
 * member of the original (unknown fields are signed, so they must survive), but
 * the known ones are checked for the types and patterns version 1 defines.
 */
export function parsePublication(raw: unknown): Publication {
  if (!isObject(raw)) bad('not an object');
  if (raw.version !== 1) bad(`version ${JSON.stringify(raw.version)} is not 1`);
  if (typeof raw.publisher !== 'string' || !raw.publisher) bad('publisher');
  if (typeof raw.sequence !== 'number' || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0)
    bad('sequence');
  if (
    !(
      raw.previousManifestSha256 === null ||
      (typeof raw.previousManifestSha256 === 'string' && HEX64_RE.test(raw.previousManifestSha256))
    )
  )
    bad('previousManifestSha256');
  for (const k of ['issuedAt', 'expiresAt'] as const) {
    const v = raw[k];
    if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) bad(k);
  }
  if (!Array.isArray(raw.indexes) || raw.indexes.length > MAX_INDEXES) bad('indexes');
  const names = new Set<string>();
  const indexes: PublicationIndex[] = raw.indexes.map((ix) => {
    if (!isObject(ix)) bad('an index is not an object');
    if (typeof ix.name !== 'string' || !NAME_RE.test(ix.name) || RESERVED.has(ix.name))
      bad(`index name ${JSON.stringify(ix.name)}`);
    if (names.has(ix.name)) bad(`index ${ix.name} listed twice`);
    names.add(ix.name);
    if (typeof ix.kind !== 'string' || !NAME_RE.test(ix.kind)) bad(`index ${ix.name}: kind`);
    if (!Array.isArray(ix.bands) || ix.bands.length > MAX_BANDS) bad(`index ${ix.name}: bands`);
    const ids = new Set<string>();
    const bands = ix.bands.map((b) => {
      const band = parseBand(b, ix.name as string);
      if (ids.has(band.id)) bad(`index ${ix.name}: band ${band.id} listed twice`);
      ids.add(band.id);
      return band;
    });
    const out: PublicationIndex = { name: ix.name, kind: ix.kind, bands };
    if (ix.filter !== undefined) out.filter = ix.filter;
    return out;
  });
  const sig = raw.signature;
  if (
    !isObject(sig) ||
    typeof sig.alg !== 'string' ||
    typeof sig.keyId !== 'string' ||
    typeof sig.sig !== 'string'
  )
    bad('signature');
  // Every other member rides along untouched: it is part of what was signed.
  return {
    ...raw,
    version: 1,
    publisher: raw.publisher,
    sequence: raw.sequence,
    previousManifestSha256: raw.previousManifestSha256 as string | null,
    issuedAt: raw.issuedAt as string,
    expiresAt: raw.expiresAt as string,
    indexes,
    signature: { alg: sig.alg, keyId: sig.keyId, sig: sig.sig },
  };
}

export interface FetchedPublication {
  /** The gateway origin the document came from, no trailing slash. */
  gateway: string;
  doc: Publication;
  /** The document exactly as served, and its SHA-256: what `previousManifestSha256` chains. */
  raw: string;
  sha256: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/** `GET /ar-io/indexes`, bounded, parsed and validated (not yet verified). */
export async function fetchPublication(gateway: string, opts: FetchOptions = {}): Promise<FetchedPublication> {
  const origin = gateway.replace(/\/+$/, '');
  const init: RequestInit = opts.signal ? { signal: opts.signal } : {};
  const res = await fetchWithTimeout(origin + '/ar-io/indexes', opts.timeoutMs ?? 15000, init, opts.fetch ?? fetch);
  if (!res.ok) throw new HttpError(res.status, describeStatus(res.status, 'the publication'));
  const len = Number(res.headers.get('content-length'));
  if (len > PUBLICATION_MAX_BYTES) throw new Error('the publication is larger than the protocol allows (4 MiB)');
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > PUBLICATION_MAX_BYTES)
    throw new Error('the publication is larger than the protocol allows (4 MiB)');
  const raw = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('the publication is not JSON');
  }
  return { gateway: origin, doc: parsePublication(parsed), raw, sha256: await sha256Hex(bytes) };
}

export interface RegistryRecord {
  wallet: string;
  observerAddress: string;
  url: string | null;
  /** The gateway whose `/ar-io/peers` answered. */
  via: string;
}

export interface RegistryOptions {
  /** Gateways to ask, in order; each must serve `/ar-io/peers` from the current registry. */
  gateways: string[];
  /** The data gateway: never asked, so the key never comes from the server that signed. */
  excluding?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * The registry record of a publisher, by wallet, read through a gateway that
 * is not the data gateway. Throws when no independent gateway could answer or
 * the publisher is not registered.
 */
export async function lookupRegistry(publisher: string, opts: RegistryOptions): Promise<RegistryRecord> {
  const ex = opts.excluding ? hostOf(opts.excluding) : null;
  const hosts = opts.gateways.filter((g) => hostOf(g) !== ex);
  if (!hosts.length) throw new Error('no independent gateway is available to read the registry from');
  let lastErr: unknown = null;
  for (const host of hosts) {
    try {
      const res = await fetchWithTimeout(
        host.replace(/\/+$/, '') + '/ar-io/peers',
        opts.timeoutMs ?? 15000,
        {},
        opts.fetch ?? fetch,
      );
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body: unknown = await res.json();
      const list = isObject(body) && isObject(body.gateways) ? body.gateways : body;
      const values: unknown[] = isObject(list) ? Object.values(list) : Array.isArray(list) ? list : [];
      const rec = values.find((g) => isObject(g) && g.wallet === publisher);
      if (!isObject(rec) || typeof rec.observerAddress !== 'string' || !rec.observerAddress)
        throw new Error('publisher is not in the registry');
      return {
        wallet: publisher,
        observerAddress: rec.observerAddress,
        url: typeof rec.url === 'string' ? rec.url : null,
        via: host,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    'could not read the registry independently: ' + (lastErr instanceof Error ? lastErr.message : String(lastErr)),
  );
}

export interface Proof {
  /** The gateway whose registry copy named the key. */
  via: string;
  /** The signing key, base58, as the registry names it and the document claims it. */
  key: string;
  publisher: string;
  publisherUrl: string | null;
  sequence: number;
  /** Whether `expiresAt` has passed: the publisher has gone quiet, not that its bands have gone bad. */
  expired: boolean;
  issuedAt: string;
  expiresAt: string;
}

export const SIGNING_PREFIX = 'ar-io-index-publication/v1\n';

/** The bytes the publisher signed: the fixed prefix and the canonical JSON of everything but `signature`. */
export function signingBase(doc: Publication): Uint8Array {
  const { signature: _drop, ...unsigned } = doc;
  const canonical = canonicalize(unsigned);
  if (typeof canonical !== 'string') throw new Error('the publication cannot be canonicalised');
  return utf8(SIGNING_PREFIX + canonical);
}

/** Step 3 alone: does `doc.signature` verify under `keyId`? Throws on any failure. */
export async function verifySignature(doc: Publication, keyId: string): Promise<void> {
  const sig = doc.signature;
  if (sig.alg !== 'ed25519') throw new Error('the publication is not Ed25519 signed');
  if (sig.keyId !== keyId)
    throw new Error(`the publication is signed by ${sig.keyId}, but the registry names ${keyId} for this gateway`);
  let pub: Uint8Array;
  try {
    pub = base58Decode(sig.keyId);
  } catch {
    throw new Error('the signing key is not base58');
  }
  if (pub.length !== 32) throw new Error('the signing key is not 32 bytes');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(sig.sig);
  } catch {
    throw new Error('the signature is not base64');
  }
  if (bytes.length !== 64) throw new Error('the signature is not 64 bytes');
  const ok = await ed.verifyAsync(bytes, signingBase(doc), pub);
  if (!ok) throw new Error('the signature does not match the publication');
}

export type CheckName = 'registry' | 'signature';
export type CheckState = 'run' | 'ok' | 'bad';

export interface VerifyOptions {
  /** Gateways to read the registry from; the data gateway is excluded. */
  registryGateways: string[];
  /** The gateway the document came from. */
  excluding?: string | null;
  /** For tests: a registry record already in hand. */
  registry?: RegistryRecord;
  now?: () => number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Called as each check starts and ends, for a trust panel. */
  onCheck?: (check: CheckName, state: CheckState) => void;
}

/**
 * Verifies a publication. Throws on any failure; a check that cannot run is a
 * failure. Which server returned the document does not matter: the signature
 * is over content, not transport.
 */
export async function verifyPublication(doc: Publication, opts: VerifyOptions): Promise<Proof> {
  if (doc.signature.alg !== 'ed25519') throw new Error('the publication is not Ed25519 signed');
  opts.onCheck?.('registry', 'run');
  let rec: RegistryRecord;
  try {
    const o: RegistryOptions = { gateways: opts.registryGateways };
    if (opts.excluding !== undefined) o.excluding = opts.excluding;
    if (opts.timeoutMs !== undefined) o.timeoutMs = opts.timeoutMs;
    if (opts.fetch) o.fetch = opts.fetch;
    rec = opts.registry ?? (await lookupRegistry(doc.publisher, o));
  } catch (e) {
    opts.onCheck?.('registry', 'bad');
    throw e;
  }
  opts.onCheck?.('registry', 'ok');
  opts.onCheck?.('signature', 'run');
  try {
    await verifySignature(doc, rec.observerAddress);
  } catch (e) {
    opts.onCheck?.('signature', 'bad');
    throw e;
  }
  opts.onCheck?.('signature', 'ok');
  const now = (opts.now ?? Date.now)();
  return {
    via: rec.via,
    key: doc.signature.keyId,
    publisher: doc.publisher,
    publisherUrl: rec.url,
    sequence: doc.sequence,
    expired: Date.parse(doc.expiresAt) < now,
    issuedAt: doc.issuedAt,
    expiresAt: doc.expiresAt,
  };
}

/* ------------------------------------------------------------------------ */
/*  Bands, as a client reads them.                                           */
/* ------------------------------------------------------------------------ */

export interface BandFile {
  name: string;
  size: number;
  sha256: string;
  /** Absolute URL on the data gateway, from the band's `http.baseUrl`. */
  url: string;
}

export interface BandTorrent {
  infohashV1: string | null;
  infohashV2: string;
  magnet: string | null;
  /** Absolute URLs of the `.torrent`: the publisher's, then the mirrors'. */
  urls: string[];
}

export interface Band {
  id: string;
  index: string;
  kind: string;
  from: number;
  /** The last height, or null for a band open at the tip. */
  to: number | null;
  records: number;
  files: Map<string, BandFile>;
  /** The sum of every file's signed size. */
  size: number;
  /** Null when the publication offers no v2 infohash: such a band cannot be range-read. */
  torrent: BandTorrent | null;
  schema: string | null;
  supersedes: string[];
  metadata: Record<string, unknown>;
  /** Set later from the chain (cosmetic): the times of the band's first and last block. */
  fromTime?: number;
  toTime?: number;
}

export interface IndexBands {
  name: string;
  kind: string;
  filter: unknown;
  bands: Band[];
  /** Bands left out, with why, so a page can say so. */
  dropped: { id: string; why: string }[];
}

export interface SelectOptions {
  /** The data gateway origin, for absolute file URLs. */
  gateway: string;
  /** Other gateways that may hold the same bytes; their torrent routes are added as fallbacks. */
  mirrors?: string[];
  /** Drop bands with `records: 0`: their files are under one BitTorrent block and hold only footers. Default true for parquet kinds. */
  dropEmpty?: boolean;
  /** Drop a band whose heights lie inside another's. Default true for parquet kinds, false for cdb64 (its bands overlap by design). */
  pruneOverlaps?: boolean;
}

/**
 * One index's bands, sorted by height, with absolute URLs, superseded and
 * empty bands removed and overlaps pruned. Throws when the publication does
 * not list the index.
 */
export function selectIndex(pub: Publication, name: string, opts: SelectOptions): IndexBands {
  const ix = pub.indexes.find((i) => i.name === name);
  if (!ix) throw new Error(`this gateway publishes no ${name} index`);
  const gw = opts.gateway.replace(/\/+$/, '');
  const mirrors = (opts.mirrors ?? []).map((m) => m.replace(/\/+$/, '')).filter((m) => hostOf(m) !== hostOf(gw));
  const parquet = ix.kind.startsWith('parquet');
  const dropEmpty = opts.dropEmpty ?? parquet;
  const pruneOverlaps = opts.pruneOverlaps ?? parquet;
  const dropped: { id: string; why: string }[] = [];
  let bands: Band[] = ix.bands.map((b) => {
    const base = b.http?.baseUrl || `/ar-io/indexes/${name}/${b.id}/`;
    const at = (n: string) => new URL(base.endsWith('/') ? base + n : `${base}/${n}`, gw + '/').toString();
    const files = new Map<string, BandFile>();
    for (const f of b.files) files.set(f.name, { ...f, url: at(f.name) });
    const ih2 = b.torrent?.infohashV2 ?? null;
    const ih1 = b.torrent?.infohashV1 ?? null;
    const urls = ih2
      ? [
          b.torrent?.torrentUrl ? new URL(b.torrent.torrentUrl, gw + '/').toString() : null,
          ...(ih1 ? mirrors.map((m) => `${m}/ar-io/indexes/torrents/${ih1}.torrent`) : []),
        ].filter((u): u is string => !!u)
      : [];
    const md = b.metadata ?? {};
    const supersedes = Array.isArray(md.supersedes)
      ? md.supersedes.filter((s): s is string => typeof s === 'string')
      : [];
    return {
      id: b.id,
      index: name,
      kind: ix.kind,
      from: b.heightRange ? b.heightRange[0] : 0,
      to: b.heightRange ? b.heightRange[1] : null,
      records: b.records ?? 0,
      files,
      size: b.files.reduce((t, f) => t + f.size, 0),
      torrent:
        ih2 && urls.length ? { infohashV1: ih1, infohashV2: ih2, magnet: b.torrent?.magnet ?? null, urls } : null,
      schema: typeof md.schema === 'string' ? md.schema : null,
      supersedes,
      metadata: md,
    };
  });
  // A publication lists only live bands, but a replacing band names what it
  // replaces: a band so named is never used beside its replacement.
  const superseded = new Set(bands.flatMap((b) => b.supersedes));
  bands = bands.filter((b) => {
    if (superseded.has(b.id)) {
      dropped.push({ id: b.id, why: 'superseded' });
      return false;
    }
    return true;
  });
  if (dropEmpty) {
    bands = bands.filter((b) => {
      if (b.records === 0) {
        dropped.push({ id: b.id, why: 'no records' });
        return false;
      }
      return true;
    });
  }
  // Newest heights last; an open tip band sorts after everything it starts above.
  bands.sort((a, b) => a.from - b.from || (a.to ?? Infinity) - (b.to ?? Infinity));
  if (pruneOverlaps) {
    const kept: Band[] = [];
    for (const b of bands) {
      const prev = kept[kept.length - 1];
      if (prev && b.from <= (prev.to ?? Infinity)) {
        // Keep the wider one: a finished band over the smaller bands beneath it.
        const prevSpan = (prev.to ?? Infinity) - prev.from;
        const span = (b.to ?? Infinity) - b.from;
        if (span > prevSpan) {
          dropped.push({ id: prev.id, why: `inside ${b.id}` });
          kept[kept.length - 1] = b;
        } else dropped.push({ id: b.id, why: `inside ${prev.id}` });
        continue;
      }
      kept.push(b);
    }
    bands = kept;
  }
  return { name, kind: ix.kind, filter: ix.filter, bands, dropped };
}

/** The highest height any band reaches, or null when a band is open at the tip. */
export function tipOf(bands: Band[]): number | null {
  let tip = -1;
  for (const b of bands) {
    if (b.to === null) return null;
    if (b.to > tip) tip = b.to;
  }
  return tip === -1 ? null : tip;
}
