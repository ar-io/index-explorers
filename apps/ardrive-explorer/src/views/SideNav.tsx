/**
 * The left nav, as ArDrive web's side bar draws it: one row per section, the
 * current one filled, items that open on a single click. Under 834 px it is a
 * drawer over a scrim, opened from the app bar's menu button.
 */
import { Icon, type IconName } from '@ar-io/explorer-ui';
import { useEffect, useRef } from 'preact/hooks';

import { useApp } from '../context.js';
import type { Section } from '../router.js';

interface Item {
  id: string;
  section: Section;
  label: string;
  icon: IconName;
  go: () => void;
}

export function SideNav({
  section,
  open,
  onClose,
}: {
  section: Section;
  open: boolean;
  onClose: () => void;
}) {
  const { session, flows } = useApp();
  const nav = useRef<HTMLElement>(null);
  // Opened on a phone: focus goes in, and Escape or the scrim closes it.
  useEffect(() => {
    if (!open) return;
    nav.current?.querySelector<HTMLElement>('.navitem')?.focus();
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
      document.getElementById('navbtn')?.focus();
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [open]);
  const main: Item[] = [
    {
      id: 'browse',
      section: 'drives',
      label: 'Drives',
      icon: 'drive',
      go: () => void flows.browse(true),
    },
    {
      id: 'nav-questions',
      section: 'questions',
      label: 'Questions',
      icon: 'question',
      go: () => session.show('questions'),
    },
    { id: 'nav-sql', section: 'sql', label: 'SQL', icon: 'code', go: () => session.show('editor') },
  ];
  const row = (it: Item) => (
    <li key={it.id}>
      <button
        type="button"
        id={it.id}
        class="navitem"
        aria-current={section === it.section ? 'page' : undefined}
        onClick={() => {
          onClose();
          it.go();
        }}
      >
        <Icon name={it.icon} />
        <span>{it.label}</span>
      </button>
    </li>
  );
  return (
    <>
      <div class="scrim" hidden={!open} onClick={onClose} />
      <nav id="sidenav" class={`sidenav${open ? ' open' : ''}`} aria-label="Explorer" ref={nav}>
        <ul>{main.map(row)}</ul>
        <hr />
        <ul>
          {row({
            id: 'nav-source',
            section: 'source',
            label: 'Data source',
            icon: 'source',
            go: () => session.show('source'),
          })}
        </ul>
        <hr />
        <ul>
          <li>
            <a
              class="navitem"
              href="https://docs.ar.io/build/advanced/index-publications"
              target="_blank"
              rel="noopener"
            >
              <Icon name="info" />
              <span>How it works</span>
              <Icon name="external" class="navitem-out" />
            </a>
          </li>
          <li>
            <a class="navitem" href="https://app.ardrive.io" target="_blank" rel="noopener">
              <span class="ico" aria-hidden="true" />
              <span>Open ArDrive</span>
              <Icon name="external" class="navitem-out" />
            </a>
          </li>
        </ul>
      </nav>
    </>
  );
}
