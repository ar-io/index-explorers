import { Proof, ArioLogo } from '@ar-io/explorer-ui';
import { type Band, fmtDay, isId43, mb, num } from '@ar-io/index-client';
import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';

import {
  ARWEAVE_GATEWAYS,
  CONFIG,
  EXAMPLE_ID,
  type IndexView,
  PACK_SET,
  type Session,
  type StageName,
  type Store,
} from '../session.js';

export const AppContext = createContext<{ store: Store; session: Session } | null>(null);
const useApp = () => {
  const v = useContext(AppContext);
  if (!v) throw new Error('no context');
  return v;
};

const PACK_RECORDS = PACK_SET.packs.reduce((t, p) => t + p.records, 0);
const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;

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

const STAGES: { k: StageName; n: string; title: string; text: string }[] = [
  {
    k: 'partition',
    n: '01',
    title: 'Partition',
    text: "The id's first byte picks a partition in each index. Each partition is a CDB64 file: in a published band, or inside an Arweave transaction for the packs.",
  },
  {
    k: 'table',
    n: '02',
    title: 'Table pointer',
    text: "The key's hash picks one of 256 hash tables, from a 16-byte pointer in the partition header.",
  },
  {
    k: 'slot',
    n: '03',
    title: 'Slot',
    text: '16-byte slots are read in turn until one holds the same hash.',
  },
  {
    k: 'record',
    n: '04',
    title: 'Record',
    text: 'The stored key confirms the match, and the value holds the root transaction.',
  },
];

function Lookup() {
  const { store, session } = useApp();
  const r = store.lookup.value;
  const [copied, setCopied] = useState(false);
  const submit = (raw: string) => {
    const m = raw.trim().match(/[A-Za-z0-9_-]{43}/);
    const id = m ? m[0] : raw.trim();
    store.query.value = id;
    if (!isId43(id)) {
      store.say('That is not a 43-character data item id.', 'bad');
      (document.getElementById('q') as HTMLInputElement | null)?.focus();
      return;
    }
    const gw = store.pub.value.auto ? null : store.pub.value.gateway;
    history.replaceState(
      null,
      '',
      gw ? `#${new URLSearchParams({ gw, id }).toString()}` : `#${id}`,
    );
    void session.lookup(id);
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.getElementById('root');
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const f = r?.found ?? null;
  const stages = store.stages.value;
  return (
    <div class="lookup">
      <form
        class="lookup-form"
        id="form"
        noValidate
        aria-busy={store.looking.value ? 'true' : undefined}
        onSubmit={(e) => {
          e.preventDefault();
          submit(store.query.value);
        }}
      >
        <div class="field field-id">
          <label for="q">Data item id</label>
          <input
            id="q"
            name="q"
            placeholder="43-character id"
            spellcheck={false}
            autocapitalize="off"
            autocorrect="off"
            autocomplete="off"
            inputMode="latin"
            maxLength={64}
            aria-describedby="hint"
            value={store.query.value}
            onInput={(e) => (store.query.value = (e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="field">
          <label for="readfrom">Read from</label>
          <select
            id="readfrom"
            value={store.readFrom.value}
            onChange={(e) => (store.readFrom.value = (e.target as HTMLSelectElement).value)}
          >
            <option value="auto">Auto (this gateway)</option>
            {ARWEAVE_GATEWAYS.map((g) => (
              <option key={g} value={g}>
                {g.replace(/^https?:\/\//, '')}
              </option>
            ))}
          </select>
        </div>
        <button id="findgo" type="submit" disabled={store.looking.value}>
          Look up
        </button>
      </form>
      <p class="hint" id="hint">
        No id to hand?{' '}
        <button
          type="button"
          class="linkbtn"
          id="example"
          disabled={store.looking.value}
          onClick={() => submit(EXAMPLE_ID)}
        >
          Try an example
        </button>
        {', an image from the ar.io docs.'}
      </p>
      <p class="hint">
        Answers from the bands the gateway publishes are checked against its signed publication;
        answers from the packs on Arweave are checked against the data, below. To route each request
        across gateways and verify every response, use{' '}
        <a href="https://github.com/ar-io/wayfinder">Wayfinder</a>.
      </p>
      <div class="trace">
        <h2 class="sr-only">How a lookup works</h2>
        <ol class="stages">
          {STAGES.map((sd) => {
            const st = stages[sd.k];
            return (
              <li key={sd.k} class="stage" data-k={sd.k} data-state={st.state}>
                <span class="rule" />
                <span class="stage-n">{sd.n}</span>
                <h3>{sd.title}</h3>
                <p>{sd.text}</p>
                <span class="stage-v">
                  <span class="stage-dot" />
                  {sd.k === 'partition'
                    ? r
                      ? `Partition ${r.id ? partitionOf(r.id) : ''}, no request`
                      : 'No request'
                    : st.reads
                      ? `${st.reads} read${st.reads === 1 ? '' : 's'}, ${num(st.bytes)} bytes`
                      : st.state === 'active'
                        ? 'Reading'
                        : 'Waiting'}
                </span>
              </li>
            );
          })}
        </ol>
        {store.groups.value.length ? (
          <ul class="groups" id="packs" aria-label="Indexes checked">
            {store.groups.value.map((g) => (
              <li key={g.key} data-s={g.state}>
                <span class="g-label">{g.label}</span>
                <span class="g-trust">
                  {g.trust === 'signed' ? 'signed' : 'on Arweave, unsigned'}
                </span>
                <span class="g-note">{g.note}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p id="status" role="status" aria-live="polite" class={'status ' + store.status.value.cls}>
        {store.status.value.text}
      </p>
      {f ? (
        <div class="result" id="result">
          <span class="eyebrow">Root transaction</span>
          <div class="rid">
            <code id="root">{f.rootTxId}</code>
            <button
              type="button"
              class="secondary copy"
              id="copy"
              onClick={() => void copy(f.rootTxId)}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p class="source">
            {f.source.kind === 'band' ? (
              <>
                From band <code>{f.source.band.id}</code>, partition{' '}
                <code>{f.source.partition}</code>, published and signed by{' '}
                {store.pub.value.publisherName ?? 'its publisher'}. Every byte read was matched
                against the band's torrent.
              </>
            ) : (
              <>
                From the {f.source.pack.name} pack on Arweave, partition {partitionOf(r!.id)} in
                transaction{' '}
                <a href={`https://arweave.net/tx/${f.source.tx}`}>{short(f.source.tx)}</a>. No
                signed publication covers the packs, so the answer is checked against the data
                below.
              </>
            )}
          </p>
          {r!.checks.length ? (
            <div class="check" id="check">
              <span class="eyebrow">Checked against the data</span>
              <ul class="data-checks" id="checks">
                {r!.checks.map((c, i) => (
                  <li key={i} data-s={c.state}>
                    {c.text}
                  </li>
                ))}
              </ul>
              {r!.hash ? (
                <div class="hashcmp" id="hashcmp">
                  <span class="hk">You asked for</span>
                  <code>{r!.hash.id}</code>
                  <span class="hk">SHA-256 of its signature</span>
                  <code>
                    {[...r!.hash.digest].map((ch, i) =>
                      ch === r!.hash!.id[i] ? <b key={i}>{ch}</b> : ch,
                    )}
                  </code>
                </div>
              ) : null}
              {r!.checkVerdict === 'ok' ? (
                <p class="checknote">
                  This confirms where the item sits. It does not check the signature itself, or that
                  the gateway served bytes that are really on Arweave:{' '}
                  <a href="https://github.com/ar-io/wayfinder">Wayfinder</a> can.
                </p>
              ) : r!.checkVerdict === 'bad' ? (
                <p class="checknote bad">
                  The index answer and the bytes at that position disagree. Try another gateway, or
                  check the item with <a href="https://github.com/ar-io/wayfinder">Wayfinder</a>.
                </p>
              ) : null}
            </div>
          ) : null}
          {r!.item ? (
            <div class="item" id="item">
              <span class="eyebrow">The data item</span>
              <a class="itemlink" id="itemlink" href={r!.item.url}>
                {r!.item.label}
              </a>
              {r!.item.image ? (
                <img
                  id="itemimg"
                  src={r!.item.image}
                  alt="The data item, an image"
                  loading="lazy"
                />
              ) : null}
            </div>
          ) : null}
          <dl class="facts">
            {f.rootDataItemOffset !== null ? (
              <div class="fact">
                <dt>Item offset</dt>
                <dd>{num(f.rootDataItemOffset)}</dd>
              </div>
            ) : null}
            {f.rootDataOffset !== null ? (
              <div class="fact">
                <dt>Data offset</dt>
                <dd>{num(f.rootDataOffset)}</dd>
              </div>
            ) : null}
            {f.dataItemSize !== null ? (
              <div class="fact">
                <dt>Item size</dt>
                <dd>{num(f.dataItemSize)}</dd>
              </div>
            ) : null}
          </dl>
          {f.path && f.path.length > 1 ? (
            <div id="pathwrap">
              <span class="eyebrow">Bundle path, root to parent</span>
              <ol class="path" id="path">
                {f.path.map((x, i) => (
                  <li key={i}>
                    <span class="k">
                      {i === 0 ? 'Root' : i === f.path!.length - 1 ? 'Parent' : `Level ${i}`}
                    </span>
                    <code>{x}</code>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : null}
      {r && r.steps.length ? (
        <details class="reqs" id="reqs">
          <summary>Show the {r.steps.length} requests</summary>
          <ol class="steps-log">
            {r.steps.map((q, i) => (
              <li key={i}>
                <code>
                  {q.kind.padEnd(8)} {q.text} · {num(q.bytes)} B
                </code>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

const partitionOf = (id: string): string => {
  try {
    return atob(id.replace(/-/g, '+').replace(/_/g, '/') + '=')
      .charCodeAt(0)
      .toString(16)
      .padStart(2, '0');
  } catch {
    return '';
  }
};

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

function WhatIsIndexed() {
  const { store } = useApp();
  const rt = store.indexes.value.find((i) => i.kind === 'cdb64-root-tx');
  const pubName = store.pub.value.publisherName;
  return (
    <section class="band-section" aria-labelledby="h-indexed">
      <p class="eyebrow">What is indexed</p>
      <h2 id="h-indexed">Three packs on Arweave, and the bands the gateway publishes</h2>
      <div class="tablewrap">
        <table class="indexed" aria-describedby="coverage">
          <thead>
            <tr>
              <th scope="col">Index</th>
              <th scope="col" class="num">
                Data items
              </th>
              <th scope="col" class="num">
                Size
              </th>
              <th scope="col" class="num">
                Arweave transactions
              </th>
              <th scope="col">Published</th>
            </tr>
          </thead>
          <tbody>
            {PACK_SET.packs.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  {p.name}
                  <span>{p.about}</span>
                </th>
                <td class="num">{num(p.records)}</td>
                <td class="num">{p.size}</td>
                <td class="num">{p.txCount}</td>
                <td>
                  <time dateTime={p.published}>{p.published}</time>
                </td>
              </tr>
            ))}
            <tr>
              <th scope="row">
                Published root-tx bands
                <span>
                  {rt
                    ? `${rt.all.length} bands from block ${num(rt.all[0]?.from ?? 0)} to ${rt.tip === null ? 'the tip' : num(rt.tip)}, signed by ${pubName ?? 'the publisher'}, rebuilt as the chain grows.`
                    : store.pub.value.verified
                      ? 'This gateway publishes no root-tx index.'
                      : 'Read from the gateway’s signed publication once it verifies.'}
                </span>
              </th>
              <td class="num">{rt ? num(rt.records) : '—'}</td>
              <td class="num">{rt ? mb(rt.size) : '—'}</td>
              <td class="num">served by the gateway</td>
              <td>
                {store.pub.value.doc ? (
                  <time dateTime={store.pub.value.doc.doc.issuedAt}>
                    {store.pub.value.doc.doc.issuedAt.slice(0, 10)}
                  </time>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="note" id="coverage">
        The packs cover data items in bundles up to Arweave block {num(PACK_SET.toHeight)}; Redstone
        data items are not included. The published bands cover what the gateway has indexed, up to
        its newest band.
      </p>
    </section>
  );
}

function HowStored() {
  return (
    <section class="band-section wash" aria-labelledby="h-stored">
      <div class="split">
        <div>
          <p class="eyebrow">How it is stored</p>
          <h2 id="h-stored">CDB64 files, read a few bytes at a time</h2>
          <p class="body">
            Each index is a manifest and up to 256 partitions. A partition is one CDB64 file: DJB's{' '}
            <a href="https://cr.yp.to/cdb.html">constant database</a> format, extended to hold files
            larger than 4 GB. The packs keep their partitions inside Arweave transactions; a
            published band keeps them as files the gateway serves, with a torrent the signed
            publication pins. Either way a reader goes straight to the bytes it needs.
          </p>
          <figure class="layout" aria-labelledby="layout-cap">
            <div
              class="file"
              role="img"
              aria-label="A CDB64 partition file has three parts in order: a 4 KB header holding 256 table pointers, where step 02 reads; the records, where step 04 reads; and the hash tables, where step 03 reads."
            >
              <div class="seg">
                <div class="segt">
                  <b>Header</b>
                  <small>256 table pointers, 4 KB</small>
                </div>
                <span class="mark">
                  <i>02</i>16 bytes
                </span>
              </div>
              <div class="seg">
                <div class="segt">
                  <b>Records</b>
                  <small>Key and value, one after another, most of the file</small>
                </div>
                <span class="mark">
                  <i>04</i>Key, then value
                </span>
              </div>
              <div class="seg">
                <div class="segt">
                  <b>Hash tables</b>
                  <small>256 tables of 16-byte slots, two per record</small>
                </div>
                <span class="mark">
                  <i>03</i>16 bytes a slot
                </span>
              </div>
            </div>
            <figcaption id="layout-cap">
              Where each step of a lookup reads inside one partition. Keys are 32-byte data item
              ids. Values are MessagePack: the root transaction id, or the full bundle path for a
              nested bundle, with offsets where known.{' '}
              <a href="https://github.com/ar-io/ar-io-node/blob/main/docs/cdb64-format.md">
                Read the format spec
              </a>
              .
            </figcaption>
          </figure>
        </div>
        <div class="card">
          <h3>A partition entry in a pack's manifest</h3>
          <pre>
            <code>{`{
  "prefix": "00",
  "location": {
    "type": "arweave-byte-range",
    "rootTxId": "G02uQHvdhUL9ya5pmFmJ1IETap2e97TJe0X8543ASVA",
    "dataOffsetInRootTx": 476132274,
    "dataItemId": "q_BOlNtAlOGcOFxe6ybdvcooo5bkzMKt5s0PQTr1-OM"
  },
  "recordCount": 3767238,
  "size": 475898202
}`}</code>
          </pre>
          <p>
            Partition 00 of the non-AO, with Content-Type pack. <code>dataOffsetInRootTx</code>{' '}
            points straight into the root transaction, so reading the index never needs a root
            transaction lookup of its own. A published band's manifest names local files instead,
            each signed in the publication.
          </p>
          <p class="note">
            A lookup in a pack reads a few hundred bytes. In a published band, every read fetches
            and checks the whole 256 KiB piece around it, plus the band's manifest once, so a hit
            costs a few megabytes and proves every byte.
          </p>
        </div>
      </div>
    </section>
  );
}

function OnGateways() {
  const { store } = useApp();
  const pub = store.pub.value.doc?.doc.publisher ?? '<publisher wallet>';
  return (
    <section class="band-section dark" aria-labelledby="h-gw">
      <div class="split">
        <div>
          <p class="eyebrow">On ar.io gateways</p>
          <h2 id="h-gw">Gateways already read them</h2>
          <p class="body">
            Since Release 70, ar.io gateways list the three packs as default sources and read them
            from Arweave as needed. To answer lookups from local disk instead, download the
            partitions, which take 516.7 GB, and point the sources at the local copies. Setting{' '}
            <code>CDB64_ROOT_TX_INDEX_SOURCES</code> replaces the defaults, so list all three.{' '}
            <code>cdb</code> must stay in <code>ROOT_TX_LOOKUP_ORDER</code>, which it is by default.
          </p>
          <p class="body">
            Since Release 84, a gateway also subscribes to a publisher's bands through index
            sharing, and installs only what verifies against the signed publication.
          </p>
          <div class="pills">
            <a class="pill" href="https://docs.ar.io/build/run-a-gateway/manage/cdb64">
              Read docs
            </a>
            <a class="pill" href="https://docs.ar.io/build/run-a-gateway">
              Run a gateway
            </a>
          </div>
        </div>
        <div>
          <figure class="term">
            <figcaption>
              Download the AO pack, from an <code>ar-io-node</code> checkout
            </figcaption>
            <pre>
              <code>{`./tools/download-cdb64 --verify \\
  --source resources/cdb64-root-tx-index-ao-to-height-1820000/manifest.json \\
  --output data/cdb64/ao`}</code>
            </pre>
          </figure>
          <figure class="term">
            <figcaption>
              Repeat for the two non-AO manifests, into <code>data/cdb64/with-ct</code> and{' '}
              <code>data/cdb64/without-ct</code>. Then set <code>.env</code>:
            </figcaption>
            <pre>
              <code>
                CDB64_ROOT_TX_INDEX_SOURCES=data/cdb64/ao,data/cdb64/with-ct,data/cdb64/without-ct
              </code>
            </pre>
          </figure>
          <figure class="term">
            <figcaption>Subscribe to this publisher's bands instead, or as well</figcaption>
            <pre>
              <code>{`./tools/index-swarm-setup --subscribe ${pub} --restart`}</code>
            </pre>
          </figure>
        </div>
      </div>
    </section>
  );
}

function Provenance() {
  return (
    <section class="band-section warm" aria-labelledby="h-prov">
      <p class="eyebrow">Provenance</p>
      <h2 id="h-prov">Every pack byte is on Arweave</h2>
      <p class="body">
        The three packs are stored in {PACK_SET.txs.length} Arweave transactions. Open any of them
        on a gateway to check it. The published bands' files, digests and torrents are listed with
        each index, above.
      </p>
      <div class="prov">
        {PACK_SET.packs.map((p) => {
          const txs = [...new Set(p.parts.map(([t]) => PACK_SET.txs[t]!))].sort();
          return (
            <details key={p.id}>
              <summary>
                <b>{p.name}</b>
                <span>{txs.length} transactions</span>
              </summary>
              <p class="src">
                Index name <code>{p.id}</code>
              </p>
              <ul class="txs">
                {txs.map((t) => (
                  <li key={t}>
                    <a href={`https://arweave.net/tx/${t}`}>{t}</a>
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  const { store, session } = useApp();
  const pub = store.pub.value;
  const doc = pub.doc?.doc;
  const indexes = store.indexes.value;
  const rt = indexes.find((i) => i.kind === 'cdb64-root-tx');
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
          <a class="pill" href="https://docs.ar.io/build/run-a-gateway/manage/cdb64">
            Read docs
          </a>
        </div>
        <p class="eyebrow">CDB64 root transaction index</p>
        <h1>
          Which transaction holds <em>this data item?</em>
        </h1>
        <p class="lede">
          Paste a data item id to find the Arweave transaction that contains it. Your browser reads
          the answer straight out of the indexes, a few range requests at a time: the packs stored
          on Arweave, and the bands the gateway publishes and signs. Nothing to install and no
          database.
        </p>
        <Lookup />
        <dl class="stats" id="stats">
          <div class="stat">
            <dd id="s-items">{fmtBig(PACK_RECORDS + (rt?.records ?? 0))}</dd>
            <dt>Data items indexed</dt>
          </div>
          <div class="stat">
            <dd id="s-size">{rt ? `${(516.7 + rt.size / 1e9).toFixed(1)} GB` : '516.7 GB'}</dd>
            <dt>Index size</dt>
          </div>
          <div class="stat">
            <dd id="s-txs">{PACK_SET.txs.length}</dd>
            <dt>Arweave transactions</dt>
          </div>
          <div class="stat">
            <dd id="s-bands">{rt ? num(rt.all.length) : '—'}</dd>
            <dt>Published bands</dt>
          </div>
        </dl>
      </header>
      <WhatIsIndexed />
      <HowStored />
      <OnGateways />
      <section class="band-section" aria-labelledby="h-pub">
        <p class="eyebrow">Every index the gateway publishes</p>
        <h2 id="h-pub">
          One signed document lists them. <em>Verified here.</em>
        </h2>
        <p class="body">
          The gateway signs a publication of its indexes: the root transaction index, the Arweave
          base layer and the data items of one app, as bands of files with their sizes, digests and
          torrents. This page checks the signature against the ar.io registry through another
          gateway, and shows what it holds.
        </p>
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
              "Every byte a lookup reads from a published band, checked against the band's BitTorrent v2 hash tree, whose root the signed publication pins",
          }}
          note={
            doc
              ? `Publisher ${doc.publisher}, publication #${doc.sequence}, issued ${doc.issuedAt.slice(0, 16).replace('T', ' ')}Z, expires ${doc.expiresAt.slice(0, 16).replace('T', ' ')}Z${pub.proof?.expired ? ' (expired: the publisher has gone quiet, not its bands bad)' : ''}. Document SHA-256 ${pub.doc?.sha256}.`
              : null
          }
        />
      </section>
      {indexes.map((ix) => (
        <IndexCard key={ix.name} ix={ix} />
      ))}
      <Provenance />
      <section class="panel" id="data">
        <details class="drawer" id="datadrawer">
          <summary>
            <span class="drawer-title">Publication source</span>
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
                ? 'Range reads are on: a lookup in a published band fetches only the pieces it touches, each checked as it arrives.'
                : `Range reads are off here (${store.rangeOk.value.why}): lookups use the packs on Arweave only, checked against the data.`}
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
      <footer class="site-foot">
        <div class="foot-row">
          <a href="https://ar.io" aria-label="ar.io home" class="logo-link">
            <ArioLogo />
          </a>
          <nav aria-label="Footer">
            <a href="https://docs.ar.io">Docs</a>
            <a href="https://console.ar.io">Console</a>
            <a href="https://github.com/ar-io">GitHub</a>
            <a href="https://x.com/ar_io_network">X</a>
          </nav>
        </div>
        <p class="foot-legal">
          Published for the ar.io network. Nothing here is advice, and the data is whichever gateway
          you point it at.
        </p>
      </footer>
    </div>
  );
}

const fmtBig = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : num(n);

export type { Band };
