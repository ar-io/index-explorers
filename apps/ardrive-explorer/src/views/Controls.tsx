/** Pieces every section shares: the status line and the period. */
import { Icon, ProgressBar, Select } from '@ar-io/explorer-ui';
import { fmtRange, mb, timeAt } from '@ar-io/index-client';
import { useEffect } from 'preact/hooks';

import { useApp } from '../context.js';
import { revealWork } from './reveal.js';

/** What is happening, in words, and the progress bar with Stop under it. */
export function StatusArea({ receipts = true }: { receipts?: boolean }) {
  const { store, session } = useApp();
  const status = store.status.value;
  // A receipt goes under the view it describes, when the view shows one.
  const here = receipts || status.cls !== 'ok' || !!status.flash;
  const stop = store.progress.value.stop;
  useEffect(() => {
    if (stop && store.revealing.value) requestAnimationFrame(revealWork);
  }, [stop]);
  return (
    // Always in the page, empty or not, so a reveal can find where the work will show.
    <div class="statusarea" id="work">
      <div id="status" aria-live="polite">
        {!status.text || !here ? null : status.cls === 'bad' ? (
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
    </div>
  );
}

/**
 * The period a listing, a question or a query reads: a clean label, and what
 * it covers and costs in the line under it.
 */
export function PeriodPicker({
  onPicked,
  inline = false,
}: {
  onPicked?: () => void;
  /** In a row of filters: the help line takes a row of its own under them. */
  inline?: boolean;
}) {
  const { store, session } = useApp();
  const pub = store.pub.value;
  const periods = store.periods.value;
  const p = store.currentPeriod();
  const when = p ? fmtRange(timeAt(session.bands, p.lo), timeAt(session.bands, p.hi)) : null;
  const cost = !p
    ? ''
    : p.bands.every((b) => session.isRangeable(b))
      ? `${mb(p.size)} of index, read as far as needed`
      : `${mb(session.wholeSize(p.bands))} to download`;
  return (
    <div class={`period${inline ? ' inline' : ''}`}>
      <Select
        id="scope"
        label="Period"
        variant="button"
        value={store.periodId.value}
        choices={
          periods.length
            ? periods.map((per) => ({
                value: per.id,
                label: session.periodDisabled(per) ? `${per.label} (too big here)` : per.label,
                disabled: session.periodDisabled(per),
              }))
            : [{ value: store.periodId.value, label: 'Reading…' }]
        }
        onChange={(id) => {
          store.periodId.value = id;
          // After a failed read, picking a period reads the publication again.
          if (!pub.verified) {
            if (pub.status === 'bad') void session.readPublication();
            return;
          }
          onPicked?.();
        }}
      />
      <span class="field-help" id="scopedates">
        {p ? [when, cost].filter(Boolean).join(' · ') : ' '}
      </span>
    </div>
  );
}
