import { describe, expect, it } from 'vitest';

import {
  cdb64,
  decodeMsgpack,
  encodeMsgpack,
  fromBase64Url,
  toBase64Url,
  type Band,
} from '../src/index.js';
import { writeCdb64 } from './cdb64-writer.js';

const rnd = (seed: number, n = 32): Uint8Array => {
  const out = new Uint8Array(n);
  let x = seed * 2654435761 + 1;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x >> 16) & 0xff;
  }
  return out;
};

describe('cdb64Hash', () => {
  it('matches the reference for the empty key and a known byte string', () => {
    expect(cdb64.cdb64Hash(new Uint8Array(0))).toBe(5381n);
    // h = ((5381 << 5) + 5381) ^ 0x61 for "a"
    expect(cdb64.cdb64Hash(new TextEncoder().encode('a'))).toBe(
      (((5381n << 5n) + 5381n) ^ 0x61n) & 0xffffffffffffffffn,
    );
  });
});

describe('cdb64Get over a written partition', () => {
  const keys = Array.from({ length: 500 }, (_, i) => rnd(i + 1));
  const records = keys.map((key, i) => ({
    key,
    value: encodeMsgpack({ r: rnd(1000 + i), i: i * 1000, d: i * 1000 + 100 }),
  }));
  const file = writeCdb64(records);
  const reads: [number, number][] = [];
  const read = async (s: number, e: number) => {
    reads.push([s, e]);
    return file.slice(s, e + 1);
  };

  it('finds every key with a few small reads and misses absent ones', async () => {
    for (let i = 0; i < keys.length; i += 37) {
      reads.length = 0;
      const v = await cdb64.cdb64Get(read, file.length, keys[i]!);
      expect(v).not.toBeNull();
      const loc = cdb64.decodeRootValue(v!);
      expect(loc.rootDataItemOffset).toBe(i * 1000);
      expect(loc.rootTxId).toBe(toBase64Url(rnd(1000 + i)));
      expect(reads.length).toBeLessThanOrEqual(4);
      expect(reads.reduce((t, [s, e]) => t + (e - s + 1), 0)).toBeLessThan(1200);
    }
    expect(await cdb64.cdb64Get(read, file.length, rnd(99999))).toBeNull();
  });

  it('refuses a corrupt header rather than reading outside the file', async () => {
    const bad = file.slice();
    new DataView(bad.buffer).setBigUint64(0, 1n << 40n, true);
    new DataView(bad.buffer).setBigUint64(8, 8n, true);
    const k = keys.find((key) => cdb64.cdb64Hash(key) % 256n === 0n);
    if (k)
      await expect(
        cdb64.cdb64Get(async (s, e) => bad.slice(s, e + 1), bad.length, k),
      ).rejects.toThrow(/outside/);
  });
});

describe('root values', () => {
  it('decodes the four shapes, with float-64 offsets past 2^32', () => {
    const r = rnd(1);
    const p = [rnd(2), rnd(3)];
    expect(cdb64.decodeRootValue(encodeMsgpack({ r }))).toMatchObject({
      rootTxId: toBase64Url(r),
      path: null,
      rootDataItemOffset: null,
    });
    const big = 2 ** 33 + 5;
    const c = cdb64.decodeRootValue(encodeMsgpack({ r, i: big, d: big + 1100, s: 4000 }));
    expect(c).toMatchObject({
      rootDataItemOffset: big,
      rootDataOffset: big + 1100,
      dataItemSize: 4000,
    });
    const pp = cdb64.decodeRootValue(encodeMsgpack({ p }));
    expect(pp.rootTxId).toBe(toBase64Url(p[0]!));
    expect(pp.path).toEqual(p.map(toBase64Url));
    const pc = cdb64.decodeRootValue(encodeMsgpack({ p, i: 7, d: 9 }));
    expect(pc.rootDataOffset).toBe(9);
    expect(() => cdb64.decodeRootValue(encodeMsgpack({ r: new Uint8Array(5) }))).toThrow(/32-byte/);
  });

  it('msgpack round-trips every integer form', () => {
    for (const n of [0, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, 2 ** 52 + 1]) {
      expect(decodeMsgpack(encodeMsgpack(n))).toBe(n);
    }
    const u64 = new Uint8Array([0xcf, 0, 0, 0, 0, 0, 0, 1, 0]);
    expect(decodeMsgpack(u64)).toBe(256);
    expect(() => decodeMsgpack(new Uint8Array([0xd9]))).toThrow(/unsupported/);
  });
});

describe('lookupRoot across bands', () => {
  const mkBand = (
    id: string,
    from: number,
    to: number | null,
    files: Record<string, Uint8Array>,
  ): Band => ({
    id,
    index: 'root-tx-index',
    kind: 'cdb64-root-tx',
    from,
    to,
    records: 1,
    files: new Map(
      Object.entries(files).map(([name, bytes]) => [
        name,
        { name, size: bytes.length, sha256: '0'.repeat(64), url: `https://x/${id}/${name}` },
      ]),
    ),
    size: 0,
    torrent: null,
    schema: null,
    supersedes: [],
    metadata: {},
  });
  const key = rnd(42);
  const prefix = key[0]!.toString(16).padStart(2, '0');
  const value = encodeMsgpack({ r: rnd(7), i: 10, d: 20 });
  const part = writeCdb64([{ key, value }]);
  const manifest = (ids: string[]) =>
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        createdAt: 'x',
        totalRecords: 1,
        partitions: ids.map((p) => ({
          prefix: p,
          location: { type: 'file', filename: `${p}.cdb` },
          recordCount: 1,
          size: part.length,
        })),
      }),
    );
  const other = prefix === '00' ? '01' : '00';
  const oldBand = mkBand('h-old', 0, 999, {
    'manifest.json': manifest([prefix]),
    [`${prefix}.cdb`]: part,
  });
  const tipBand = mkBand('tip', 1000, null, {
    'manifest.json': manifest([other]),
    [`${other}.cdb`]: part,
  });
  const store = new Map<string, Uint8Array>();
  for (const b of [oldBand, tipBand])
    for (const [n] of b.files)
      store.set(
        `${b.id}/${n}`,
        n === 'manifest.json' ? (b.id === 'tip' ? manifest([other]) : manifest([prefix])) : part,
      );
  const read = async (band: Band, file: string, s: number, e: number) =>
    store.get(`${band.id}/${file}`)!.slice(s, e + 1);

  it('searches the tip first, skips bands without the prefix, and reports every read', async () => {
    const hit = await cdb64.lookupRoot(toBase64Url(key), { bands: [oldBand, tipBand], read });
    expect(hit?.band.id).toBe('h-old');
    expect(hit?.rootTxId).toBe(toBase64Url(rnd(7)));
    expect(hit?.reads.map((r) => r.file)).toEqual([
      'manifest.json',
      `${prefix}.cdb`,
      `${prefix}.cdb`,
      `${prefix}.cdb`,
      `${prefix}.cdb`,
    ]);
    expect(
      await cdb64.lookupRoot(toBase64Url(rnd(5)), { bands: [oldBand, tipBand], read }),
    ).toBeNull();
  });

  it('refuses a manifest naming a remote partition', () => {
    expect(() =>
      cdb64.parseCdb64Manifest({
        version: 1,
        partitions: [{ prefix: '00', location: { type: 'http', url: 'https://evil' }, size: 1 }],
      }),
    ).toThrow(/not a local file/);
  });

  it('orders bands newest first with the open tip ahead', () => {
    const a = mkBand('a', 0, 99, {});
    const b = mkBand('b', 100, 199, {});
    const t = mkBand('t', 150, null, {});
    expect(cdb64.cdb64BandOrder([a, t, b]).map((x) => x.id)).toEqual(['t', 'b', 'a']);
  });

  it('round-trips an id through base64url', () => {
    expect(fromBase64Url(toBase64Url(key))).toEqual(key);
  });
});
