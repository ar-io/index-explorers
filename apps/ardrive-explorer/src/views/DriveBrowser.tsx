/**
 * The drive browser: an ArFS file browser over one drive's records. Header
 * (name, counts, size, privacy, owner), breadcrumbs, a search box, a sortable
 * windowed list with typed icons, and a details panel with versions.
 */
import { Badge, Icon, iconFor, OwnerDot, typeLabel, useWindowed } from '@ar-io/explorer-ui';
import { bytesText, fmtDate, fmtWhen, isId43, num, shortId } from '@ar-io/index-client';
import { useEffect, useMemo, useRef } from 'preact/hooks';

import { CONFIG } from '../config.js';
import { useApp } from '../context.js';
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
          class="d-close"
          aria-label="Close details"
          onClick={() => (store.driveUi.value = { ...store.driveUi.value, selected: null })}
        >
          ×
        </button>
      </div>
      <div class="d-actions">
        {dataTxId && !isPrivate ? (
          <>
            <a class="btn" href={`${session.gateway}/${dataTxId}`} target="_blank" rel="noopener">
              Open
            </a>
            <button
              type="button"
              class="secondary"
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

function Row({
  d,
  x,
  selected,
  onOpen,
  onSelect,
}: {
  d: DriveModel;
  x: DriveItem;
  selected: boolean;
  onOpen: () => void;
  onSelect: () => void;
}) {
  const { session } = useApp();
  const isPrivate = d.privacy === 'private';
  const folder = x.kind === 'folder';
  const open = () => (folder ? onOpen() : onSelect());
  const dataTxId =
    x.meta && typeof x.meta.dataTxId === 'string' && isId43(x.meta.dataTxId)
      ? x.meta.dataTxId
      : null;
  const parentName = x.parent ? d.folders.get(x.parent)?.name : null;
  return (
    <tr
      class={`b-row${x.hidden ? ' b-hidden' : ''}${selected ? ' selected' : ''}`}
      tabIndex={0}
      onClick={open}
      onDblClick={() => {
        if (!folder && dataTxId && !isPrivate)
          window.open(`${session.gateway}/${dataTxId}`, '_blank', 'noopener');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
    >
      <td class="b-namecell">
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
        {parentName !== undefined &&
        parentName !== null &&
        x.parent &&
        d.folders.get(x.parent) &&
        d.folders.get(x.parent) !== currentFolder(d, [])
          ? null
          : null}
        {x.versions.length > 1 ? <span class="b-ver">{x.versions.length} versions</span> : null}
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
            ? 'encrypted'
            : x.type || x.name
              ? typeLabel(x.type, x.name)
              : '…'}
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
              class={`b-name${!isPrivate && d.driveRec && !d.name ? ' name pending' : ''}`}
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
          <Badge text={d.privacy} kind={d.privacy} />
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
              <OwnerDot addr={owner} />
              {shortId(owner)}
            </button>
          ) : null}
        </div>
      </div>
      <div class="b-tools">
        <Crumbs d={d} />
        <div class="b-search">
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
                  >
                    {label}
                  </th>
                ))}
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
                  <td colSpan={4}>
                    <Icon name="up" /> Back
                  </td>
                </tr>
              ) : null}
              {rows.map((x) => (
                <Row
                  key={x.kind + x.entityId}
                  d={d}
                  x={x}
                  selected={selected === x}
                  onOpen={() => flows.setFolder(pathTo(d, x))}
                  onSelect={() =>
                    (store.driveUi.value = { ...store.driveUi.value, selected: x.entityId })
                  }
                />
              ))}
              {more ? (
                <tr class="b-more" ref={(el) => setSentinel(el)}>
                  <td
                    colSpan={4}
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
      </div>
    </section>
  );
}
