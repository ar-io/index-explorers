/**
 * The lookup files' keys, as SQL. Two encodings, which any client reproduces
 * (ar-io-node docs/index-publication.md, "Keys"):
 *
 * - prefix64(bytes): the first 8 bytes, big-endian, zero-padded on the right.
 *   For ids and addresses, which are already uniform hashes.
 * - sha256_64(bytes): prefix64 of the SHA-256. For tag names and values.
 */

/** Macros every layout defines: base64url both ways and the two key encodings. */
export const KEY_MACROS: string[] = [
  "CREATE OR REPLACE MACRO b64u(x) AS rtrim(replace(replace(to_base64(x),'+','-'),'/','_'),'=')",
  // The inverse, for filters. On a constant it folds to bytes, so a filter
  // like owner_address = unb64u('…') reaches the Parquet reader.
  "CREATE OR REPLACE MACRO unb64u(s) AS from_base64(rpad(replace(replace(s,'-','+'),'_','/'), CAST(ceil(length(s) / 4) * 4 AS INTEGER), '='))",
  "CREATE OR REPLACE MACRO key64(b) AS ('0x' || rpad(left(hex(b), 16), 16, '0'))::UBIGINT",
  "CREATE OR REPLACE MACRO hkey(s) AS ('0x' || left(sha256(s), 16))::UBIGINT",
];

/** prefix64 of an id or address given as base64url text. */
export const idKeySql = (idLiteral: string): string => `key64(unb64u(${idLiteral}))`;
/** sha256_64 of a tag name or value given as text. */
export const tagKeySql = (textLiteral: string): string => `hkey(${textLiteral})`;

/** `read_parquet([...])` over registered file names. */
export const readList = (names: readonly string[]): string =>
  `read_parquet([${names.map((n) => `'${n}'`).join(',')}])`;
