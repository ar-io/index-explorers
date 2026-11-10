/**
 * The drive browser: an ArFS file browser over one drive's records. Header
 * (name, counts, size, privacy, owner), breadcrumbs, a search box, a sortable
 * windowed list with typed icons, and a details panel with versions.
 */
import {
  ActionMenu,
  AnchoredMenu,
  ardriveUrl,
  FilePreview,
  Icon,
  iconFor,
  typeLabel,
  previewKind,
  useWindowed,
  type Action,
} from '@ar-io/explorer-ui';
import { bytesText, fmtDate, fmtWhen, isId43, num, shortId } from '@ar-io/index-client';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { CONFIG } from '../config.js';
import { useApp } from '../context.js';
import { saveBlob } from '../util/export.js';
import { sentence, useViewActions } from './ViewArea.js';
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
      {/* One path from the list of drives down: the root is not a folder, so not a .crumb. */}
      <button type="button" class="crumb-root" onClick={() => void flows.browse(true)}>
        Drives
      </button>
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

/** Downloaded in the page, under its name, up to this size; past it the gateway's tab saves it. */
const DOWNLOAD_IN_PAGE = 200e6;

/** The same place in the ArDrive app (null for a private drive, whose key this page never has). */
export function inArDrive(d: DriveModel, x: DriveItem | null): string | null {
  return ardriveUrl(
    {
      driveId: d.driveId,
      privacy: d.privacy,
      folderId: x?.kind === 'folder' ? x.entityId : null,
      fileId: x && x.kind !== 'folder' ? x.entityId : null,
    },
    CONFIG.appUrl,
  );
}

/** Copies a link, and says so on the status line. */
function useCopy() {
  const { store } = useApp();
  return (url: string) =>
    void navigator.clipboard.writeText(url).then(
      () => store.say('Link copied.', 'ok', { flash: true }),
      () => store.say('The browser would not give clipboard access.', 'bad'),
    );
}

/** Saves a public file under its name; a large one opens on the gateway instead. */
function useDownload() {
  const { store } = useApp();
  return async (url: string, name: string, size: number | null) => {
    if (size !== null && size > DOWNLOAD_IN_PAGE) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    store.say(`Downloading ${name}…`, '', { flash: true });
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`the gateway answered ${r.status}`);
      saveBlob(name, await r.blob());
      store.say(`Saved ${name}.`, 'ok', { flash: true });
    } catch (e) {
      store.say(
        `Could not download ${name}: ${e instanceof Error ? e.message : String(e)}.`,
        'bad',
      );
    }
  };
}

function Facts({ children }: { children: preact.ComponentChildren }) {
  return <dl class="d-facts">{children}</dl>;
}
const fact = (k: string, v: string | null | undefined | preact.JSX.Element, mono = false) =>
  v === null || v === undefined || v === '' ? null : (
    <>
      <dt>{k}</dt>
      <dd class={mono ? 'mono' : undefined}>{v}</dd>
    </>
  );

function Head({
  icon,
  title,
  onClose,
}: {
  icon: preact.JSX.Element;
  title: string;
  onClose: () => void;
}) {
  return (
    <div class="d-head">
      {icon}
      <h3>{title}</h3>
      <button
        type="button"
        class="iconbtn compact d-close"
        aria-label="Close details"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

/** The drive's own details: what the header leaves out. */
function DriveDetails({ d }: { d: DriveModel }) {
  const { store, flows } = useApp();
  const r = d.driveRec;
  const app = inArDrive(d, null);
  const close = () => (store.driveUi.value = { ...store.driveUi.value, selected: null });
  return (
    <aside class="b-details" id="b-details" aria-label="Drive details">
      <Head
        icon={<Icon name={d.privacy === 'private' ? 'privateDrive' : 'drive'} />}
        title={d.privacy === 'private' ? 'Private drive' : d.name || 'Drive'}
        onClose={close}
      />
      {app ? (
        <div class="d-actions">
          <a class="btn secondary compact" href={app} target="_blank" rel="noopener">
            Open in ArDrive
            <Icon name="external" />
          </a>
        </div>
      ) : null}
      <Facts>
        {fact('Privacy', sentence(d.privacy))}
        {fact('Drive-Id', d.driveId, true)}
        {r?.arfs ? fact('ArFS', r.arfs) : null}
        {r && Number(r.created_at) > 0 ? fact('Created', fmtWhen(r.created_at)) : null}
        {r
          ? fact(
              'Owner',
              <button
                type="button"
                class="rowlink mono"
                onClick={() => void flows.openWallet(r.owner, false)}
              >
                {r.owner}
              </button>,
            )
          : null}
        {r ? fact('App', `${r.app || ''} ${r.app_version || ''}`.trim()) : null}
        {r
          ? fact(
              'Record',
              <button type="button" class="rowlink mono" onClick={() => void flows.openId(r.id)}>
                {r.id}
              </button>,
            )
          : null}
        {d.rootFolderId ? fact('Root folder', d.rootFolderId, true) : null}
      </Facts>
    </aside>
  );
}

function Details({ d, x }: { d: DriveModel; x: DriveItem }) {
  const { store, flows, session } = useApp();
  void store.namesTick.value;
  const copy = useCopy();
  const download = useDownload();
  const m = x.meta ?? {};
  const dataTxId = typeof m.dataTxId === 'string' && isId43(m.dataTxId) ? m.dataTxId : null;
  const isPrivate = d.privacy === 'private';
  const url = fileUrl(d, x, session.gateway);
  const kind = url ? previewKind(x.type, x.name) : null;
  const app = inArDrive(d, x);
  const title = isPrivate
    ? x.kind === 'folder'
      ? 'Encrypted folder'
      : 'Encrypted file'
    : x.name || (x.failed ? 'name unavailable' : 'fetching name…');
  const close = () => (store.driveUi.value = { ...store.driveUi.value, selected: null });
  return (
    <aside class="b-details" id="b-details" aria-label="Details">
      <Head
        icon={
          <Icon
            name={x.kind === 'folder' ? 'folder' : isPrivate ? 'file' : iconFor(x.type, x.name)}
          />
        }
        title={title}
        onClose={close}
      />
      {url && kind ? (
        <FilePreview
          key={url}
          url={url}
          kind={kind}
          name={x.name || 'this file'}
          size={x.size ?? null}
        />
      ) : null}
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
        {url ? (
          <button
            type="button"
            class="primary compact"
            id="d-download"
            onClick={() => void download(url, x.name || dataTxId!, x.size ?? null)}
          >
            <Icon name="download" />
            Download
          </button>
        ) : null}
        {app ? (
          <a class="btn secondary compact" href={app} target="_blank" rel="noopener">
            Open in ArDrive
            <Icon name="external" />
          </a>
        ) : null}
        {url ? (
          <ActionMenu
            id="d-more"
            label={`More for ${title}`}
            actions={[
              { label: 'Copy link', icon: 'copy', run: () => copy(url) },
              {
                label: 'Open on the gateway',
                icon: 'external',
                run: () => window.open(url, '_blank', 'noopener'),
              },
            ]}
          />
        ) : null}
      </div>
      <Facts>
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
      </Facts>
      {x.versions.length > 1 ? (
        <>
          <h4>{x.versions.length} versions</h4>
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
          <Icon name={folder ? 'folder' : isPrivate ? 'file' : iconFor(x.type, x.name)} />
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
  const viewActions = useViewActions();
  const [menu, setMenu] = useState<{ x: DriveItem; anchor: HTMLElement } | null>(null);
  const select = (x: DriveItem) =>
    (store.driveUi.value = { ...store.driveUi.value, selected: x.entityId });
  const copy = useCopy();
  const download = useDownload();
  /** The details, scrolled to the preview: what Preview in a row's menu asks for. */
  const preview = (x: DriveItem) => {
    select(x);
    requestAnimationFrame(() =>
      document.getElementById('preview')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    );
  };
  // A file's menu, in the design system's order, leaving out what does not apply:
  // Open or Preview | Copy link | Download | Open in ArDrive | More info.
  const menuActions = (x: DriveItem): Action[] => {
    const url = fileUrl(d, x, session.gateway);
    const app = inArDrive(d, x);
    const folder = x.kind === 'folder';
    const share =
      folder && !isPrivate
        ? session.shareUrl({ kind: 'drive', key: d.driveId, folder: x.entityId })
        : url;
    const out: Action[] = [];
    if (folder && !isPrivate)
      out.push({ label: 'Open', icon: 'folder', run: () => flows.setFolder(pathTo(d, x)) });
    if (!folder && url && previewKind(x.type, x.name))
      out.push({ label: 'Preview', icon: 'preview', run: () => preview(x) });
    if (share)
      out.push({ label: 'Copy link', icon: 'copy', run: () => copy(share), group: out.length > 0 });
    if (url)
      out.push({
        label: 'Download',
        icon: 'download',
        run: () => void download(url, x.name || x.entityId, x.size ?? null),
        group: true,
      });
    if (app)
      out.push({
        label: 'Open in ArDrive',
        icon: 'external',
        run: () => window.open(app, '_blank', 'noopener'),
        group: !url,
      });
    out.push({ label: 'More info', icon: 'info', run: () => select(x), group: out.length > 0 });
    return out;
  };
  const driveApp = inArDrive(d, null);
  const driveActions: Action[] = [
    ...viewActions,
    ...(driveApp
      ? [
          {
            label: 'Open in ArDrive',
            icon: 'external' as const,
            run: () => window.open(driveApp, '_blank', 'noopener'),
            group: true,
          },
        ]
      : []),
    {
      label: 'More info',
      icon: 'info',
      run: () => (store.driveUi.value = { ...store.driveUi.value, selected: d.driveId }),
      group: true,
    },
  ];
  const headers: [SortKey, string, boolean][] = [
    ['name', 'Name', false],
    ['modified', 'Modified', false],
    ['size', 'Size', true],
    ['type', 'Type', false],
  ];
  return (
    <section class="drive" id="browser" aria-labelledby="viewtitle">
      <Crumbs d={d} />
      <div class="b-head">
        <div class="b-title">
          <Icon name={isPrivate ? 'privateDrive' : 'drive'} big />
          <div>
            <div class="b-namerow">
              <h2
                class={`b-drive-name${!isPrivate && d.driveRec && !d.name ? ' pending' : ''}`}
                id="viewtitle"
              >
                {isPrivate ? 'Private drive' : d.name || (d.driveRec ? 'fetching name…' : 'Drive')}
              </h2>
              <ActionMenu id="viewmenu" label="Actions for this drive" actions={driveActions} />
            </div>
            <p class="b-sub" id="b-sub">
              {parts.join(' · ') + (d.note ? `\n${d.note}.` : '')}
            </p>
          </div>
        </div>
        {/* Privacy in words, as ArDrive web shows it: the drive's icon carries it too. */}
        <div class="b-stats" id="b-stats">
          <span class="privacy">{sentence(d.privacy)}</span>
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
      <div class="browser">
        <div class="b-tools">
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
                        ui.sort.key === k
                          ? ui.sort.dir > 0
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                    >
                      {label}
                      {ui.sort.key === k ? (
                        <Icon name={ui.sort.dir > 0 ? 'sortUp' : 'sortDown'} class="b-sortdir" />
                      ) : null}
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
          {ui.selected === d.driveId ? (
            <DriveDetails d={d} />
          ) : selected ? (
            <Details d={d} x={selected} />
          ) : null}
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
      </div>
    </section>
  );
}
