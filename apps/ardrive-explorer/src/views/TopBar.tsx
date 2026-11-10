/**
 * The app bar, as ArDrive web's: the wordmark (the way home), Find in the
 * middle, and on the right the Verified chip (the proof, told once) and the
 * theme. On a phone a menu button opens the nav, and Find takes a row of its own.
 */
import { Icon, PROOF_LABELS, type ProofChecks } from '@ar-io/explorer-ui';
import onDark from '@ar-io/explorer-ui/brand/ardrive-wordmark-on-dark.svg?url';
import onLight from '@ar-io/explorer-ui/brand/ardrive-wordmark-on-light.svg?url';
import { useEffect, useRef, useState } from 'preact/hooks';

import { useApp } from '../context.js';
import { revealAround } from './reveal.js';
import { useMedia } from './useMedia.js';

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

function Find() {
  const { store, flows } = useApp();
  const [text, setText] = useState('');
  // The full hint is cut mid-word in a phone's box, so a phone gets a short one.
  const narrow = useMedia('(max-width: 480px)');
  const narrowest = useMedia('(max-width: 360px)');
  const find = () => revealAround(store, flows.find(text));
  return (
    <div class="find" role="search">
      <div class="searchbox">
        <Icon name="search" />
        <input
          id="find"
          type="search"
          aria-label="Find a drive, wallet, file or block"
          aria-describedby="findhint"
          placeholder={
            narrowest
              ? 'Id or block'
              : narrow
                ? 'Id, address or block'
                : 'Drive id, wallet address, file id or block height'
          }
          spellcheck={false}
          autocomplete="off"
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
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
  );
}

const CHIP: Record<'run' | 'ok' | 'bad', string> = {
  run: 'Checking',
  ok: 'Verified',
  bad: 'Not verified',
};

/**
 * The trust story, told once: a chip that says whether the index verified,
 * and opens the four checks behind it. A failure turns it red; the error, with
 * its way out, is said in the view, which the panel would cover.
 */
function VerifiedChip() {
  const { store, session } = useApp();
  const pub = store.pub.value;
  const box = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const host = pub.gateway ? pub.gateway.replace(/^https?:\/\//, '') : null;
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      box.current?.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <details
      class="proof chip"
      id="proof"
      ref={box}
      data-state={pub.proofState}
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary aria-label={`${CHIP[pub.proofState]}: how the index is checked`}>
        <i aria-hidden="true" />
        <span class="chip-label">{CHIP[pub.proofState]}</span>
        {host && pub.proofState === 'ok' ? <span class="chip-host">{host}</span> : null}
      </summary>
      <div class="proof-panel">
        <p id="proof-text" class="proof-text">
          {pub.proofText}
        </p>
        <ol class="checks" id="checks">
          {(Object.keys(PROOF_LABELS) as (keyof ProofChecks)[]).map((k) => (
            <li key={k} data-k={k} data-state={pub.checks[k]}>
              <i />
              <span>{PROOF_LABELS[k]}</span>
            </li>
          ))}
        </ol>
        <p class="proof-note">
          Ids, owners, sizes, dates and the drive each file belongs to come from the signed index.{' '}
          <strong>Names are the exception:</strong> each lives in a small metadata record read from
          the gateway, outside the signature. Its size is checked against the index, and a mismatch
          is shown struck through. A check that fails or cannot run stops the listing.
        </p>
        <p class="proof-links">
          <button
            type="button"
            class="linkbtn"
            onClick={() => {
              setOpen(false);
              session.show('source');
            }}
          >
            Data source
          </button>
          <a
            href="https://docs.ar.io/build/advanced/index-publications"
            target="_blank"
            rel="noopener"
          >
            How the index works
            <Icon name="external" />
          </a>
        </p>
      </div>
    </details>
  );
}

export function TopBar({ navOpen, onMenu }: { navOpen: boolean; onMenu: () => void }) {
  const { session } = useApp();
  return (
    <header class="topbar">
      <button
        type="button"
        class="iconbtn navbtn"
        id="navbtn"
        aria-label="Menu"
        aria-controls="sidenav"
        aria-expanded={navOpen ? 'true' : 'false'}
        onClick={onMenu}
      >
        <Icon name="menu" />
      </button>
      <a
        class="brand"
        href="./"
        aria-label="ArDrive Explorer home"
        onClick={(e) => {
          e.preventDefault();
          void session.home(true);
        }}
      >
        <img class="on-dark" src={onDark} alt="" width={288} height={65} />
        <img class="on-light" src={onLight} alt="" width={288} height={65} />
        <span class="product">Explorer</span>
      </a>
      <Find />
      <div class="topbar-actions">
        <VerifiedChip />
        <ThemeToggle />
      </div>
    </header>
  );
}
