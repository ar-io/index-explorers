import { Icon, Proof } from '@ar-io/explorer-ui';
import onDark from '@ar-io/explorer-ui/brand/ardrive-wordmark-on-dark.svg?url';
import onLight from '@ar-io/explorer-ui/brand/ardrive-wordmark-on-light.svg?url';
import { useState } from 'preact/hooks';

import { useApp } from '../context.js';

const THEME_KEY = 'ardrive-explorer-theme';

/** The theme now on: the toggle's choice, else the system's. */
const themeNow = (): 'light' | 'dark' => {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

/** Dark and light, as the ArDrive app's own toggle switches them; remembered in this browser only. */
function ThemeToggle() {
  const [theme, setTheme] = useState(themeNow);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      class="iconbtn"
      id="theme"
      aria-label={`Switch to the ${next} theme`}
      title={`Switch to the ${next} theme`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(THEME_KEY, next);
        } catch {
          // A private window may refuse; the switch still holds for this visit.
        }
        setTheme(next);
      }}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}

export function Masthead() {
  const { store } = useApp();
  const pub = store.pub.value;
  const hero = store.hero.value;
  return (
    <>
      <header class="topbar">
        <a class="brand" href="https://ardrive.io" aria-label="ArDrive home">
          <img class="on-dark" src={onDark} alt="ArDrive" width={288} height={65} />
          <img class="on-light" src={onLight} alt="ArDrive" width={288} height={65} />
          <span class="product">Explorer</span>
        </a>
        <nav class="topbar-actions" aria-label="About this page">
          <a
            class="btn outline"
            href="https://docs.ar.io/build/advanced/index-publications"
            target="_blank"
            rel="noopener"
            aria-label="How the index works (opens in a new window)"
          >
            <span>How the index works</span>
            <Icon name="external" />
          </a>
          <ThemeToggle />
        </nav>
      </header>
      <section class="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">
          Every drive, folder and file on ArDrive. <em>Verified in your browser.</em>
        </h1>
        <p class="lede">
          Browse public drives newest first, open any drive or wallet, or ask the whole data set a
          question. Nothing is installed and your questions never leave this tab.
        </p>
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
          Counting drive and file records in this tab. The query engine starts first, which can take
          a few seconds on a first visit.
        </p>
        <Proof
          state={pub.proofState}
          text={pub.proofText}
          checks={pub.checks}
          note={
            <>
              Ids, owners, sizes, dates and the drive each file belongs to come from the signed
              index and are checked as above. <strong>Names are the exception:</strong> a drive's or
              file's name lives in its small metadata record, which is read from the gateway and is
              not covered by the signature. Each one is checked for size against the index, and a
              mismatch is shown, never hidden. A failure at any step stops the listing; a check that
              cannot run counts as a failure.
            </>
          }
        />
      </section>
    </>
  );
}
