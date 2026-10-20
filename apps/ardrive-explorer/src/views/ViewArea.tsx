import { Badge, Icon, OwnerDot } from '@ar-io/explorer-ui';
import { bytesText, fmtDate, fmtWhen, isId43, isUuid, num, shortId } from '@ar-io/index-client';
import type { ComponentChildren } from 'preact';

import { CONFIG } from '../config.js';
import { useApp } from '../context.js';
import type { EntityRecord } from '../model/arfs.js';
import type { Column, TableContent } from '../store.js';
import { saveFile, toCsv, toJson } from '../util/export.js';
import { captionSegments } from '../data/questions.js';
import { DriveBrowser } from './DriveBrowser.js';
import type { WalletDrive } from '../data/wallet.js';

/** A clickable id or address that opens its own view. */
export function RowLink({ text, go, mono, children }: { text?: string; go: () => void; mono?: boolean; children?: ComponentChildren }) {
  return (
    <button type="button" class={`rowlink${mono ? ' mono' : ''}`} onClick={go}>
      {children}
      {text}
    </button>
  );
}

/** A name from a record: as it arrives, or its fallback, or struck through when the bytes did not match the index. */
export function Name({ id, size, fallback, isPrivate }: { id: string; size: number | null; fallback: string; isPrivate?: boolean }) {
  const { store, session } = useApp();
  void store.namesTick.value;
  if (isPrivate) return <span class="name">{fallback}</span>;
  const r = session.names.want(id, size, true);
  if (!r) return <span class="name pending">fetching name…</span>;
  if (r.ok && r.name) return <span class="name">{r.name}</span>;
  if (r.ok) return <span class="name pending">{fallback}</span>;
  return (
    <span class="name mismatch" title={r.why ?? ''}>
      {fallback === 'Unnamed drive' ? 'name unavailable' : fallback}
    </span>
  );
}

function DrivesTable({ rows }: { rows: EntityRecord[] }) {
  const { flows } = useApp();
  return (
    <table id="results">
      <thead>
        <tr>
          <th scope="col">Drive</th>
          <th scope="col">Owner</th>
          <th scope="col">Created</th>
          <th scope="col">Privacy</th>
          <th scope="col">App</th>
          <th scope="col" class="num">
            Records
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const open = () => void flows.openDrive(r.drive_id!, false, null);
          return (
            <tr
              key={r.id}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button, a')) return;
                open();
              }}
            >
              <td>
                <div class="namewrap">
                  <RowLink go={open}>
                    <Icon name={r.privacy === 'private' ? 'lock' : 'drive'} />
                    <Name id={r.id} size={r.record_size} fallback={r.privacy === 'private' ? 'Private drive' : 'Unnamed drive'} isPrivate={r.privacy === 'private'} />
                  </RowLink>
                  <span class="sub">{r.drive_id}</span>
                </div>
              </td>
              <td>
                <RowLink go={() => void flows.openWallet(r.owner, false)} mono text={shortId(r.owner)}>
                  <OwnerDot addr={r.owner} />
                </RowLink>
              </td>
              <td>{Number(r.created_at) > 0 ? fmtDate(r.created_at) : `block ${num(r.height)}`}</td>
              <td>
                <Badge text={r.privacy} kind={r.privacy} />
              </td>
              <td>{`${r.app || ''}${r.app_version ? ' ' + r.app_version : ''}`}</td>
              <td class="num">{num((r as unknown as { versions: number }).versions)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function WalletDrivesTable({ rows }: { rows: WalletDrive[] }) {
  const { flows } = useApp();
  return (
    <table id="results">
      <thead>
        <tr>
          <th scope="col">Drive</th>
          <th scope="col">Privacy</th>
          <th scope="col" class="num">
            Records here
          </th>
          <th scope="col">Last written</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.drive_id} onClick={(e) => ((e.target as HTMLElement).closest('button, a') ? null : void flows.openDrive(d.drive_id, false, null))}>
            <td>
              <div class="namewrap">
                <RowLink go={() => void flows.openDrive(d.drive_id, false, null)}>
                  {d.privacy === 'private' || !d.drive ? (
                    <span class="name pending">{d.privacy === 'private' ? 'private drive' : 'drive (record not in this stretch)'}</span>
                  ) : (
                    <Name id={d.drive.id} size={d.drive.record_size} fallback="unnamed drive" />
                  )}
                </RowLink>
                <span class="sub">{d.drive_id}</span>
              </div>
            </td>
            <td>
              <Badge text={d.privacy} kind={d.privacy} />
            </td>
            <td class="num">{num(d.records)}</td>
            <td>{Number(d.last.created_at) > 0 ? fmtWhen(d.last.created_at) : `block ${num(d.last.height)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GenericTable({ table }: { table: TableContent }) {
  const { flows } = useApp();
  const isTime = table.isTime ?? new Set<string>();
  const cell = (c: Column, v: unknown, row: Record<string, unknown>): { node: ComponentChildren; num: boolean } => {
    if (c.render) return { node: c.render(v, row), num: !!c.num };
    if (v === null || v === undefined) return { node: '', num: false };
    if (isTime.has(c.key)) return { node: Number(v) > 0 ? fmtWhen(v) : '', num: false };
    const text = String(v);
    if (c.key === 'owner' && isId43(text)) return { node: <RowLink text={text} mono go={() => void flows.openWallet(text, false)} />, num: false };
    if (c.key === 'drive_id' && isUuid(text)) return { node: <RowLink text={text} mono go={() => void flows.openDrive(text, false, null)} />, num: false };
    if ((c.key === 'id' || c.key === 'name_id') && isId43(text)) return { node: <RowLink text={text} mono go={() => void flows.openId(text)} />, num: false };
    const wide = typeof v === 'object' && /^-?\d+(\.\d+)?$/.test(text);
    const isNum = typeof v === 'bigint' || typeof v === 'number' || wide;
    if (isNum || c.num) return { node: num(wide ? Number(text) : (v as number)), num: true };
    return { node: text, num: false };
  };
  const numCols = new Set<string>();
  const body = table.rows.map((r, i) => {
    const cells = table.cols.map((c) => {
      const out = cell(c, r[c.key], r);
      if (out.num) numCols.add(c.key);
      return { c, ...out };
    });
    return (
      <tr key={i}>
        {cells.map(({ c, node, num: isNum }) => (
          <td key={c.key} class={isNum ? 'num' : c.mono ? 'mono' : undefined}>
            {node}
          </td>
        ))}
      </tr>
    );
  });
  return (
    <table id="results">
      <thead>
        <tr>
          {table.cols.map((c) => (
            <th key={c.key} scope="col" class={numCols.has(c.key) || c.num ? 'num' : undefined}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  );
}

function TitleName() {
  const { store, session } = useApp();
  void store.namesTick.value;
  const t = store.content.value.titleName;
  if (!t) return null;
  const r = session.names.want(t.id, t.size, true);
  return (
    <>
      {t.prefix}
      {!r ? <span class="name pending">fetching name…</span> : r.ok && r.name ? <span class="name">{r.name}</span> : r.ok ? <span class="name pending">{t.fallback}</span> : <span class="name mismatch" title={r.why ?? ''}>{t.fallback}</span>}
    </>
  );
}

/** For a file record, once its JSON is in hand: a link to the file itself. */
function OpenFileLink() {
  const { store, session } = useApp();
  void store.namesTick.value;
  const t = store.content.value.titleName;
  if (!t) return null;
  const r = session.names.cache.get(t.id);
  const meta = r?.ok ? r.meta : null;
  const dataTxId = meta && typeof meta.dataTxId === 'string' && isId43(meta.dataTxId) ? meta.dataTxId : null;
  if (!dataTxId) return null;
  return (
    <a href={`${session.gateway}/${dataTxId}`} target="_blank" rel="noopener">
      Open the file
      {meta!.size != null ? ` (${bytesText(meta!.size)}${typeof meta!.dataContentType === 'string' ? ', ' + meta!.dataContentType : ''})` : ''}
    </a>
  );
}

export function ViewArea() {
  const { store, session } = useApp();
  const c = store.content.value;
  const drive = store.drive.value;
  const view = store.view.value;
  const exp = c.exportable;
  const copyLink = async () => {
    const v = view.kind === 'drive' && drive ? { ...view, folder: store.driveUi.value.path.at(-1) ?? null } : view;
    const url = session.shareUrl(v);
    history.replaceState(v, '', url);
    try {
      await navigator.clipboard.writeText(url);
      store.say('Link copied. The gateway, period and view ride in the fragment, so none of it is sent to a server.', 'ok');
    } catch {
      store.say('The browser would not give clipboard access, so the link is in the address bar instead.', 'bad');
    }
  };
  return (
    <article class="view" id="view" aria-live="polite">
      <nav class="crumbs" id="crumbs" hidden={!c.crumbs.length}>
        {c.crumbs.map((cr, i) => (
          <span key={i} class={i > 0 ? 'crumb-item' : ''}>
            {i > 0 ? <span class="sep" /> : null}
            {cr.go ? (
              <button type="button" class="linkbtn" onClick={cr.go}>
                {cr.label}
              </button>
            ) : (
              cr.label
            )}
          </span>
        ))}
      </nav>
      <div class="view-head">
        <h3 class="view-title" id="viewtitle">
          {c.titleName ? <TitleName /> : c.title}
        </h3>
        <div class="result-actions" id="resultactions" hidden={!exp && !drive && c.title === ''}>
          <button type="button" class="secondary" id="csv" disabled={!exp || !exp.rows.length} onClick={() => exp && (saveFile(`ardrive-${exp.slug}.csv`, 'text/csv;charset=utf-8', toCsv(exp.cols, exp.rows, exp.isTime)), store.say(`Saved ${num(exp.rows.length)} rows as CSV.`, 'ok'))}>
            CSV
          </button>
          <button type="button" class="secondary" id="json" disabled={!exp || !exp.rows.length} onClick={() => exp && (saveFile(`ardrive-${exp.slug}.json`, 'application/json', toJson(exp.cols, exp.rows, exp.isTime)), store.say(`Saved ${num(exp.rows.length)} rows as JSON.`, 'ok'))}>
            JSON
          </button>
          <button type="button" class="secondary" id="copylink" onClick={() => void copyLink()}>
            Copy link
          </button>
        </div>
      </div>
      <p class="view-sub" id="viewsub" hidden={!c.sub}>
        {c.sub}
      </p>
      <dl class="facts" id="viewfacts" hidden={!c.facts.length}>
        {c.facts
          .filter((f) => f.dd !== null && f.dd !== undefined && f.dd !== '')
          .map((f) => (
            <div class="fact" key={f.dt}>
              <dt>{f.dt}</dt>
              <dd class={f.mono ? 'mono' : undefined}>{f.dd}</dd>
            </div>
          ))}
      </dl>
      <div class="cost" id="cost" hidden={!c.cost}>
        {c.cost ? (
          <>
            <span>
              {Array.isArray(c.cost.text) ? c.cost.text.map((t, i) => (i === 1 ? <strong key={i}>{t}</strong> : <span key={i}>{t}</span>)) : c.cost.text}
            </span>
            {c.cost.action ? (
              <button type="button" onClick={c.cost.action.go}>
                {c.cost.action.label}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      <p class="caption" id="caption" hidden={!c.caption}>
        {c.caption ? captionSegments(c.caption).map((sgm, i) => (sgm.strong ? <strong key={i}>{sgm.text}</strong> : <span key={i}>{sgm.text}</span>)) : null}
      </p>
      <div class="tablewrap" hidden={!c.table || !c.table.rows.length}>
        {c.table && c.table.rows.length ? (
          c.table.preset === 'drives' ? (
            <DrivesTable rows={c.table.rows as unknown as EntityRecord[]} />
          ) : c.table.preset === 'walletDrives' ? (
            <WalletDrivesTable rows={c.table.rows as unknown as WalletDrive[]} />
          ) : (
            <GenericTable table={c.table} />
          )
        ) : null}
      </div>
      {drive ? <DriveBrowser /> : null}
      <div class="more" id="more" hidden={!c.more.length && !c.titleName && !c.portalWallet}>
        {c.titleName ? <OpenFileLink /> : null}
        {c.more.map((m, i) =>
          m.kind === 'button' ? (
            <button key={i} type="button" class="secondary" onClick={m.go}>
              {m.label}
            </button>
          ) : m.kind === 'link' ? (
            <a key={i} href={m.href} target="_blank" rel="noopener">
              {m.label}
            </a>
          ) : (
            <span key={i}>{m.label}</span>
          ),
        )}
        {c.portalWallet ? (
          <a href={`${CONFIG.portalUrl}/#/balances/${c.portalWallet}`} target="_blank" rel="noopener">
            On the Network Portal
          </a>
        ) : null}
      </div>
      <p class="names-note" id="namesnote" hidden={!c.namesNote}>
        Names are read from the gateway's copy of each entity's metadata and checked for size against the signed index; everything else
        here is from the index.
      </p>
    </article>
  );
}
