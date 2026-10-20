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

/**
 * Looks one key up in one partition file through `read`. Returns the value
 * bytes, or null when the key is not present. Throws on a corrupt structure.
 */
export async function cdb64Get(
  read: (start: number, end: number) => Promise<Uint8Array>,
  fileSize: number,
  key: Uint8Array,
): Promise<Uint8Array | null> {
  if (fileSize < CDB64_HEADER_BYTES)
    throw new Error('the partition is shorter than a CDB64 header');
  const h = cdb64Hash(key);
  const table = Number(h % 256n);
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
    const run = await read(pos + slot * 16, pos + (slot + n) * 16 - 1);
    for (let k = 0; k < n; k++) {
      const slotHash = u64(run, k * 16);
      const rec = u64(run, k * 16 + 8);
      if (rec === 0n) return null;
      if (slotHash === h) {
        const at = toNum(rec, 'record position');
        if (at < CDB64_HEADER_BYTES || at + 16 > fileSize)
          throw new Error('a record lies outside the partition');
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
    const value = await cdb64Get((s, e) => read(part.filename, s, e), file.size, key);
    if (value) return { band, partition: part.filename, reads, ...decodeRootValue(value) };
  }
  return null;
}
