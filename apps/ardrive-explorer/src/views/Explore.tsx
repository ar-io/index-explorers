import { ProgressBar } from '@ar-io/explorer-ui';
import { fmtRange, mb, num, timeAt } from '@ar-io/index-client';
import { useState } from 'preact/hooks';

import { APPS } from '../config.js';
import { useApp } from '../context.js';
import { reveal } from './reveal.js';
import { useMedia } from './useMedia.js';
import { ViewArea } from './ViewArea.js';

export function Explore() {
  const { store, session, flows } = useApp();
  const [findText, setFindText] = useState('');
  // The answer, or why there is none, lands below the fold on a laptop: bring
  // it into view at once (a rejection is said at once) and again once shown.
  const find = () => {
    const done = flows.find(findText);
    requestAnimationFrame(() => reveal(store));
    void done.then(() => reveal(store));
  };
  // The full hint is cut mid-word in a phone's box, so a phone gets a short one.
  const narrow = useMedia('(max-width: 480px)');
  const narrowest = useMedia('(max-width: 360px)');
  const pub = store.pub.value;
  const periods = store.periods.value;
  const p = store.currentPeriod();
  const when = p ? fmtRange(timeAt(session.bands, p.lo), timeAt(session.bands, p.hi)) : null;
  const status = store.status.value;
  const view = store.view.value;
  const periodLabel = (id: string, label: string) => {
    const per = periods.find((x) => x.id === id);
    if (!per) return label;
    const whole = session.wholeSize(per.bands);
    if (whole > 100e6) return `${label} · ${mb(whole)}, too big to download`;
    return per.bands.every((b) => session.isRangeable(b))
      ? `${label} · ~${mb(per.size)}`
      : `${label} · ${mb(whole)} to download`;
  };
  const onPeriod = (id: string) => {
    store.periodId.value = id;
    if (!pub.verified) return;
    if (view.kind === 'browse') void flows.browse(true);
  };
  return (
    <section class="panel" id="explore">
      <p class="panel-label">Explore</p>
      <h2 class="panel-title">Look up a drive, a wallet or a file, or browse what's new.</h2>
      <div class="askbar">
        <div class="searchbox">
          <label for="find" class="sr-only">
            Look up a drive id, wallet address, file or folder id, or block height
          </label>
          <input
            id="find"
            placeholder={
              narrowest
                ? 'Id or block'
                : narrow
                  ? 'Id, address or block'
                  : 'Drive id, wallet address, file or folder id, or a block height'
            }
            spellcheck={false}
            autocomplete="off"
            value={findText}
            onInput={(e) => setFindText((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                find();
              }
            }}
          />
          <button id="findgo" type="button" onClick={find}>
            Find
          </button>
        </div>
        <div class="periodbox">
          <label for="scope" class="period-label">
            Period
          </label>
          <select
            id="scope"
            value={store.periodId.value}
            onChange={(e) => onPeriod((e.target as HTMLSelectElement).value)}
          >
            {periods.length ? (
              periods.map((per) => (
                <option key={per.id} value={per.id} disabled={session.periodDisabled(per)}>
                  {periodLabel(per.id, per.label)}
                </option>
              ))
            ) : (
              <option value="month">Reading…</option>
            )}
          </select>
          <span class="period-dates" id="scopedates">
            {p ? when || `Blocks ${num(p.lo)} to ${num(p.hi)}` : ' '}
          </span>
        </div>
      </div>
      <div class="filters" id="filters">
        <button
          type="button"
          class="secondary chipbtn"
          id="browse"
          aria-pressed={view.kind === 'browse' ? 'true' : 'false'}
          onClick={() => void flows.browse(true)}
        >
          Newest drives
        </button>
        <select
          id="privacy"
          aria-label="Privacy"
          value={store.privacy.value}
          onChange={(e) => {
            store.privacy.value = (e.target as HTMLSelectElement).value as
              | 'any'
              | 'public'
              | 'private';
            if (view.kind === 'browse') void flows.browse(true);
          }}
        >
          <option value="any">Public and private</option>
          <option value="public">Public only</option>
          <option value="private">Private only</option>
        </select>
        <select
          id="app"
          aria-label="App"
          value={store.app.value}
          onChange={(e) => {
            store.app.value = (e.target as HTMLSelectElement).value;
            if (view.kind === 'browse') void flows.browse(true);
          }}
        >
          <option value="any">Any app</option>
          {APPS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          id="contents"
          aria-label="Contents"
          title="An empty drive holds nothing but its root folder: 2 records in the index's tag lookup."
          value={store.hideEmpty.value ? 'some' : 'any'}
          disabled={!pub.hasLookups}
          onChange={(e) => {
            store.hideEmpty.value = (e.target as HTMLSelectElement).value === 'some';
            if (view.kind === 'browse') void flows.browse(true);
          }}
        >
          <option value="some">With contents</option>
          <option value="any">Empty ones too</option>
        </select>
        <span class="note" id="asknote" style="margin:0">
          {!pub.verified
            ? pub.status === 'bad'
              ? 'Nothing can load: the publication did not verify.'
              : 'Checking the publication first…'
            : store.rangeOk.value.ok
              ? 'Each listing reads only what it needs; pieces already checked are reused.' +
                (store.extFallback.value
                  ? ' (Parquet reader from duckdb.org, signature checked.)'
                  : '')
              : `Downloads ${p ? mb(session.wholeSize(p.bands)) : ''} once, checked against the signed digests.`}
        </span>
      </div>
      <div id="status" aria-live="polite">
        {status.text ? <span class={status.cls}>{status.text}</span> : null}
      </div>
      <ProgressBar state={store.progress.value} onStop={() => void session.stop()} />
      <ViewArea />
    </section>
  );
}
