/**
 * cdb64.ar.io: which Arweave transaction holds a data item, looked up in the
 * browser, plus every index the gateway publishes, verified.
 *
 * A lookup searches, in order: the root-tx bands the gateway's signed
 * publication lists above the packs' height (every byte checked against the
 * band's torrent), the three root-tx packs on Arweave that cdb64.ar.io has
 * always read (to block 1,820,000, plain range reads: no publication covers
 * them), then the remaining published bands. Any hit is then checked against
 * the data: the SHA-256 of the item's signature, read at its offset in the
 * root transaction, must be the id.
 */
import { signal } from '@preact/signals';
import type { CheckState, ProofChecks } from '@ar-io/explorer-ui';
import {
  autoCandidates,
  type Band,
  cdb64,
  type FetchedPublication,
  fetchPublication,
  fetchBandDates,
  fetchWithTimeout,
  hostOf,
  KNOWN_PUBLISHERS,
  mirrorsOf,
  pickGateway,
  type Proof,
  type RangeReader,
  rangeable,
  rangeSpec,
  REGISTRY_GATEWAYS,
  registerRangeReader,
  selectIndex,
  verifyPublication,
  type IndexBands,
  isId43,
  num,
} from '@ar-io/index-client';
import PACKS from './data/packs.json';

export interface PackInfo extends cdb64.Cdb64Pack {
  about: string;
  size: string;
  published: string;
  txCount: number;
}
export const PACK_SET = PACKS as unknown as {
  toHeight: number;
  txs: string[];
  packs: PackInfo[];
};
/** The original page's example: an image from the ar.io docs. */
export const EXAMPLE_ID = 'YAXoMBQkkreZfg1UdUEnJ__i366bha5i2z3zU08dgd8';
/** Gateways a reader can pick to read Arweave data (the packs, the item, its root) from. */
export const ARWEAVE_GATEWAYS = (import.meta.env.VITE_ARWEAVE_GATEWAYS as string | undefined)
  ?.split(',')
  .map((g) => g.trim())
  .filter(Boolean) ?? [
  'https://turbo-gateway.com',
  'https://vilenarios.com',
  'https://arweave.net',
];

const env = import.meta.env as Record<string, string | undefined>;
const list = (v: string | undefined): string[] | null =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
export const CONFIG = {
  registryGateways: list(env.VITE_REGISTRY_GATEWAYS) ?? REGISTRY_GATEWAYS,
  publishers: list(env.VITE_PUBLISHERS) ?? KNOWN_PUBLISHERS,
  portalUrl: 'https://gateways.ar.io',
} as const;

export interface IndexView extends IndexBands {
  /** Every band the publication lists for the index, dropped ones included, for the table. */
  all: Band[];
  records: number;
  size: number;
  tip: number | null;
  /** The newest band's last block time, when known. */
  tipTime: number | null;
}

export interface LookupStep {
  /** Which index the read was for: a band id or a pack name. */
  index: string;
  kind: cdb64.Cdb64Stage | 'manifest';
  text: string;
  bytes: number;
}

export type StageName = 'partition' | cdb64.Cdb64Stage;
export interface StageState {
  state: 'idle' | 'active' | 'done';
  reads: number;
  bytes: number;
}
export interface GroupState {
  key: string;
  label: string;
  /** Who vouches for the answer: a signed publication, or nobody (checked against the data). */
  trust: 'signed' | 'unsigned';
  state: 'wait' | 'checking' | 'miss' | 'hit' | 'skip' | 'error';
  note: string;
}

export interface ItemCheckRow {
  text: string;
  state: 'ok' | 'bad' | 'skip' | 'wait';
}

export interface Found {
  rootTxId: string;
  path: string[] | null;
  rootDataItemOffset: number | null;
  rootDataOffset: number | null;
  dataItemSize: number | null;
  /** Where the answer came from. */
  source:
    | { kind: 'band'; band: Band; partition: string }
    | { kind: 'pack'; pack: PackInfo; tx: string; offset: number };
}

export interface LookupResult {
  id: string;
  found: Found | null;
  steps: LookupStep[];
  bytes: number;
  reads: number;
  ms: number;
  /** The gateway Arweave data was read from. */
  arweaveGateway: string | null;
  error: string | null;
  checks: ItemCheckRow[];
  hash: { id: string; digest: string } | null;
  checkVerdict: 'ok' | 'bad' | null;
  item: { url: string; label: string; image: string | null } | null;
}

const freshStages = (): Record<StageName, StageState> => ({
  partition: { state: 'idle', reads: 0, bytes: 0 },
  table: { state: 'idle', reads: 0, bytes: 0 },
  slot: { state: 'idle', reads: 0, bytes: 0 },
  record: { state: 'idle', reads: 0, bytes: 0 },
});

export class Store {
  readonly proof = signal<{ state: 'run' | 'ok' | 'bad'; text: string; checks: ProofChecks }>({
    state: 'run',
    text: "Checking the publisher's signature…",
    checks: { registry: '', signature: '', engine: '', pieces: '' },
  });
  readonly pub = signal<{
    verified: boolean;
    doc: FetchedPublication | null;
    proof: Proof | null;
    gateway: string | null;
    publisherName: string | null;
    auto: boolean;
    chainTip: number | null;
  }>({
    verified: false,
    doc: null,
    proof: null,
    gateway: null,
    publisherName: null,
    auto: true,
    chainTip: null,
  });
  readonly indexes = signal<IndexView[]>([]);
  readonly gatewayChoice = signal('auto');
  readonly customGateway = signal('');
  readonly status = signal<{ text: string; cls: '' | 'ok' | 'bad' }>({ text: '', cls: '' });
  readonly rangeOk = signal<{ ok: boolean; why: string | null }>({ ok: false, why: 'starting' });
  readonly lookup = signal<LookupResult | null>(null);
  readonly looking = signal(false);
  /** The id box: set by a link, the example, or typing. */
  readonly query = signal('');
  /** Where Arweave data is read from: 'auto', or a gateway URL. */
  readonly readFrom = signal('auto');
  readonly stages = signal<Record<StageName, StageState>>(freshStages());
  readonly groups = signal<GroupState[]>([]);
  say(text: string, cls: '' | 'ok' | 'bad' = ''): void {
    this.status.value = { text, cls };
  }
  setCheck(k: keyof ProofChecks, state: CheckState): void {
    const p = this.proof.value;
    this.proof.value = { ...p, checks: { ...p.checks, [k]: state } };
  }
}

export class Session {
  reader: RangeReader | null = null;
  gateway: string | null = null;
  constructor(readonly store: Store) {}

  get mirrors(): string[] {
    return mirrorsOf(this.gateway, CONFIG.publishers);
  }

  async start(): Promise<void> {
    const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
    // The original page's links were #<id>; these are #gw=…&id=…. Both run the lookup.
    const bare = /^[A-Za-z0-9_-]{43}$/.test(hash) ? hash : null;
    const q = new URLSearchParams(bare ? '' : hash);
    const gw = q.get('gw');
    if (gw) {
      if (CONFIG.publishers.includes(gw)) this.store.gatewayChoice.value = gw;
      else {
        this.store.gatewayChoice.value = 'custom';
        this.store.customGateway.value = gw;
      }
    }
    const id = bare ?? q.get('id');
    if (id && isId43(id)) this.store.query.value = id;
    this.reader = await registerRangeReader();
    this.store.rangeOk.value = { ok: this.reader.ok, why: this.reader.why };
    await this.readPublication();
    if (id && isId43(id)) await this.lookup(id);
  }

  async readPublication(): Promise<void> {
    const st = this.store;
    let checking = false;
    st.proof.value = {
      state: 'run',
      text: "Checking the publisher's signature…",
      checks: { registry: '', signature: '', engine: '', pieces: '' },
    };
    st.indexes.value = [];
    st.lookup.value = null;
    try {
      st.say('Finding a gateway');
      const choice =
        st.gatewayChoice.value === 'custom' ? st.customGateway.value : st.gatewayChoice.value;
      // Any index will do: this page shows them all.
      const picked = await pickGateway({
        choice,
        indexName: 'root-tx-index',
        candidates: autoCandidates(location, CONFIG.publishers),
      }).catch(() =>
        pickGateway({
          choice,
          indexName: 'parquet-l1',
          candidates: autoCandidates(location, CONFIG.publishers),
        }),
      );
      this.gateway = picked.gateway;
      const fetched = picked.publication ?? (await fetchPublication(picked.gateway));
      st.say('Verifying the publication signature against the gateway registry');
      checking = true;
      const proof = await verifyPublication(fetched.doc, {
        registryGateways: CONFIG.registryGateways,
        excluding: picked.gateway,
        onCheck: (c, s) => st.setCheck(c, s),
      });
      const publisherName = proof.publisherUrl ? hostOf(proof.publisherUrl) : null;
      const views: IndexView[] = [];
      for (const ix of fetched.doc.indexes) {
        const sel = selectIndex(fetched.doc, ix.name, {
          gateway: picked.gateway,
          mirrors: this.mirrors,
          dropEmpty: false,
        });
        const all = sel.bands;
        const tipBand = all[all.length - 1];
        views.push({
          ...sel,
          all,
          records: all.reduce((t, b) => t + b.records, 0),
          size: all.reduce((t, b) => t + b.size, 0),
          tip: tipBand ? tipBand.to : null,
          tipTime: null,
        });
      }
      st.pub.value = {
        verified: true,
        doc: fetched,
        proof,
        gateway: picked.gateway,
        publisherName,
        auto: picked.auto,
        chainTip: null,
      };
      st.proof.value = {
        ...st.proof.value,
        state: 'ok',
        text:
          (publisherName
            ? `Verified · signed by ${publisherName}`
            : 'Verified · signed by its publisher') +
          (proof.expired ? ' · this publication has expired' : ''),
      };
      st.indexes.value = views;
      st.say('');
      // Cosmetic: the dates of every tip, and the chain's own tip, from GraphQL.
      const heights = views.flatMap((v) =>
        v.tip !== null ? [v.tip] : v.all.length ? [v.all[v.all.length - 1]!.from] : [],
      );
      const dates = await fetchBandDates([picked.gateway, ...this.mirrors], heights);
      st.indexes.value = views.map((v) => ({ ...v, tipTime: dates.get(v.tip ?? -1) ?? null }));
      st.pub.value = { ...st.pub.value, chainTip: await this.chainTip() };
    } catch (e) {
      const checks = st.proof.value.checks;
      for (const k of ['registry', 'signature'] as const)
        if (checks[k] === 'run') st.setCheck(k, 'bad');
      const msg = e instanceof Error ? e.message : String(e);
      st.proof.value = {
        ...st.proof.value,
        state: 'bad',
        text: (checking ? 'Not verified · ' : 'Could not read the publication · ') + msg,
      };
      st.pub.value = { ...st.pub.value, verified: false, doc: null };
      st.say('Refusing this publication: ' + msg, 'bad');
    }
  }

  private async chainTip(): Promise<number | null> {
    for (const g of [this.gateway, ...this.mirrors].filter((x): x is string => !!x)) {
      try {
        const res = await fetchWithTimeout(g + '/graphql', 8000, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: '{ blocks(first: 1) { edges { node { height } } } }' }),
        });
        if (!res.ok) continue;
        const h = (
          (await res.json()) as { data?: { blocks?: { edges?: { node?: { height?: number } }[] } } }
        ).data?.blocks?.edges?.[0]?.node?.height;
        if (typeof h === 'number') return h;
      } catch {
        /* next */
      }
    }
    return null;
  }

  /** A verified range read through the service worker: nothing else is accepted. */
  private async read(band: Band, file: string, start: number, end: number): Promise<Uint8Array> {
    const reader = this.reader;
    if (!reader?.ok)
      throw new Error(
        `the range reader is off here (${reader?.why ?? 'not started'}), so nothing can be read and checked`,
      );
    if (!band.torrent)
      throw new Error(`band ${band.id} has no torrent, so its files cannot be verified in ranges`);
    const f = band.files.get(file);
    if (!f) throw new Error(`${band.id} lists no ${file}`);
    const res = await fetch(reader.url(rangeSpec(band, f, { mirrors: this.mirrors })), {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (res.status !== 206 && res.status !== 200)
      throw new Error((await res.text()) || `read of ${file} failed (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== end - start + 1)
      throw new Error(
        `the reader returned ${bytes.length} bytes for a ${end - start + 1}-byte range`,
      );
    return bytes;
  }

  /** The gateway Arweave data is read from: the reader's pick, or the first that answers a range. */
  private async arweaveGateway(): Promise<string> {
    const pick = this.store.readFrom.value;
    if (pick !== 'auto') return pick;
    const cands = [
      ...(location.protocol === 'https:' && !/\.ar\.io$/.test(location.hostname)
        ? [location.origin]
        : []),
      ...ARWEAVE_GATEWAYS,
    ];
    const [txIndex, offset] = PACK_SET.packs[0]!.parts[0]!;
    const tx = PACK_SET.txs[txIndex]!;
    for (const c of cands) {
      try {
        const r = await fetchWithTimeout(`${c}/${tx}`, 8000, {
          headers: { Range: `bytes=${offset}-${offset + 15}` },
        });
        if (r.status === 206) return c;
      } catch {
        /* next */
      }
    }
    throw new Error('no gateway answered a range read of Arweave data');
  }

  private mark(stage: StageName, state: StageState['state'], bytes = 0): void {
    const all = this.store.stages.value;
    const cur = all[stage];
    this.store.stages.value = {
      ...all,
      [stage]: {
        state,
        reads: cur.reads + (state === 'done' && bytes ? 1 : 0),
        bytes: cur.bytes + (state === 'done' ? bytes : 0),
      },
    };
  }

  private setGroup(key: string, state: GroupState['state'], note: string): void {
    this.store.groups.value = this.store.groups.value.map((g) =>
      g.key === key ? { ...g, state, note } : g,
    );
  }

  /**
   * Which root transaction holds a data item, and where. Published bands above
   * the packs' height first (verified reads), then the packs on Arweave, then
   * the older published bands; the first hit wins and is checked against the data.
   */
  async lookup(id: string): Promise<void> {
    const st = this.store;
    if (st.looking.value) return;
    st.query.value = id;
    st.looking.value = true;
    st.stages.value = freshStages();
    const key = id;
    const pfx = (() => {
      const b = atob(key.replace(/-/g, '+').replace(/_/g, '/') + '=');
      return b.charCodeAt(0).toString(16).padStart(2, '0');
    })();
    st.stages.value = {
      ...st.stages.value,
      partition: { state: 'done', reads: 0, bytes: 0 },
    };
    const ix = st.indexes.value.find((i) => i.kind === 'cdb64-root-tx');
    const verified = st.pub.value.verified;
    const usable = ix ? ix.all.filter((b) => rangeable(this.reader, b)) : [];
    const above = usable.filter((b) => b.to === null || b.to > PACK_SET.toHeight);
    const below = usable.filter((b) => !above.includes(b));
    const pubName = st.pub.value.publisherName ?? 'its publisher';
    const why = !ix
      ? 'this gateway publishes no root-tx index'
      : !verified
        ? 'the publication did not verify'
        : !usable.length
          ? st.rangeOk.value.ok
            ? 'no band has a torrent to check reads against'
            : `range reads are off here (${st.rangeOk.value.why})`
          : '';
    st.groups.value = [
      {
        key: 'above',
        label:
          `Published bands above block ${num(PACK_SET.toHeight)}` +
          (above.length ? ` (${above.length})` : ''),
        trust: 'signed',
        state: why || !above.length ? 'skip' : 'wait',
        note: why || (!above.length ? 'none' : `signed by ${pubName}`),
      },
      ...PACK_SET.packs.map(
        (p): GroupState => ({
          key: 'pack:' + p.id,
          label: `${p.name} pack`,
          trust: 'unsigned',
          state: 'wait',
          note: `to block ${num(PACK_SET.toHeight)}`,
        }),
      ),
      {
        key: 'below',
        label:
          `Published bands to block ${num(PACK_SET.toHeight)}` +
          (below.length ? ` (${below.length})` : ''),
        trust: 'signed',
        state: why || !below.length ? 'skip' : 'wait',
        note: why || (!below.length ? 'none' : `signed by ${pubName}`),
      },
    ];
    const steps: LookupStep[] = [];
    const result: LookupResult = {
      id,
      found: null,
      steps,
      bytes: 0,
      reads: 0,
      ms: 0,
      arweaveGateway: null,
      error: null,
      checks: [],
      hash: null,
      checkVerdict: null,
      item: null,
    };
    const publish = () =>
      (st.lookup.value = { ...result, steps: [...steps], checks: [...result.checks] });
    publish();
    st.say('Looking it up…');
    const t0 = performance.now();
    // Once an answer is in, the other searches stop at their next read.
    let settled = false;
    class Abandoned extends Error {}
    const log = (index: string, kind: LookupStep['kind'], text: string, bytes: number) => {
      result.reads += 1;
      result.bytes += bytes;
      steps.push({ index, kind, text, bytes });
      if (kind !== 'manifest') this.mark(kind, 'done', bytes);
      publish();
    };

    // Published bands, through the verified range reader.
    const searchBands = async (group: 'above' | 'below', bands: Band[]): Promise<Found | null> => {
      if (why || !bands.length) return null;
      this.setGroup(group, 'checking', 'reading');
      let kind: LookupStep['kind'] = 'table';
      const watch = this.reader ? await this.reader.watch('Looking up') : null;
      try {
        const hit = await cdb64.lookupRoot(id, {
          bands,
          onStage: (_b, s) => {
            kind = s;
            this.mark(s, 'active');
          },
          read: async (band, file, start, end) => {
            if (settled) throw new Abandoned();
            if (file === 'manifest.json') kind = 'manifest';
            const bytes = await this.read(band, file, start, end);
            log(band.id, kind, `${band.id} ${file} bytes ${start}–${end}`, bytes.length);
            return bytes;
          },
        });
        const r = watch ? await watch.done() : null;
        if (r && watch && !watch.fail && (r.checked > 0 || r.reused > 0))
          st.setCheck('pieces', 'ok');
        if (hit) {
          this.setGroup(group, 'hit', `found in ${hit.band.id}`);
          return {
            rootTxId: hit.rootTxId,
            path: hit.path,
            rootDataItemOffset: hit.rootDataItemOffset,
            rootDataOffset: hit.rootDataOffset,
            dataItemSize: hit.dataItemSize,
            source: { kind: 'band', band: hit.band, partition: hit.partition },
          };
        }
        this.setGroup(
          group,
          'miss',
          `not here, ${bands.length} band${bands.length === 1 ? '' : 's'}`,
        );
        return null;
      } catch (e) {
        if (watch) await watch.done();
        if (e instanceof Abandoned) {
          this.setGroup(group, 'skip', 'not needed: found elsewhere first');
          return null;
        }
        if (watch?.fail?.code === 'integrity') st.setCheck('pieces', 'bad');
        const msg = watch?.fail
          ? `${watch.fail.msg}; nothing unverified was used`
          : String((e as Error).message ?? e);
        this.setGroup(group, 'error', msg);
        return null;
      }
    };

    // The packs on Arweave: plain range reads, checked against the data afterwards.
    let agw: string | null = null;
    const searchPacks = async (): Promise<Found | null> => {
      let kind: LookupStep['kind'] = 'table';
      try {
        agw = await this.arweaveGateway();
        result.arweaveGateway = agw;
        const gw = agw;
        const found = await cdb64.lookupPacks(
          id,
          PACK_SET,
          async (tx, start, end) => {
            if (settled) throw new Abandoned();
            const r = await fetchWithTimeout(`${gw}/${tx}`, 30000, {
              headers: { Range: `bytes=${start}-${end}` },
            });
            if (r.status !== 206 && r.status !== 200)
              throw new Error(`range read failed: HTTP ${r.status}`);
            const b = new Uint8Array(await r.arrayBuffer());
            log(
              `pack:${tx}`,
              kind,
              `tx ${tx.slice(0, 6)}…${tx.slice(-4)} bytes ${start}–${end}`,
              b.length,
            );
            return b;
          },
          {
            pack: (p) => this.setGroup('pack:' + p.id, 'checking', `partition ${pfx}`),
            stage: (_p, s) => {
              kind = s;
              this.mark(s, 'active');
            },
            miss: (p) => this.setGroup('pack:' + p.id, 'miss', 'not here'),
          },
        );
        if (!found) return null;
        const pack = found.pack as PackInfo;
        this.setGroup(
          'pack:' + pack.id,
          'hit',
          `found, partition ${pfx} in tx ${found.tx.slice(0, 6)}…`,
        );
        return {
          rootTxId: found.rootTxId,
          path: found.path,
          rootDataItemOffset: found.rootDataItemOffset,
          rootDataOffset: found.rootDataOffset,
          dataItemSize: found.dataItemSize,
          source: { kind: 'pack', pack, tx: found.tx, offset: found.offset },
        };
      } catch (e) {
        const abandoned = e instanceof Abandoned;
        const cur = st.groups.value.find(
          (g) => g.key.startsWith('pack:') && g.state === 'checking',
        );
        for (const g of st.groups.value)
          if (g.key.startsWith('pack:') && (g === cur || g.state === 'wait'))
            this.setGroup(
              g.key,
              abandoned ? 'skip' : 'error',
              abandoned
                ? 'not needed: found elsewhere first'
                : g === cur
                  ? `read failed: ${(e as Error).message}`
                  : (e as Error).message,
            );
        return null;
      }
    };

    // The newest bands and the packs together: the first answer wins.
    const firstHit = (ps: Promise<Found | null>[]): Promise<Found | null> =>
      new Promise((resolve) => {
        let left = ps.length;
        for (const p of ps)
          void p.then((v) => {
            if (v && !settled) {
              settled = true;
              resolve(v);
            } else if (--left === 0) resolve(null);
          });
      });

    try {
      let found = await firstHit([searchBands('above', above), searchPacks()]);
      if (!found) found = await searchBands('below', below);
      settled = true;
      result.found = found;
      const hit = !!found;
      for (const g of st.groups.value)
        if (g.state === 'wait') this.setGroup(g.key, 'skip', 'not needed');
      result.ms = Math.round(performance.now() - t0);
      for (const k of ['table', 'slot', 'record'] as const)
        if (st.stages.value[k].state === 'active') this.mark(k, 'idle');
      const summary = `${num(result.bytes)} bytes in ${result.reads} range read${result.reads === 1 ? '' : 's'}, ${fmtMs(result.ms)}.`;
      if (!result.found) {
        const failed = st.groups.value.filter((g) => g.state === 'error');
        result.error = failed.length ? failed.map((g) => `${g.label}: ${g.note}`).join('; ') : null;
        publish();
        st.say(
          failed.length
            ? `Not found, and some indexes could not be read (${result.error}). ${summary} Try another gateway.`
            : `Not in any index this page reads. ${summary} It might be newer than the newest published band, or not a data item in a bundle.`,
          failed.length ? 'bad' : '',
        );
        return;
      }
      const f = result.found;
      st.say(
        f.source.kind === 'band'
          ? `Found in ${f.source.band.id}, a band ${pubName} signed. ${summary}`
          : `Found in the ${f.source.pack.name} pack on Arweave. ${summary}`,
        'ok',
      );
      publish();
      await this.checkAgainstData(result, agw);
    } finally {
      st.looking.value = false;
    }
  }

  /**
   * The answer against the data, as the original page did: what the gateway itself says the
   * root is, then the item's signature at its offset in the root transaction,
   * whose SHA-256 must be the id. Then a link to the item, and an image preview.
   */
  private async checkAgainstData(result: LookupResult, agwIn: string | null): Promise<void> {
    const st = this.store;
    const f = result.found!;
    const publish = () => (st.lookup.value = { ...result, checks: [...result.checks] });
    let agw = agwIn;
    try {
      agw ??= await this.arweaveGateway();
    } catch (e) {
      result.checks.push({
        text: `No gateway answered, so the answer was not checked against the data (${(e as Error).message}).`,
        state: 'skip',
      });
      publish();
      return;
    }
    result.arweaveGateway = agw;
    const host = agw.replace(/^https?:\/\//, '');
    const url = `${agw}/${result.id}`;
    let headers: Headers | null = null;
    let type = '';
    let total = 0;
    try {
      const r = await fetchWithTimeout(url, 20000, { headers: { Range: 'bytes=0-0' } });
      headers = r.headers;
      type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim();
      total = Number(
        (r.headers.get('content-range') ?? '').split('/')[1] ||
          r.headers.get('content-length') ||
          0,
      );
      r.body?.cancel().catch(() => {});
    } catch {
      /* the item may not be served; the offset check still runs */
    }
    result.item = {
      url,
      label: `Open it on ${host}${type ? ` (${type}${total ? ', ' + fmtSize(total) : ''})` : ''}`,
      image: type.startsWith('image/') && total > 0 && total <= 15 * 1024 * 1024 ? url : null,
    };
    const gwRoot = headers?.get('x-ar-io-root-transaction-id');
    if (gwRoot)
      result.checks.push(
        gwRoot === f.rootTxId
          ? { text: `${host} reports the same root transaction, from its own lookup.`, state: 'ok' }
          : {
              text: `${host} reports a different root transaction, ${gwRoot.slice(0, 6)}…${gwRoot.slice(-4)}.`,
              state: 'bad',
            },
      );
    let off = f.rootDataItemOffset;
    if (off === null && headers) {
      const h = headers.get('x-ar-io-root-data-item-offset');
      if (h !== null && h !== '') off = Number(h);
    }
    if (off === null || !Number.isFinite(off) || !crypto?.subtle) {
      result.checks.push({
        text: `${host} did not say where the item sits inside the root transaction, so its signature was not checked here.`,
        state: 'skip',
      });
      publish();
      return;
    }
    const row: ItemCheckRow = {
      text: `Reading the signature at byte ${num(off)} of the root transaction…`,
      state: 'wait',
    };
    result.checks.push(row);
    publish();
    try {
      const c = await cdb64.checkItemAtOffset(result.id, off, async (s, e) => {
        const r = await fetchWithTimeout(`${agw}/${f.rootTxId}`, 30000, {
          headers: { Range: `bytes=${s}-${e}` },
        });
        if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      });
      if (c.state === 'skip')
        Object.assign(row, {
          text: `The item ${c.why}, so its signature was not checked.`,
          state: 'skip',
        });
      else {
        Object.assign(row, {
          state: c.state,
          text:
            c.state === 'ok'
              ? `The item at byte ${num(off)} of the root transaction has a ${c.signatureBytes}-byte signature whose SHA-256 is the id you asked for.`
              : `The ${c.signatureBytes}-byte signature at byte ${num(off)} does not hash to this id.`,
        });
        result.hash = { id: result.id, digest: c.digest };
        result.checkVerdict = c.state;
      }
    } catch (e) {
      Object.assign(row, {
        text: `The signature could not be read (${(e as Error).message}).`,
        state: 'skip',
      });
    }
    publish();
  }
}

const fmtMs = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtSize = (n: number): string =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;
