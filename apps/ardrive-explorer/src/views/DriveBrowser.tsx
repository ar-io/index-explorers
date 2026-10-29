/**
 * The drive browser: an ArFS file browser over one drive's records. Header
 * (name, counts, size, privacy, owner), breadcrumbs, a search box, a sortable
 * windowed list with typed icons, and a details panel with versions.
 */
import {
  AnchoredMenu,
  Badge,
  Icon,
  iconFor,
  typeLabel,
  useWindowed,
  type Action,
} from '@ar-io/explorer-ui';
import { bytesText, fmtDate, fmtWhen, isId43, num, shortId } from '@ar-io/index-client';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { CONFIG } from '../config.js';
import { useApp } from '../context.js';
import { sentence } from './ViewArea.js';
import {
  currentFolder,
  type DriveItem,
  type DriveModel,
  pathTo,
  sortItems,
  type SortKey,
  visibleItems,
} from '../model/arfs.js';

const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function Crumbs({ d }: { d: DriveModel }) {
  const { store, flows, session } = useApp();
  void store.namesTick.value;
  const ui = store.driveUi.value;
  const items: { label: string; go: (() => void) | null; last: boolean }[] = [
    {
      label: d.name || 'Drive',
      go: () => flows.setFolder([]),
      last: ui.path.length === 0 && !ui.filter,
    },
  ];
  ui.path.forEach((fid, i) => {
    const f = d.folders.get(fid);
    if (f && d.privacy !== 'private') session.names.want(f.latest.id, f.latest.record_size, true);
    items.push({
      label: f?.name || 'folder',
      go: () => flows.setFolder(ui.path.slice(0, i + 1)),
      last: i === ui.path.length - 1 && !ui.filter,
    });
  });
  if (ui.filter) items.push({ label: `search "${ui.filter}"`, go: null, last: true });
  return (
    <nav class="b-crumbs" id="b-crumbs" aria-label="Folder path">
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          class={`crumb${it.last ? ' current' : ''}`}
          onClick={it.go ?? undefined}
          disabled={!it.go && !it.last}
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}

function Details({ d, x }: { d: DriveModel; x: DriveItem }) {
  const { store, flows, session } = useApp();
  void store.namesTick.value;
  const m = x.meta ?? {};
  const dataTxId = typeof m.dataTxId === 'string' && isId43(m.dataTxId) ? m.dataTxId : null;
  const isPrivate = d.privacy === 'private';
  const copyRef = useRef<HTMLButtonElement>(null);
  const fact = (k: string, v: string | null | undefined | preact.JSX.Element, mono = false) =>
    v === null || v === undefined || v === '' ? null : (
      <>
        <dt>{k}</dt>
        <dd class={mono ? 'mono' : undefined}>{v}</dd>
      </>
    );
  return (
    <aside class="b-details" id="b-details">
      <div class="d-head">
        <Icon
          name={isPrivate ? 'lock' : x.kind === 'folder' ? 'folder' : iconFor(x.type, x.name)}
        />
        <h4>
          {isPrivate
            ? x.kind === 'folder'
              ? 'Encrypted folder'
              : 'Encrypted file'
            : x.name || (x.failed ? 'name unavailable' : 'fetching name…')}
        </h4>
        <button
          type="button"
          class="iconbtn compact d-close"
          aria-label="Close details"
          onClick={() => (store.driveUi.value = { ...store.driveUi.value, selected: null })}
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="d-actions">
        {x.kind === 'folder' && !isPrivate ? (
          <button
            type="button"
            class="primary compact"
            onClick={() => flows.setFolder(pathTo(d, x))}
          >
            Open
          </button>
        ) : null}
        {dataTxId && !isPrivate ? (
          <>
            <a
              class="btn primary compact"
              href={`${session.gateway}/${dataTxId}`}
              target="_blank"
              rel="noopener"
            >
              Open
              <Icon name="external" />
            </a>
            <button
              type="button"
              class="compact"
              ref={copyRef}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`${session.gateway}/${dataTxId}`);
                  if (copyRef.current) {
                    copyRef.current.textContent = 'Copied';
                    setTimeout(
                      () => copyRef.current && (copyRef.current.textContent = 'Copy link'),
                      1500,
                    );
                  }
                } catch {
                  store.say('The browser would not give clipboard access.', 'bad');
                }
              }}
            >
              Copy link
            </button>
          </>
        ) : null}
      </div>
      <dl class="d-facts">
        {fact(
          'Type',
          isPrivate
            ? 'encrypted'
            : x.kind === 'folder'
              ? 'Folder'
              : x.type || typeLabel(null, x.name),
        )}
        {fact('Size', x.size != null ? `${bytesText(x.size)} (${num(x.size)} bytes)` : null)}
        {fact('Modified', x.modified ? fmtWhen(x.modified) : null)}
        {fact(
          'Uploaded',
          Number(x.latest.created_at) > 0
            ? fmtWhen(x.latest.created_at)
            : `block ${num(x.latest.height)}`,
        )}
        {fact(
          'Owner',
          <button
            type="button"
            class="rowlink mono"
            onClick={() => void flows.openWallet(x.latest.owner, false)}
          >
            {x.latest.owner}
          </button>,
        )}
        {fact('App', `${x.latest.app || ''} ${x.latest.app_version || ''}`.trim())}
        {fact(x.kind === 'folder' ? 'Folder-Id' : 'File-Id', x.entityId, true)}
        {fact(
          'Record',
          <button type="button" class="rowlink mono" onClick={() => void flows.openId(x.latest.id)}>
            {x.latest.id}
          </button>,
        )}
        {dataTxId
          ? fact(
              'Data',
              <button
                type="button"
                class="rowlink mono"
                onClick={() => void flows.openId(dataTxId)}
              >
                {dataTxId}
              </button>,
            )
          : null}
      </dl>
      {x.versions.length > 1 ? (
        <>
          <h5>{x.versions.length} versions</h5>
          <ul class="d-versions">
            {x.versions.map((v, i) => (
              <li key={v.id}>
                {`${i === 0 ? 'current' : 'v' + (x.versions.length - i)} · ${Number(v.created_at) > 0 ? fmtWhen(v.created_at) : `block ${num(v.height)}`} · `}
                <button type="button" class="rowlink mono" onClick={() => void flows.openId(v.id)}>
                  {shortId(v.id)}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {x.hidden ? <p class="d-note">Hidden in the ArDrive app (Is-Hidden).</p> : null}
      {x.failed ? <p class="d-note bad">The record could not be read: {x.failed}.</p> : null}
    </aside>
  );
}

/** A public file's address on the gateway, or null (a folder, a private file, no data id yet). */
const fileUrl = (d: DriveModel, x: DriveItem, gateway: string | null): string | null => {
  const id = x.meta && typeof x.meta.dataTxId === 'string' ? x.meta.dataTxId : null;
  return gateway && x.kind !== 'folder' && id && isId43(id) && d.privacy !== 'private'
    ? `${gateway}/${id}`
    : null;
};

/** The item's own name, or what it is when it has none to show. */
const itemLabel = (d: DriveModel, x: DriveItem): string =>
  d.privacy === 'private'
    ? x.kind === 'folder'
      ? 'Encrypted folder'
      : 'Encrypted file'
    : x.name || x.kind;

/**
 * One item of the list, as the design system's lists behave: a click selects
 * it (its details open beside the list); a double-click, Enter or a tap on a
 * touch screen opens a folder (a file's details are its open view, and a
 * double-click opens a public file itself). Its actions sit in a menu at the
 * row's end: the row draws only the button, and the list owns one menu.
 */
function Row({
  d,
  x,
  selected,
  menuOpen,
  onOpen,
  onSelect,
  onMenu,
}: {
  d: DriveModel;
  x: DriveItem;
  selected: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onSelect: () => void;
  onMenu: (button: HTMLElement) => void;
}) {
  const { session } = useApp();
  const isPrivate = d.privacy === 'private';
  const folder = x.kind === 'folder';
  const touch = useRef(false);
  const open = () => (folder ? onOpen() : onSelect());
  const stop = (e: Event) => e.stopPropagation();
  return (
    <tr
      class={`b-row${x.hidden ? ' b-hidden' : ''}${selected ? ' selected' : ''}`}
      tabIndex={0}
      aria-selected={selected ? 'true' : 'false'}
      onPointerDown={(e) => (touch.current = e.pointerType === 'touch')}
      onClick={() => (touch.current ? open() : onSelect())}
      onDblClick={() => {
        const url = fileUrl(d, x, session.gateway);
        if (folder) onOpen();
        else if (url) window.open(url, '_blank', 'noopener');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
    >
      <td class="b-namecol">
        <div class="b-namecell">
          <Icon name={folder ? 'folder' : isPrivate ? 'lock' : iconFor(x.type, x.name)} />
          {isPrivate ? (
            <span class="name">{folder ? 'Encrypted folder' : 'Encrypted file'}</span>
          ) : x.name ? (
            <span class="name">{x.name}</span>
          ) : x.failed ? (
            <span class="name mismatch" title={x.failed}>
              name unavailable
            </span>
          ) : (
            <span class="name pending">{folder ? 'folder…' : 'file…'}</span>
          )}
          {x.versions.length > 1 ? <span class="b-ver">{x.versions.length} versions</span> : null}
        </div>
      </td>
      <td class="b-dim">{fmtDate(x.modified ?? x.latest.created_at)}</td>
      <td class="num b-dim">
        {folder
          ? `${num((d.children.get(x.entityId) ?? []).length)} items`
          : x.size != null
            ? bytesText(x.size)
            : isPrivate
              ? ''
              : '…'}
      </td>
      <td class="b-dim">
        {folder
          ? 'Folder'
          : isPrivate
            ? 'Encrypted'
            : x.type || x.name
              ? typeLabel(x.type, x.name)
              : '…'}
      </td>
      <td class="b-act">
        <button
          type="button"
          class="iconbtn compact"
          aria-label={`Actions for ${itemLabel(d, x)}`}
          aria-haspopup="menu"
          aria-controls="b-rowmenu"
          aria-expanded={menuOpen ? 'true' : 'false'}
          onClick={(e) => {
            e.stopPropagation();
            onMenu(e.currentTarget);
          }}
          onDblClick={stop}
          onKeyDown={stop}
        >
          <Icon name="more" />
        </button>
      </td>
    </tr>
  );
}

export function DriveBrowser() {
  const { store, flows, session } = useApp();
  const d = store.drive.value!;
  const ui = store.driveUi.value;
  const tick = store.namesTick.value;
  const progress = store.namesProgress.value;
  const isPrivate = d.privacy === 'private';
  const cur = currentFolder(d, ui.path);
  // Names landing re-sort the listing; a search over the whole drive re-sorts
  // on a slower cadence, since every match is a candidate.
  const sortTick = ui.filter ? Math.floor(tick / 10) : tick;
  const list = useMemo(
    () => sortItems(d, visibleItems(d, ui.path, ui.filter), ui.sort.key, ui.sort.dir, COLLATOR),
    [d, ui.path, ui.filter, ui.sort, sortTick],
  );
  const resetKey = `${ui.path.join('/')}|${ui.filter}|${ui.sort.key}${ui.sort.dir}`;
  const { shown, setSentinel, setRoot, more } = useWindowed(
    list.length,
    CONFIG.renderChunk,
    resetKey,
  );
  const rows = list.slice(0, shown);
  // Records for what is on screen first, then the rest of this folder.
  useEffect(() => {
    if (isPrivate) return;
    session.wantNames(d, rows, true);
    session.wantNames(d, list.slice(shown, shown + CONFIG.renderChunk), false);
  }, [d, resetKey, shown]);
  // A search needs every name; say how far it is.
  useEffect(() => {
    if (ui.filter && !ui.allNames && !isPrivate) {
      store.driveUi.value = { ...ui, allNames: true };
      session.wantNames(d, d.items, false);
    }
  }, [ui.filter]);
  const sortBy = (k: SortKey) =>
    (store.driveUi.value = {
      ...store.driveUi.value,
      sort: { key: k, dir: ui.sort.key === k ? (-ui.sort.dir as 1 | -1) : 1 },
    });
  const owner = d.driveRec ? d.driveRec.owner : d.items[0]?.latest.owner;
  const pending = progress.wanted - progress.loaded;
  const parts = [
    `${num(d.files)} file${d.files === 1 ? '' : 's'}`,
    `${num(d.folders.size)} folder${d.folders.size === 1 ? '' : 's'}`,
  ];
  // Names and sizes come from the same record reads, so while they run they
  // are one phrase: the bytes so far, then how far the reads have got.
  if (pending > 0) {
    if (d.sizeKnown) parts.push(`${bytesText(d.bytes)} so far`);
  } else if (d.sizeKnown)
    parts.push(
      `${bytesText(d.bytes)}${d.sizeKnown < d.files ? ` in ${num(d.sizeKnown)} of ${num(d.files)} files` : ''}`,
    );
  if (d.capped) parts.push(`listing capped at ${num(CONFIG.listCap)} records`);
  if (pending > 0)
    parts.push(
      `reading names and sizes: ${num(progress.loaded)} of ${num(progress.wanted)} records`,
    );
  const selected = ui.selected ? (d.byId.get(ui.selected) ?? null) : null;
  const [menu, setMenu] = useState<{ x: DriveItem; anchor: HTMLElement } | null>(null);
  const select = (x: DriveItem) =>
    (store.driveUi.value = { ...store.driveUi.value, selected: x.entityId });
  const menuActions = (x: DriveItem): Action[] => {
    const url = fileUrl(d, x, session.gateway);
    return [
      ...(x.kind === 'folder' && !isPrivate
        ? [{ label: 'Open', icon: 'folder' as const, run: () => flows.setFolder(pathTo(d, x)) }]
        : []),
      ...(url
        ? [
            {
              label: 'Open',
              icon: 'external' as const,
              run: () => window.open(url, '_blank', 'noopener'),
            },
            {
              label: 'Copy link',
              run: () =>
                void navigator.clipboard.writeText(url).then(
                  () => store.say('Link copied.', 'ok'),
                  () => store.say('The browser would not give clipboard access.', 'bad'),
                ),
            },
          ]
        : []),
      { label: 'More info', icon: 'info', run: () => select(x), group: !isPrivate },
    ];
  };
  const headers: [SortKey, string, boolean][] = [
    ['name', 'Name', false],
    ['modified', 'Modified', false],
    ['size', 'Size', true],
    ['type', 'Type', false],
  ];
  return (
    <section class="browser" id="browser">
      <div class="b-head">
        <div class="b-title">
          <Icon name="drive" big />
          <div>
            <h3
              class={`b-drive-name${!isPrivate && d.driveRec && !d.name ? ' pending' : ''}`}
              id="b-name"
            >
              {isPrivate ? 'Private drive' : d.name || (d.driveRec ? 'fetching name…' : 'Drive')}
            </h3>
            <p class="b-sub" id="b-sub">
              {parts.join(' · ') + (d.note ? `\n${d.note}.` : '')}
            </p>
          </div>
        </div>
        <div class="b-stats" id="b-stats">
          <Badge text={sentence(d.privacy)} kind={d.privacy} />
          {d.driveRec?.arfs ? <Badge text={`ArFS ${d.driveRec.arfs}`} /> : null}
          {d.driveRec && Number(d.driveRec.created_at) > 0 ? (
            <span class="b-meta">Created {fmtDate(d.driveRec.created_at)}</span>
          ) : null}
          {owner ? (
            <button
              type="button"
              class="rowlink b-owner"
              title={owner}
              onClick={() => void flows.openWallet(owner, false)}
            >
              {shortId(owner)}
            </button>
          ) : null}
        </div>
      </div>
      <div class="b-tools">
        <Crumbs d={d} />
        <div class="b-search">
          <Icon name="search" />
          <input
            id="b-filter"
            type="search"
            placeholder="Search in this drive"
            autocomplete="off"
            spellcheck={false}
            aria-label="Search in this drive"
            value={ui.filter}
            onInput={(e) =>
              (store.driveUi.value = {
                ...store.driveUi.value,
                filter: (e.target as HTMLInputElement).value.trim().toLowerCase(),
                selected: null,
              })
            }
          />
        </div>
      </div>
      <div class="b-body">
        <div class="b-listwrap" ref={setRoot}>
          <table class="b-list" id="b-list">
            <thead>
              <tr>
                {headers.map(([k, label, isNum]) => (
                  <th
                    key={k}
                    data-key={k}
                    class={`b-sort${isNum ? ' num' : ''}`}
                    data-dir={ui.sort.key === k ? (ui.sort.dir > 0 ? 'asc' : 'desc') : ''}
                    onClick={() => sortBy(k)}
                    aria-sort={
                      ui.sort.key === k ? (ui.sort.dir > 0 ? 'ascending' : 'descending') : undefined
                    }
                  >
                    {label}
                  </th>
                ))}
                <th class="b-act">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {cur && !ui.filter ? (
                <tr
                  class="b-row b-up"
                  tabIndex={0}
                  onClick={() => flows.setFolder(ui.path.slice(0, -1))}
                  onKeyDown={(e) => e.key === 'Enter' && flows.setFolder(ui.path.slice(0, -1))}
                >
                  <td colSpan={5}>
                    <Icon name="up" />
                    Back
                  </td>
                </tr>
              ) : null}
              {rows.map((x) => (
                <Row
                  key={x.kind + x.entityId}
                  d={d}
                  x={x}
                  selected={selected === x}
                  menuOpen={menu?.x === x}
                  onOpen={() => flows.setFolder(pathTo(d, x))}
                  onSelect={() => select(x)}
                  onMenu={(anchor) => setMenu(menu?.x === x ? null : { x, anchor })}
                />
              ))}
              {more ? (
                <tr class="b-more" ref={(el) => setSentinel(el)}>
                  <td
                    colSpan={5}
                  >{`${num(shown)} of ${num(list.length)} shown · scroll for more`}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p class="b-empty" id="b-empty" hidden={list.length > 0}>
            {ui.filter
              ? pending > 0
                ? `No match yet; still reading names (${num(progress.loaded)} of ${num(progress.wanted)}).`
                : `Nothing named like "${ui.filter}" in this drive.`
              : 'This folder is empty.'}
          </p>
        </div>
        {selected ? <Details d={d} x={selected} /> : null}
        {menu ? (
          <AnchoredMenu
            id="b-rowmenu"
            label={`Actions for ${itemLabel(d, menu.x)}`}
            anchor={menu.anchor}
            actions={menuActions(menu.x)}
            onClose={() => setMenu(null)}
          />
        ) : null}
      </div>
    </section>
  );
}
