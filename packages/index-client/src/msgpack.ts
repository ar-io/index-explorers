/**
 * The MessagePack subset the root-tx index uses: fixmap, fixarray, fixstr,
 * bin 8, the integer forms and float 64 (offsets of 2^32 and above are
 * encoded as float 64 by the reference encoder; they are exact). Anything
 * else is refused: a value is a few dozen bytes with known keys.
 */
export type MsgValue = number | string | Uint8Array | MsgValue[] | { [k: string]: MsgValue } | null | boolean;

export function decodeMsgpack(b: Uint8Array): MsgValue {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const need = (n: number) => {
    if (i + n > b.length) throw new Error('truncated value');
  };
  const read = (): MsgValue => {
    need(1);
    const t = b[i]!;
    if (t <= 0x7f) {
      i += 1;
      return t;
    }
    if (t >= 0x80 && t <= 0x8f) {
      const n = t & 0x0f;
      i += 1;
      const out: { [k: string]: MsgValue } = {};
      for (let k = 0; k < n; k++) {
        const key = read();
        if (typeof key !== 'string') throw new Error('map key is not a string');
        out[key] = read();
      }
      return out;
    }
    if (t >= 0x90 && t <= 0x9f) {
      const n = t & 0x0f;
      i += 1;
      const out: MsgValue[] = [];
      for (let k = 0; k < n; k++) out.push(read());
      return out;
    }
    if (t >= 0xa0 && t <= 0xbf) {
      const n = t & 0x1f;
      i += 1;
      need(n);
      const s = new TextDecoder().decode(b.subarray(i, i + n));
      i += n;
      return s;
    }
    if (t === 0xc0) {
      i += 1;
      return null;
    }
    if (t === 0xc2 || t === 0xc3) {
      i += 1;
      return t === 0xc3;
    }
    if (t === 0xc4) {
      need(2);
      const n = b[i + 1]!;
      i += 2;
      need(n);
      const v = b.slice(i, i + n);
      i += n;
      return v;
    }
    if (t === 0xcc) {
      need(2);
      const v = b[i + 1]!;
      i += 2;
      return v;
    }
    if (t === 0xcd) {
      need(3);
      const v = view.getUint16(i + 1);
      i += 3;
      return v;
    }
    if (t === 0xce) {
      need(5);
      const v = view.getUint32(i + 1);
      i += 5;
      return v;
    }
    if (t === 0xcf) {
      need(9);
      const v = view.getBigUint64(i + 1);
      i += 9;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('integer too large');
      return Number(v);
    }
    if (t === 0xcb) {
      need(9);
      const v = view.getFloat64(i + 1);
      i += 9;
      if (!Number.isSafeInteger(v)) throw new Error('float is not an integer');
      return v;
    }
    throw new Error(`unsupported MessagePack type 0x${t.toString(16)}`);
  };
  const v = read();
  if (i !== b.length) throw new Error('trailing bytes after the value');
  return v;
}

/** Encodes the same subset, for fixtures: integers choose the smallest form and float 64 from 2^32. */
export function encodeMsgpack(v: MsgValue): Uint8Array {
  const parts: number[] = [];
  const push = (...xs: number[]): void => {
    parts.push(...xs);
  };
  const enc = (x: MsgValue): void => {
    if (x === null) return push(0xc0);
    if (typeof x === 'boolean') return push(x ? 0xc3 : 0xc2);
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x) || x < 0) throw new Error('only non-negative safe integers');
      if (x <= 0x7f) return push(x);
      if (x <= 0xff) return push(0xcc, x);
      if (x <= 0xffff) return push(0xcd, x >> 8, x & 0xff);
      if (x <= 0xffffffff) return push(0xce, (x >>> 24) & 0xff, (x >>> 16) & 0xff, (x >>> 8) & 0xff, x & 0xff);
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setFloat64(0, x);
      return push(0xcb, ...buf);
    }
    if (typeof x === 'string') {
      const u = new TextEncoder().encode(x);
      if (u.length > 31) throw new Error('fixstr only');
      return push(0xa0 | u.length, ...u);
    }
    if (x instanceof Uint8Array) {
      if (x.length > 255) throw new Error('bin 8 only');
      return push(0xc4, x.length, ...x);
    }
    if (Array.isArray(x)) {
      if (x.length > 15) throw new Error('fixarray only');
      push(0x90 | x.length);
      for (const e of x) enc(e);
      return;
    }
    const keys = Object.keys(x);
    if (keys.length > 15) throw new Error('fixmap only');
    push(0x80 | keys.length);
    for (const k of keys) {
      enc(k);
      enc(x[k]!);
    }
  };
  enc(v);
  return new Uint8Array(parts);
}
