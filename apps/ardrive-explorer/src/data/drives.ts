/**
 * Browse: the newest drives, walking back from the tip in windows; and a
 * drive: its window from the tag lookup, owner narrowing when cheaper, slices
 * so memory stays flat, then the browser.
 */
import {
  arfs,
  clusterHeights,
  fmtDay,
  fmtRange,
  mb,
  num,
  parquetL2,
  type PlannedReads,
  planReads,
  readAhead,
  rowsOf,
  sliceWindow,
  sq,
  timeAt,
} from '@ar-io/index-client';

import { CONFIG } from '../config.js';
import {
  buildDriveModel,
  type DriveRow,
  EMPTY_DRIVE_RECORDS,
  type EntityRecord,
  toRecord,
} from '../model/arfs.js';
import { toRecordsChunked, yieldToBrowser } from '../model/rows.js';
import type { Session } from '../session.js';
import { emptyContent } from '../store.js';

export interface BrowseState {
  period: string;
  hi: number;
  rows: DriveRow[];
  /** Drives left out as empty. */
  hidden: number;
  step: number;
  done: boolean;
}

export interface DriveWindow {
  records: number | null;
  lo: number;
  hi: number;
  byLookup: boolean;
}

export function filtersSql(privacy: string, app: string): string {
  const w: string[] = [];
  if (privacy !== 'any') w.push(`privacy = '${privacy}'`);
  if (app !== 'any') w.push(`app = ${sq(app)}`);
  return w.length ? ' AND ' + w.join(' AND ') : '';
}

export function createDriveFlows(s: Session) {
  const st = s.store;
  let browseState: BrowseState | null = null;

  /**
   * Each drive's records over its whole history, from the tag lookup, read
   * ahead in parallel first. A drive's records never come before the drive,
   * so only the bands from the oldest of them on are read.
   */
  async function withRecords(rows: EntityRecord[], my: number): Promise<DriveRow[]> {
    const ids = [...new Set(rows.map((r) => r.drive_id).filter((d): d is string => !!d))];
    if (!s.hasLookups || !ids.length) return rows.map((r) => ({ ...r, records: null }));
    const bands = s.registeredBands();
    const from = Math.min(...rows.map((r) => r.height));
    const counts = new Map<string, number>();
    for (let i = 0; i < ids.length; i += CONFIG.page) {
      const part = ids.slice(i, i + CONFIG.page);
      await readAhead(s.engine!, [arfs.driveRecordCountsReadAhead(bands, part, from)], {
        stop: () => s.overtaken(my),
      });
      if (s.overtaken(my)) break;
      for (const r of rowsOf(
        await s.engine!.query(`SELECT * FROM ${arfs.driveRecordCountsSql(bands, part, from)}`),
      ))
        counts.set(String(r.drive_id), Number(r.records));
    }
    return rows.map((r) => ({ ...r, records: counts.get(r.drive_id ?? '') ?? null }));
  }

  async function browse(reset: boolean): Promise<void> {
    const my = ++s.nav;
    st.tr(`browse reset=${reset}`);
    s.pushHistory({ kind: 'browse' }, !reset);
    if (!(await s.ready()) || s.overtaken(my)) return;
    const p = st.currentPeriod()!;
    if (reset || !browseState || browseState.period !== p.id) {
      s.clearView();
      const when = fmtRange(timeAt(s.bands, p.lo), timeAt(s.bands, p.hi));
      st.content.value = {
        ...emptyContent(),
        title: 'Newest drives',
        sub: `Drives created ${when ?? p.label.toLowerCase()}, newest first.`,
      };
      browseState = { period: p.id, hi: p.hi, rows: [], hidden: 0, step: 1000, done: false };
    }
    const bs = browseState;
    if (bs.done) return;
    const where = filtersSql(st.privacy.value, st.app.value);
    const hide = st.hideEmpty.value && s.hasLookups;
    const r = await s.measured('Reading drives', async () => {
      const got: DriveRow[] = [];
      // Walk back in windows until a page is full: a window that comes back
      // nearly empty is doubled, so a quiet period does not cost many requests.
      while (got.length < CONFIG.page && bs.hi >= p.lo) {
        const lo = Math.max(p.lo, bs.hi - bs.step + 1);
        const rows = rowsOf(
          await s.engine!.query(arfs.newestDrivesSql(s.registeredBands(), lo, bs.hi, where)),
        ).map(toRecord);
        bs.hi = lo - 1;
        if (rows.length < CONFIG.page / 4) bs.step = Math.min(bs.step * 2, 64000);
        for (const d of await withRecords(rows, my)) {
          if (hide && d.records !== null && d.records <= EMPTY_DRIVE_RECORDS) bs.hidden++;
          else got.push(d);
        }
        if (s.overtaken(my)) break;
      }
      if (bs.hi < p.lo) bs.done = true;
      return got;
    });
    if (!r || s.overtaken(my)) return;
    bs.rows.push(...r.out);
    const c = st.content.value;
    st.content.value = {
      ...c,
      table: { cols: [], rows: bs.rows as unknown as Record<string, unknown>[], preset: 'drives' },
      namesNote: true,
      more: bs.done
        ? [
            {
              kind: 'text',
              label:
                `${num(bs.rows.length)} drive${bs.rows.length === 1 ? '' : 's'} in this period` +
                (bs.hidden ? `, and ${num(bs.hidden)} empty ones hidden.` : '.'),
            },
          ]
        : [
            { kind: 'button', label: 'Show older drives', go: () => void browse(false) },
            {
              kind: 'text',
              label:
                `${num(bs.rows.length)} so far, back to block ${num(bs.hi + 1)}` +
                (timeAt(s.bands, bs.hi + 1) ? ` (${fmtDay(timeAt(s.bands, bs.hi + 1)!)})` : '') +
                (bs.hidden ? `; ${num(bs.hidden)} empty ones hidden` : ''),
            },
          ],
      exportable: {
        cols: [
          'drive_id',
          'id',
          'owner',
          'privacy',
          'created_at',
          'app',
          'app_version',
          'arfs',
          'records',
        ],
        rows: bs.rows as unknown as Record<string, unknown>[],
        isTime: new Set(['created_at']),
        slug: 'drives',
      },
    };
    st.say(r.receipt, 'ok');
  }

  /** Where a drive's records are, from the tag lookup: how many, and the first and last block. */
  async function driveWindow(driveId: string): Promise<DriveWindow | null> {
    if (!s.hasLookups) {
      const p = st.currentPeriod()!;
      return { records: null, lo: p.lo, hi: p.hi, byLookup: false };
    }
    // Every band's lookup is read at once rather than one band after another.
    st.tr('lookup ahead');
    await readAhead(s.engine!, [
      parquetL2.tagLookupReadAhead(s.registeredBands(), 'Drive-Id', driveId),
    ]);
    st.tr('lookup');
    const [r] = rowsOf(await s.engine!.query(`SELECT * FROM drive_window(${sq(driveId)})`));
    st.tr('lookup done');
    if (!r || r.lo == null) return null;
    return { records: Number(r.records), lo: Number(r.lo), hi: Number(r.hi), byLookup: true };
  }

  /**
   * Narrows a wide window to the blocks its owner actually wrote in, through
   * the wallet lookup: one cheap read for the owner, one for the heights, then
   * clusters of blocks instead of the whole span. Null when it would not help.
   */
  async function narrowByOwner(
    driveId: string,
    w: DriveWindow,
  ): Promise<{ owner: string; clusters: [number, number][] } | null> {
    const bands = s.registeredBands();
    // The window's first block, read at once: the listing reads it too.
    await readAhead(s.engine!, parquetL2.windowReadAhead(bands, w.lo, w.lo));
    const [first] = rowsOf(
      await s.engine!.query(
        `SELECT b64u(i.owner_address) AS owner FROM ${parquetL2.tagsSql(bands, w.lo, w.lo)} t JOIN ${parquetL2.itemsSql(bands, w.lo, w.lo, true)} i ON i.id = t.id AND i.height = t.height
         WHERE t.name = 'Drive-Id' AND t.value = ${sq(driveId)} LIMIT 1`,
      ),
    );
    if (!first) return null;
    // Only the window's bands, and their row groups for the address, read at once.
    const owner = String(first.owner);
    st.tr('owner');
    await readAhead(s.engine!, [parquetL2.walletLookupReadAhead(bands, owner, w.lo, w.hi)]);
    const heights = rowsOf(
      await s.engine!.query(parquetL2.walletHeightsSql(bands, owner, w.lo, w.hi)),
    ).map((r) => Number(r.height));
    if (!heights.length) return null;
    return { owner, clusters: clusterHeights(heights, CONFIG.clusterGap) };
  }

  /** What listing a drive over these stretches reads, from the files' footers. */
  type DrivePlan = { clusters: [number, number][]; reads: PlannedReads; owner?: string };
  const priced = async (clusters: [number, number][]) => ({
    clusters,
    reads: await planReads(s.engine!, parquetL2.clustersReadAhead(s.registeredBands(), clusters)),
  });

  async function openDrive(
    driveIdRaw: string,
    confirmed: boolean,
    folder: string | null,
    planned?: { w: DriveWindow; plan: DrivePlan },
  ): Promise<void> {
    const my = ++s.nav;
    const driveId = driveIdRaw.toLowerCase();
    if (!confirmed) s.pushHistory({ kind: 'drive', key: driveId, folder });
    else st.view.value = { kind: 'drive', key: driveId, folder };
    if (!(await s.ready()) || s.overtaken(my)) return;
    s.clearView();
    const crumbs = [{ label: 'Drives', go: () => void browse(true) }];
    st.content.value = {
      ...emptyContent(),
      crumbs: [...crumbs, { label: `Drive ${driveId.slice(0, 8)}…`, go: null }],
      title: `Drive ${driveId.slice(0, 8)}…`,
      sub: 'Finding its records through the index’s lookups…',
    };
    const w = planned?.w ?? (await driveWindow(driveId).catch(() => null));
    if (s.overtaken(my)) return;
    if (!w) {
      st.content.value = {
        ...st.content.value,
        title: `No drive ${driveId.slice(0, 8)}…`,
        sub: 'Nothing in the index carries this Drive-Id. Check the id, or the index may not reach it yet.',
      };
      st.say('');
      return;
    }
    // A wide window is read as slices of blocks, one small scan each, so the
    // memory a listing needs stays flat however wide the drive. Narrowing to
    // the stretches its owner wrote in is taken whenever it reads less. What
    // each reads comes from the files' footers, which the listing needs anyway.
    // Confirming a cost card reads what the card priced, without planning again.
    let plan: DrivePlan;
    if (planned) plan = planned.plan;
    else
      try {
        st.tr('plan');
        plan = await priced(sliceWindow(w.lo, w.hi, CONFIG.slice));
        if (plan.reads.bytes > CONFIG.askFirstBytes && s.hasLookups) {
          st.tr('narrow');
          const n = await narrowByOwner(driveId, w).catch(() => null);
          st.tr('narrowed');
          if (s.overtaken(my)) return;
          const p = n && (await priced(n.clusters));
          if (p && p.reads.bytes < plan.reads.bytes) plan = { ...p, owner: n.owner };
        }
        st.tr('planned');
      } catch (e) {
        if (!s.overtaken(my))
          st.say(`Could not read the index: ${e instanceof Error ? e.message : String(e)}`, 'bad');
        return;
      }
    if (s.overtaken(my)) return;
    const cost = plan.reads.bytes;
    const when = fmtRange(timeAt(s.bands, w.lo), timeAt(s.bands, w.hi));
    const span = `${w.records != null ? num(w.records) + ' records' : 'Records'} between blocks ${num(w.lo)} and ${num(w.hi)}${when ? ` (${when})` : ''}.`;
    st.content.value = { ...st.content.value, sub: span };
    if (cost > CONFIG.askFirstBytes && !confirmed) {
      const text = [
        `Listing this drive reads about `,
        mb(cost),
        ` of the index` +
          (plan.owner
            ? ` (narrowed to the ${num(plan.clusters.length)} stretches of blocks its owner wrote in)`
            : ` (its records are spread over ${num(w.hi - w.lo + 1)} blocks)`) +
          ((w.records ?? 0) > 2e6
            ? `. With ${num(w.records!)} records it is too large to show as a tree; the list is capped at ${num(CONFIG.listCap)} files.`
            : '.'),
      ];
      st.content.value = {
        ...st.content.value,
        cost: {
          text,
          action: {
            label: `Read ${mb(cost)} and list it`,
            go: () => void openDrive(driveId, true, folder, { w, plan }),
          },
        },
      };
      return;
    }
    const r = await s.measured('Reading the drive', async () => {
      const bands = s.registeredBands();
      // The window's row groups at once, in parallel, rather than one by one as the engine asks.
      st.tr('window ahead');
      await readAhead(s.engine!, plan.reads, { stop: () => s.overtaken(my) });
      st.tr('window');
      const src = `(${arfs.clusterSql(bands, plan.clusters, `drive_id = ${sq(driveId)}`)})`;
      // The drive and its folders first, so a cap cuts files, never the tree they hang from.
      const table = await s.engine!.query(
        `SELECT * FROM ${src} ORDER BY CASE kind WHEN 'drive' THEN 0 WHEN 'folder' THEN 1 ELSE 2 END, height DESC LIMIT ${CONFIG.listCap}`,
      );
      st.tr(`query done ${table.numRows}`);
      return toRecordsChunked(table, 4000, () => st.tr('chunk'));
    });
    if (!r || s.overtaken(my)) return;
    const recs = r.out;
    st.tr('records');
    // The model is built in its own task, and drawn in the next, so neither is a long one.
    await yieldToBrowser();
    if (s.overtaken(my)) return;
    const model = buildDriveModel(recs, {
      driveId,
      capped: recs.length === CONFIG.listCap,
      note:
        `${num(recs.length)} records between blocks ${num(w.lo)} and ${num(w.hi)}${when ? ` (${when})` : ''}` +
        (recs.some((x) => x.privacy === 'private') &&
        !recs.some((x) => x.privacy === 'public' && x.kind === 'drive')
          ? '. A private drive: names and contents are encrypted, so only its shape is shown'
          : ''),
    });
    const privacy = model.privacy;
    st.content.value = {
      ...emptyContent(),
      crumbs: [...crumbs, { label: privacy === 'private' ? 'Private drive' : 'Drive', go: null }],
      exportable: {
        cols: [
          'kind',
          'id',
          'entity_id',
          'parent_folder_id',
          'owner',
          'created_at',
          'height',
          'app',
          'app_version',
          'record_size',
        ],
        rows: recs as unknown as Record<string, unknown>[],
        isTime: new Set(['created_at']),
        slug: `drive-${driveId.slice(0, 8)}`,
      },
      namesNote: privacy !== 'private',
    };
    s.names.reset();
    st.driveUi.value = {
      path: folder && model.folders.has(folder) ? s.pathFor(model, folder) : [],
      sort: { key: 'name', dir: 1 },
      filter: '',
      selected: null,
      allNames: false,
    };
    st.tr('model');
    await yieldToBrowser();
    if (s.overtaken(my)) return;
    st.drive.value = model;
    st.tr('drive set');
    // The drive's own name and root folder come from its record; then the rest
    // of the names in the background, up to a cap: a drive with twenty thousand
    // files does not fetch twenty thousand records unless a folder is opened
    // or a search asks for them.
    if (privacy !== 'private') {
      s.wantDriveName(model);
      s.wantNames(model, model.items.slice(0, CONFIG.backgroundNames), false);
    }
    st.say(r.receipt, 'ok');
  }

  /** Folder navigation is a history entry, so Back and Forward walk folders. */
  function setFolder(path: string[], replace = false): void {
    const d = st.drive.value;
    if (!d) return;
    st.driveUi.value = { ...st.driveUi.value, path, selected: null, filter: '' };
    s.pushHistory(
      { kind: 'drive', key: d.driveId, folder: path.length ? path[path.length - 1]! : null },
      replace,
    );
  }

  return { browse, openDrive, setFolder, driveWindow };
}
