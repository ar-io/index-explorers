/**
 * Puts the pinned Parquet extension in fixtures/cache for the fixture gateway,
 * checked against engine.lock.json. The worker and wasm come from
 * node_modules (the same bytes, as scripts/check-pins.mjs proves).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(readFileSync(path.join(ROOT, 'engine.lock.json'), 'utf8'));
const CACHE = path.join(ROOT, 'fixtures', 'cache');
const target = path.join(CACHE, 'parquet.duckdb_extension.wasm');
const sha = (b) => createHash('sha256').update(b).digest('hex');

if (existsSync(target) && sha(readFileSync(target)) === LOCK.extension.sha256) {
  console.log('extension already cached and matches the lock');
  process.exit(0);
}
mkdirSync(CACHE, { recursive: true });
let last = null;
for (const host of LOCK.hosts) {
  try {
    const res = await fetch(host + LOCK.extension.path);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sha(bytes) !== LOCK.extension.sha256) throw new Error('hash mismatch');
    writeFileSync(target, bytes);
    console.log(`cached the Parquet extension from ${host} (${bytes.length} bytes)`);
    process.exit(0);
  } catch (e) {
    last = e;
    console.warn(`${host}: ${e.message}`);
  }
}
console.error('could not fetch the extension from any host', last);
process.exit(1);
