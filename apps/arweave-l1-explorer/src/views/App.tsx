import { ProgressBar, Proof, ArioLogo } from '@ar-io/explorer-ui';
import { cellNum, fmtRange, isId43, mb, num } from '@ar-io/index-client';
import { createContext } from 'preact';
import { useContext, useState } from 'preact/hooks';

import { CONFIG } from '../config.js';
import { PRESETS, presetSql, QUESTIONS } from '../questions.js';
import type { Session, Store, Window } from '../session.js';
import { saveFile, toCsv, toJson } from '../util/export.js';
import { revealAround } from './reveal.js';

export const AppContext = createContext<{ store: Store; session: Session } | null>(null);
const useApp = () => {
  const v = useContext(AppContext);
  if (!v) throw new Error('no context');
  return v;
};

function Results() {
  const { store, session } = useApp();
  const r = store.result.value;
  const win = session.currentWindow();
  const copyLink = async () => {
    const url = session.shareUrl();
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      store.say(
        'Link copied. The gateway, scope and SQL ride in the fragment, so none of it is sent to a server.',
        'ok',
      );
    } catch {
      store.say(
        'The browser would not give clipboard access, so the link is in the address bar instead.',
        'bad',
      );
    }
  };
  const more = win
    ? store.windows.value
        .filter((w) => w.key !== win.key && !session.disabled(w))
        .filter((w) => {
          const span = (x: Window): [number, number] => [
            Math.max(x.from ?? -Infinity, x.bands[0]!.fromTime ?? -Infinity),
            Math.min(
              x.to != null ? x.to - 1 : Infinity,
              x.bands[x.bands.length - 1]!.toTime ?? Infinity,
            ),
          ];
          const [ca, cz] = span(win);
          const [a, z] = span(w);
          return a <= ca && z >= cz && (a < ca || z > cz);
        })
        .sort((x, y) => x.size - y.size)
        .slice(0, 2)
    : [];
  const rows = r ? r.rows.slice(0, 200) : [];
  const numCols = new Set<string>();
  const cell = (c: string, v: unknown): { text: string; num: boolean } => {
    if (v === null || v === undefined) return { text: '', num: false };
    if (r!.isTime.has(c)) {
      const d = new Date(Number(v));
      return {
        text: Number.isFinite(d.getTime())
          ? d.toISOString().replace('T', ' ').replace('.000Z', 'Z')
          : '',
        num: false,
      };
    }
    const text = String(v);
    const wide = typeof v === 'object' && /^-?\d+(\.\d+)?$/.test(text);
    const isNum = typeof v === 'bigint' || typeof v === 'number' || wide;
    if (isNum) numCols.add(c);
    return { text: isNum ? cellNum(c, wide ? text : (v as number)) : text, num: isNum };
  };
  const body = rows.map((row, i) => (
    <tr key={i}>
      {r!.cols.map((c) => {
        const x = cell(c, row[c]);
        return (
          <td key={c} class={x.num ? 'num' : undefined}>
            {x.text}
          </td>
        );
      })}
    </tr>
  ));
  const when = session.windowDates(win);
  const [lo, hi] = win ? session.windowHeights(win) : [0, 0];
  return (
    <article class="answer" id="answer" aria-live="polite">
      <h3 class="answer-title" id="answertitle">
        {store.answerLabel.value}
      </h3>
      <p class="caption" id="caption" hidden={!r?.caption}>
        {r?.caption}
      </p>
      <p class="widen" id="widen" hidden={!r || !win || r.windowKey !== win.key}>
        {win ? (
          <>
            <span>
              Over <strong>{when || win.label}</strong> · blocks {num(lo)} to {num(hi)}
            </span>
            {more.length ? <span class="widen-more">Ask over more:</span> : null}
            {more.map((w) => (
              <button
                key={w.id}
                type="button"
                class="secondary"
                disabled={store.working.value}
                onClick={() => {
                  store.scope.value = w.id;
                  void session.runQuery({
                    label: store.answerLabel.value,
                    caption: r?.captionTemplate ?? null,
                    wallet: r?.wallet ?? null,
                  });
                }}
              >
                {w.label}
                <small>
                  {w.bands.every((b) => session.isRangeable(b))
                    ? mb(w.size)
                    : session.toDownload(w)
                      ? `+${mb(session.toDownload(w))}`
                      : 'loaded'}
                </small>
              </button>
            ))}
          </>
        ) : null}
      </p>
      <SqlDrawer />
      <div class="tablewrap">
        <table id="results" hidden={!r || !rows.length}>
          {r ? (
            <>
              <thead>
                <tr>
                  {r.cols.map((c) => (
                    <th key={c} scope="col" class={numCols.has(c) ? 'num' : undefined}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{body}</tbody>
            </>
          ) : null}
        </table>
      </div>
      <ProgressBar state={store.progress.value} onStop={() => void session.stop()} />
      <div id="status">
        {store.status.value.text ? (
          <span class={store.status.value.cls}>{store.status.value.text}</span>
        ) : null}
        {store.status.value.detail ? (
          <pre class="statusdetail">{store.status.value.detail}</pre>
        ) : null}
      </div>
      <div class="row result-actions" id="resultactions" hidden={!r && !store.queried.value}>
        <button id="copylink" class="secondary" type="button" onClick={() => void copyLink()}>
          Copy link
        </button>
        {/* Exports of an answer with rows only: a failed or empty one has nothing to save. */}
        {r && r.rows.length ? (
          <>
            <button
              id="csv"
              class="secondary"
              type="button"
              onClick={() =>
                r &&
                (saveFile(
                  `arweave-l1-${r.lo}-${r.hi}.csv`,
                  'text/csv;charset=utf-8',
                  toCsv(r.cols, r.rows, r.isTime),
                ),
                store.say(`Saved ${num(r.rows.length)} rows as CSV.`, 'ok'))
              }
            >
              CSV
            </button>
            <button
              id="json"
              class="secondary"
              type="button"
              onClick={() =>
                r &&
                (saveFile(
                  `arweave-l1-${r.lo}-${r.hi}.json`,
                  'application/json',
                  toJson(r.cols, r.rows, r.isTime),
                ),
                store.say(`Saved ${num(r.rows.length)} rows as JSON.`, 'ok'))
              }
            >
              JSON
            </button>
          </>
        ) : null}
        {r?.wallet && isId43(r.wallet) ? (
          <a
            class="action-link"
            id="portallink"
            href={`${CONFIG.portalUrl}/#/balances/${r.wallet}`}
            target="_blank"
            rel="noopener"
          >
            Its ARIO balance and stake ›
          </a>
        ) : null}
      </div>
      {store.switchTo.value ? (
        <p class="widen">
          <span>Another gateway publishes the same files, signed by its own key.</span>
          <button
            type="button"
            class="secondary"
            onClick={() => {
              store.gatewayChoice.value = store.switchTo.value!;
              store.switchTo.value = null;
              void session.readPublication();
            }}
          >
            Read from {store.switchTo.value.replace(/^https?:\/\//, '')} instead
          </button>
        </p>
      ) : null}
    </article>
  );
}

function SqlDrawer() {
  const { store, session } = useApp();
  const sql = store.sql.value;
  const fill = (i: number) => presetSql(i, store.sampleWallet.value);
  return (
    <details
      class="sqlcell"
      id="editor"
      open={store.editorOpen.value}
      onToggle={(e) => (store.editorOpen.value = (e.target as HTMLDetailsElement).open)}
    >
      <summary>
        <span class="sqlcell-title">
          <span class="when-closed">Show the SQL</span>
          <span class="when-open">Hide the SQL</span>
        </span>
        <span class="sqlcell-sub">edit it, or write your own</span>
      </summary>
      <div class="sqlcell-body">
        <p class="note presets-note">Start from an example:</p>
        <div class="presets" id="presets">
          {PRESETS.map(([label], i) => (
            <button
              key={label}
              type="button"
              class="secondary"
              aria-pressed={fill(i) === sql ? 'true' : 'false'}
              onClick={() => {
                store.sql.value = fill(i);
                const ta = document.getElementById('sql') as HTMLTextAreaElement | null;
                requestAnimationFrame(() => {
                  ta?.focus();
                  ta?.setSelectionRange(0, 0);
                });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <label for="sql" class="note sql-label">
          SQL over <code>txs</code> (one row per transaction), <code>blocks</code> and{' '}
          <code>tags</code>
        </label>
        <textarea
          id="sql"
          spellcheck={false}
          value={sql}
          onInput={(e) => (store.sql.value = (e.target as HTMLTextAreaElement).value)}
        />
        <div class="toolbar">
          <p class="runscope">
            <span id="runscope">
              {(() => {
                const w = session.currentWindow();
                if (!w) return 'No period available';
                const when = session.windowDates(w);
                const [lo, hi] = session.windowHeights(w);
                return `Over ${w.label}${when && w.label !== when ? `, ${when}` : ''} · blocks ${num(lo)} to ${num(hi)}`;
              })()}
            </span>{' '}
            <button
              type="button"
              class="linkbtn"
              id="changeperiod"
              onClick={() => {
                const sel = document.getElementById('scope');
                sel?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                sel?.focus({ preventScroll: true });
              }}
            >
              Change
            </button>
          </p>
          <button
            id="run"
            type="button"
            disabled={!store.pub.value.verified || store.working.value}
            onClick={() => {
              store.asked.value = null;
              void session.runQuery({});
            }}
          >
            Run query
          </button>
        </div>
        <details class="guide">
          <summary>Columns and SQL tips</summary>
          <div class="guide-body">
            <div>
              <h3>
                The <code>txs</code> table
              </h3>
              <table class="schema">
                <tbody>
                  {[
                    ['tx_id', 'Transaction ID, base64url, as you would paste into a gateway URL'],
                    ['height', 'Block height it was mined in'],
                    ['mined_at', 'When that block was mined, a real timestamp you can date_trunc'],
                    ['owner', 'Wallet address that signed it, base64url'],
                    ['target', 'Recipient address for a transfer, empty otherwise'],
                    ['data_size', 'Bytes of data, as an integer'],
                    ['content_type', 'Its Content-Type tag, often NULL'],
                    ['quantity', 'AR transferred, in winston'],
                    ['reward', 'Mining fee paid, in winston'],
                    ['format', '1 or 2, the transaction format'],
                    ['data_root', 'Merkle root of the data, base64url'],
                  ].map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 style="margin-top:16px">
                The <code>blocks</code> table
              </h3>
              <table class="schema">
                <tbody>
                  {[
                    ['height', 'Block height, joins to txs.height'],
                    ['mined_at', 'Timestamp the block was mined'],
                    ['tx_count', 'Transactions in the block'],
                    ['block_size', 'Bytes the block added to the weave'],
                    ['block_id', 'Its independent hash, base64url'],
                  ].map(([k, v]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3>Writing a query</h3>
              <ul class="tips">
                <li>
                  It is ordinary SQL. <code>SELECT</code>, <code>WHERE</code>, <code>GROUP BY</code>
                  , <code>ORDER BY</code>, <code>JOIN</code> and window functions all work.
                </li>
                <li>
                  IDs and addresses are plain text here, so <code>WHERE owner = 'FPjb…'</code> is
                  all a wallet lookup needs. Matching the stored bytes is quicker, since nothing is
                  decoded first: <code>FROM rawtx WHERE owner_address = unb64u('FPjb…')</code>.
                  Either way a wallet over all history reads every band's wallet column, a few
                  hundred MB; a transaction ID found with the search bar reads a few dozen.
                </li>
                <li>
                  Three shortcuts work over any period: <code>SELECT * FROM find_tx('…')</code>,{' '}
                  <code>wallet_totals('…')</code> and <code>tag_counts('App-Name')</code>. Where the
                  bands carry lookup files they read those, about a megabyte a band, instead of a
                  whole column.
                </li>
                <li>
                  Sizes are bytes. Divide to taste:{' '}
                  <code>round(data_size / power(2,20), 2) AS mib</code>.
                </li>
                <li>
                  AR amounts are winston, so divide by <code>1e12</code> for AR.
                </li>
                <li>
                  Questions cover the period chosen at the top, next to the search bar. Pick a wider
                  one to reach further back.
                </li>
                <li>Everything runs locally, so a mistake costs nothing. Try things.</li>
              </ul>
            </div>
          </div>
        </details>
      </div>
    </details>
  );
}

function DataDrawer() {
  const { store, session } = useApp();
  const pub = store.pub.value;
  const win = session.currentWindow();
  const range = store.rangeOk.value;
  const when = session.windowDates(win);
  const [lo, hi] = win ? session.windowHeights(win) : [0, 0];
  const ranged = !!win && win.bands.every((b) => session.isRangeable(b));
  const add = win ? session.toDownload(win) : 0;
  const open = !!win && store.loadedKey.value === win.key;
  const noTorrent = session.bands.filter((b) => !b.torrent).length;
  return (
    <details class="drawer" id="datasrc">
      <summary>
        <span class="drawer-title">Data</span>
        <span class="drawer-sub" id="dataline">
          {win
            ? `${win.label}${when && win.id !== 'latest' && !/^\d{4}$/.test(win.label) ? '' : when ? ', ' + when : ''} · ${pub.publisherName || 'auto'}`
            : 'the newest blocks'}
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
              <option value="auto">Auto: whichever gateway serves this page</option>
              {CONFIG.publishers.map((g) => (
                <option key={g} value={g}>
                  {g.replace(/^https?:\/\//, '')}
                </option>
              ))}
              <option value="custom">Another gateway…</option>
            </select>
          </div>
          <div class="field" id="gwcustomwrap" hidden={store.gatewayChoice.value !== 'custom'}>
            <label for="gw">Its URL</label>
            <input
              id="gw"
              value={store.customGateway.value}
              placeholder="https://your-gateway.example"
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => (store.customGateway.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) =>
                e.key === 'Enter' && (e.preventDefault(), void session.readPublication())
              }
            />
          </div>
          <button
            id="connect"
            class="secondary"
            type="button"
            onClick={() => void session.readPublication()}
          >
            Re-read publication
          </button>
        </div>
        <p class="note" id="gwnote" style="margin-top:10px">
          {pub.gatewayNote}
        </p>
        <dl class="facts" id="facts" hidden={!pub.publisher}>
          <div class="fact wide">
            <dt>Publisher</dt>
            <dd id="f-pub" class="mono">
              {pub.publisher ?? '—'}
            </dd>
            {pub.publisher ? (
              <a
                class="fact-link"
                id="f-portal"
                href={`${CONFIG.portalUrl}/#/gateways/${pub.publisher}`}
                target="_blank"
                rel="noopener"
              >
                Its stake and performance on the Network Portal ›
              </a>
            ) : null}
          </div>
          <div class="fact">
            <dt>Publication</dt>
            <dd id="f-seq">#{pub.sequence ?? '?'}</dd>
          </div>
          <div class="fact">
            <dt>Bands</dt>
            <dd id="f-bands">{session.bands.length}</dd>
          </div>
          <div class="fact">
            <dt>Block heights</dt>
            <dd id="f-range">
              {session.bands.length
                ? `${num(session.bands[0]!.from)} – ${num(session.bands[session.bands.length - 1]!.to ?? 0)}`
                : '—'}
            </dd>
          </div>
        </dl>
        <p class="note" id="trustnote">
          Nothing loads until this publication passes the checks under <em>How it's verified</em>,
          at the top of the page.
        </p>
        <div class="row loadrow">
          <p class="note" id="loadnote">
            Questions open the period themselves. Load it ahead of time here, or after switching
            gateway.
          </p>
          <button
            id="load"
            type="button"
            disabled={
              !win ||
              session.disabled(win) ||
              (ranged ? open : add === 0) ||
              !pub.verified ||
              store.working.value
            }
            onClick={() => void session.openPeriod()}
          >
            {ranged ? (open ? 'Ready' : 'Open period') : add === 0 ? 'Loaded' : 'Load ' + mb(add)}
          </button>
        </div>
        <p class="note" id="scopenote">
          {!win
            ? 'No bands available.'
            : session.disabled(win)
              ? `${win.label} is ${mb(session.wholeSize(win.bands))} to download whole, too much for a tab. ` +
                (range.ok
                  ? 'Some of its bands have no torrent to read them in ranges.'
                  : 'This browser cannot read it in ranges (see below).')
              : (when ? when + '. ' : '') +
                `Blocks ${num(lo)} to ${num(hi)}, ` +
                (ranged
                  ? `${mb(win.size)} of data. A question fetches only the parts it needs` +
                    (store.booted.value ? '.' : ', plus the DuckDB engine the first time.')
                  : add === 0
                    ? 'already loaded.'
                    : `${mb(add)} to download` +
                      (store.booted.value ? '.' : ', plus the DuckDB engine the first time.'))}
        </p>
        <p class="note" id="rangenote">
          {!pub.verified
            ? ''
            : range.ok
              ? 'Range reads are on: questions fetch only the parts of each file they touch, and every piece is checked as it arrives.' +
                (noTorrent
                  ? ` ${noTorrent} band${noTorrent === 1 ? ' has' : 's have'} no torrent and ${noTorrent === 1 ? 'is' : 'are'} downloaded whole.`
                  : '')
              : `Range reads are off here (${range.why}), so periods are downloaded whole and hashed, up to ${mb(CONFIG.loadCap)}.`}
        </p>
      </div>
    </details>
  );
}

export function App() {
  const { store, session } = useApp();
  const [findText, setFindText] = useState('');
  const pub = store.pub.value;
  const win = session.currentWindow();
  const when = session.windowDates(win);
  const [lo, hi] = win ? session.windowHeights(win) : [0, 0];
  const home = (pub.publisherUrl ?? pub.gateway ?? 'https://turbo-gateway.com').replace(/\/+$/, '');
  const label = (w: Window) => {
    const add = session.toDownload(w);
    return (
      `${w.label} · ` +
      (session.disabled(w)
        ? `${mb(w.size)}, too big to download`
        : w.bands.every((b) => session.isRangeable(b))
          ? mb(w.size)
          : add === 0
            ? 'loaded'
            : mb(add))
    );
  };
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
            Read docs
          </a>
        </div>
        <p class="eyebrow">ar.io · verifiable indexes</p>
        <h1>
          Query Arweave's base layer. <em>Verify every byte.</em>
        </h1>
        <p class="lede">
          Every transaction on Arweave, searchable with SQL right here. No account, no install, and
          your queries never leave the browser.
        </p>
        <dl class="stats" id="stats">
          <div class="stat">
            <dd id="s-txs">{store.hero.value.txs}</dd>
            <dt>Transactions</dt>
          </div>
          <div class="stat">
            <dd id="s-blocks">{store.hero.value.blocks}</dd>
            <dt>Blocks</dt>
          </div>
          <div class="stat">
            <dd id="s-span">{store.hero.value.span}</dd>
            <dt>Covering</dt>
          </div>
        </dl>
        <Proof
          state={store.proof.value.state}
          text={store.proof.value.text}
          checks={store.proof.value.checks}
          labels={{
            registry:
              "The publisher's signing key, read from the ar.io registry through a different gateway",
            signature: "The publication's signature, checked against that key",
            engine:
              "The query engine, matched against a hash pinned in this page, and its Parquet reader, which the engine accepts only with DuckDB's signature. Checked when you first load data",
            pieces:
              "Every piece of data a question reads, checked as it arrives against the file's BitTorrent v2 hash tree, whose root the signed publication pins. Checked when you first ask",
          }}
          note="A question fetches only the parts of each file it needs, and nothing it reads is used until it matches the hash tree. Where a browser cannot do that, files are downloaded whole and hashed against the digest the signature covers instead. A failure at any step stops the question, and a check that cannot run counts as a failure. This page's own scripts, the range reader included, come in the same Arweave manifest as the page, so they are not hashed separately."
        />
      </header>
      <section class="panel ask" id="ask">
        <p class="panel-label">Ask the chain</p>
        <h2 class="panel-title">
          Search, pick a question, or write SQL. Answers are computed in this tab.
        </h2>
        <div class="askbar">
          <div class="searchbox">
            <label for="find" class="sr-only">
              Look up a wallet, transaction or block
            </label>
            <input
              id="find"
              placeholder="Wallet address, transaction ID, block height, or 2015000-2015100"
              spellcheck={false}
              autocomplete="off"
              value={findText}
              onInput={(e) => setFindText((e.target as HTMLInputElement).value)}
              onKeyDown={(e) =>
                e.key === 'Enter' &&
                !store.working.value &&
                (e.preventDefault(), revealAround(store, session.find(findText)))
              }
            />
            <button
              id="findgo"
              type="button"
              disabled={store.working.value}
              onClick={() => revealAround(store, session.find(findText))}
            >
              Find
            </button>
          </div>
          <div class="periodbox">
            <label for="scope" class="period-label">
              Period
            </label>
            <select
              id="scope"
              value={store.scope.value}
              onChange={(e) => (store.scope.value = (e.target as HTMLSelectElement).value)}
            >
              {store.windows.value.length ? (
                store.windows.value.map((w) => (
                  <option key={w.id} value={w.id} disabled={session.disabled(w)}>
                    {label(w)}
                  </option>
                ))
              ) : (
                <option value="latest">Last few days</option>
              )}
              <option value="pick">One period…</option>
            </select>
            <span class="period-dates" id="scopedates">
              {win ? when || `Blocks ${num(lo)} to ${num(hi)}` : ' '}
            </span>
          </div>
        </div>
        <div class="field pickfield" id="pickwrap" hidden={store.scope.value !== 'pick'}>
          <label for="band">Which period</label>
          <select
            id="band"
            value={store.pickedBand.value ?? ''}
            onChange={(e) => (store.pickedBand.value = (e.target as HTMLSelectElement).value)}
          >
            {[...session.bands].reverse().map((b) => {
              const w = fmtRange(b.fromTime, b.toTime);
              const big = session.wholeSize([b]) > CONFIG.loadCap;
              return (
                <option key={b.id} value={b.id} disabled={big}>
                  {(w ? w + '   ·   ' : '') +
                    `blocks ${num(b.from)} – ${num(b.to ?? b.from)}   (${mb(session.tableSize(b))}${big ? ', too big to download)' : ')'}`}
                </option>
              );
            })}
          </select>
        </div>
        <div class="asks" id="asks">
          {QUESTIONS.map((q, i) => (
            <button
              key={q.title}
              type="button"
              disabled={!pub.verified || store.working.value}
              aria-pressed={store.asked.value === i ? 'true' : 'false'}
              onClick={() => revealAround(store, session.ask(i))}
            >
              <span>{q.title}</span>
              <small>{q.sub}</small>
            </button>
          ))}
        </div>
        <p class="note" id="asknote">
          {!pub.verified
            ? store.proof.value.state === 'bad'
              ? 'Nothing can load: the publication did not verify. See How it’s verified, above.'
              : 'Checking the publication first…'
            : win && store.loadedKey.value === win.key
              ? win.bands.every((b) => session.isRangeable(b))
                ? 'Each question reads only what it needs, and pieces already checked are reused.' +
                  (store.extFallback.value
                    ? ' (Parquet reader from duckdb.org, signature checked.)'
                    : '')
                : `Loaded and checked: ${win.label}${when ? ' (' + when + ')' : ''}. Answers are instant now.`
              : win && win.bands.every((b) => session.isRangeable(b))
                ? `A question reads only the parts of these ${mb(win.size)} it needs` +
                  (store.booted.value ? '' : ', plus the engine once') +
                  ', checking every piece as it arrives.'
                : win
                  ? `First answer: ${mb(session.toDownload(win))} of data` +
                    (store.booted.value ? '' : ' plus the engine, once') +
                    '. Every file is checked before use.'
                  : ''}
        </p>
        <Results />
        <DataDrawer />
      </section>
      <footer>
        <div class="foot-grid">
          <div>
            <h4>Learn</h4>
            <ul>
              <li>
                <a href="https://docs.ar.io/build/advanced/index-publications">
                  Reading shared indexes
                </a>
              </li>
              <li>
                <a href="https://docs.ar.io/build/run-a-gateway/manage/index-sharing">
                  Index sharing
                </a>
              </li>
              <li>
                <a href="https://docs.ar.io/build/run-a-gateway">Run a gateway</a>
              </li>
            </ul>
          </div>
          <div>
            <h4>On ar.io</h4>
            <ul class="foot-apps">
              <li>
                <a href="https://gateways.ar.io/" target="_blank" rel="noopener">
                  Network Portal
                </a>
                <span>Explore gateways, delegate stake and check token balances.</span>
              </li>
              <li>
                <a href="https://console.ar.io/" target="_blank" rel="noopener">
                  Console
                </a>
                <span>Upload data to Arweave, and buy and manage ArNS names.</span>
              </li>
              <li>
                <a href="https://cdb64.ar.io" target="_blank" rel="noopener">
                  Network index
                </a>
                <span>Every index the gateway publishes, verified, with a root lookup.</span>
              </li>
            </ul>
          </div>
          <div>
            <h4>This page</h4>
            <ul>
              <li>
                <a id="foot-pub" href={`${home}/ar-io/indexes`}>
                  The signed publication it reads
                </a>
              </li>
              <li>
                <a href="https://duck-db-wasm.ar.io/">DuckDB-WASM 1.30.0, from Arweave</a>
              </li>
              <li>
                <a href="https://ar.io">ar.io</a>
              </li>
            </ul>
          </div>
          <div class="foot-cli">
            <h4>Without a browser</h4>
            <p>
              DuckDB on the command line reads the same files in byte ranges, for scripts and
              anything too big for a tab.
            </p>
            <pre>
              <code>{`duckdb -c "INSTALL httpfs; LOAD httpfs;\n  SELECT count(*) FROM read_parquet('${home}/ar-io/indexes/parquet-l1/<band>/transactions.parquet')"`}</code>
            </pre>
            <p class="foot-note">
              Full recipe in{' '}
              <a href="https://docs.ar.io/build/advanced/index-publications#query-a-parquet-dataset">
                the docs
              </a>
              .
            </p>
          </div>
        </div>
        <p class="foot-legal">
          An ar.io demonstration of verifiable indexes. Nothing here is advice, and the data is
          whichever gateway you point it at.
        </p>
      </footer>
    </div>
  );
}
