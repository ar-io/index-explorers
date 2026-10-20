import { Proof } from '@ar-io/explorer-ui';

import { useApp } from '../context.js';
import logo from '@ar-io/explorer-ui/ardrive-wordmark.svg?raw';

export function Masthead() {
  const { store } = useApp();
  const pub = store.pub.value;
  const hero = store.hero.value;
  return (
    <header class="framed">
      <div class="bar">
        <a
          href="https://ardrive.io"
          aria-label="ArDrive home"
          class="logo-link"
          dangerouslySetInnerHTML={{ __html: logo.replace('<svg ', '<svg class="logo" ') }}
        />
        <a
          class="pill"
          href="https://docs.ar.io/build/advanced/index-publications"
          target="_blank"
          rel="noopener"
        >
          How the index works
        </a>
      </div>
      <p class="eyebrow">ArDrive — the public record</p>
      <h1>
        Every drive, folder and file on ArDrive. <em>Verified in your browser.</em>
      </h1>
      <p class="lede">
        Browse public drives newest first, open any drive or wallet, or ask the whole data set a
        question. Nothing is installed and your questions never leave this tab.
      </p>
      <dl class="stats" id="stats">
        <div class="stat">
          <dd id="s-drives">{hero.drives}</dd>
          <dt>Drives</dt>
        </div>
        <div class="stat">
          <dd id="s-files">{hero.files}</dd>
          <dt>Files</dt>
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
      <Proof
        state={pub.proofState}
        text={pub.proofText}
        checks={pub.checks}
        note={
          <>
            Ids, owners, sizes, dates and the drive each file belongs to come from the signed index
            and are checked as above. <strong>Names are the exception:</strong> a drive's or file's
            name lives in its small metadata record, which is read from the gateway and is not
            covered by the signature. Each one is checked for size against the index, and a mismatch
            is shown, never hidden. A failure at any step stops the listing; a check that cannot run
            counts as a failure.
          </>
        }
      />
    </header>
  );
}
