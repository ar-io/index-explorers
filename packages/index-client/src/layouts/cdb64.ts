/**
 * The `cdb64-root-tx` layout: a partitioned CDB64 index mapping a data item
 * id to the root transaction that holds it, and where. Finding an item's
 * root is the band's manifest, one 16-byte header entry, a few 16-byte slots
 * and one record, each a small range read through the verified reader.
 * See ar-io/ar-io-node docs/cdb64-format.md.
 */
import { decodeMsgpack, type MsgValue } from '../msgpack.js';
import type { Band } from '../publication.js';
import { fromBase64Url, toBase64Url } from '../util/bytes.js';

export const CDB64_HEADER_BYTES = 4096;

/** DJB hash with 64-bit arithmetic: `h = 5381; h = ((h << 5) + h) ^ byte`. */
export function cdb64Hash(key: Uint8Array): bigint {
  const MASK = 0xffffffffffffffffn;
  let h = 5381n;
  for (const b of key) h = (((h << 5n) + h) ^ BigInt(b)) & MASK;
  return h;
}

export interface Cdb64Partition {
  prefix: string;
  filename: string;
  recordCount: number;
  size: number;
}

export interface Cdb64Manifest {
  version: number;
  createdAt: string;
  totalRecords: number;
  partitions: Cdb64Partition[];
  heightRange: [number, number | null] | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Parses a band's `manifest.json`. A partition named by URL or Arweave id is
 * refused: nothing in the publication checks bytes fetched from there, and
 * following it lets a publisher choose what the client requests.
 */
export function parseCdb64Manifest(raw: unknown): Cdb64Manifest {
  if (!isObject(raw) || raw.version !== 1)
    throw new Error('the manifest is not a version 1 CDB64 manifest');
  if (!Array.isArray(raw.partitions)) throw new Error('the manifest lists no partitions');
  const partitions = raw.partitions.map((p): Cdb64Partition => {
    if (!isObject(p) || typeof p.prefix !== 'string' || !/^[0-9a-f]{2}$/.test(p.prefix))
      throw new Error('a partition has no two-digit hex prefix');
    const loc = p.location;
    if (!isObject(loc) || loc.type !== 'file' || typeof loc.filename !== 'string')
      throw new Error(
        `partition ${p.prefix} is not a local file, so it cannot be verified against the publication`,
      );
    if (typeof p.size !== 'number' || !Number.isSafeInteger(p.size) || p.size < 0)
      throw new Error(`partition ${p.prefix}: size`);
    return {
      prefix: p.prefix,
      filename: loc.filename,
      recordCount: typeof p.recordCount === 'number' ? p.recordCount : 0,
      size: p.size,
    };
  });
  const md = isObject(raw.metadata) ? raw.metadata : {};
  const hr = md.heightRange;
  const heightRange: Cdb64Manifest['heightRange'] =
    Array.isArray(hr) && typeof hr[0] === 'number' && (hr[1] === null || typeof hr[1] === 'number')
      ? [hr[0], hr[1] as number | null]
      : null;
  return {
    version: 1,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    totalRecords: typeof raw.totalRecords === 'number' ? raw.totalRecords : 0,
    partitions,
    heightRange,
  };
}

/** A verified range read of one band file: bytes `start..end` inclusive. */
export type RangeRead = (
  band: Band,
  file: string,
  start: number,
  end: number,
) => Promise<Uint8Array>;

export interface ReadLog {
  band: string;
  file: string;
  start: number;
  end: number;
}

export interface RootLocation {
  band: Band;
  rootTxId: string;
  /** The bundle path from the root to the item's parent, when the value carries one. */
  path: string[] | null;
  rootDataItemOffset: number | null;
  rootDataOffset: number | null;
  dataItemSize: number | null;
  /** The partition the key was found in. */
  partition: string;
  reads: ReadLog[];
}

const u64 = (b: Uint8Array, at: number): bigint =>
  new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(at, true);
const toNum = (v: bigint, what: string): number => {
  if (v > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${what} is beyond a safe integer: the partition is corrupt`);
  return Number(v);
};

/** Bands newest first: the open tip band, then by the end of each band's heights. */
export function cdb64BandOrder(bands: readonly Band[]): Band[] {
  return [...bands].sort((a, b) => {
    const ea = a.to ?? Infinity;
    const eb = b.to ?? Infinity;
    return eb - ea || b.from - a.from;
  });
}

const MAX_VALUE_BYTES = 4096;
const SLOT_RUN = 32;

/** The part of a partition a read is for: the header's table pointer, a run of slots, a record. */
export type Cdb64Stage = 'table' | 'slot' | 'record';

/**
 * Looks one key up in one partition file through `read`. Returns the value
 * bytes, or null when the key is not present. Throws on a corrupt structure.
 * `onStage`, when given, is told which part of the file each read is for, so
 * a page can show a lookup as it happens.
 */
export async function cdb64Get(
  read: (start: number, end: number) => Promise<Uint8Array>,
  fileSize: number,
  key: Uint8Array,
  onStage?: (stage: Cdb64Stage) => void,
): Promise<Uint8Array | null> {
  if (fileSize < CDB64_HEADER_BYTES)
    throw new Error('the partition is shorter than a CDB64 header');
  const h = cdb64Hash(key);
  const table = Number(h % 256n);
  onStage?.('table');
  const header = await read(table * 16, table * 16 + 15);
  const pos = toNum(u64(header, 0), 'table position');
  const slots = toNum(u64(header, 8), 'table length');
  if (slots === 0) return null;
  if (pos < CDB64_HEADER_BYTES || pos + slots * 16 > fileSize)
    throw new Error('the hash table lies outside the partition');
  const start = Number((h >> 8n) % BigInt(slots));
  let probed = 0;
  let slot = start;
  while (probed < slots) {
    const n = Math.min(SLOT_RUN, slots - slot, slots - probed);
    onStage?.('slot');
    const run = await read(pos + slot * 16, pos + (slot + n) * 16 - 1);
    for (let k = 0; k < n; k++) {
      const slotHash = u64(run, k * 16);
      const rec = u64(run, k * 16 + 8);
      if (rec === 0n) return null;
      if (slotHash === h) {
        const at = toNum(rec, 'record position');
        if (at < CDB64_HEADER_BYTES || at + 16 > fileSize)
          throw new Error('a record lies outside the partition');
        onStage?.('record');
        const head = await read(at, at + 15);
        const klen = toNum(u64(head, 0), 'key length');
        const vlen = toNum(u64(head, 8), 'value length');
        if (klen !== key.length || vlen > MAX_VALUE_BYTES || at + 16 + klen + vlen > fileSize) {
          if (klen !== key.length) {
            probed += 1;
            continue;
          }
          throw new Error('a record has an impossible length: the partition is corrupt');
        }
        onStage?.('record');
        const body = await read(at + 16, at + 16 + klen + vlen - 1);
        let same = true;
        for (let i = 0; i < klen; i++) if (body[i] !== key[i]) same = false;
        if (same) return body.slice(klen, klen + vlen);
      }
      probed += 1;
    }
    slot = (slot + n) % slots;
  }
  return null;
}

/** Decodes a root-tx index value into its location. */
export function decodeRootValue(
  value: Uint8Array,
): Omit<RootLocation, 'band' | 'partition' | 'reads'> {
  const v = decodeMsgpack(value);
  if (!isObject(v)) throw new Error('the value is not a map');
  const id = (x: MsgValue | undefined, what: string): string => {
    if (!(x instanceof Uint8Array) || x.length !== 32)
      throw new Error(`${what} is not a 32-byte id`);
    return toBase64Url(x);
  };
  const int = (x: MsgValue | undefined): number | null => (typeof x === 'number' ? x : null);
  let rootTxId: string;
  let path: string[] | null = null;
  if (Array.isArray(v.p)) {
    if (!v.p.length || v.p.length > 10) throw new Error('the bundle path is empty or too deep');
    path = v.p.map((x, i) => id(x, `path element ${i}`));
    rootTxId = path[0]!;
  } else rootTxId = id(v.r as MsgValue | undefined, 'the root transaction id');
  return {
    rootTxId,
    path,
    rootDataItemOffset: int(v.i as MsgValue | undefined),
    rootDataOffset: int(v.d as MsgValue | undefined),
    dataItemSize: int(v.s as MsgValue | undefined),
  };
}

export interface LookupRootOptions {
  /** Only bands whose heights may hold the item; default every band, newest first. */
  bands: readonly Band[];
  read: RangeRead;
  /** Parsed manifests already in hand, by band id. */
  manifests?: Map<string, Cdb64Manifest>;
  /** Stop after the first band whose files were read, when a caller wants one answer. Default true. */
  firstMatch?: boolean;
  /** Told as each band starts, and which part of a partition each read is for. */
  onBand?: (band: Band) => void;
  onStage?: (band: Band, stage: Cdb64Stage) => void;
}

/**
 * Which root transaction holds a data item, and at what offset, from the
 * root-tx bands, newest first. Every byte read comes through `read`, which
 * the caller backs with the verified range reader. Returns null when no
 * band holds the key.
 */
export async function lookupRoot(
  id: string,
  opts: LookupRootOptions,
): Promise<RootLocation | null> {
  const key = fromBase64Url(id);
  if (key.length !== 32) throw new Error('a data item id is 32 bytes');
  const prefix = key[0]!.toString(16).padStart(2, '0');
  const manifests = opts.manifests ?? new Map<string, Cdb64Manifest>();
  for (const band of cdb64BandOrder(opts.bands)) {
    opts.onBand?.(band);
    const reads: ReadLog[] = [];
    const read = async (file: string, start: number, end: number) => {
      reads.push({ band: band.id, file, start, end });
      return opts.read(band, file, start, end);
    };
    let manifest = manifests.get(band.id);
    if (!manifest) {
      const mf = band.files.get('manifest.json');
      if (!mf) continue;
      const bytes = await read('manifest.json', 0, mf.size - 1);
      manifest = parseCdb64Manifest(JSON.parse(new TextDecoder().decode(bytes)));
      manifests.set(band.id, manifest);
    }
    const part = manifest.partitions.find((p) => p.prefix === prefix);
    if (!part) continue;
    const file = band.files.get(part.filename);
    if (!file)
      throw new Error(
        `${band.id}: the manifest names ${part.filename}, which the publication does not list`,
      );
    if (file.size !== part.size)
      throw new Error(
        `${band.id}: the manifest says ${part.filename} is ${part.size} bytes; the publication signed ${file.size}`,
      );
    const value = await cdb64Get(
      (s, e) => read(part.filename, s, e),
      file.size,
      key,
      opts.onStage ? (stage) => opts.onStage!(band, stage) : undefined,
    );
    if (value) return { band, partition: part.filename, reads, ...decodeRootValue(value) };
  }
  return null;
}

/**
 * A CDB64 index stored as a pack on Arweave, the way cdb64.ar.io first read
 * the root-transaction index: 256 partitions, one per first byte of the key,
 * each a CDB64 file starting at a byte offset inside an Arweave transaction.
 * The table of where each partition starts ships with the page; no signed
 * publication covers it, so a caller checks a hit against the data itself
 * (see `checkItemAtOffset`).
 */
export interface Cdb64Pack {
  /** The index name the pack was published under. */
  id: string;
  /** A short label, and the name shown to a reader. */
  label: string;
  name: string;
  records: number;
  /** For each first byte of the key, 0 to 255: [index into `txs`, byte offset of the partition]. */
  parts: [number, number][];
}

export interface Cdb64PackSet {
  /** The Arweave transactions that hold the partitions. */
  txs: string[];
  /** Searched in order; the first hit wins. */
  packs: Cdb64Pack[];
}

export interface PackLocation extends Omit<RootLocation, 'band' | 'partition' | 'reads'> {
  pack: Cdb64Pack;
  /** The Arweave transaction and offset of the partition that answered. */
  tx: string;
  offset: number;
}

/**
 * Looks a data item up in Arweave-hosted packs, in order, through
 * `read(tx, start, end)` (inclusive bytes of the transaction's data). Returns
 * the first hit, or null. A pack partition's length is not recorded, so only
 * the header's own bounds are checked; the answer is checked against the data.
 */
export async function lookupPacks(
  id: string,
  set: Cdb64PackSet,
  read: (tx: string, start: number, end: number) => Promise<Uint8Array>,
  on?: {
    pack?: (pack: Cdb64Pack, tx: string) => void;
    stage?: (pack: Cdb64Pack, stage: Cdb64Stage) => void;
    miss?: (pack: Cdb64Pack) => void;
  },
): Promise<PackLocation | null> {
  const key = fromBase64Url(id);
  if (key.length !== 32) throw new Error('a data item id is 32 bytes');
  for (const pack of set.packs) {
    const part = pack.parts[key[0]!];
    if (!part) continue;
    const [txIndex, offset] = part;
    const tx = set.txs[txIndex];
    if (!tx) throw new Error(`${pack.id}: partition ${key[0]} names a transaction the set lacks`);
    on?.pack?.(pack, tx);
    const value = await cdb64Get(
      (s, e) => read(tx, offset + s, offset + e),
      Number.MAX_SAFE_INTEGER,
      key,
      on?.stage ? (stage) => on.stage!(pack, stage) : undefined,
    );
    if (value) return { pack, tx, offset, ...decodeRootValue(value) };
    on?.miss?.(pack);
  }
  return null;
}

/** ANS-104 signature lengths by signature type. */
export const ANS104_SIGNATURE_BYTES: Record<number, number> = {
  1: 512,
  2: 64,
  3: 65,
  4: 64,
  5: 64,
  6: 2052,
  7: 65,
  101: 65,
};

export type ItemCheck =
  | { state: 'ok'; signatureBytes: number; digest: string }
  | { state: 'bad'; signatureBytes: number; digest: string }
  | { state: 'skip'; why: string };

/**
 * Checks an index answer against the data: reads the ANS-104 header at
 * `offset` of the root transaction through `read(start, end)` and compares the
 * SHA-256 of the item's signature with its id, which is what a data item id is.
 * It confirms where the item sits; it does not check the signature itself.
 */
export async function checkItemAtOffset(
  id: string,
  offset: number,
  read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<ItemCheck> {
  const t = await read(offset, offset + 1);
  const type = t[0]! | (t[1]! << 8);
  const len = ANS104_SIGNATURE_BYTES[type];
  if (!len) return { state: 'skip', why: `signature type ${type} is not one this page reads` };
  const sig = await read(offset + 2, offset + 2 + len - 1);
  if (sig.length !== len)
    return { state: 'skip', why: `the gateway returned ${sig.length} of ${len} signature bytes` };
  const digest = toBase64Url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', sig as BufferSource)),
  );
  return { state: digest === id ? 'ok' : 'bad', signatureBytes: len, digest };
}
