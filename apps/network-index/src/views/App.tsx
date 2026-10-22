import { Proof, ArioLogo } from '@ar-io/explorer-ui';
import { type Band, fmtDay, isId43, mb, num } from '@ar-io/index-client';
import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';

import { CONFIG, type IndexView, type Session, type Store } from '../session.js';

export const AppContext = createContext<{ store: Store; session: Session } | null>(null);
const useApp = () => {
  const v = useContext(AppContext);
  if (!v) throw new Error('no context');
  return v;
};

const KIND_TEXT: Record<
  string,
  {
    title: string;
    what: string;
    verify: (dir: string, publisher: string) => string;
    explorer: string | null;
  }
> = {
  'cdb64-root-tx': {
    title: 'Root transaction index',
    what: 'Which Arweave transaction holds any data item, and at what offset: a partitioned CDB64 constant database per band of block heights. A gateway that installs these answers root-transaction lookups from disk instead of asking its peers.',
    verify: (dir) =>
      `./tools/ar-io-node index-band-verify --band-dir ${dir}/<band> --arweave-nodes default`,
    explorer: null,
  },
  'parquet-l1': {
    title: 'Arweave base layer',
    what: 'Every block and transaction since genesis as Parquet, in bands of 100,000 heights, with tags, owners and three lookup files per band. A new gateway imports it instead of indexing the chain block by block; anyone queries it where it sits.',
    verify: (dir) => `./tools/ar-io-node index-l1-verify --bands-dir ${dir}`,
    explorer: 'https://arweave-l1-search.ar.io',
  },
  'parquet-l2': {
    title: 'Data items of one selection',
    what: "The ANS-104 data items one selection takes (ArDrive's, for ardrive-l2) as Parquet over the same height grid, with their tags, owners, locations in their root transactions, and lookup files.",
    verify: (dir, publisher) =>
      `./tools/ar-io-node index-l2-verify --bands-dir ${dir} --publisher ${publisher}`,
    explorer: 'https://explore_ardrive.ar.io',
  },
};

function Resolver() {
  const { store, session } = useApp();
  const [id, setId] = useState('');
  const r = store.lookup.value;
  const gw = session.gateway ?? '';
  const go = () => {
    const v = id.trim();
    if (!isId43(v)) {
      store.say('A data item id is 43 characters of base64url.', 'bad');
      return;
    }
    history.replaceState(
      null,
      '',
      `#${new URLSearchParams({ ...(store.pub.value.gateway ? { gw: store.pub.value.gateway } : {}), id: v }).toString()}`,
    );
    void session.lookup(v);
  };
  const rt = store.indexes.value.find((i) => i.kind === 'cdb64-root-tx');
  return (
    <section class="panel" id="resolve">
      <p class="panel-label">Resolve a data item</p>
      <h2 class="panel-title">
        Which transaction holds it, and where. A few verified range reads, in your browser.
      </h2>
      <p class="note" style="margin:0 0 14px">
        This page carries no index. It reads the header, one hash-table slot and one record of the
        right partition out of the publisher's bands, through the same checked reader as the
        explorers: every byte is matched against the torrent the signed publication pins before it
        is used.
      </p>
      <div class="askbar">
        <div class="searchbox">
          <label for="find" class="sr-only">
            Data item id
          </label>
          <input
            id="find"
            placeholder="data item id (43 characters)"
            spellcheck={false}
            autocomplete="off"
            value={id}
            onInput={(e) => setId((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), go())}
          />
          <button
            id="findgo"
            type="button"
            disabled={!store.pub.value.verified || store.looking.value || !rt}
            onClick={go}
          >
            Resolve
          </button>
        </div>
        <div class="periodbox">
          <span class="period-label">Reads</span>
          <span style="font-weight:600">
            {r ? `${r.reads} range read${r.reads === 1 ? '' : 's'} · ${num(r.bytes)} bytes` : '—'}
          </span>
          <span class="period-dates">
            {rt ? `${rt.all.length} bands, newest first` : 'no root-tx index here'}
          </span>
        </div>
      </div>
      <div id="status" aria-live="polite">
        {store.status.value.text ? (
          <span class={store.status.value.cls}>{store.status.value.text}</span>
        ) : null}
      </div>
      {r ? (
        <div class="result" id="lookup">
          {r.found ? (
            <dl class="facts">
              <div class="fact wide">
                <dt>Root transaction</dt>
                <dd class="mono">
                  <a href={`${gw}/raw/${r.found.rootTxId}`} target="_blank" rel="noopener">
                    {r.found.rootTxId}
                  </a>
                </dd>
              </div>
              <div class="fact">
                <dt>Band</dt>
                <dd class="mono">{r.found.band.id}</dd>
              </div>
              <div class="fact">
                <dt>Partition</dt>
                <dd class="mono">{r.found.partition}</dd>
              </div>
              {r.found.rootDataItemOffset !== null ? (
                <div class="fact">
                  <dt>Item offset</dt>
                  <dd>{num(r.found.rootDataItemOffset)}</dd>
                </div>
              ) : null}
              {r.found.rootDataOffset !== null ? (
                <div class="fact">
                  <dt>Data offset</dt>
                  <dd>{num(r.found.rootDataOffset)}</dd>
                </div>
              ) : null}
              {r.found.dataItemSize !== null ? (
                <div class="fact">
                  <dt>Item size</dt>
                  <dd>{num(r.found.dataItemSize)}</dd>
                </div>
              ) : null}
              {r.found.path ? (
                <div class="fact wide">
                  <dt>Bundle path</dt>
                  <dd class="mono">{r.found.path.join(' › ')}</dd>
                </div>
              ) : null}
            </dl>
          ) : r.error ? null : store.looking.value ? (
            <p class="note">Reading…</p>
          ) : (
            <p class="note">Not found in any band.</p>
          )}
          <details class="guide" style="margin-top:10px">
            <summary>What was read ({r.steps.length} ranges)</summary>
            <ol class="steps-log">
              {r.steps.map((s, i) => (
                <li key={i}>
                  <code>{s.text}</code>
                </li>
              ))}
            </ol>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function Bands({ ix }: { ix: IndexView }) {
  const { session } = useApp();
  const gw = session.gateway ?? '';
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div class="tablewrap">
      <table class="bands">
        <thead>
          <tr>
            <th scope="col">Band</th>
            <th scope="col">Blocks</th>
            <th scope="col" class="num">
              Records
            </th>
            <th scope="col" class="num">
              Size
            </th>
            <th scope="col">Files</th>
            <th scope="col">Torrent</th>
          </tr>
        </thead>
        <tbody>
          {[...ix.all].reverse().map((b) => (
            <>
              <tr key={b.id} class="band-row" onClick={() => setOpen(open === b.id ? null : b.id)}>
                <td class="mono">
                  {b.id}
                  {ix.dropped.some((d) => d.id === b.id) ? (
                    <span class="badge">{ix.dropped.find((d) => d.id === b.id)!.why}</span>
                  ) : null}
                </td>
                <td>{`${num(b.from)} – ${b.to === null ? 'tip' : num(b.to)}`}</td>
                <td class="num">{b.records ? num(b.records) : '—'}</td>
                <td class="num">{mb(b.size)}</td>
                <td>{b.files.size}</td>
                <td class="mono">
                  {b.torrent ? (
                    <>
                      <a
                        href={b.torrent.urls[0]}
                        target="_blank"
                        rel="noopener"
                        onClick={(e) => e.stopPropagation()}
                      >
                        .torrent
                      </a>
                      {b.torrent.magnet ? (
                        <>
                          {' · '}
                          <a href={b.torrent.magnet} onClick={(e) => e.stopPropagation()}>
                            magnet
                          </a>
                        </>
                      ) : null}
                    </>
                  ) : (
                    'none'
                  )}
                </td>
              </tr>
              {open === b.id ? (
                <tr key={b.id + ':files'} class="band-files">
                  <td colSpan={6}>
                    <p class="note" style="margin:0 0 6px">
                      {b.torrent ? (
                        <>
                          BitTorrent v2 infohash <code>{b.torrent.infohashV2}</code>
                          {b.torrent.infohashV1 ? (
                            <>
                              {' '}
                              · v1 <code>{b.torrent.infohashV1}</code>
                            </>
                          ) : null}
                        </>
                      ) : (
                        'No torrent: files are downloaded whole and hashed.'
                      )}
                      {b.schema ? (
                        <>
                          {' '}
                          · layout <code>{b.schema}</code>
                        </>
                      ) : null}
                    </p>
                    <table class="files">
                      <tbody>
                        {[...b.files.values()].map((f) => (
                          <tr key={f.name}>
                            <td class="mono">
                              <a href={f.url} target="_blank" rel="noopener">
                                {f.name}
                              </a>
                            </td>
                            <td class="num">{num(f.size)}</td>
                            <td class="mono digest">{f.sha256}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p class="note" style="margin:6px 0 0">
                      By content: <code>{`${gw}/ar-io/indexes/blob/<sha256>`}</code>
                    </p>
                  </td>
                </tr>
              ) : null}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IndexCard({ ix }: { ix: IndexView }) {
  const { store } = useApp();
  const text = KIND_TEXT[ix.kind] ?? { title: ix.kind, what: '', verify: () => '', explorer: null };
  const pub = store.pub.value;
  const chainTip = pub.chainTip;
  const behind = chainTip !== null && ix.tip !== null ? chainTip - ix.tip : null;
  const live = ix.all.filter((b) => !ix.dropped.some((d) => d.id === b.id));
  return (
    <section class="panel index" id={`index-${ix.name}`}>
      <p class="panel-label">{text.title}</p>
      <h2 class="panel-title">
        <code>{ix.name}</code> <span class="kind">{ix.kind}</span>
      </h2>
      <p class="note" style="margin:0 0 14px">
        {text.what}
      </p>
      <dl class="facts">
        <div class="fact">
          <dt>Bands</dt>
          <dd>{num(live.length)}</dd>
        </div>
        <div class="fact">
          <dt>Records</dt>
          <dd>{ix.records ? num(ix.records) : '—'}</dd>
        </div>
        <div class="fact">
          <dt>Size</dt>
          <dd>{mb(ix.size)}</dd>
        </div>
        <div class="fact">
          <dt>Reaches block</dt>
          <dd>{ix.tip === null ? 'the tip' : num(ix.tip)}</dd>
        </div>
        <div class="fact">
          <dt>Freshness</dt>
          <dd>
            {ix.tip === null
              ? 'open at the tip'
              : behind !== null
                ? behind <= 0
                  ? 'at the chain tip'
                  : `${num(behind)} blocks behind`
                : ix.tipTime
                  ? fmtDay(ix.tipTime)
                  : '—'}
          </dd>
        </div>
        {text.explorer ? (
          <div class="fact">
            <dt>Explore</dt>
            <dd>
              <a href={text.explorer} target="_blank" rel="noopener">
                {text.explorer.replace(/^https?:\/\//, '')}
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
      {ix.filter ? (
        <p class="note">
          Selection: <code>{JSON.stringify(ix.filter)}</code>
        </p>
      ) : null}
      <Bands ix={ix} />
      <details class="guide">
        <summary>Run a copy and verify it</summary>
        <div class="guide-body one">
          <p class="note">
            Subscribe a gateway to this publisher's bands (the index-swarm sidecar fetches them over
            HTTP and BitTorrent, checks every digest, and installs them):
          </p>
          <pre>
            <code>{`./tools/index-swarm-setup --subscribe ${pub.doc?.doc.publisher ?? '<publisher wallet>'}${ix.name === 'parquet-l1' ? ' --l1' : ''} --restart`}</code>
          </pre>
          {ix.kind === 'parquet-l2' ? (
            <p class="note">
              L2 indexes are opt-in: name them in <code>INDEX_SWARM_SUBSCRIBE</code>,{' '}
              <code>{`{"publisher":"${pub.doc?.doc.publisher ?? '…'}","name":["root-tx-index","${ix.name}"]}`}</code>
              .
            </p>
          ) : null}
          <p class="note">Then check what arrived, with nothing trusted but the chain:</p>
          <pre>
            <code>
              {text.verify(
                `data/indexes/installed/${ix.name}`,
                pub.doc?.doc.publisher ?? '<publisher wallet>',
              )}
            </code>
          </pre>
        </div>
      </details>
    </section>
  );
}

export function App() {
  const { store, session } = useApp();
  const pub = store.pub.value;
  const doc = pub.doc?.doc;
  const indexes = store.indexes.value;
  const issued = doc ? Date.parse(doc.issuedAt) : NaN;
  const ageH = Number.isFinite(issued) ? Math.round((Date.now() - issued) / 3600000) : null;
  const home = (pub.proof?.publisherUrl ?? pub.gateway ?? 'https://turbo-gateway.com').replace(
    /\/+$/,
    '',
  );
  return (
    <div class="rail">
      <header class="framed">
        <div class="bar">
          <a href="https://ar.io" aria-label="ar.io home" class="logo-link">
            <ArioLogo />
          </a>
          <a
            class="pill"
            href="https://docs.ar.io/build/advanced/index-publications"
            target="_blank"
            rel="noopener"
          >
            How publications work
          </a>
        </div>
        <p class="eyebrow">ar.io · the network index</p>
        <h1>
          Every index the gateway publishes. <em>Verified.</em>
        </h1>
        <p class="lede">
          One signed document lists the gateway's indexes: the root transaction index, the Arweave
          base layer and the data items of one app, as bands of files with their sizes, digests and
          torrents. This page reads it, checks the signature against the ar.io registry through
          another gateway, and shows what it holds.
        </p>
        <dl class="stats" id="stats">
          <div class="stat">
            <dd id="s-indexes">{indexes.length || '—'}</dd>
            <dt>Indexes</dt>
          </div>
          <div class="stat">
            <dd id="s-bands">
              {indexes.length ? num(indexes.reduce((t, i) => t + i.all.length, 0)) : '—'}
            </dd>
            <dt>Bands</dt>
          </div>
          <div class="stat">
            <dd id="s-size">
              {indexes.length ? mb(indexes.reduce((t, i) => t + i.size, 0)) : '—'}
            </dd>
            <dt>Index data</dt>
          </div>
          <div class="stat">
            <dd id="s-seq">{doc ? `#${doc.sequence}` : '—'}</dd>
            <dt>Publication</dt>
          </div>
          <div class="stat">
            <dd id="s-age">
              {ageH === null
                ? '—'
                : ageH < 1
                  ? 'this hour'
                  : ageH < 48
                    ? `${ageH} h ago`
                    : `${Math.round(ageH / 24)} days ago`}
            </dd>
            <dt>Issued</dt>
          </div>
        </dl>
        <Proof
          state={store.proof.value.state}
          text={store.proof.value.text}
          checks={store.proof.value.checks}
          labels={{
            registry:
              "The publisher's signing key, read from the ar.io registry through a different gateway",
            signature:
              "The publication's signature, checked against that key (Ed25519 over RFC 8785 canonical JSON)",
            engine: 'No query engine on this page: a lookup is a handful of range reads',
            pieces:
              "Every byte a lookup reads, checked against the band's BitTorrent v2 hash tree, whose root the signed publication pins",
          }}
          note={
            doc
              ? `Publisher ${doc.publisher}, publication #${doc.sequence}, issued ${doc.issuedAt.slice(0, 16).replace('T', ' ')}Z, expires ${doc.expiresAt.slice(0, 16).replace('T', ' ')}Z${pub.proof?.expired ? ' (expired: the publisher has gone quiet, not its bands bad)' : ''}. Document SHA-256 ${pub.doc?.sha256}.`
              : null
          }
        />
      </header>
      <Resolver />
      {indexes.map((ix) => (
        <IndexCard key={ix.name} ix={ix} />
      ))}
      <section class="panel" id="how">
        <p class="panel-label">How a lookup works</p>
        <h2 class="panel-title">Three reads, a few hundred bytes</h2>
        <div class="guide-body">
          <div>
            <ol class="steps">
              <li>
                The first byte of the 32-byte data item id selects one of 256 partition files. No
                search.
              </li>
              <li>
                A 4 KB header in that partition holds 256 hash table pointers.{' '}
                <code>hash(key) % 256</code> picks the table.
              </li>
              <li>
                Probe 16-byte slots, follow the pointer, read the record: MessagePack with the root
                transaction id, the item's offsets and its size.
              </li>
            </ol>
            <p class="note">
              Bands are searched newest first. Each read goes through the range reader, which
              fetches the piece that holds the bytes, checks it against the hash tree, and keeps it
              so the next read of the same piece costs nothing.
            </p>
          </div>
          <div>
            <h3>CDB64</h3>
            <p class="note" style="margin:0">
              An extended <a href="https://cr.yp.to/cdb.html">constant database</a> that supports
              files larger than 4 GB: 64-bit offsets, the DJB hash with 64-bit arithmetic, O(1)
              lookups. Keys are 32-byte binary{' '}
              <a href="https://github.com/ArweaveTeam/arweave-standards/blob/master/ans/ANS-104.md">
                ANS-104
              </a>{' '}
              data item ids; values are MessagePack, either a root transaction id or a bundle path{' '}
              <code>[root, …, parent]</code> for nested bundles, with offsets. The format is
              specified in{' '}
              <a href="https://github.com/ar-io/ar-io-node/blob/develop/docs/cdb64-format.md">
                ar-io-node
              </a>
              .
            </p>
          </div>
        </div>
      </section>
      <section class="panel" id="data">
        <details class="drawer" id="datadrawer" open>
          <summary>
            <span class="drawer-title">Data source</span>
            <span class="drawer-sub" id="dataline">
              {pub.publisherName ?? 'auto'}
            </span>
          </summary>
          <div class="drawer-body">
            <div class="row">
              <div class="field">
                <label for="gwsel">Gateway</label>
                <select
                  id="gwsel"
                  value={store.gatewayChoice.value}
                  onChange={(e) => {
                    store.gatewayChoice.value = (e.target as HTMLSelectElement).value;
                    if (store.gatewayChoice.value !== 'custom') void session.readPublication();
                  }}
                >
                  <option value="auto">Auto</option>
                  {CONFIG.publishers.map((g) => (
                    <option key={g} value={g}>
                      {g.replace(/^https?:\/\//, '')}
                    </option>
                  ))}
                  <option value="custom">Other…</option>
                </select>
              </div>
              <div class="field" id="gwcustomwrap" hidden={store.gatewayChoice.value !== 'custom'}>
                <label for="gw">Gateway URL</label>
                <input
                  id="gw"
                  placeholder="https://my-gateway.example"
                  value={store.customGateway.value}
                  onInput={(e) =>
                    (store.customGateway.value = (e.target as HTMLInputElement).value)
                  }
                  onKeyDown={(e) =>
                    e.key === 'Enter' && (e.preventDefault(), void session.readPublication())
                  }
                />
              </div>
              <button
                id="connect"
                type="button"
                class="secondary"
                onClick={() => void session.readPublication()}
              >
                Read publication
              </button>
            </div>
            <p class="note">
              {store.rangeOk.value.ok
                ? 'Range reads are on: a lookup fetches only the pieces it touches, each checked as it arrives.'
                : `Range reads are off here (${store.rangeOk.value.why}): nothing can be looked up, since nothing could be checked.`}
            </p>
            {doc ? (
              <p class="note">
                Publisher{' '}
                <a
                  href={`${CONFIG.portalUrl}/#/gateways/${doc.publisher}`}
                  target="_blank"
                  rel="noopener"
                >
                  {doc.publisher}
                </a>{' '}
                ·{' '}
                <a id="foot-pub" href={`${home}/ar-io/indexes`} target="_blank" rel="noopener">
                  the signed publication
                </a>{' '}
                · registry read through {pub.proof?.via.replace(/^https?:\/\//, '')}
              </p>
            ) : null}
          </div>
        </details>
      </section>
      <footer>
        <p class="foot-legal">
          Published for the ar.io network. Nothing here is advice, and the data is whichever gateway
          you point it at; every claim shown is checked against that gateway's signed publication.
        </p>
      </footer>
    </div>
  );
}

export type { Band };
