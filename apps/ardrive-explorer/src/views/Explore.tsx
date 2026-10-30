import { Icon, ProgressBar, Select } from '@ar-io/explorer-ui';
import { fmtRange, mb, num, timeAt } from '@ar-io/index-client';
import { useState } from 'preact/hooks';

import { APPS } from '../config.js';
import { useApp } from '../context.js';
import { revealAround } from './reveal.js';
import { useMedia } from './useMedia.js';
import { ViewArea } from './ViewArea.js';

export function Explore() {
  const { store, session, flows } = useApp();
  const [findText, setFindText] = useState('');
  // The answer, or why there is none, lands below the fold on a laptop: bring
  // the work into view at once (a rejection is said at once) and the answer once shown.
  const find = () => revealAround(store, flows.find(findText));
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
    // After a failed read, picking a period reads the publication again.
    if (!pub.verified) {
      if (pub.status === 'bad') void session.readPublication();
      return;
    }
    if (view.kind === 'browse') void flows.browse(true);
  };
  const filter = (go: () => void) => {
    go();
    if (view.kind === 'browse') void flows.browse(true);
  };
  return (
    <section class="panel" id="explore">
      <h2 class="panel-title">Look up a drive, a wallet or a file, or browse what's new.</h2>
      <div class="askbar">
        <div class="field">
          <label for="find" class="field-label">
            Find
          </label>
          <div class="searchbox">
            <Icon name="search" />
            <input
              id="find"
              type="search"
              aria-describedby="findhint"
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
            <button id="findgo" type="button" class="primary compact" onClick={find}>
              Find
            </button>
          </div>
          <span class="sr-only" id="findhint">
            A drive id, wallet address, file or folder id, or a block height
          </span>
        </div>
        <div class="field">
          <span class="field-label" id="scope-label">
            Period
          </span>
          <Select
            id="scope"
            label="Period"
            value={store.periodId.value}
            choices={
              periods.length
                ? periods.map((per) => ({
                    value: per.id,
                    label: periodLabel(per.id, per.label),
                    disabled: session.periodDisabled(per),
                  }))
                : [{ value: store.periodId.value, label: 'Reading…' }]
            }
            onChange={onPeriod}
          />
          <span class="field-help" id="scopedates">
            {p ? when || `Blocks ${num(p.lo)} to ${num(p.hi)}` : '\u00a0'}
          </span>
        </div>
      </div>
      <div class="filters" id="filters">
        <button
          type="button"
          class="secondary"
          id="browse"
          aria-pressed={view.kind === 'browse' ? 'true' : 'false'}
          onClick={() => void flows.browse(true)}
        >
          Newest drives
        </button>
        <Select
          id="privacy"
          label="Privacy"
          variant="button"
          value={store.privacy.value}
          choices={[
            { value: 'any', label: 'Public and private' },
            { value: 'public', label: 'Public only' },
            { value: 'private', label: 'Private only' },
          ]}
          onChange={(v) => filter(() => (store.privacy.value = v as 'any' | 'public' | 'private'))}
        />
        <Select
          id="app"
          label="App"
          variant="button"
          value={store.app.value}
          choices={[
            { value: 'any', label: 'Any app' },
            ...APPS.map((a) => ({ value: a, label: a })),
          ]}
          onChange={(v) => filter(() => (store.app.value = v))}
        />
        <Select
          id="contents"
          label="Contents: an empty drive holds nothing but its root folder"
          variant="button"
          value={store.hideEmpty.value ? 'some' : 'any'}
          disabled={!pub.hasLookups}
          choices={[
            { value: 'some', label: 'With contents' },
            { value: 'any', label: 'Empty ones too' },
          ]}
          onChange={(v) => filter(() => (store.hideEmpty.value = v === 'some'))}
        />
        <span class="note" id="asknote">
          {!pub.verified
            ? pub.status === 'bad'
              ? 'Nothing can load until the publication is read and verified.'
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
        {!status.text ? null : status.cls === 'bad' ? (
          <div class="notice error">
            <Icon name="error" />
            <span class="notice-text status-text bad">{status.text}</span>
            {status.detail ? <pre class="statusdetail">{status.detail}</pre> : null}
            {status.action ? (
              <button type="button" class="secondary compact statusbtn" onClick={status.action.go}>
                {status.action.label}
              </button>
            ) : null}
          </div>
        ) : (
          <p class={`status-line ${status.cls}`}>
            {status.cls === 'ok' ? <Icon name="success" /> : null}
            <span class={`status-text ${status.cls}`}>{status.text}</span>
            {status.action ? (
              <button type="button" class="secondary compact statusbtn" onClick={status.action.go}>
                {status.action.label}
              </button>
            ) : null}
          </p>
        )}
      </div>
      <ProgressBar state={store.progress.value} onStop={() => void session.stop()} />
      <ViewArea />
    </section>
  );
}
