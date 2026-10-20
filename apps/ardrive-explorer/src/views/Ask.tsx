import { fmtRange, mb, num, timeAt } from '@ar-io/index-client';

import { CONFIG } from '../config.js';
import { useApp } from '../context.js';
import { PRESETS, presetSql, QUESTIONS } from '../data/questions.js';

export function Questions() {
  const { store, flows } = useApp();
  const enabled = store.asksEnabled.value;
  const asked = store.asked.value;
  return (
    <div class="asks" id="asks">
      {QUESTIONS.map((q, i) => (
        <button
          key={q.title}
          type="button"
          disabled={!enabled}
          aria-pressed={asked === i ? 'true' : 'false'}
          onClick={() => {
            void flows.ask(i).then(() => document.getElementById('view')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
          }}
        >
          <span>{q.title}</span>
          <small>{q.sub}</small>
        </button>
      ))}
    </div>
  );
}

export function SqlDrawer() {
  const { store, session, flows } = useApp();
  const sql = store.sql.value;
  const p = store.currentPeriod();
  const when = p ? fmtRange(timeAt(session.bands, p.lo), timeAt(session.bands, p.hi)) : null;
  const fill = (i: number) => presetSql(PRESETS[i]!, store.sampleWallet.value, store.sampleDrive.value);
  return (
    <details class="sqlcell" id="editor" open={store.editorOpen.value} onToggle={(e) => (store.editorOpen.value = (e.target as HTMLDetailsElement).open)}>
      <summary>
        <span class="sqlcell-title">
          <span class="when-closed">Show the SQL</span>
          <span class="when-open">Hide the SQL</span>
        </span>
        <span class="sqlcell-sub">edit it, or write your own</span>
      </summary>
      <div class="sqlcell-body">
        <p class="note" style="margin:8px 0 0">
          Start from an example:
        </p>
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
        <label for="sql" class="note" style="display:block;margin:4px 0 6px">
          SQL over <code>drives</code>, <code>folders</code>, <code>files</code>, <code>entities</code>, <code>uploads</code> and <code>tags</code>
        </label>
        <textarea id="sql" spellcheck={false} value={sql} onInput={(e) => (store.sql.value = (e.target as HTMLTextAreaElement).value)} />
        <div class="toolbar">
          <p class="runscope">
            <span id="runscope">{p ? `Over ${p.label}${when ? `, ${when}` : ''} · blocks ${num(p.lo)} to ${num(p.hi)}` : 'Over the period chosen at the top'}</span>{' '}
            <button
              type="button"
              class="linkbtn"
              id="changeperiod"
              onClick={() => {
                const el = document.getElementById('scope');
                el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el?.focus();
              }}
            >
              Change
            </button>
          </p>
          <button
            id="run"
            type="button"
            disabled={!store.asksEnabled.value}
            onClick={() => {
              store.asked.value = null;
              const label = PRESETS.findIndex((_, i) => fill(i) === sql);
              void flows.runQuery({ title: label >= 0 ? PRESETS[label]!.label : 'Your query' });
            }}
          >
            Run query
          </button>
        </div>
        <details class="guide">
          <summary>Tables, columns and SQL tips</summary>
          <div class="guide-body">
            <div>
              <h3>What a row is</h3>
              <table class="schema">
                <tbody>
                  <tr>
                    <td>drives</td>
                    <td>
                      One row per drive: its newest record. <code>drive_id</code>, <code>name_id</code> (the record to fetch the name from), <code>owner</code>,{' '}
                      <code>privacy</code>, <code>created_at</code>, <code>app</code>, <code>app_version</code>, <code>arfs</code>, <code>versions</code>
                    </td>
                  </tr>
                  <tr>
                    <td>folders</td>
                    <td>
                      One row per folder: <code>folder_id</code>, <code>drive_id</code>, <code>parent_folder_id</code>, <code>owner</code>, <code>created_at</code>,{' '}
                      <code>versions</code>
                    </td>
                  </tr>
                  <tr>
                    <td>files</td>
                    <td>
                      One row per file: <code>file_id</code>, <code>drive_id</code>, <code>parent_folder_id</code>, <code>owner</code>, <code>created_at</code>,{' '}
                      <code>versions</code>, <code>is_hidden</code>. Its size and name are in its metadata record (<code>name_id</code>), not the index
                    </td>
                  </tr>
                  <tr>
                    <td>entities</td>
                    <td>
                      Every ArFS record, every version: <code>id</code>, <code>height</code>, <code>created_at</code>, <code>kind</code> (drive, folder, file, snapshot),{' '}
                      <code>drive_id</code>, <code>entity_id</code>, <code>parent_folder_id</code>, <code>privacy</code>, <code>cipher</code>, <code>arfs</code>, <code>app</code>,{' '}
                      <code>app_version</code>, <code>owner</code>, <code>record_size</code>
                    </td>
                  </tr>
                  <tr>
                    <td>uploads</td>
                    <td>
                      Every upload ArDrive made in the period, records and file data alike: <code>id</code>, <code>height</code>, <code>created_at</code>, <code>owner</code>,{' '}
                      <code>data_size</code>, <code>content_type</code>, <code>bundle</code>, <code>app</code>, <code>app_version</code>
                    </td>
                  </tr>
                  <tr>
                    <td>tags</td>
                    <td>
                      Every tag on every upload: <code>id</code>, <code>height</code>, <code>name</code>, <code>value</code>
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
                    <td>Every record of one drive, by its Drive-Id, whatever the period. Reads the drive's whole span of blocks across every band: use Find above for the cheap path</td>
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
              <h3 style="margin-top:14px">Tips</h3>
              <ul class="tips">
                <li>
                  Every table is already limited to the period; add <code>WHERE height BETWEEN</code> to read even less.
                </li>
                <li>
                  <code>created_at</code> is the Unix-Time the app wrote; <code>date_trunc('month', created_at)</code> groups by month.
                </li>
                <li>
                  A file's bytes are a separate upload named in its record as <code>dataTxId</code>; the record itself is tiny.
                </li>
                <li>A listing shows 200 rows; CSV and JSON carry them all.</li>
                <li>Questions over periods larger than {mb(CONFIG.askFirstPeriod)} of index ask first.</li>
              </ul>
            </div>
          </div>
        </details>
      </div>
    </details>
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
  return (
    <details class="drawer" id="datadrawer">
      <summary>
        <span class="drawer-title">Data source</span>
        <span class="drawer-sub" id="dataline">
          {p ? `${p.label}${when ? ', ' + when : ''} · ${pub.publisherName || 'auto'}` : ' '}
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
              onInput={(e) => (store.customGateway.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void session.readPublication();
                }
              }}
            />
          </div>
          <button id="connect" type="button" class="secondary" disabled={pub.status === 'reading'} onClick={() => void session.readPublication()}>
            Read publication
          </button>
        </div>
        <p class="note" id="gwnote">
          {pub.gatewayNote}
        </p>
        <dl class="facts" id="facts" hidden={!pub.publisher}>
          <div class="fact wide">
            <dt>Publisher</dt>
            <dd class="mono" id="f-pub">
              {pub.publisher ?? '(none)'}
            </dd>
            {pub.publisher && /^[A-Za-z0-9_-]{43,44}$/.test(pub.publisher) ? (
              <a class="fact-link" id="f-portal" href={`${CONFIG.portalUrl}/#/gateways/${pub.publisher}`} target="_blank" rel="noopener">
                On the Network Portal
              </a>
            ) : null}
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
            <dd id="f-range">{pub.bands.length ? `${num(pub.bands[0]!.from)} – ${num(pub.tip)}` : ''}</dd>
          </div>
        </dl>
        <p class="note" id="rangenote">
          {!pub.verified
            ? ''
            : range.ok
              ? 'Range reads are on: a listing fetches only the parts of each file it touches, and every piece is checked as it arrives.' +
                (noTorrent ? ` ${noTorrent} band${noTorrent === 1 ? ' has' : 's have'} no torrent and ${noTorrent === 1 ? 'is' : 'are'} downloaded whole.` : '')
              : `Range reads are off here (${range.why}), so periods are downloaded whole and hashed, up to ${mb(CONFIG.loadCap)}.`}
        </p>
        <p class="note" id="scopenote">
          {p
            ? session.periodDisabled(p)
              ? `${p.label} is ${mb(session.wholeSize(p.bands))} to download whole, too much for a tab. ` + (range.ok ? 'Some of its bands have no torrent to read them in ranges.' : 'This browser cannot read in ranges (see above).')
              : (when ? when + '. ' : '') + `Blocks ${num(p.lo)} to ${num(p.hi)}; about ${mb(p.size)} of index` + (p.bands.every((b) => session.isRangeable(b)) ? ', read only as far as a question needs.' : ' to download.')
            : ''}
        </p>
        {tipBand ? (
          <p class="note">
            Do the same on the command line: <code id="cli">{`duckdb -c "SELECT count(*) FROM read_parquet('${tipBand.files.get('data_items.parquet')?.url ?? ''}')"`}</code>
          </p>
        ) : null}
      </div>
    </details>
  );
}
