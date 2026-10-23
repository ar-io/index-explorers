/**
 * A local gateway for deterministic E2E runs. It serves, from a fixture
 * directory (fixtures/synthetic by default):
 *
 *   /ar-io/indexes                            the publication (publication.json)
 *   /ar-io/peers                              the registry (peers.json)
 *   /ar-io/indexes/<index>/<band>/<file>      band files, with Range (206)
 *   /ar-io/indexes/blob/<sha256>              the same by content
 *   /ar-io/indexes/torrents/<ih1>.torrent     torrents
 *   /raw/<id>                                 records (raw/<id>.json)
 *   /graphql                                  block timestamps (blocks.json)
 *   /engine/<path>                            the pinned DuckDB-WASM files, from node_modules and fixtures/cache
 *   /<anything else>                          a static site directory (the app's dist), for the page itself
 *
 * Two ports: the data gateway and a second origin that stands in for the
 * independent registry gateway, so the registry never comes from the data
 * gateway's host. Options: --fixtures <dir> --site <dir> --port <n>
 * --registry-port <n> --chaos (serve one wrong byte in band files, to prove
 * the reader refuses it; see --chaos-file).
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const FIXTURES = path.resolve(opt('--fixtures', path.join(ROOT, 'fixtures', 'synthetic')));
const SITE = opt('--site', null) ? path.resolve(opt('--site')) : null;
/** Further apps mounted under a prefix: --mount /l1/=apps/arweave-l1-explorer/dist-e2e (repeatable). */
const MOUNTS = [];
for (let i = 0; i < args.length; i++)
  if (args[i] === '--mount') {
    const [prefix, dir] = args[i + 1].split('=');
    MOUNTS.push({ prefix, dir: path.resolve(dir) });
  }
const PORT = Number(opt('--port', process.env.FIXTURE_PORT || 8787));
const REGISTRY_PORT = Number(opt('--registry-port', process.env.FIXTURE_REGISTRY_PORT || PORT + 1));
const CHAOS_FILE = opt('--chaos-file', null); // e.g. tags.parquet: its bytes are served with one bit flipped
const LOCK = JSON.parse(readFileSync(path.join(ROOT, 'engine.lock.json'), 'utf8'));
const CACHE = path.join(ROOT, 'fixtures', 'cache');

const types = {
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.parquet': 'application/octet-stream',
  '.cdb': 'application/octet-stream',
  '.torrent': 'application/x-bittorrent',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};
const typeOf = (p) => types[path.extname(p)] || 'application/octet-stream';

const publicationPath = path.join(FIXTURES, 'publication.json');
let rawMap = null;
const rawRecords = () => {
  if (rawMap === null) {
    const f = path.join(FIXTURES, 'raw.json');
    rawMap = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  }
  return rawMap;
};
const loadPublication = () => JSON.parse(readFileSync(publicationPath, 'utf8'));
/** sha256 -> absolute file path, from the publication's own listing. */
function blobIndex() {
  const pub = loadPublication();
  const map = new Map();
  for (const ix of pub.indexes)
    for (const b of ix.bands)
      for (const f of b.files) map.set(f.sha256, path.join(FIXTURES, ix.name, b.id, f.name));
  return map;
}

const engineFiles = {
  [LOCK.worker.path]: path.join(ROOT, 'node_modules', '@duckdb', 'duckdb-wasm', LOCK.worker.npm),
  [LOCK.wasm.path]: path.join(ROOT, 'node_modules', '@duckdb', 'duckdb-wasm', LOCK.wasm.npm),
  [LOCK.extension.path]: path.join(CACHE, 'parquet.duckdb_extension.wasm'),
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': '*',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function serveFile(req, res, file, { chaos = false } = {}) {
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found');
  const size = statSync(file).size;
  const type = typeOf(file);
  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!m) return send(res, 416, 'bad range', { 'content-range': `bytes */${size}` });
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start > end || start >= size)
      return send(res, 416, 'bad range', { 'content-range': `bytes */${size}` });
    status = 206;
  }
  const headers = {
    'content-type': type,
    'content-length': String(end - start + 1),
    'accept-ranges': 'bytes',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': '*',
    'cache-control': 'no-store',
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
  if (req.method === 'HEAD') {
    res.writeHead(status, headers);
    return res.end();
  }
  if (chaos) {
    const buf = Buffer.from(readFileSync(file)).subarray(start, end + 1);
    const copy = Buffer.from(buf);
    if (copy.length) copy[Math.floor(copy.length / 2)] ^= 0x01;
    res.writeHead(status, headers);
    return res.end(copy);
  }
  res.writeHead(status, headers);
  createReadStream(file, { start, end }).pipe(res);
}

function handle(req, res, { registryOnly = false } = {}) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (p === '/ar-io/peers')
    return send(res, 200, readFileSync(path.join(FIXTURES, 'peers.json')), {
      'content-type': 'application/json',
    });
  if (registryOnly) {
    if (p === '/ar-io/indexes') return send(res, 404, 'this gateway publishes nothing');
    return send(res, 404, 'not found');
  }
  if (p === '/ar-io/indexes')
    return send(res, 200, readFileSync(publicationPath), { 'content-type': 'application/json' });
  if (p === '/ar-io/info')
    return send(
      res,
      200,
      JSON.stringify({
        indexes: {
          manifestUrl: '/ar-io/indexes',
          names: loadPublication().indexes.map((i) => i.name),
        },
      }),
      { 'content-type': 'application/json' },
    );
  let m;
  if ((m = /^\/ar-io\/indexes\/blob\/([0-9a-f]{64})$/.exec(p))) {
    const file = blobIndex().get(m[1]);
    return file ? serveFile(req, res, file) : send(res, 404, 'no such blob');
  }
  if ((m = /^\/ar-io\/indexes\/torrents\/([0-9a-f]{40})\.torrent$/.exec(p)))
    return serveFile(req, res, path.join(FIXTURES, 'torrents', `${m[1]}.torrent`));
  if ((m = /^\/ar-io\/indexes\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(p))) {
    const file = path.join(FIXTURES, m[1], m[2], m[3]);
    return serveFile(req, res, file, { chaos: CHAOS_FILE !== null && m[3] === CHAOS_FILE });
  }
  if ((m = /^\/raw\/([A-Za-z0-9_-]{43})$/.exec(p))) {
    // Records: one raw.json map (synthetic fixtures), or raw/<id>.json files (recorded ones).
    const body = rawRecords()[m[1]];
    if (body !== undefined) return send(res, 200, body, { 'content-type': 'application/json' });
    const file = path.join(FIXTURES, 'raw', `${m[1]}.json`);
    if (!existsSync(file)) return send(res, 404, 'not found');
    return send(res, 200, readFileSync(file), { 'content-type': 'application/json' });
  }
  if (p === '/graphql' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const blocks = existsSync(path.join(FIXTURES, 'blocks.json'))
        ? JSON.parse(readFileSync(path.join(FIXTURES, 'blocks.json'), 'utf8'))
        : {};
      const data = {};
      for (const hm of body.matchAll(/(h\d+):\s*blocks\(height:\{min:(\d+)/g)) {
        const t = blocks[hm[2]];
        data[hm[1]] = { edges: t ? [{ node: { height: Number(hm[2]), timestamp: t } }] : [] };
      }
      // A transaction hint, for the L1 explorer's Find: never answered here.
      if (/transaction\(/.test(body)) data.transaction = null;
      send(res, 200, JSON.stringify({ data }), { 'content-type': 'application/json' });
    });
    return;
  }
  if (p.startsWith('/engine/')) {
    const rel = p.slice('/engine/'.length);
    const file = engineFiles[rel];
    if (!file) return send(res, 404, 'not a pinned engine file');
    if (!existsSync(file)) return send(res, 503, `missing ${file}; run pnpm fixtures:engine`);
    return serveFile(req, res, file);
  }
  const mount = MOUNTS.find((m) => p === m.prefix.replace(/\/$/, '') || p.startsWith(m.prefix));
  const site = mount ? mount.dir : SITE;
  const rel = mount ? p.slice(mount.prefix.length - 1) : p;
  if (site) {
    let file = path.join(site, rel === '/' || rel === '' ? 'index.html' : rel);
    if (!file.startsWith(site)) return send(res, 403, 'no');
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return send(res, 404, 'not found');
    const headers = { 'content-type': typeOf(file), 'cache-control': 'no-store' };
    if (file.endsWith('sw.js')) headers['service-worker-allowed'] = mount ? mount.prefix : '/';
    if (file.endsWith('.gz')) headers['content-encoding'] = 'gzip';
    res.writeHead(200, headers);
    return createReadStream(file).pipe(res);
  }
  send(res, 404, 'not found');
}

createServer((req, res) => handle(req, res)).listen(PORT, () =>
  console.log(
    `fixture gateway http://localhost:${PORT} (fixtures ${FIXTURES}${SITE ? ', site ' + SITE : ''}${CHAOS_FILE ? ', chaos on ' + CHAOS_FILE : ''})`,
  ),
);
createServer((req, res) => handle(req, res, { registryOnly: true })).listen(REGISTRY_PORT, () =>
  console.log(`fixture registry http://localhost:${REGISTRY_PORT}`),
);
void createGunzip;
