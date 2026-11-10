import { Icon, Select } from '@ar-io/explorer-ui';
import { fmtRange, mb, num, timeAt } from '@ar-io/index-client';

import { CONFIG } from '../config.js';
import { useApp } from '../context.js';
import { PRESETS, presetSql, QUESTIONS } from '../data/questions.js';
import { revealAround } from './reveal.js';
import { PeriodPicker } from './Controls.js';

export function Questions({ compact = false }: { compact?: boolean }) {
  const { store, flows } = useApp();
  const enabled = store.asksEnabled.value;
  const asked = store.view.value.kind === 'query' ? store.asked.value : null;
  return (
    <div class={`asks${compact ? ' compact' : ''}`} id="asks">
      {QUESTIONS.map((q, i) => (
        <button
          key={q.title}
          type="button"
          disabled={!enabled}
          aria-pressed={asked === i ? 'true' : 'false'}
          onClick={() => {
            revealAround(store, flows.ask(i));
          }}
        >
          <span>{q.title}</span>
          <small>{q.sub}</small>
        </button>
      ))}
    </div>
  );
}

/** Ctrl+Enter, or Command+Enter on a Mac: as most SQL editors run a query. */
const RUN_KEYS =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '\u2318\u21b5'
    : 'Ctrl \u21b5';

export function SqlEditor() {
  const { store, session, flows } = useApp();
  const sql = store.sql.value;
  const p = store.currentPeriod();
  const when = p ? fmtRange(timeAt(session.bands, p.lo), timeAt(session.bands, p.hi)) : null;
  const fill = (i: number) =>
    presetSql(PRESETS[i]!, store.sampleWallet.value, store.sampleDrive.value);
  const run = () => {
    store.asked.value = null;
    const label = PRESETS.findIndex((_, i) => fill(i) === store.sql.value);
    // A long query pushes the answer below the fold: bring the work, then the answer, into view.
    revealAround(
      store,
      flows.runQuery({
        title: label >= 0 ? PRESETS[label]!.label : 'Your query',
        labels: label >= 0,
      }),
    );
  };
  return (
    <section class="sqlcell" id="editor" aria-label="SQL editor">
      <p class="field-label">Start from an example</p>
      <div class="presets" id="presets">
        {PRESETS.map((pr, i) => (
          <button
            key={pr.label}
            type="button"
            class="secondary"
            aria-pressed={fill(i) === sql ? 'true' : 'false'}
            onClick={() => {
              store.sql.value = fill(i);
              store.asked.value = null;
              const ta = document.getElementById('sql') as HTMLTextAreaElement | null;
              if (ta) {
                ta.focus();
                ta.setSelectionRange(0, 0);
                ta.scrollTop = 0;
              }
            }}
          >
            {pr.label}
          </button>
        ))}
      </div>
      <div class="field">
        <label for="sql" class="field-label">
          SQL over <code>drives</code>, <code>folders</code>, <code>files</code>,{' '}
          <code>entities</code>, <code>uploads</code> and <code>tags</code>
        </label>
        <p class="field-help" id="sqlnote">
          <code>created_at</code> is the Unix-Time tag the app stamped. File data from ArDrive-CLI
          and ArDrive-Core carries none, so it has no date; the file’s record does.
        </p>
        <textarea
          id="sql"
          aria-describedby="sqlnote"
          spellcheck={false}
          value={sql}
          onInput={(e) => (store.sql.value = (e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && store.asksEnabled.value) {
              e.preventDefault();
              run();
            }
          }}
        />
      </div>
      <div class="toolbar">
        <div class="runscope">
          <PeriodPicker />
          <span class="sr-only" id="runscope">
            {p
              ? `Over ${p.label}${when ? `, ${when}` : ''} · blocks ${num(p.lo)} to ${num(p.hi)}`
              : ''}
          </span>
        </div>
        <div class="runbox">
          <kbd class="keys" aria-hidden="true">
            {RUN_KEYS}
          </kbd>
          <button
            id="run"
            type="button"
            class="primary"
            aria-keyshortcuts="Control+Enter Meta+Enter"
            disabled={!store.asksEnabled.value}
            onClick={run}
          >
            Run query
          </button>
        </div>
      </div>
      <details class="guide">
        <summary>
          <Icon name="chevron" />
          Tables, columns and SQL tips
        </summary>
        <div class="guide-body">
          <div>
            <h3>What a row is</h3>
            <table class="schema">
              <tbody>
                <tr>
                  <td>drives</td>
                  <td>
                    One row per drive: its newest record. <code>drive_id</code>,{' '}
                    <code>name_id</code> (the record to fetch the name from), <code>owner</code>,{' '}
                    <code>privacy</code>, <code>created_at</code>, <code>app</code>,{' '}
                    <code>app_version</code>, <code>arfs</code>, <code>versions</code>
                  </td>
                </tr>
                <tr>
                  <td>folders</td>
                  <td>
                    One row per folder: <code>folder_id</code>, <code>drive_id</code>,{' '}
                    <code>parent_folder_id</code>, <code>owner</code>, <code>created_at</code>,{' '}
                    <code>versions</code>
                  </td>
                </tr>
                <tr>
                  <td>files</td>
                  <td>
                    One row per file: <code>file_id</code>, <code>drive_id</code>,{' '}
                    <code>parent_folder_id</code>, <code>owner</code>, <code>created_at</code>,{' '}
                    <code>versions</code>, <code>is_hidden</code>. Its size and name are in its
                    metadata record (<code>name_id</code>), not the index
                  </td>
                </tr>
                <tr>
                  <td>entities</td>
                  <td>
                    Every ArFS record, every version: <code>id</code>, <code>height</code>,{' '}
                    <code>created_at</code>, <code>kind</code> (drive, folder, file, snapshot),{' '}
                    <code>drive_id</code>, <code>entity_id</code>, <code>parent_folder_id</code>,{' '}
                    <code>privacy</code>, <code>cipher</code>, <code>arfs</code>, <code>app</code>,{' '}
                    <code>app_version</code>, <code>owner</code>, <code>record_size</code>
                  </td>
                </tr>
                <tr>
                  <td>uploads</td>
                  <td>
                    Every upload ArDrive made in the period, records and file data alike:{' '}
                    <code>id</code>, <code>height</code>, <code>created_at</code>,{' '}
                    <code>owner</code>, <code>data_size</code>, <code>content_type</code>,{' '}
                    <code>bundle</code>, <code>app</code>, <code>app_version</code>
                  </td>
                </tr>
                <tr>
                  <td>tags</td>
                  <td>
                    Every tag on every upload: <code>id</code>, <code>height</code>,{' '}
                    <code>name</code>, <code>value</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <h3>Helpers</h3>
            <table class="schema">
              <tbody>
                <tr>
                  <td>drive('…')</td>
                  <td>
                    Every record of one drive, by its Drive-Id, whatever the period. Reads the
                    drive's whole span of blocks across every band: use Find above for the cheap
                    path
                  </td>
                </tr>
                <tr>
                  <td>wallet_totals('…')</td>
                  <td>Uploads, bytes, first and last block for a wallet, from the lookups</td>
                </tr>
                <tr>
                  <td>find_id('…')</td>
                  <td>Any 43-character id: the upload and its tags, through the id lookup</td>
                </tr>
                <tr>
                  <td>tag_counts('Name')</td>
                  <td>Exact counts of every value of a tag over every band, from the lookups</td>
                </tr>
                <tr>
                  <td>b64u(x), unb64u(s)</td>
                  <td>Bytes to the id form gateways use, and back</td>
                </tr>
              </tbody>
            </table>
            <h3 style="margin-top:24px">Tips</h3>
            <ul class="tips">
              <li>
                Every table is already limited to the period; add <code>WHERE height BETWEEN</code>{' '}
                to read even less.
              </li>
              <li>
                <code>created_at</code> is the Unix-Time the app wrote;{' '}
                <code>date_trunc('month', created_at)</code> groups by month.
              </li>
              <li>
                A file's bytes are a separate upload named in its record as <code>dataTxId</code>;
                the record itself is tiny.
              </li>
              <li>A listing shows 200 rows; CSV and JSON carry them all.</li>
              <li>
                Questions over periods larger than {mb(CONFIG.askFirstPeriod)} of index ask first.
              </li>
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}

export function DataSource() {
  const { store, session } = useApp();
  const pub = store.pub.value;
  const p = store.currentPeriod();
  const when = p ? fmtRange(timeAt(session.bands, p.lo), timeAt(session.bands, p.hi)) : null;
  const range = store.rangeOk.value;
  const noTorrent = pub.bands.filter((b) => !b.torrent).length;
  const tipBand = pub.bands[pub.bands.length - 1];
  const home = (pub.publisherUrl ?? pub.gateway ?? 'https://turbo-gateway.com').replace(/\/+$/, '');
  return (
    <div class="source" id="source">
      <section class="card">
        <h2 class="card-title" id="gw-title">
          Gateway
        </h2>
        <div class="row">
          <div class="field">
            <Select
              id="gwsel"
              label="Gateway"
              value={store.gatewayChoice.value}
              choices={[
                { value: 'auto', label: 'Auto' },
                ...CONFIG.publishers.map((g) => ({
                  value: g,
                  label: g.replace(/^https?:\/\//, ''),
                })),
                { value: 'custom', label: 'Other…' },
              ]}
              onChange={(v) => {
                store.gatewayChoice.value = v;
                if (v !== 'custom') void session.readPublication();
              }}
            />
          </div>
          <div class="field" id="gwcustomwrap" hidden={store.gatewayChoice.value !== 'custom'}>
            <label for="gw">Gateway URL</label>
            <input
              id="gw"
              placeholder="https://my-gateway.example"
              value={store.customGateway.value}
              onInput={(e) => (store.customGateway.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void session.readPublication();
                }
              }}
            />
          </div>
          <button
            id="connect"
            type="button"
            disabled={pub.status === 'reading'}
            onClick={() => void session.readPublication()}
          >
            Read publication
          </button>
        </div>
        <p class="note" id="gwnote">
          {pub.gatewayNote}
        </p>
      </section>
      <section class="card" hidden={!pub.publisher}>
        <h2 class="card-title">Publication</h2>
        <dl class="facts" id="facts">
          <div class="fact wide">
            <dt>Publisher</dt>
            <dd>
              <span class="mono" id="f-pub">
                {pub.publisher ?? '(none)'}
              </span>
              {pub.publisher && /^[A-Za-z0-9_-]{43,44}$/.test(pub.publisher) ? (
                <a
                  class="fact-link"
                  id="f-portal"
                  href={`${CONFIG.portalUrl}/#/gateways/${pub.publisher}`}
                  target="_blank"
                  rel="noopener"
                >
                  On the Network Portal
                  <Icon name="external" />
                </a>
              ) : null}
            </dd>
          </div>
          <div class="fact">
            <dt>Publication</dt>
            <dd id="f-seq">#{pub.sequence ?? '?'}</dd>
          </div>
          <div class="fact">
            <dt>Bands</dt>
            <dd id="f-bands">{pub.bands.length}</dd>
          </div>
          <div class="fact">
            <dt>Blocks</dt>
            <dd id="f-range">
              {pub.bands.length ? `${num(pub.bands[0]!.from)} to ${num(pub.tip)}` : ''}
            </dd>
          </div>
        </dl>
        <p class="note" id="rangenote">
          {!pub.verified
            ? ''
            : range.ok
              ? 'Range reads are on: a listing fetches only the parts of each file it touches, checks every piece as it arrives, and reuses pieces it already checked.' +
                (noTorrent
                  ? ` ${noTorrent} band${noTorrent === 1 ? ' has' : 's have'} no torrent and ${noTorrent === 1 ? 'is' : 'are'} downloaded whole.`
                  : '') +
                (store.extFallback.value
                  ? ' The Parquet reader came from duckdb.org, its signature checked.'
                  : '')
              : `Range reads are off here (${range.why}), so periods are downloaded whole and hashed, up to ${mb(CONFIG.loadCap)}.`}
        </p>
        <p class="note" id="scopenote">
          {p
            ? session.periodDisabled(p)
              ? `${p.label} is ${mb(session.wholeSize(p.bands))} to download whole, too much for a tab. ` +
                (range.ok
                  ? 'Some of its bands have no torrent to read them in ranges.'
                  : 'This browser cannot read in ranges (see above).')
              : `${p.label}: ` +
                (when ? when + ', ' : '') +
                `blocks ${num(p.lo)} to ${num(p.hi)}, about ${mb(p.size)} of index` +
                (p.bands.every((b) => session.isRangeable(b))
                  ? ', read only as far as a question needs.'
                  : ' to download.')
            : ''}
        </p>
      </section>
      <section class="card">
        <h2 class="card-title">On the command line</h2>
        <p class="note">The bands are plain Parquet. With DuckDB installed:</p>
        {/* It scrolls sideways, so a keyboard can reach it too. */}
        <pre class="cli" tabIndex={0} aria-label="The DuckDB command">
          <code id="cli">{`duckdb -c "SELECT count(*) FROM read_parquet('${tipBand?.files.get('data_items.parquet')?.url ?? `${home}/ar-io/indexes/ardrive-l2/<band>/data_items.parquet`}')"`}</code>
        </pre>
        <p class="note">
          Verify first: <code>ar-io-node index-l2-verify --bands-dir …</code> checks every band
          against its signed digests and a sample against the chain.
        </p>
      </section>
      <section class="card">
        <h2 class="card-title">About this page</h2>
        <ul class="links">
          <li>
            <a id="foot-pub" href={`${home}/ar-io/indexes`} target="_blank" rel="noopener">
              {pub.publisherName
                ? `${pub.publisherName}'s signed publication`
                : 'The signed publication'}
              <Icon name="external" />
            </a>
          </li>
          <li>
            <a href="https://docs.ardrive.io/docs/arfs/" target="_blank" rel="noopener">
              The ArFS file system
              <Icon name="external" />
            </a>
          </li>
          <li>
            <a href="https://arweave-l1-search.ar.io" target="_blank" rel="noopener">
              The Arweave L1 explorer
              <Icon name="external" />
            </a>
          </li>
          <li>
            <a href="https://cdb64.ar.io" target="_blank" rel="noopener">
              Every index the gateway publishes
              <Icon name="external" />
            </a>
          </li>
        </ul>
        <p class="note">
          Built on the ar.io network's verifiable indexes. ArDrive is a product of Permanent Data
          Solutions. This page holds no accounts and sets no cookies; what it remembers (checked
          pieces of the index) stays in your browser.
        </p>
      </section>
    </div>
  );
}
