/**
 * A wallet: totals from the lookup, then the drives it wrote to in its most
 * recent stretches of activity; everything only on request, with its cost said.
 */
import {
  arfs,
  clusterHeights,
  mb,
  num,
  parquetL2,
  planReads,
  readAhead,
  rowsOf,
  shortId,
  sq,
} from '@ar-io/index-client';

import { CONFIG } from '../config.js';
import { type EntityRecord, toRecord } from '../model/arfs.js';
import type { Session } from '../session.js';
import { emptyContent, type Fact } from '../store.js';

export interface WalletDrive {
  drive_id: string;
  records: number;
  privacy: string;
  last: EntityRecord;
  drive: EntityRecord | null;
}

export function createWalletFlow(
  s: Session,
  go: {
    browse: (reset: boolean) => Promise<void>;
    openDrive: (id: string, confirmed: boolean, folder: string | null) => Promise<void>;
  },
) {
  const st = s.store;

  async function openWallet(addr: string, everything: boolean, confirmed = false): Promise<void> {
    const my = ++s.nav;
    if (!everything) s.pushHistory({ kind: 'wallet', key: addr });
    if (!(await s.ready()) || s.overtaken(my)) return;
    s.clearView();
    const crumbs = [
      { label: 'Drives', go: () => void go.browse(true) },
      { label: `Wallet ${shortId(addr)}`, go: null },
    ];
    st.content.value = {
      ...emptyContent(),
      crumbs,
      title: `Wallet ${shortId(addr)}`,
      sub: 'Totals from the index’s wallet lookup…',
    };
    const r = await s.measured('Reading the wallet', async () => {
      const [t] = rowsOf(await s.engine!.query(`SELECT * FROM wallet_totals(${sq(addr)})`));
      if (!t || !Number(t.uploads)) return null;
      const p = st.currentPeriod()!;
      const bands = s.registeredBands();
      const heights = (
        s.hasLookups
          ? rowsOf(
              await s.engine!.query(
                `SELECT DISTINCT height FROM lookup_wallet WHERE addr8 = key64(unb64u(${sq(addr)})) AND role = 0 ORDER BY 1`,
              ),
            )
          : rowsOf(
              await s.engine!.query(
                `SELECT DISTINCT height FROM ${parquetL2.itemsSql(bands, p.lo, p.hi, true)} WHERE owner_address = unb64u(${sq(addr)}) ORDER BY 1`,
              ),
            )
      ).map((x) => Number(x.height));
      const clusters = clusterHeights(heights, CONFIG.clusterGap);
      // Recent activity first: the last few stretches of blocks reveal the
      // drives in use. At most 400 stretches in one question, newest first.
      const use = everything
        ? clusters.slice(-CONFIG.walletMax)
        : clusters.slice(-CONFIG.walletRecent);
      // What reading those stretches fetches, from the files' footers: said
      // before a large read of everything, and read ahead in parallel.
      const reads = await planReads(s.engine!, parquetL2.clustersReadAhead(bands, use));
      const capped = everything && clusters.length > CONFIG.walletMax;
      if (everything && !confirmed && reads.bytes > CONFIG.askFirstBytes)
        return { t, clusters, used: use.length, capped, ask: reads.bytes, recs: [] };
      await readAhead(s.engine!, reads, { stop: () => s.overtaken(my) });
      const recs = rowsOf(
        await s.engine!.query(
          `SELECT * FROM (${arfs.clusterSql(bands, use, `owner = ${sq(addr)}`)}) ORDER BY height DESC LIMIT ${CONFIG.walletRows}`,
        ),
      ).map(toRecord);
      return { t, clusters, used: use.length, capped, ask: null, recs };
    });
    if (!r || s.overtaken(my)) return;
    if (!r.out) {
      st.content.value = {
        ...st.content.value,
        sub: 'This wallet has no ArDrive uploads in the index.',
      };
      st.say(r.receipt, 'ok');
      return;
    }
    const { t, clusters, used, capped, ask, recs } = r.out;
    if (ask !== null) {
      st.content.value = {
        ...st.content.value,
        sub: `${num(clusters.length)} stretches of blocks with this wallet’s uploads.`,
        cost: {
          text: [
            `Finding ${capped ? `its drives over the newest ${num(used)} stretches` : 'every drive it wrote to'} reads about `,
            mb(ask),
            ' of the index.',
          ],
          action: {
            label: `Read ${mb(ask)} and find them`,
            go: () => void openWallet(addr, true, true),
          },
        },
      };
      st.say('');
      return;
    }
    const driveIds = new Map<string, WalletDrive>();
    for (const x of recs) {
      if (!x.drive_id) continue;
      const d = driveIds.get(x.drive_id) || {
        drive_id: x.drive_id,
        records: 0,
        privacy: x.privacy,
        last: x,
        drive: null,
      };
      d.records += 1;
      if (x.kind === 'drive' && (!d.drive || x.height > d.drive.height)) d.drive = x;
      driveIds.set(x.drive_id, d);
    }
    const list = [...driveIds.values()].sort((a, b) => b.last.height - a.last.height);
    const facts: Fact[] = [
      { dt: 'Uploads', dd: num(t.uploads as number) },
      { dt: 'Data uploaded', dd: `${Number(t.gib_uploaded).toFixed(2)} GiB` },
      { dt: 'First block', dd: num(t.first_block as number) },
      { dt: 'Last block', dd: num(t.last_block as number) },
      { dt: 'Active stretches', dd: num(clusters.length) },
      { dt: 'Address', dd: addr, mono: true },
    ];
    const sub = everything
      ? capped
        ? `Drives this wallet wrote to in its newest ${CONFIG.walletMax} stretches of activity (of ${num(clusters.length)}; the rest are not read in a browser).`
        : `Every drive this wallet wrote to, from all ${num(clusters.length)} stretches of blocks it was active in.`
      : `Drives it wrote to in its ${used === 1 ? 'latest stretch' : `last ${used} stretches`} of activity${clusters.length > used ? ` (of ${num(clusters.length)})` : ''}.`;
    st.content.value = {
      ...emptyContent(),
      crumbs,
      title: `Wallet ${shortId(addr)}`,
      sub: sub + (list.length ? '' : ' No drive records in those stretches.'),
      facts,
      table: {
        cols: [],
        rows: list as unknown as Record<string, unknown>[],
        preset: 'walletDrives',
      },
      more: [
        ...(!everything && clusters.length > used
          ? [
              {
                kind: 'button' as const,
                label: `Find ${clusters.length > CONFIG.walletMax ? `its drives over the newest ${CONFIG.walletMax} stretches` : 'every drive'}`,
                go: () => void openWallet(addr, true),
              },
            ]
          : []),
      ],
      portalWallet: addr,
      namesNote: list.some((d) => d.privacy !== 'private' && d.drive),
      exportable: {
        cols: [
          'id',
          'kind',
          'drive_id',
          'entity_id',
          'parent_folder_id',
          'created_at',
          'height',
          'privacy',
          'app',
          'app_version',
        ],
        rows: recs as unknown as Record<string, unknown>[],
        isTime: new Set(['created_at']),
        slug: `wallet-${addr.slice(0, 8)}`,
      },
    };
    for (const d of list)
      if (d.drive && d.privacy !== 'private') s.names.want(d.drive.id, d.drive.record_size, false);
    st.say(r.receipt, 'ok');
  }

  return { openWallet };
}
