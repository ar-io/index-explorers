/**
 * Proves engine.lock.json: the npm package's worker and wasm hash to the
 * pins, and so do the copies on at least two gateways (decompressed). Exits 1
 * on any mismatch. Run in CI before a deploy.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = JSON.parse(readFileSync(path.join(ROOT, 'engine.lock.json'), 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
let failed = false;
const report = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed = true;
};

const pkg = JSON.parse(
  readFileSync(path.join(ROOT, 'node_modules/@duckdb/duckdb-wasm/package.json'), 'utf8'),
);
report(
  pkg.version === LOCK.version,
  `npm @duckdb/duckdb-wasm is ${pkg.version} (lock ${LOCK.version})`,
);
for (const k of ['worker', 'wasm']) {
  const bytes = readFileSync(path.join(ROOT, 'node_modules/@duckdb/duckdb-wasm', LOCK[k].npm));
  report(
    sha(bytes) === LOCK[k].sha256 && bytes.length === LOCK[k].size,
    `npm ${LOCK[k].npm}: ${sha(bytes).slice(0, 16)}… ${bytes.length} bytes`,
  );
}

const minHosts = Number(process.env.PIN_HOSTS || 2);
let okHosts = 0;
for (const host of LOCK.hosts) {
  let hostOk = true;
  for (const k of ['worker', 'wasm', 'extension']) {
    try {
      const res = await fetch(host + LOCK[k].path);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const good = sha(bytes) === LOCK[k].sha256 && bytes.length === LOCK[k].size;
      report(good, `${host}${LOCK[k].path}: ${sha(bytes).slice(0, 16)}… ${bytes.length} bytes`);
      hostOk &&= good;
    } catch (e) {
      console.log(`warn ${host}${LOCK[k].path}: ${e.message}`);
      hostOk = false;
    }
  }
  if (hostOk) okHosts++;
}
report(okHosts >= minHosts, `${okHosts} gateway(s) serve the pinned bytes (need ${minHosts})`);
process.exit(failed ? 1 : 0);
