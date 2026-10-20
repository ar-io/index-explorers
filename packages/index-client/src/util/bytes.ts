/** Byte-level helpers shared by the page, the worker and the tests. No DOM. */

export const hex = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Fails rather than returns, so a missing SubtleCrypto can never skip a check. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'this browser cannot compute SHA-256 here, so nothing can be verified. A secure context (https) is required.',
    );
  }
  return new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource));
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => hex(await sha256(bytes));

const B64U_RE = /^[A-Za-z0-9_-]+$/;

/** base64url without padding, as Arweave writes ids and addresses. */
export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let k = 0; k < bytes.length; k += 8192) bin += String.fromCharCode(...bytes.subarray(k, k + 8192));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (!B64U_RE.test(s)) throw new Error('not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const fromUtf8 = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A 43-character base64url id or address (32 bytes). */
export const isId43 = (v: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(v);
/** An ArFS Drive-Id, File-Id or Folder-Id. */
export const isUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
