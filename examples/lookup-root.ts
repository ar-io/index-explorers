/**
 * Which Arweave transaction holds a data item, verified end to end, from Node.
 *
 *   pnpm example:lookup <data-item-id> [gateway]
 *
 * The same checks the pages make, without a browser:
 *   1. the publication's signature, against the registry read through another gateway
 *   2. the root-tx band's torrent, against the infohash the publication signs
 *   3. every range read, against the torrent's hash tree, piece by piece
 *   4. the CDB64 lookup itself: manifest, header slot, probes, record
 *
 * Only @ar-io/index-client is used; the range reader here is twenty lines of
 * fetch with a Range header, checked with the client's pieceOk.
 */
import {
  type Band,
  cdb64,
  checkTorrent,
  fetchPublication,
  type FileTree,
  mirrorsOf,
  pieceOk,
  REGISTRY_GATEWAYS,
  selectIndex,
  verifyPublication,
} from '../packages/index-client/src/index.js';

const [id, gateway = 'https://turbo-gateway.com'] = process.argv.slice(2);
if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) {
  console.error('usage: pnpm example:lookup <data-item-id> [gateway]');
  process.exit(2);
}

const pub = await fetchPublication(gateway);
const proof = await verifyPublication(pub.doc, {
  registryGateways: REGISTRY_GATEWAYS,
  excluding: pub.gateway,
});
console.log(
  `publication #${pub.doc.sequence} by ${pub.doc.publisher}: verified against the registry read through ${proof.via}`,
);
const { bands } = selectIndex(pub.doc, 'root-tx-index', {
  gateway: pub.gateway,
  mirrors: mirrorsOf(pub.gateway),
});
console.log(`${bands.length} root-tx bands`);

/** One checked torrent per band, fetched on first use. */
const trees = new Map<string, Promise<Map<string, FileTree>>>();
const treesOf = (band: Band) => {
  let p = trees.get(band.id);
  if (!p) {
    p = (async () => {
      if (!band.torrent) throw new Error(`${band.id} has no torrent`);
      const res = await fetch(band.torrent.urls[0]!);
      if (!res.ok) throw new Error(`torrent: HTTP ${res.status}`);
      return checkTorrent(new Uint8Array(await res.arrayBuffer()), band.torrent.infohashV2);
    })();
    trees.set(band.id, p);
  }
  return p;
};

/** The pieces a byte range needs, each fetched once and checked against the tree before use. */
const pieces = new Map<string, Uint8Array>();
let fetched = 0;
let checked = 0;
async function read(band: Band, file: string, start: number, end: number): Promise<Uint8Array> {
  const tree = (await treesOf(band)).get(file);
  const f = band.files.get(file);
  if (!tree || !f) throw new Error(`${band.id} has no ${file}`);
  if (tree.size !== f.size)
    throw new Error(`torrent and publication disagree on the size of ${file}`);
  const out = new Uint8Array(end - start + 1);
  const P = tree.pieceLength;
  for (let k = Math.floor(start / P); k <= Math.floor(end / P); k++) {
    const key = `${tree.rootHex}:${k}`;
    let piece = pieces.get(key);
    if (!piece) {
      const a = k * P;
      const z = Math.min(a + P, tree.size) - 1;
      const res = await fetch(f.url, { headers: { Range: `bytes=${a}-${z}` } });
      if (res.status !== 206) throw new Error(`${file}: HTTP ${res.status} for a range`);
      piece = new Uint8Array(await res.arrayBuffer());
      fetched += piece.length;
      if (!(await pieceOk(tree, k, piece)))
        throw new Error(
          `${file} piece ${k} does not match the torrent the publisher signed: refused`,
        );
      checked += 1;
      pieces.set(key, piece);
    }
    const from = Math.max(start, k * P) - k * P;
    const to = Math.min(end, k * P + piece.length - 1) - k * P;
    out.set(piece.subarray(from, to + 1), Math.max(start, k * P) - start);
  }
  return out;
}

const found = await cdb64.lookupRoot(id, { bands, read });
if (!found) {
  console.log(
    `not in any band (${fetched.toLocaleString()} bytes fetched, ${checked} pieces checked)`,
  );
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      band: found.band.id,
      partition: found.partition,
      rootTxId: found.rootTxId,
      path: found.path,
      rootDataItemOffset: found.rootDataItemOffset,
      rootDataOffset: found.rootDataOffset,
      dataItemSize: found.dataItemSize,
      reads: found.reads.length,
      bytesFetched: fetched,
      piecesChecked: checked,
    },
    null,
    2,
  ),
);
