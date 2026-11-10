/**
 * What the content area shows for each section of the nav. Each view gets
 * the whole area: a drive, a wallet, an answer and the editor no longer share
 * one page with the others.
 */
import { Icon, Select } from '@ar-io/explorer-ui';

import { APPS } from '../config.js';
import { useApp } from '../context.js';
import { DataSource, Questions, SqlEditor } from './Ask.js';
import { PeriodPicker, StatusArea } from './Controls.js';
import { ViewArea } from './ViewArea.js';

/** The drives list's own filters, in its header: they apply to nothing else. */
function BrowseToolbar() {
  const { store, flows } = useApp();
  const pub = store.pub.value;
  const filter = (go: () => void) => {
    go();
    void flows.browse(true);
  };
  return (
    <div class="filters" id="filters">
      <PeriodPicker inline onPicked={() => void flows.browse(true)} />
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
        choices={[{ value: 'any', label: 'Any app' }, ...APPS.map((a) => ({ value: a, label: a }))]}
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
    </div>
  );
}

export function HomeView() {
  const { store } = useApp();
  const hero = store.hero.value;
  return (
    <>
      <section class="intro" aria-labelledby="intro-title">
        <h1 id="intro-title">Every drive, folder and file on ArDrive, verified in your browser.</h1>
        <dl class="stats" id="stats">
          <div class="stat">
            <dd id="s-drives">{hero.drives}</dd>
            <dt title="Every drive record the index holds: a drive renamed or changed counts once per record.">
              Drive records
            </dt>
          </div>
          <div class="stat">
            <dd id="s-files">{hero.files}</dd>
            <dt title="Every file record the index holds: a file renamed or moved counts once per record.">
              File records
            </dt>
          </div>
          <div class="stat">
            <dd id="s-items">{hero.items}</dd>
            <dt>Uploads indexed</dt>
          </div>
          <div class="stat">
            <dd id="s-span">{hero.span}</dd>
            <dt>Covering</dt>
          </div>
        </dl>
        <p class="stats-note" id="statsnote" hidden={!hero.counting}>
          Counting records in this tab. The query engine starts first, which can take a few seconds
          on a first visit.
        </p>
      </section>
      <StatusArea />
      <ViewArea />
    </>
  );
}

export function DrivesView() {
  const { store } = useApp();
  const browsing = store.view.value.kind === 'browse';
  return (
    <>
      <StatusArea receipts={false} />
      <ViewArea toolbar={browsing ? <BrowseToolbar /> : null} receipt />
    </>
  );
}

export function QuestionsView() {
  const { store, session } = useApp();
  const answered = store.view.value.kind === 'query';
  return (
    <>
      <header class="section-head">
        <div>
          <h1>Questions</h1>
          <p class="section-sub">Answered in this tab, over the period you pick.</p>
        </div>
        <PeriodPicker />
      </header>
      {answered ? (
        <>
          <button type="button" class="linkbtn back" onClick={() => session.show('questions')}>
            <Icon name="back" />
            All questions
          </button>
          <StatusArea receipts={false} />
          <ViewArea receipt />
          <h2 class="subhead">More questions</h2>
          <Questions compact />
        </>
      ) : (
        <>
          <StatusArea />
          <Questions />
        </>
      )}
    </>
  );
}

export function SqlView() {
  const { store } = useApp();
  const ran = store.view.value.kind === 'query';
  return (
    <>
      <header class="section-head">
        <div>
          <h1>SQL</h1>
          <p class="section-sub">Edit an example or write your own; it runs in this tab.</p>
        </div>
      </header>
      <SqlEditor />
      <StatusArea receipts={!ran} />
      {ran ? <ViewArea receipt /> : null}
    </>
  );
}

export function SourceView() {
  return (
    <>
      <header class="section-head">
        <div>
          <h1>Data source</h1>
          <p class="section-sub">The gateway this page reads, and the publication it verified.</p>
        </div>
      </header>
      <StatusArea />
      <DataSource />
    </>
  );
}
