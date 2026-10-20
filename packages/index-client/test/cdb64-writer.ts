/**
 * A CDB64 writer, for fixtures and tests only: the format in
 * ar-io/ar-io-node docs/cdb64-format.md, written as the spec describes.
 */
import { cdb64Hash, CDB64_HEADER_BYTES } from '../src/layouts/cdb64.js';

export function writeCdb64(records: { key: Uint8Array; value: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = CDB64_HEADER_BYTES;
  const entries: { hash: bigint; pos: number }[] = [];
  for (const r of records) {
    const rec = new Uint8Array(16 + r.key.length + r.value.length);
    const dv = new DataView(rec.buffer);
    dv.setBigUint64(0, BigInt(r.key.length), true);
    dv.setBigUint64(8, BigInt(r.value.length), true);
    rec.set(r.key, 16);
    rec.set(r.value, 16 + r.key.length);
    parts.push(rec);
    entries.push({ hash: cdb64Hash(r.key), pos });
    pos += rec.length;
  }
  const header = new Uint8Array(CDB64_HEADER_BYTES);
  const hv = new DataView(header.buffer);
  for (let t = 0; t < 256; t++) {
    const mine = entries.filter((e) => Number(e.hash % 256n) === t);
    const slots = mine.length * 2;
    hv.setBigUint64(t * 16, BigInt(slots ? pos : 0), true);
    hv.setBigUint64(t * 16 + 8, BigInt(slots), true);
    if (!slots) continue;
    const table = new Uint8Array(slots * 16);
    const tv = new DataView(table.buffer);
    for (const e of mine) {
      let s = Number((e.hash >> 8n) % BigInt(slots));
      while (tv.getBigUint64(s * 16 + 8, true) !== 0n) s = (s + 1) % slots;
      tv.setBigUint64(s * 16, e.hash, true);
      tv.setBigUint64(s * 16 + 8, BigInt(e.pos), true);
    }
    parts.push(table);
    pos += table.length;
  }
  const out = new Uint8Array(pos);
  out.set(header, 0);
  let o = CDB64_HEADER_BYTES;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
