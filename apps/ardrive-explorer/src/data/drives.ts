/**
 * Browse: the newest drives, walking back from the tip in windows; and a
 * drive: its window from the tag lookup, owner narrowing when cheaper, slices
 * so memory stays flat, then the browser.
 */
import { clusterHeights, fmtDay, fmtRange, mb, num, parquetL2, rowsOf, sliceWindow, sq, timeAt, windowCost } from '@ar-io/index-client';

import { CONFIG } from '../config.js';
import { buildDriveModel, type EntityRecord, toRecord } from '../model/arfs.js';
import { toRecordsChunked, yieldToBrowser } from '../model/rows.js';
import type { Session } from '../session.js';
import { emptyContent } from '../store.js';

export interface BrowseState {
  period: string;
  hi: number;
  rows: EntityRecord[];
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

  async function browse(reset: boolean): Promise<void> {
    const my = ++s.nav;
    st.tr(`browse reset=${reset}`);
    s.pushHistory({ kind: 'browse' }, !reset);
    if (!(await s.ready()) || s.overtaken(my)) return;
    const p = st.currentPeriod()!;
    if (reset || !browseState || browseState.period !== p.id) {
      s.clearView();
      const when = fmtRange(timeAt(s.bands, p.lo), timeAt(s.bands, p.hi));
      st.content.value = { ...emptyContent(), title: 'Newest drives', sub: `Drives created ${when ?? p.label.toLowerCase()}, newest first.` };
      browseState = { period: p.id, hi: p.hi, rows: [], step: 1000, done: false };
    }
    const bs = browseState;
    if (bs.done) return;
    const where = filtersSql(st.privacy.value, st.app.value);
    const r = await s.measured('Reading drives', async () => {
      const got: EntityRecord[] = [];
      // Walk back in windows until a page is full: a window that comes back
      // nearly empty is doubled, so a quiet period does not cost many requests.
      while (got.length < CONFIG.page && bs.hi >= p.lo) {
        const lo = Math.max(p.lo, bs.hi - bs.step + 1);
        const rows = rowsOf(await s.engine!.query(parquetL2.newestDrivesSql(s.registeredBands(), lo, bs.hi, where))).map(toRecord);
        got.push(...rows);
        bs.hi = lo - 1;
        if (rows.length < CONFIG.page / 4) bs.step = Math.min(bs.step * 2, 64000);
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
        ? [{ kind: 'text', label: `${num(bs.rows.length)} drive${bs.rows.length === 1 ? '' : 's'} in this period.` }]
        : [
            { kind: 'button', label: 'Show older drives', go: () => void browse(false) },
            {
              kind: 'text',
              label: `${num(bs.rows.length)} so far, back to block ${num(bs.hi + 1)}` + (timeAt(s.bands, bs.hi + 1) ? ` (${fmtDay(timeAt(s.bands, bs.hi + 1)!)})` : ''),
            },
          ],
      exportable: {
        cols: ['drive_id', 'id', 'owner', 'privacy', 'created_at', 'app', 'app_version', 'arfs', 'versions'],
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
    const [r] = rowsOf(await s.engine!.query(`SELECT * FROM drive_window(${sq(driveId)})`));
    if (!r || r.lo == null) return null;
    return { records: Number(r.records), lo: Number(r.lo), hi: Number(r.hi), byLookup: true };
  }

  /**
   * Narrows a wide window to the blocks its owner actually wrote in, through
   * the wallet lookup: one cheap read for the owner, one for the heights, then
   * clusters of blocks instead of the whole span. Null when it would not help.
   */
  async function narrowByOwner(driveId: string, w: DriveWindow): Promise<{ owner: string; clusters: [number, number][]; cost: number } | null> {
    const bands = s.registeredBands();
    const [first] = rowsOf(
      await s.engine!.query(
        `SELECT b64u(i.owner_address) AS owner FROM ${parquetL2.tagsSql(bands, w.lo, w.lo)} t JOIN ${parquetL2.itemsSql(bands, w.lo, w.lo, true)} i ON i.id = t.id AND i.height = t.height
         WHERE t.name = 'Drive-Id' AND t.value = ${sq(driveId)} LIMIT 1`,
      ),
    );
    if (!first) return null;
    const heights = rowsOf(
      await s.engine!.query(
        `SELECT DISTINCT height FROM lookup_wallet WHERE addr8 = key64(unb64u(${sq(first.owner)})) AND role = 0 AND height BETWEEN ${w.lo} AND ${w.hi} ORDER BY 1`,
      ),
    ).map((r) => Number(r.height));
    if (!heights.length) return null;
    const clusters = clusterHeights(heights, CONFIG.clusterGap);
    const cost = clusters.reduce((t, [a, z]) => t + windowCost(s.bands, a, z, { min: CONFIG.costMin }), 0);
    return { owner: String(first.owner), clusters, cost };
  }

  async function openDrive(driveIdRaw: string, confirmed: boolean, folder: string | null): Promise<void> {
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
    const w = await driveWindow(driveId).catch(() => null);
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
    // the stretches its owner wrote in is taken whenever it reads less.
    let plan: { clusters: [number, number][]; cost: number; owner?: string } = { clusters: sliceWindow(w.lo, w.hi, CONFIG.slice), cost: windowCost(s.bands, w.lo, w.hi, { min: CONFIG.costMin }) };
    if (plan.cost > CONFIG.askFirstBytes && s.hasLookups) {
      const n = await narrowByOwner(driveId, w).catch(() => null);
      if (s.overtaken(my)) return;
      if (n && n.cost < plan.cost) plan = { clusters: n.clusters, cost: n.cost, owner: n.owner };
    }
    const when = fmtRange(timeAt(s.bands, w.lo), timeAt(s.bands, w.hi));
    const span = `${w.records != null ? num(w.records) + ' records' : 'Records'} between blocks ${num(w.lo)} and ${num(w.hi)}${when ? ` (${when})` : ''}.`;
    st.content.value = { ...st.content.value, sub: span };
    if (plan.cost > CONFIG.askFirstBytes && !confirmed) {
      const text = [
        `Listing this drive reads about `,
        mb(plan.cost),
        ` of the index` +
          (plan.owner ? ` (narrowed to the ${num(plan.clusters.length)} stretches of blocks its owner wrote in)` : ` (its records are spread over ${num(w.hi - w.lo + 1)} blocks)`) +
          ((w.records ?? 0) > 2e6 ? `. With ${num(w.records!)} records it is too large to show as a tree; the list is capped at ${num(CONFIG.listCap)} files.` : '.'),
      ];
      st.content.value = {
        ...st.content.value,
        cost: { text, action: { label: `Read ${mb(plan.cost)} and list it`, go: () => void openDrive(driveId, true, folder) } },
      };
      return;
    }
    const r = await s.measured('Reading the drive', async () => {
      const src = `(${parquetL2.clusterSql(s.registeredBands(), plan.clusters, `drive_id = ${sq(driveId)}`)})`;
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
        (recs.some((x) => x.privacy === 'private') && !recs.some((x) => x.privacy === 'public' && x.kind === 'drive')
          ? '. A private drive: names and contents are encrypted, so only its shape is shown'
          : ''),
    });
    const privacy = model.privacy;
    st.content.value = {
      ...emptyContent(),
      crumbs: [...crumbs, { label: privacy === 'private' ? 'Private drive' : 'Drive', go: null }],
      exportable: {
        cols: ['kind', 'id', 'entity_id', 'parent_folder_id', 'owner', 'created_at', 'height', 'app', 'app_version', 'record_size'],
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
    s.pushHistory({ kind: 'drive', key: d.driveId, folder: path.length ? path[path.length - 1]! : null }, replace);
  }

  return { browse, openDrive, setFolder, driveWindow };
}
