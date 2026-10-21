/**
 * Find: a drive id, a wallet, any upload id, or a block height. An id is
 * looked up through the index's id lookup, then its wallet lookup.
 */
import {
  arfs,
  bytesText,
  fmtWhen,
  isId43,
  isUuid,
  num,
  parquetL2,
  rowsOf,
  shortId,
  sq,
} from '@ar-io/index-client';

import { toRecord } from '../model/arfs.js';
import type { Session } from '../session.js';
import { emptyContent, type Fact } from '../store.js';

export interface IdHit {
  id: string;
  height: number;
  owner: string;
  data_size: number;
  content_type: string | null;
  bundle: string | null;
  tags: string | null;
}

export function createFindFlows(
  s: Session,
  go: {
    browse: (reset: boolean) => Promise<void>;
    openDrive: (id: string, confirmed: boolean, folder: string | null) => Promise<void>;
    openWallet: (addr: string, everything: boolean) => Promise<void>;
    runQuery: (opts: {
      title?: string | null;
      caption?: string | null;
      confirmed?: boolean;
      sql?: string;
    }) => Promise<void>;
  },
) {
  const st = s.store;

  async function openId(id: string): Promise<void> {
    const my = ++s.nav;
    s.pushHistory({ kind: 'id', key: id });
    if (!(await s.ready()) || s.overtaken(my)) return;
    s.clearView();
    const crumbs = [
      { label: 'Drives', go: () => void go.browse(true) },
      { label: shortId(id), go: null },
    ];
    st.content.value = {
      ...emptyContent(),
      crumbs,
      title: `Looking up ${shortId(id)}`,
      sub: 'Through the index’s id lookup, then its wallet lookup.',
    };
    const r = await s.measured('Looking it up', async () => {
      const bands = s.registeredBands();
      const p = st.currentPeriod()!;
      const heights = s.hasLookups
        ? rowsOf(
            await s.engine!.query(
              `SELECT DISTINCT height FROM lookup_id WHERE id8 = key64(unb64u(${sq(id)}))`,
            ),
          ).map((x) => Number(x.height))
        : [];
      const lo = heights.length ? Math.min(...heights) : p.lo;
      const hi = heights.length ? Math.max(...heights) : p.hi;
      const hit =
        !heights.length && s.hasLookups
          ? null
          : ((rowsOf(
              await s.engine!.query(
                `SELECT b64u(i.id) AS id, i.height, b64u(i.owner_address) AS owner, i.data_size, i.content_type, b64u(i.root_transaction_id) AS bundle,
                 (SELECT string_agg(name || '=' || value, '  ') FROM ${parquetL2.tagsSql(bands, lo, hi)} g WHERE g.height = i.height AND g.id = i.id) AS tags
                 FROM ${parquetL2.itemsSql(bands, lo, hi, false)} i WHERE i.id = unb64u(${sq(id)}) LIMIT 1`,
              ),
            )[0] as unknown as IdHit | undefined) ?? null);
      if (hit) {
        hit.height = Number(hit.height);
        hit.data_size = Number(hit.data_size);
        const ent = rowsOf(
          await s.engine!.query(
            `SELECT * FROM ${arfs.entitiesSql(bands, hit.height, hit.height)} WHERE id = ${sq(id)}`,
          ),
        )[0];
        return { hit, ent: ent ? toRecord(ent) : null, wallet: null };
      }
      const [w] = rowsOf(await s.engine!.query(`SELECT * FROM wallet_totals(${sq(id)})`));
      return { hit: null, ent: null, wallet: w && Number(w.uploads) > 0 ? w : null };
    });
    if (!r || s.overtaken(my)) return;
    const { hit, ent, wallet } = r.out;
    if (wallet) {
      await go.openWallet(id, false);
      return;
    }
    if (!hit) {
      st.content.value = {
        ...st.content.value,
        title: `Nothing found for ${shortId(id)}`,
        sub: 'Not an ArDrive upload and not a wallet with ArDrive uploads, by the index’s own lookups. It may be newer than the index, or not ArDrive’s.',
      };
      st.say(r.receipt, 'ok');
      return;
    }
    const kindText = ent ? `${ent.kind} record` : 'file data';
    const Title = kindText[0]!.toUpperCase() + kindText.slice(1);
    const facts: Fact[] = [
      { dt: 'Owner', dd: hit.owner, mono: true },
      { dt: 'Size', dd: bytesText(hit.data_size) },
      { dt: 'Type', dd: hit.content_type || '' },
      { dt: 'Block', dd: num(hit.height) },
      { dt: 'Written', dd: ent && Number(ent.created_at) > 0 ? fmtWhen(ent.created_at) : '' },
      { dt: 'Bundle', dd: hit.bundle ?? '', mono: true },
      { dt: 'Drive', dd: ent?.drive_id ?? '', mono: true },
      { dt: 'Parent folder', dd: ent?.parent_folder_id ?? '', mono: true },
      { dt: 'App', dd: ent ? `${ent.app || ''} ${ent.app_version || ''}`.trim() : '' },
    ];
    const gw = s.gateway ?? '';
    st.content.value = {
      ...emptyContent(),
      crumbs,
      title: ent && ent.privacy !== 'private' ? `${Title}: ` : `${Title} ${shortId(id)}`,
      sub: '',
      facts,
      caption: 'Tags: ' + (hit.tags || '(none)'),
      more: [
        {
          kind: 'link',
          label: ent ? 'Open the record' : 'Open the data',
          href: `${gw}/${ent ? 'raw/' : ''}${id}`,
        },
      ],
      namesNote: !!ent && ent.privacy !== 'private',
      exportable: {
        cols: Object.keys(hit),
        rows: [hit as unknown as Record<string, unknown>],
        isTime: new Set(),
        slug: `id-${id.slice(0, 8)}`,
      },
    };
    // The record view's title carries its name (fetched); a file record also links to its bytes.
    if (ent && ent.privacy !== 'private') {
      st.content.value = {
        ...st.content.value,
        title: '',
        titleName: { prefix: `${Title}: `, id, size: hit.data_size, fallback: shortId(id) },
      };
      s.names.want(id, hit.data_size, true);
    }
    st.say(r.receipt, 'ok');
  }

  async function openHeight(h: number): Promise<void> {
    st.sql.value = `SELECT id, owner, data_size, content_type, app, is_record\nFROM uploads_between(${h}, ${h})\nORDER BY data_size DESC;`;
    st.asked.value = null;
    await go.runQuery({ title: `Block ${num(h)}`, caption: null });
  }

  function find(raw: string): void {
    const v = raw.trim();
    // A rejection must not be overwritten by a listing still finishing.
    s.nav += 1;
    if (!v) {
      st.say('Type a drive id, a wallet address, a file or folder id, or a block height.', 'bad');
      return;
    }
    if (!st.pub.value.verified) {
      st.say('The publication is still being checked; this will work in a moment.', 'bad');
      return;
    }
    if (isUuid(v)) {
      void go.openDrive(v, false, null);
      return;
    }
    if (isId43(v)) {
      void openId(v);
      return;
    }
    if (/^\d[\d,_]*$/.test(v)) {
      void openHeight(Number(v.replace(/[,_]/g, '')));
      return;
    }
    st.say(
      `"${v.slice(0, 48)}" is not a drive id (uuid), a 43-character id or address, or a block height.`,
      'bad',
    );
  }

  return { openId, openHeight, find };
}
