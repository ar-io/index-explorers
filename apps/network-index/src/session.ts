/**
 * The network index page: the gateway's publication, verified, every index it
 * publishes with its bands, and a CDB64 lookup in the browser through the
 * verified range reader.
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
} from '@ar-io/index-client';

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
  text: string;
  bytes?: number;
}

export interface LookupResult {
  id: string;
  found: cdb64.RootLocation | null;
  steps: LookupStep[];
  bytes: number;
  reads: number;
  bands: number;
  error: string | null;
}

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
    const q = new URLSearchParams(location.hash.replace(/^#/, ''));
    const gw = q.get('gw');
    if (gw) {
      if (CONFIG.publishers.includes(gw)) this.store.gatewayChoice.value = gw;
      else {
        this.store.gatewayChoice.value = 'custom';
        this.store.customGateway.value = gw;
      }
    }
    this.reader = await registerRangeReader();
    this.store.rangeOk.value = { ok: this.reader.ok, why: this.reader.why };
    await this.readPublication();
    const id = q.get('id');
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

  /** Which root transaction holds a data item: the root-tx bands, newest first, through verified reads. */
  async lookup(id: string): Promise<void> {
    const st = this.store;
    const ix = st.indexes.value.find((i) => i.kind === 'cdb64-root-tx');
    if (!ix) {
      st.say('this gateway publishes no root-tx index', 'bad');
      return;
    }
    const bands = ix.all.filter((b) => rangeable(this.reader, b));
    if (!bands.length) {
      st.say(
        `nothing can be read: ${st.rangeOk.value.ok ? 'no band has a torrent to verify against' : st.rangeOk.value.why}`,
        'bad',
      );
      return;
    }
    st.looking.value = true;
    st.say('Reading…');
    const steps: LookupStep[] = [];
    const result: LookupResult = {
      id,
      found: null,
      steps,
      bytes: 0,
      reads: 0,
      bands: 0,
      error: null,
    };
    st.lookup.value = result;
    const touched = new Set<string>();
    const watch = this.reader ? await this.reader.watch('Looking up') : null;
    try {
      const found = await cdb64.lookupRoot(id, {
        bands,
        read: async (band, file, start, end) => {
          const bytes = await this.read(band, file, start, end);
          touched.add(band.id);
          result.reads += 1;
          result.bytes += bytes.length;
          steps.push({
            text: `${band.id}: ${file} bytes ${start.toLocaleString()}–${end.toLocaleString()}`,
            bytes: bytes.length,
          });
          st.lookup.value = { ...result, steps: [...steps], bands: touched.size };
          return bytes;
        },
      });
      result.found = found;
      result.bands = touched.size;
      const r = watch ? await watch.done() : null;
      if (r && watch && !watch.fail && (r.checked > 0 || r.reused > 0)) st.setCheck('pieces', 'ok');
      st.lookup.value = { ...result, steps: [...steps] };
      st.say(
        found
          ? `Found in ${found.band.id}: ${result.reads} verified range reads, ${result.bytes.toLocaleString()} bytes requested${r ? `, ${r.fetched.toLocaleString()} bytes fetched in ${r.checked} checked piece${r.checked === 1 ? '' : 's'}` : ''}.`
          : `Not in any of the ${bands.length} root-tx bands this publication lists (${result.reads} reads).`,
        found ? 'ok' : '',
      );
    } catch (e) {
      if (watch) await watch.done();
      const msg = watch?.fail
        ? `${watch.fail.msg}. Refused: nothing unverified was used.`
        : e instanceof Error
          ? e.message
          : String(e);
      if (watch?.fail?.code === 'integrity') st.setCheck('pieces', 'bad');
      st.lookup.value = { ...result, steps: [...steps], error: msg };
      st.say('Could not resolve it: ' + msg, 'bad');
    } finally {
      st.looking.value = false;
    }
  }
}
