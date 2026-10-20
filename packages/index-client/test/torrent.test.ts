import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { bdecode, bencode, buildTorrent, checkTorrent, pieceOk, Refusal } from '../src/index.js';
import { LIVE_BAND_DIR, LIVE_TORRENT, LIVE_TORRENT_IH2, readBytes } from './helpers.js';

const torrent = readBytes(LIVE_TORRENT);

describe('the recorded torrent', () => {
  it('parses, matches the signed infohash and lists every band file', async () => {
    const files = await checkTorrent(torrent, LIVE_TORRENT_IH2);
    expect([...files.keys()].sort()).toEqual([
      'band.json',
      'data_items.parquet',
      'lookup_id.parquet',
      'lookup_tag.parquet',
      'lookup_wallet.parquet',
      'parents.parquet',
      'tags.parquet',
      'wallets.parquet',
    ]);
    const t = files.get('data_items.parquet')!;
    expect(t.size).toBe(138513);
    expect(t.pieceLength).toBe(262144);
    expect(t.single).toBe(true);
  });

  it('refuses a torrent whose info dictionary does not hash to the signed infohash', async () => {
    const flipped = torrent.slice();
    // Flip a byte inside the info dictionary (the piece length digits).
    const { infoSpan } = bdecode(torrent);
    const at = infoSpan![0] + 40;
    flipped[at] = flipped[at]! ^ 0x01;
    let err: unknown;
    try {
      await checkTorrent(flipped, LIVE_TORRENT_IH2);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Refusal).code).toMatch(/integrity|torrent/);
    await expect(checkTorrent(torrent, '0'.repeat(64))).rejects.toThrow(/infohash/);
  });

  it('accepts each real band file as its own single piece and refuses a flipped byte', async () => {
    const files = await checkTorrent(torrent, LIVE_TORRENT_IH2);
    for (const name of ['data_items.parquet', 'tags.parquet', 'lookup_wallet.parquet', 'parents.parquet']) {
      const t = files.get(name)!;
      const bytes = readBytes(path.join(LIVE_BAND_DIR, name));
      expect(bytes.length).toBe(t.size);
      expect(await pieceOk(t, 0, bytes)).toBe(true);
      const bad = bytes.slice();
      bad[Math.floor(bad.length / 2)]! ^= 0x80;
      expect(await pieceOk(t, 0, bad)).toBe(false);
      expect(await pieceOk(t, 0, bytes.subarray(0, bytes.length - 1))).toBe(false);
    }
  });
});

describe('bencode', () => {
  it('round-trips the recorded torrent byte for byte', () => {
    const { value } = bdecode(torrent);
    expect(Buffer.from(bencode(value)).equals(Buffer.from(torrent))).toBe(true);
  });

  it('refuses malformed input', () => {
    expect(() => bdecode(new TextEncoder().encode('d3:abc'))).toThrow(/malformed/);
    expect(() => bdecode(new TextEncoder().encode('i01e'))).toThrow(/integer/);
    expect(() => bdecode(new TextEncoder().encode('le0:'))).toThrow(/trailing/);
  });
});

describe('a built multi-piece torrent', () => {
  it('is accepted whole and its pieces verify, while a flipped byte in any piece is refused', async () => {
    const pieceLength = 65536;
    const big = new Uint8Array(pieceLength * 3 + 1234);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919 + 13) & 0xff;
    const small = new TextEncoder().encode('{"hello":"world"}');
    const { bytes, infohashV2 } = await buildTorrent(
      [
        { name: 'big.parquet', bytes: big },
        { name: 'small.json', bytes: small },
      ],
      { pieceLength },
    );
    const files = await checkTorrent(bytes, infohashV2);
    const t = files.get('big.parquet')!;
    expect(t.single).toBe(false);
    expect(t.layer.length).toBe(4 * 32);
    for (let k = 0; k < 4; k++) {
      const piece = big.subarray(k * pieceLength, Math.min((k + 1) * pieceLength, big.length));
      expect(await pieceOk(t, k, piece)).toBe(true);
      const bad = piece.slice();
      bad[k * 100]! ^= 0x01;
      expect(await pieceOk(t, k, bad)).toBe(false);
    }
    expect(await pieceOk(files.get('small.json')!, 0, small)).toBe(true);
    // A piece layer that does not hash to its root is an integrity refusal.
    const { value } = bdecode(bytes);
    const layers = (value as Map<string, unknown>).get('piece layers') as Map<string, Uint8Array>;
    const [key, layer] = [...layers.entries()][0]!;
    const broken = layer.slice();
    broken[5]! ^= 0xff;
    layers.set(key, broken);
    await expect(checkTorrent(bencode(value as never), infohashV2)).rejects.toThrow(/does not hash to the signed root/);
  });
});
