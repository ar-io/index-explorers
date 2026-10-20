/**
 * BitTorrent v2 (BEP 52) hash trees, as the range reader checks them.
 *
 *   signed infohashV2 == SHA-256(the torrent's info dictionary)
 *     -> the file's `pieces root`, inside the info dictionary
 *       -> its piece layer, outside it: rebuilt up to that root
 *         -> every piece read: its 16 KiB block hashes, rebuilt up to the layer
 *
 * Pure functions, shared by the service worker and the tests. Anything that is
 * not a verified answer is a Refusal naming what went wrong in words.
 */
import { bytesEqual, concat, hex, sha256 } from '../util/bytes.js';

export const BLOCK = 16384;
export const ZERO = new Uint8Array(32);
export const MAX_PIECE_LENGTH = 64 * 1024 * 1024;

export type RefusalCode =
  | 'integrity'
  | 'torrent'
  | 'cancelled'
  | 'payment'
  | 'rate'
  | 'server'
  | 'status'
  | 'network'
  | 'size'
  | 'request'
  | 'error';

/** A refusal the page shows as it is. `code` lets it decide what to offer. */
export class Refusal extends Error {
  constructor(
    public readonly code: RefusalCode,
    msg: string,
  ) {
    super(msg);
    this.name = 'Refusal';
  }
}

export type Bencoded = number | Uint8Array | Bencoded[] | Map<string, Bencoded>;

/** Keys are bytes; one char per byte keeps binary keys (piece layers) intact. */
export const latin1 = (b: Uint8Array): string => {
  let s = '';
  for (let k = 0; k < b.length; k += 8192) s += String.fromCharCode(...b.subarray(k, k + 8192));
  return s;
};

/** Bencode, strictly enough for a torrent; records where the top-level `info` sits. */
export function bdecode(b: Uint8Array): { value: Bencoded; infoSpan: [number, number] | null } {
  let i = 0;
  let infoSpan: [number, number] | null = null;
  let depth = 0;
  const bad = (why: string): never => {
    throw new Refusal('torrent', `the torrent is malformed (${why})`);
  };
  const int = (end: number): number => {
    if (end - i > 20) bad('integer');
    const s = new TextDecoder().decode(b.subarray(i, end));
    if (!/^(0|-?[1-9]\d*)$/.test(s)) bad('integer');
    const n = Number(s);
    if (!Number.isSafeInteger(n)) bad('integer');
    return n;
  };
  // Nesting: a real torrent is a few levels deep. Without a cap, a gateway
  // could exhaust the stack or memory with a deeply nested one.
  let nest = 0;
  const enter = () => {
    if (++nest > 64) bad('too deeply nested');
  };
  const str = (): Uint8Array => {
    let j = i;
    while (j < b.length && b[j] !== 58) j++;
    if (j >= b.length) bad('string');
    const n = int(j);
    if (n < 0 || j + 1 + n > b.length) bad('string length');
    const s = b.subarray(j + 1, j + 1 + n);
    i = j + 1 + n;
    return s;
  };
  const val = (): Bencoded => {
    if (i >= b.length) bad('truncated');
    const c = b[i];
    if (c === 105) {
      i++;
      let j = i;
      while (j < b.length && b[j] !== 101) j++;
      const n = int(j);
      i = j + 1;
      return n;
    }
    if (c === 108) {
      i++;
      enter();
      const out: Bencoded[] = [];
      while (b[i] !== 101) {
        out.push(val());
        if (i >= b.length) bad('list');
      }
      i++;
      nest--;
      return out;
    }
    if (c === 100) {
      i++;
      depth++;
      enter();
      const out = new Map<string, Bencoded>();
      while (b[i] !== 101) {
        if (i >= b.length) bad('dictionary');
        const k = latin1(str());
        const start = i;
        const v = val();
        if (depth === 1 && k === 'info') infoSpan = [start, i];
        out.set(k, v);
      }
      i++;
      depth--;
      nest--;
      return out;
    }
    if (c !== undefined && c >= 48 && c <= 57) return str();
    return bad('unknown type');
  };
  const value = val();
  if (i !== b.length) bad('trailing bytes');
  return { value, infoSpan };
}

/** Root of a perfect binary tree over `leaves`, padded to `width` with `pad`. */
export async function merkle(leaves: Uint8Array[], width: number, pad: Uint8Array): Promise<Uint8Array> {
  let layer = leaves.slice();
  while (layer.length < width) layer.push(pad);
  while (layer.length > 1) {
    const next: Uint8Array[] = [];
    for (let k = 0; k < layer.length; k += 2) next.push(await sha256(concat(layer[k]!, layer[k + 1]!)));
    layer = next;
  }
  return layer[0]!;
}

/** One file's checked hash tree: what a piece is compared against. */
export interface FileTree {
  size: number;
  pieceLength: number;
  /** The piece layer (32 bytes a piece), or the root itself for a single-piece file. */
  layer: Uint8Array;
  rootHex: string;
  single: boolean;
}

/**
 * Parses a torrent, checks its info dictionary against the signed infohash
 * and every file's piece layer against its pieces root. Returns the files'
 * trees by path, or throws a Refusal. A torrent is accepted only whole.
 */
export async function checkTorrent(bytes: Uint8Array, ih: string): Promise<Map<string, FileTree>> {
  const { value: top, infoSpan } = bdecode(bytes);
  if (!(top instanceof Map) || !infoSpan)
    throw new Refusal('torrent', 'the torrent is malformed (no info dictionary)');
  if (hex(await sha256(bytes.subarray(infoSpan[0], infoSpan[1]))) !== ih) {
    throw new Refusal('integrity', 'does not match the infohash the publisher signed');
  }
  const info = top.get('info');
  const pieceLength = info instanceof Map ? info.get('piece length') : undefined;
  if (
    typeof pieceLength !== 'number' ||
    !Number.isSafeInteger(pieceLength) ||
    pieceLength < BLOCK ||
    pieceLength > MAX_PIECE_LENGTH ||
    !Number.isInteger(Math.log2(pieceLength))
  ) {
    throw new Refusal('torrent', 'the torrent has no valid piece length');
  }
  const layers = top.get('piece layers');
  const per = pieceLength / BLOCK;
  let pad: Uint8Array = ZERO;
  for (let w = 1; w < per; w *= 2) pad = await sha256(concat(pad, pad));
  const files = new Map<string, FileTree>();
  const fileTree = async (leaf: Map<string, Bencoded>, name: string): Promise<FileTree> => {
    const size = leaf.get('length');
    const root = leaf.get('pieces root');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
      throw new Refusal('torrent', `the torrent gives ${name} no valid length`);
    if (size === 0) return { size, pieceLength, layer: new Uint8Array(0), rootHex: 'empty', single: true };
    if (!(root instanceof Uint8Array) || root.length !== 32)
      throw new Refusal('torrent', `the torrent has no pieces root for ${name}`);
    // One piece: its own subtree root is the file's root.
    if (size <= pieceLength) return { size, pieceLength, layer: root, rootHex: hex(root), single: true };
    const layer = layers instanceof Map ? layers.get(latin1(root)) : undefined;
    const pieces = Math.ceil(size / pieceLength);
    if (!(layer instanceof Uint8Array) || layer.length !== pieces * 32) {
      throw new Refusal('integrity', `has a piece layer for ${name} that is missing or the wrong size`);
    }
    // BEP 52 pads the leaves with zero hashes; at the piece layer that is the
    // root of an all-zero piece's subtree.
    const list: Uint8Array[] = [];
    for (let k = 0; k < pieces; k++) list.push(layer.subarray(k * 32, k * 32 + 32));
    let width = 1;
    while (width < pieces) width *= 2;
    if (!bytesEqual(await merkle(list, width, pad), root)) {
      throw new Refusal('integrity', `has a piece layer for ${name} that does not hash to the signed root`);
    }
    return { size, pieceLength, layer, rootHex: hex(root), single: false };
  };
  const walk = async (node: Bencoded | undefined, path: string[], depth: number): Promise<void> => {
    if (!(node instanceof Map) || depth > 16) throw new Refusal('torrent', 'the torrent’s file tree is malformed');
    for (const [key, child] of node) {
      if (key === '') {
        if (!(child instanceof Map)) throw new Refusal('torrent', 'the torrent’s file tree is malformed');
        files.set(path.join('/'), await fileTree(child, path.join('/')));
      } else {
        await walk(child, [...path, new TextDecoder().decode(Uint8Array.from(key, (c) => c.charCodeAt(0)))], depth + 1);
      }
    }
  };
  await walk(info instanceof Map ? info.get('file tree') : undefined, [], 0);
  if (!files.size) throw new Refusal('torrent', 'the torrent lists no files');
  return files;
}

/** The exact length piece `k` of a file must have. */
export const pieceSize = (t: FileTree, k: number): number =>
  t.single ? t.size : Math.min(t.pieceLength, t.size - k * t.pieceLength);

/** Whether `data` is piece `k` of the file: its blocks hash up to the layer's entry. */
export async function pieceOk(t: FileTree, k: number, data: Uint8Array): Promise<boolean> {
  if (data.length !== pieceSize(t, k)) return false;
  const leaves: Uint8Array[] = [];
  for (let o = 0; o < data.length; o += BLOCK) leaves.push(await sha256(data.subarray(o, Math.min(o + BLOCK, data.length))));
  // A full piece's subtree is pieceLength/16 KiB wide; a single-piece file's
  // tree is only as wide as its own blocks, rounded up to a power of two.
  let width = t.pieceLength / BLOCK;
  if (t.single) {
    width = 1;
    while (width < leaves.length) width *= 2;
  }
  const want = t.single ? t.layer : t.layer.subarray(k * 32, k * 32 + 32);
  return bytesEqual(await merkle(leaves, width, ZERO), want);
}

/* ------------------------------------------------------------------------ */
/*  Building: for fixtures and tests. A publisher's torrents are not made     */
/*  here, but the same tree is what they must hash to.                       */
/* ------------------------------------------------------------------------ */

export function bencode(v: Bencoded): Uint8Array {
  const enc = new TextEncoder();
  if (typeof v === 'number') return enc.encode(`i${v}e`);
  if (v instanceof Uint8Array) return concat(enc.encode(`${v.length}:`), v);
  if (Array.isArray(v)) return concat(enc.encode('l'), ...v.map(bencode), enc.encode('e'));
  // Keys are latin1 strings of bytes, sorted bytewise as BEP 3 requires.
  const keys = [...v.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: Uint8Array[] = [enc.encode('d')];
  for (const k of keys) {
    const kb = Uint8Array.from(k, (c) => c.charCodeAt(0));
    parts.push(enc.encode(`${kb.length}:`), kb, bencode(v.get(k)!));
  }
  parts.push(enc.encode('e'));
  return concat(...parts);
}

/** The pieces root and piece layer of one file's bytes, per BEP 52. */
export async function fileHashes(
  bytes: Uint8Array,
  pieceLength: number,
): Promise<{ root: Uint8Array; layer: Uint8Array | null }> {
  if (bytes.length === 0) return { root: new Uint8Array(0), layer: null };
  const per = pieceLength / BLOCK;
  const pieces = Math.ceil(bytes.length / pieceLength);
  const pieceRoots: Uint8Array[] = [];
  for (let k = 0; k < pieces; k++) {
    const piece = bytes.subarray(k * pieceLength, Math.min((k + 1) * pieceLength, bytes.length));
    const leaves: Uint8Array[] = [];
    for (let o = 0; o < piece.length; o += BLOCK) leaves.push(await sha256(piece.subarray(o, Math.min(o + BLOCK, piece.length))));
    let width = per;
    if (pieces === 1) {
      width = 1;
      while (width < leaves.length) width *= 2;
    }
    pieceRoots.push(await merkle(leaves, width, ZERO));
  }
  if (pieces === 1) return { root: pieceRoots[0]!, layer: null };
  let pad: Uint8Array = ZERO;
  for (let w = 1; w < per; w *= 2) pad = await sha256(concat(pad, pad));
  let width = 1;
  while (width < pieces) width *= 2;
  return { root: await merkle(pieceRoots, width, pad), layer: concat(...pieceRoots) };
}

/**
 * A v2-only torrent over a flat set of files, for fixtures. Returns the
 * bytes and the infohash the publication would sign.
 */
export async function buildTorrent(
  files: { name: string; bytes: Uint8Array }[],
  opts: { pieceLength?: number; name?: string; webseeds?: string[] } = {},
): Promise<{ bytes: Uint8Array; infohashV2: string }> {
  const pieceLength = opts.pieceLength ?? 262144;
  const tree = new Map<string, Bencoded>();
  const layers = new Map<string, Bencoded>();
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const { root, layer } = await fileHashes(f.bytes, pieceLength);
    const leaf = new Map<string, Bencoded>([['length', f.bytes.length]]);
    if (f.bytes.length > 0) leaf.set('pieces root', root);
    tree.set(f.name, new Map<string, Bencoded>([['', leaf]]));
    if (layer) layers.set(latin1(root), layer);
  }
  const info = new Map<string, Bencoded>([
    ['file tree', tree],
    ['meta version', 2],
    ['name', new TextEncoder().encode(opts.name ?? 'fixture')],
    ['piece length', pieceLength],
  ]);
  const top = new Map<string, Bencoded>([['info', info]]);
  if (layers.size) top.set('piece layers', layers);
  if (opts.webseeds?.length) top.set('url-list', opts.webseeds.map((u) => new TextEncoder().encode(u)));
  const bytes = bencode(top);
  return { bytes, infohashV2: hex(await sha256(bencode(info))) };
}
