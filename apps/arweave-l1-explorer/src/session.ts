/**
 * The L1 explorer's session: the verified publication's `parquet-l1` bands,
 * the periods (windows) a reader is offered, the engine with the window's
 * views, and the receipts. One instance, created in main.
 */
import { signal, type Signal } from '@preact/signals';
import type { CheckState, ProofChecks, ProgressState } from '@ar-io/explorer-ui';
import {
  autoCandidates,
  type Band,
  columnsOf,
  Engine,
  explainReadError,
  fetchBandDates,
  fetchPublication,
  fetchWithProgress,
  fetchWithTimeout,
  fmtDay,
  fmtRange,
  hostOf,
  mb,
  mirrorsOf,
  num,
  openEngine,
  parquetL1,
  pickGateway,
  type Proof,
  type RangeReader,
  rangeable,
  rangeSpec,
  type Receipt,
  notesText,
  receiptText,
  registerRangeReader,
  rowsOf,
  selectIndex,
  sha256Hex,
  timeColumnsOf,
  verifyPublication,
} from '@ar-io/index-client';

import { CONFIG } from './config.js';
import { lookupSql, PRESETS, presetSql, QUESTIONS, txSql, walletSql } from './questions.js';

type L1Band = parquetL1.RegisteredL1Band;
const DAY = 86400;

/** A period: the bands it reads and, for a calendar year, the dates it is cut to. */
export interface Window {
  id: string;
  label: string;
  bands: Band[];
  from: number | null;
  to: number | null;
  key: string;
  size: number;
}

export interface QueryOpts {
  label?: string;
  caption?: string | null;
  wallet?: string | null;
  note?: string | null;
}

export interface Result {
  cols: string[];
  rows: Record<string, unknown>[];
  isTime: Set<string>;
  label: string;
  caption: string | null;
  /** The caption before {RANGE} was filled in, so the answer can be asked again over more. */
  captionTemplate: string | null;
  wallet: string | null;
  /** The period this answer covers: its key and heights. */
  windowKey: string;
  lo: number;
  hi: number;
  secs: string;
  receipt: string;
  note: string | null;
}

export class Store {
  readonly proof = signal<{ state: 'run' | 'ok' | 'bad'; text: string; checks: ProofChecks }>({
    state: 'run',
    text: "Checking the publisher's signature…",
    checks: { registry: '', signature: '', engine: '', pieces: '' },
  });
  readonly pub = signal<{
    verified: boolean;
    publisher: string | null;
    publisherName: string | null;
    publisherUrl: string | null;
    sequence: number | null;
    gateway: string | null;
    auto: boolean;
    gatewayNote: string;
    expired: boolean;
  }>({
    verified: false,
    publisher: null,
    publisherName: null,
    publisherUrl: null,
    sequence: null,
    gateway: null,
    auto: true,
    gatewayNote: '',
    expired: false,
  });
  readonly hero = signal<{ txs: string; blocks: string; span: string }>({
    txs: '—',
    blocks: '—',
    span: '—',
  });
  readonly gatewayChoice = signal('auto');
  readonly customGateway = signal('');
  readonly windows = signal<Window[]>([]);
  readonly scope = signal('latest');
  readonly pickedBand = signal<string | null>(null);
  readonly loadedKey = signal<string | null>(null);
  readonly status = signal<{ text: string; cls: '' | 'ok' | 'bad' }>({ text: '', cls: '' });
  readonly progress = signal<ProgressState>({
    visible: false,
    indeterminate: false,
    pct: 0,
    note: '',
    stop: false,
    stopDisabled: false,
  });
  readonly rangeOk = signal<{ ok: boolean; why: string | null }>({ ok: false, why: 'starting' });
  readonly booted = signal(false);
  readonly extFallback = signal(false);
  readonly sql = signal(PRESETS[0]![1]);
  readonly editorOpen = signal(false);
  /** True while a period loads or a query runs: the controls that start either wait. */
  readonly working = signal(false);
  /** True once anything was asked, so the share link stays reachable after an error. */
  readonly queried = signal(false);
  readonly asked = signal<number | null>(null);
  readonly answerLabel = signal<string>('Pick a question, or search for anything on Arweave');
  readonly result = signal<Result | null>(null);
  readonly sampleWallet = signal<string | null>(null);
  readonly switchTo = signal<string | null>(null);
  readonly trace: string[] = [];
  say(text: string, cls: '' | 'ok' | 'bad' = ''): void {
    this.status.value = { text, cls };
  }
  setCheck(k: keyof ProofChecks, state: CheckState): void {
    const p = this.proof.value;
    this.proof.value = { ...p, checks: { ...p.checks, [k]: state } };
  }
  setProof(state: 'run' | 'ok' | 'bad', text: string): void {
    this.proof.value = { ...this.proof.value, state, text };
  }
  barShow(got: number, total: number, label: string): void {
    const pct = total > 0 ? Math.min(100, (got / total) * 100) : 0;
    this.progress.value = {
      ...this.progress.value,
      visible: true,
      indeterminate: false,
      pct,
      note:
        total > 0
          ? `${label}: ${mb(got)} of ${mb(total)}, ${pct.toFixed(0)}%`
          : `${label}: ${mb(got)}`,
    };
  }
  barBusy(label: string): void {
    this.progress.value = {
      ...this.progress.value,
      visible: true,
      indeterminate: true,
      note: label,
    };
  }
  barHide(): void {
    this.progress.value = {
      ...this.progress.value,
      visible: false,
      indeterminate: false,
      pct: 0,
      note: '',
    };
  }
  tr(m: string): void {
    this.trace.push(`${Date.now() % 100000} ${m}`);
    if (this.trace.length > 200) this.trace.shift();
  }
}

export class Session {
  engine: Engine | null = null;
  reader: RangeReader | null = null;
  bands: Band[] = [];
  registered = new Map<string, L1Band & { ranged: boolean; bytes: number; used: number }>();
  gateway: string | null = null;
  proof: Proof | null = null;
  scopeHasLookups = false;
  private busy = false;
  private pending: { scope: string | null; band: string | null } | null = null;

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
    const sql = q.get('sql');
    if (sql) {
      this.store.sql.value = sql;
      this.store.editorOpen.value = true;
    }
    if (q.get('scope') || q.get('band'))
      this.pending = { scope: q.get('scope'), band: q.get('band') };
    this.reader = await registerRangeReader();
    this.store.rangeOk.value = { ok: this.reader.ok, why: this.reader.why };
    this.reader.onEvent((e) => {
      if (e.type === 'progress') this.showReading();
    });
    await this.readPublication();
  }

  isRangeable(b: Band): boolean {
    return rangeable(this.reader, b);
  }
  /** A band read in ranges costs nothing up front; the rest is downloaded whole. */
  wholeSize(list: readonly Band[]): number {
    return list.filter((b) => !this.isRangeable(b)).reduce((t, b) => t + this.tableSize(b), 0);
  }
  tableSize(b: Band): number {
    return (
      (b.files.get('transactions.parquet')?.size ?? 0) +
      (b.files.get('blocks.parquet')?.size ?? 0) +
      (b.files.get('tags.parquet')?.size ?? 0)
    );
  }
  /** What loading a window would download now: cached bands are free. */
  toDownload(w: Window): number {
    return this.wholeSize(w.bands.filter((b) => !this.registered.has(b.id)));
  }
  disabled(w: Window): boolean {
    return this.wholeSize(w.bands) > CONFIG.loadCap;
  }

  currentWindow(): Window | null {
    const st = this.store;
    if (st.scope.value === 'pick') {
      const b = this.bands.find((x) => x.id === st.pickedBand.value);
      if (!b) return null;
      return {
        id: 'pick',
        label: fmtRange(b.fromTime, b.toTime) || `blocks ${num(b.from)}–${num(b.to ?? b.from)}`,
        bands: [b],
        from: null,
        to: null,
        size: this.tableSize(b),
        key: 'pick|' + b.id,
      };
    }
    return st.windows.value.find((w) => w.id === st.scope.value) || st.windows.value[0] || null;
  }

  /** The dates a window really shows: its own bounds, trimmed to the data. */
  windowDates(w: Window | null): string | null {
    if (!w || !w.bands.length) return null;
    const a = Math.max(w.from ?? -Infinity, w.bands[0]!.fromTime ?? -Infinity);
    const z = Math.min(
      w.to != null ? w.to - 1 : Infinity,
      w.bands[w.bands.length - 1]!.toTime ?? Infinity,
    );
    return Number.isFinite(a) && Number.isFinite(z) ? fmtRange(a, z) : null;
  }

  windowHeights(w: Window): [number, number] {
    return [
      Math.min(...w.bands.map((b) => b.from)),
      Math.max(...w.bands.map((b) => b.to ?? b.from)),
    ];
  }

  /* ---------------------------------------------------------- publication */

  async readPublication(): Promise<void> {
    const st = this.store;
    let checking = false;
    st.proof.value = {
      ...st.proof.value,
      checks: { registry: '', signature: '', engine: st.proof.value.checks.engine, pieces: '' },
    };
    await this.forgetLoaded();
    try {
      st.say('Finding a gateway that publishes parquet-l1');
      const choice =
        st.gatewayChoice.value === 'custom' ? st.customGateway.value : st.gatewayChoice.value;
      const picked = await pickGateway({
        choice,
        indexName: CONFIG.indexName,
        candidates: autoCandidates(location, CONFIG.publishers),
      });
      this.gateway = picked.gateway;
      const fetched = picked.publication ?? (await fetchPublication(picked.gateway));
      if (!fetched.doc.indexes.some((i) => i.name === CONFIG.indexName))
        throw new Error('this gateway publishes no parquet-l1 index');
      st.setProof('run', "Checking the publisher's signature…");
      st.say('Verifying the publication signature against the gateway registry');
      checking = true;
      const proof = await verifyPublication(fetched.doc, {
        registryGateways: CONFIG.registryGateways,
        excluding: picked.gateway,
        onCheck: (c, s) => st.setCheck(c, s),
      });
      this.proof = proof;
      const ix = selectIndex(fetched.doc, CONFIG.indexName, {
        gateway: picked.gateway,
        mirrors: this.mirrors,
        dropEmpty: false,
      });
      this.bands = ix.bands.filter((b) => b.files.has('transactions.parquet'));
      if (!this.bands.length) throw new Error('the publication lists no transactions.parquet');
      const dates = await fetchBandDates(
        [picked.gateway, ...this.mirrors],
        this.bands.flatMap((b) => [b.from, b.to ?? b.from]),
      );
      for (const b of this.bands) {
        const f = dates.get(b.from);
        const t = dates.get(b.to ?? b.from);
        if (f) b.fromTime = f;
        if (t) b.toTime = t;
      }
      const publisherName = proof.publisherUrl ? hostOf(proof.publisherUrl) : null;
      const first = this.bands[0]!;
      const last = this.bands[this.bands.length - 1]!;
      const records = this.bands.reduce((t, b) => t + b.records, 0);
      const yr = (t: number) => new Date(t * 1000).getUTCFullYear();
      st.hero.value = {
        txs: records ? num(records) : '—',
        blocks: num((last.to ?? last.from) - first.from + 1),
        span:
          first.fromTime && last.toTime ? `${yr(first.fromTime)}–${yr(last.toTime)}` : 'all of it',
      };
      st.pub.value = {
        verified: true,
        publisher: fetched.doc.publisher,
        publisherName,
        publisherUrl: proof.publisherUrl,
        sequence: fetched.doc.sequence,
        gateway: picked.gateway,
        auto: picked.auto,
        gatewayNote: picked.auto
          ? `Reading ${publisherName ? publisherName + '’s' : 'this gateway’s'} publication.`
          : '',
        expired: proof.expired,
      };
      st.setProof(
        'ok',
        (publisherName
          ? `Verified · signed by ${publisherName}`
          : 'Verified · signed by its publisher') +
          (proof.expired ? ' · this publication has expired' : ''),
      );
      this.buildWindows();
      const note = this.applyPending();
      st.say(note ?? '', note ? 'ok' : '');
    } catch (e) {
      this.bands = [];
      const checks = st.proof.value.checks;
      for (const k of ['registry', 'signature', 'engine'] as const)
        if (checks[k] === 'run') st.setCheck(k, 'bad');
      st.hero.value = { txs: '—', blocks: '—', span: '—' };
      const msg =
        e instanceof Error && e.name === 'AbortError'
          ? 'the gateway did not answer within 15 seconds'
          : e instanceof TypeError
            ? 'the gateway could not be reached'
            : e instanceof Error
              ? e.message
              : String(e);
      st.setProof(
        'bad',
        (checking ? 'Not verified · ' : 'Could not read the publication · ') + msg,
      );
      st.pub.value = { ...st.pub.value, verified: false };
      st.windows.value = [];
      // Refusing is for a publication that was read; one never read was not refused.
      st.say(
        checking ? 'Refusing this publication: ' + msg : msg.charAt(0).toUpperCase() + msg.slice(1),
        'bad',
      );
    }
  }

  /**
   * Periods a reader understands, built from the bands. Recent ones follow
   * band edges, so nothing is downloaded that the period does not show; years
   * are calendar years, filtered to the exact dates.
   */
  private buildWindows(): void {
    const bands = this.bands;
    const out: Window[] = [];
    const add = (w: Omit<Window, 'key' | 'size'>) => {
      if (!w.bands.length) return;
      const key = w.bands.map((b) => b.id).join(',') + `|${w.from}|${w.to}`;
      if (out.some((x) => x.key === key)) return;
      out.push({ ...w, key, size: w.bands.reduce((t, b) => t + this.tableSize(b), 0) });
    };
    const tip = bands[bands.length - 1]!;
    add({ id: 'latest', label: 'Last few days', bands: [tip], from: null, to: null });
    const history = bands.filter((b) => (b.to ?? b.from) - b.from + 1 >= CONFIG.l1Span);
    const lastHistory = history[history.length - 1];
    const subs = bands.filter((b) => !lastHistory || b.from > (lastHistory.to ?? lastHistory.from));
    if (subs.length > 1 && subs[0]!.fromTime && tip.toTime) {
      const weeks = Math.max(1, Math.round((tip.toTime - subs[0]!.fromTime) / (7 * DAY)));
      add({
        id: 'weeks',
        label: `Last ${weeks} week${weeks === 1 ? '' : 's'}`,
        bands: subs,
        from: null,
        to: null,
      });
    }
    if (lastHistory && lastHistory.fromTime)
      add({
        id: 'recent',
        label: `Since ${fmtDay(lastHistory.fromTime)}`,
        bands: [lastHistory, ...subs],
        from: null,
        to: null,
      });
    if (bands.length > 1)
      add({ id: 'all', label: 'All history', bands: [...bands], from: null, to: null });
    if (bands.every((b) => b.fromTime && b.toTime)) {
      const y0 = new Date(bands[0]!.fromTime! * 1000).getUTCFullYear();
      const y1 = new Date(tip.toTime! * 1000).getUTCFullYear();
      for (let y = y1; y >= y0; y--) {
        const from = Date.UTC(y, 0, 1) / 1000;
        const to = Date.UTC(y + 1, 0, 1) / 1000;
        add({
          id: 'y' + y,
          label: String(y),
          bands: bands.filter((b) => b.fromTime! < to && b.toTime! >= from),
          from,
          to,
        });
      }
    }
    this.store.windows.value = out;
    const was = this.store.scope.value;
    if (!out.some((w) => w.id === was && !this.disabled(w)) && was !== 'pick')
      this.store.scope.value = 'latest';
  }

  /** A shared link's scope, applied once the bands are known. */
  private applyPending(): string | null {
    const want = this.pending;
    this.pending = null;
    if (!want) return null;
    if (want.band) {
      if (!this.bands.some((b) => b.id === want.band))
        return 'The link names a band this publisher does not have, so the scope was left alone.';
      this.store.scope.value = 'pick';
      this.store.pickedBand.value = want.band;
    } else if (want.scope && this.store.windows.value.some((w) => w.id === want.scope))
      this.store.scope.value = want.scope;
    return 'Period and SQL came from the shared link. Run it when you are ready.';
  }

  private async forgetLoaded(): Promise<void> {
    this.store.loadedKey.value = null;
    if (this.engine) {
      for (const s of parquetL1.l1DropSql()) await this.engine.query(s).catch(() => {});
      for (const r of this.registered.values())
        for (const n of Object.values(r.names)) if (n) await this.engine.dropFile(n);
    }
    this.registered.clear();
    this.store.result.value = null;
    this.store.answerLabel.value =
      this.store.editorOpen.value && this.store.sql.value.trim()
        ? 'A query, ready to run'
        : 'Pick a question, or search for anything on Arweave';
  }

  /* --------------------------------------------------------------- engine */

  private async boot(): Promise<void> {
    if (this.engine) return;
    const st = this.store;
    st.setCheck('engine', 'run');
    try {
      this.engine = await openEngine({
        hosts: CONFIG.engineHosts,
        pins: CONFIG.pins,
        onStatus: (m) => st.say(m),
        onProgress: (p) => ('busy' in p ? st.barBusy(p.busy) : st.barShow(p.got, p.total, p.label)),
      });
      st.extFallback.value = this.engine.extFallback;
      st.setCheck('engine', 'ok');
      st.booted.value = true;
    } catch (e) {
      st.setCheck('engine', 'bad');
      this.engine = null;
      throw e;
    }
  }

  /** Loads the chosen scope; true when it is ready to query. */
  async loadScope(): Promise<boolean> {
    const st = this.store;
    const win = this.currentWindow();
    const sel = win ? win.bands : [];
    if (!win || !sel.length) return false;
    if (!st.pub.value.verified) {
      st.say('The publication has not verified, so nothing will be loaded.', 'bad');
      return false;
    }
    if (this.disabled(win)) {
      st.say(
        `${win.label} is ${mb(this.wholeSize(win.bands))} to download whole, too much for a tab. Pick a shorter period.`,
        'bad',
      );
      return false;
    }
    let watch: Awaited<ReturnType<RangeReader['watch']>> | null = null;
    try {
      await this.boot();
      const engine = this.engine!;
      if (sel.some((b) => this.isRangeable(b)) && !this.reader?.controlled())
        throw new Error('the range reader stopped controlling this page; reload it');
      if (this.reader?.ok) await this.reader.resume();
      for (const s of parquetL1.l1DropSql()) await engine.query(s).catch(() => {});
      // Keep what was loaded before, but never hold more than a tab can: drop
      // the least recently used bands this period does not need.
      const need = new Set(sel.map((b) => b.id));
      const incoming = this.wholeSize(sel.filter((b) => !this.registered.has(b.id)));
      let held = [...this.registered.values()].reduce((t, c) => t + c.bytes, 0);
      for (const [id, c] of [...this.registered.entries()].sort((x, y) => x[1].used - y[1].used)) {
        if (held + incoming <= CONFIG.loadCap) break;
        if (need.has(id)) continue;
        for (const n of Object.values(c.names)) if (n) await engine.dropFile(n);
        this.registered.delete(id);
        held -= c.bytes;
      }
      const missing = sel.filter((b) => !this.registered.has(b.id));
      for (const band of missing.filter((b) => this.isRangeable(b))) {
        const names: L1Band['names'] = {};
        const lookups =
          parquetL1.l1SchemaHasLookups(band.schema) &&
          parquetL1.L1_LOOKUP_KINDS.every((k) => band.files.has(parquetL1.L1_FILES[k]));
        for (const kind of [
          ...parquetL1.L1_TABLE_KINDS,
          ...(lookups ? parquetL1.L1_LOOKUP_KINDS : []),
        ]) {
          const f = band.files.get(parquetL1.L1_FILES[kind]);
          if (!f) continue;
          const name = engine.freshName(kind);
          await engine.registerUrl(
            name,
            this.reader!.url(rangeSpec(band, f, { mirrors: this.mirrors })),
          );
          names[kind] = name;
        }
        this.registered.set(band.id, {
          id: band.id,
          from: band.from,
          to: band.to ?? band.from,
          names,
          ranged: true,
          bytes: 0,
          used: 0,
        });
      }
      const whole = missing.filter((b) => !this.isRangeable(b));
      let done = 0;
      const total = whole.reduce(
        (n, b) =>
          n + parquetL1.L1_TABLE_KINDS.filter((k) => b.files.has(parquetL1.L1_FILES[k])).length,
        0,
      );
      for (const band of whole) {
        const names: L1Band['names'] = {};
        for (const kind of parquetL1.L1_TABLE_KINDS) {
          const f = band.files.get(parquetL1.L1_FILES[kind]);
          if (!f) continue;
          done += 1;
          const what = `${fmtRange(band.fromTime, band.toTime) || 'band ' + band.from + '–' + band.to}, file ${done} of ${total}`;
          st.say(`Downloading ${done} of ${total}, ${mb(f.size)}`);
          const bytes = await fetchWithProgress(f.url, what, f.size, (p) =>
            st.barShow(p.got, p.total, p.label),
          );
          st.barBusy(`Checking ${what} against its signed SHA-256`);
          if ((await sha256Hex(bytes)) !== f.sha256)
            throw new Error(`${band.id} does not match its signed SHA-256`);
          const name = engine.freshName(kind);
          await engine.registerBuffer(name, bytes);
          names[kind] = name;
        }
        this.registered.set(band.id, {
          id: band.id,
          from: band.from,
          to: band.to ?? band.from,
          names,
          ranged: false,
          bytes: this.tableSize(band),
          used: 0,
        });
      }
      const stamp = performance.now();
      for (const b of sel) this.registered.get(b.id)!.used = stamp;
      const regs = sel.map((b) => this.registered.get(b.id)!);
      if (sel.some((b) => this.isRangeable(b)) && this.reader) {
        if (this.reader.watching) this.reader.watching.label = 'Opening the period';
        else {
          watch = await this.reader.watch('Opening the period');
          st.progress.value = { ...st.progress.value, stop: true, stopDisabled: false };
        }
      }
      const period = parquetL1.l1PeriodSql(regs, {
        ...(win.from != null ? { fromTime: win.from } : {}),
        ...(win.to != null ? { toTime: win.to } : {}),
      });
      await engine.exec(period.first);
      let [lo, hi] = this.windowHeights(win);
      if (period.dated) {
        const [r] = rowsOf(
          await engine.query('SELECT min(height) AS lo, max(height) AS hi FROM blocks'),
        );
        if (r && r.lo != null) {
          lo = Number(r.lo);
          hi = Number(r.hi);
        }
      }
      await engine.exec(period.second(lo, hi));
      this.scopeHasLookups = !period.dated && parquetL1.l1HasLookups(regs);
      const [cnt] = rowsOf(await engine.query('SELECT count(*) AS n FROM rawtx'));
      // A wallet that really is in this scope, so the wallet presets never run empty.
      const newest = regs[regs.length - 1]!.names.tx;
      try {
        const w = rowsOf(
          await engine.query(
            `SELECT b64u(owner_address) AS owner FROM read_parquet('${newest}') WHERE height > ${hi - 200} AND octet_length(owner_address) > 0 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
          ),
        );
        if (w.length) {
          const was = st.sql.value;
          const prev = PRESETS.findIndex((_, i) => presetSql(i, st.sampleWallet.value) === was);
          st.sampleWallet.value = String(w[0]!.owner);
          if (prev >= 0) st.sql.value = presetSql(prev, st.sampleWallet.value);
        }
      } catch {
        /* a placeholder is not worth failing a load over */
      }
      const when = this.windowDates(win);
      const how = !sel.some((b) => this.isRangeable(b))
        ? 'Every file matched the SHA-256 the publisher signed.'
        : sel.every((b) => this.isRangeable(b))
          ? 'Questions read only what they need, checked against the torrents the publisher signed.'
          : 'Downloaded files matched their signed SHA-256; the rest are read in checked ranges.';
      st.say(
        `${num(cnt!.n as number)} transactions${when ? ` from ${when}` : ''}, blocks ${num(lo)} to ${num(hi)}. ${how}`,
        'ok',
      );
      st.loadedKey.value = win.key;
      return true;
    } catch (e) {
      const why = explainReadError(e, this.reader?.watching ?? null, this.mirrors);
      st.loadedKey.value = null;
      await this.forgetRanged(sel);
      st.say(why.stopped ? why.msg : 'Load failed: ' + why.msg, 'bad');
      st.switchTo.value = why.switchTo ?? null;
      return false;
    } finally {
      if (watch) {
        const r = await watch.done();
        if (st.loadedKey.value === win.key && !watch.fail && (r.checked > 0 || r.reused > 0))
          st.setCheck('pieces', 'ok');
      }
      st.progress.value = { ...st.progress.value, stop: false };
      st.barHide();
    }
  }

  /** Drops these bands' range-read registrations after a read was cancelled or failed. */
  private async forgetRanged(list: readonly Band[]): Promise<void> {
    for (const b of list) {
      const c = this.registered.get(b.id);
      if (!c || !c.ranged) continue;
      for (const n of Object.values(c.names)) if (n) await this.engine?.dropFile(n);
      this.registered.delete(b.id);
    }
  }

  showReading(): void {
    const w = this.reader?.watching;
    if (!w) return;
    const t = this.reader!.totals;
    const b = w.before;
    const fetched = t.originBytes - b.originBytes;
    const checked = t.verified - b.verified;
    const reused = t.memHits - b.memHits + (t.diskHits - b.diskHits);
    this.store.barBusy(
      `${w.label}: ${mb(fetched)} fetched, ${num(checked)} piece${checked === 1 ? '' : 's'} checked` +
        (reused ? `, ${num(reused)} reused` : '') +
        (fetched > 500e6
          ? '. This one reads much of the period; Stop if that was not the plan'
          : ''),
    );
  }

  async stop(): Promise<void> {
    this.store.progress.value = { ...this.store.progress.value, stopDisabled: true };
    await this.reader?.cancel();
  }

  /* --------------------------------------------------------------- queries */

  /** Runs the editor's SQL, loading the scope first when it is not loaded yet. */
  async runQuery(opts: QueryOpts = {}): Promise<void> {
    const st = this.store;
    const sql = st.sql.value.trim().replace(/;+\s*$/, '');
    if (this.busy) return;
    if (!sql) {
      st.say('Write a query, or pick one of the examples above the editor, first.', 'bad');
      return;
    }
    // One thing at a time: a second click while a period loads or a query
    // runs would start a second load.
    this.busy = true;
    st.working.value = true;
    st.queried.value = true;
    try {
      await this.runQueryOnce(opts, sql);
    } finally {
      this.busy = false;
      st.working.value = false;
    }
  }

  /** Opens the current period from its button, under the same one-at-a-time rule. */
  async openPeriod(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.store.working.value = true;
    try {
      await this.loadScope();
    } finally {
      this.busy = false;
      this.store.working.value = false;
    }
  }

  private async runQueryOnce(opts: QueryOpts, sql: string): Promise<void> {
    const st = this.store;
    const win = this.currentWindow();
    if (!win) return;
    const ranged = win.bands.some((b) => this.isRangeable(b));
    if (ranged && !this.reader?.controlled()) {
      st.say(
        'The range reader stopped controlling this page, so nothing would be checked. Reload the page.',
        'bad',
      );
      return;
    }
    const label = opts.label ?? this.presetLabel() ?? 'Your query';
    st.answerLabel.value = label;
    let watch: Awaited<ReturnType<RangeReader['watch']>> | null = null;
    if (ranged && this.reader) {
      watch = await this.reader.watch('Reading');
      st.progress.value = { ...st.progress.value, stop: true, stopDisabled: false };
    }
    if (st.loadedKey.value !== win.key && !(await this.loadScope())) {
      if (watch) await watch.done();
      st.progress.value = { ...st.progress.value, stop: false };
      return;
    }
    let read: Receipt | null = null;
    try {
      const t0 = performance.now();
      if (watch) st.barBusy('Reading');
      let table;
      try {
        table = await this.engine!.query(sql);
      } finally {
        if (watch) {
          read = await watch.done();
          st.barHide();
        }
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(2);
      if (read && watch && !watch.fail && (read.checked > 0 || read.reused > 0))
        st.setCheck('pieces', 'ok');
      const rows = rowsOf(table);
      const cols = columnsOf(table);
      const isTime = timeColumnsOf(table);
      const when = this.windowDates(win);
      const [lo, hi] = this.windowHeights(win);
      const caption = opts.caption
        ? opts.caption.replace(
            '{RANGE}',
            when ? `from ${when}` : `over blocks ${num(lo)}–${num(hi)}`,
          )
        : null;
      const receipt =
        receiptText(read, mb) + (watch?.notes.length ? ' ' + notesText(watch.notes) : '');
      st.result.value = {
        cols,
        rows,
        isTime,
        label,
        caption,
        captionTemplate: opts.caption ?? null,
        wallet: opts.wallet ?? null,
        windowKey: win.key,
        lo,
        hi,
        secs,
        receipt,
        note: opts.note ?? null,
      };
      // A gateway offer belongs to the failure that raised it.
      st.switchTo.value = null;
      if (opts.note && rows.length === 0) st.say(`${opts.note} ${receipt}`.trim(), 'bad');
      else if (caption) {
        const more =
          rows.length > 200 ? 'Showing the first 200 rows; CSV and JSON have them all. ' : '';
        st.say((more + receipt).trim(), watch?.notes.length ? 'bad' : 'ok');
      } else
        st.say(
          `${num(rows.length)} row${rows.length === 1 ? '' : 's'} in ${secs}s, over blocks ${num(lo)}–${num(hi)}` +
            (rows.length > 200 ? ', showing the first 200; a download has them all' : '') +
            '. ' +
            receipt,
          watch?.notes.length ? 'bad' : 'ok',
        );
    } catch (e) {
      st.result.value = null;
      const why = explainReadError(e, watch, this.mirrors);
      if (why.integrity) st.setCheck('pieces', 'bad');
      if (why.oom) {
        await this.engine?.resetConnection().catch(() => {});
        await this.forgetRanged(win.bands);
        st.loadedKey.value = null;
      } else if (
        watch?.fail ||
        /magic bytes|IO Error|HTTP/i.test(e instanceof Error ? e.message : String(e))
      ) {
        await this.forgetRanged(win.bands);
        st.loadedKey.value = null;
      }
      st.say(why.stopped ? why.msg : 'Query error: ' + why.msg, 'bad');
      st.switchTo.value = why.switchTo ?? null;
    } finally {
      st.progress.value = { ...st.progress.value, stop: false };
      st.barHide();
    }
  }

  presetLabel(): string | null {
    const v = this.store.sql.value;
    const i = PRESETS.findIndex((_, k) => presetSql(k, this.store.sampleWallet.value) === v);
    return i >= 0 ? PRESETS[i]![0] : null;
  }

  async ask(i: number): Promise<void> {
    const q = QUESTIONS[i]!;
    this.store.asked.value = i;
    this.store.sql.value = q.sql;
    await this.runQuery({ label: q.title, caption: q.caption });
  }

  /* ------------------------------------------------------------------ find */

  /**
   * Where a 43-character id sits, asked of the gateway's GraphQL: a hint only.
   * The answer is read from the signed index at that height, so a wrong hint
   * finds nothing rather than something false.
   */
  private async txHint(id: string): Promise<{
    height?: number;
    bundle?: string | null;
    missing?: boolean;
    pending?: boolean;
    error?: string;
  }> {
    const query = `{ transaction(id: "${id}") { id block { height } bundledIn { id } } }`;
    let last: { missing?: boolean; pending?: boolean; error?: string } = { missing: true };
    for (const g of [this.gateway, ...this.mirrors].filter((x): x is string => !!x)) {
      try {
        const res = await fetchWithTimeout(g + '/graphql', 8000, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        if (!res.ok) {
          last = { error: 'HTTP ' + res.status };
          continue;
        }
        const t = (
          (await res.json()) as {
            data?: {
              transaction?: { block?: { height?: number }; bundledIn?: { id?: string } } | null;
            };
          }
        ).data?.transaction;
        if (!t) {
          if (!last.pending) last = { missing: true };
          continue;
        }
        const height = t.block && Number.isSafeInteger(t.block.height) ? t.block.height! : null;
        const bundle =
          t.bundledIn && /^[A-Za-z0-9_-]{43}$/.test(t.bundledIn.id ?? '') ? t.bundledIn.id! : null;
        if (height === null) {
          last = { missing: true, pending: true };
          continue;
        }
        return { height, bundle };
      } catch (e) {
        if (last.missing && !last.pending)
          last = {
            error:
              e instanceof Error && e.name === 'AbortError'
                ? 'no answer in 8 seconds'
                : 'unreachable',
          };
      }
    }
    return last;
  }

  /** Find through the lookup files; true when it answered. */
  private async findByLookups(v: string): Promise<boolean> {
    const st = this.store;
    const win = this.currentWindow();
    if (!win) return false;
    if (st.loadedKey.value !== win.key && !(await this.loadScope())) return true;
    if (!this.scopeHasLookups) return false;
    st.say('Looking it up in the index’s own lookup files.');
    const key = `key64(unb64u('${v}'))`;
    const heights = rowsOf(
      await this.engine!.query(
        `SELECT DISTINCT height FROM lookup_tx_id WHERE id8 = ${key} ORDER BY 1`,
      ),
    ).map((r) => Number(r.height));
    const short = v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;
    if (heights.length > 0) {
      st.sql.value = parquetL1.txLookupSql(v, heights);
      st.asked.value = null;
      await this.runQuery({
        label: `Transaction ${short}`,
        note: `The lookup pointed at block ${heights.map(num).join(', ')}, which holds no transaction with this id: another id shares its first 8 bytes.`,
      });
      return true;
    }
    const [w] = rowsOf(
      await this.engine!.query(`SELECT count(*) AS n FROM lookup_wallet WHERE addr8 = ${key}`),
    );
    if (Number(w!.n) > 0) {
      st.sql.value = `-- ${v.slice(0, 8)}… is a wallet. Its totals, from this index's lookup files;\n-- "One wallet: history" lists its transactions.\nSELECT * FROM wallet_totals('${v}');`;
      st.asked.value = null;
      await this.runQuery({ label: `Wallet ${short}`, wallet: v });
      return true;
    }
    return false;
  }

  private windowHasLookups(w: Window | null): boolean {
    return (
      !!w &&
      w.from == null &&
      w.to == null &&
      w.bands.every(
        (b) =>
          this.isRangeable(b) &&
          parquetL1.l1SchemaHasLookups(b.schema) &&
          parquetL1.L1_LOOKUP_KINDS.every((k) => b.files.has(parquetL1.L1_FILES[k])),
      )
    );
  }

  async findId(v: string): Promise<void> {
    const st = this.store;
    if (!st.pub.value.verified) {
      st.say('The publication is still being checked; this will work in a moment.', 'bad');
      return;
    }
    // With range reads, Find searches everything: a lookup reads only what it needs.
    if (
      this.reader?.ok &&
      this.bands.every((b) => this.isRangeable(b)) &&
      st.scope.value !== 'all' &&
      st.windows.value.some((w) => w.id === 'all')
    )
      st.scope.value = 'all';
    if (this.windowHasLookups(this.currentWindow()) && (await this.findByLookups(v))) return;
    st.say('Asking the gateway which block this is in. A hint: the signed index decides.');
    const hint = await this.txHint(v);
    const short = `${v.slice(0, 8)}…${v.slice(-4)}`;
    const w = this.currentWindow();
    let sql: string;
    let label: string;
    let note: string;
    if (hint.height != null) {
      label = hint.bundle ? `Data item ${short}` : `Transaction ${short}`;
      sql = txSql(hint.bundle || v, hint.height, hint.bundle ? v : null);
      const inScope =
        !!w && w.bands.some((b) => hint.height! >= b.from && hint.height! <= (b.to ?? b.from));
      const tip = this.bands.length ? (this.bands[this.bands.length - 1]!.to ?? 0) : 0;
      note =
        hint.height > tip
          ? `${hint.bundle ? 'Its bundle is' : 'It is'} in block ${num(hint.height)}, newer than this index, which reaches block ${num(tip)}. The publisher adds new blocks as it updates its newest band.`
          : inScope
            ? `Not in block ${num(hint.height)} of the signed index, though a gateway said it would be. Nothing was taken on its word.`
            : `Block ${num(hint.height)} is outside the period chosen under Data; pick one that contains it.`;
    } else if (this.windowHasLookups(w) && this.scopeHasLookups) {
      label = `Nothing found for ${short}`;
      sql = `-- Neither a transaction nor a wallet in this period: its lookup files hold no such key.\nSELECT height FROM lookup_tx_id WHERE id8 = key64(unb64u('${v}'));`;
      note = `Not a transaction or a wallet in this period, by its own lookup files, and ${hint.error ? `the gateway did not answer (${hint.error})` : hint.pending ? 'the gateway has this id but not yet in a block' : 'the gateway knows no transaction with this id'}.`;
    } else {
      label = `Wallet or transaction ${short}`;
      sql = walletSql(
        v,
        hint.error
          ? `The gateway did not answer (${hint.error})`
          : hint.pending
            ? 'The gateway has this id but not yet in a block'
            : 'The gateway knows no transaction with this id',
      );
      note =
        'No transaction in this period was sent or received by this wallet, and the gateway knows no transaction with this id.';
    }
    st.sql.value = sql;
    st.asked.value = null;
    await this.runQuery({ label, note });
  }

  find(raw: string): void {
    const st = this.store;
    const sql = lookupSql(raw);
    if (sql === 'id') {
      void this.findId(raw.trim());
      return;
    }
    if (sql === null) {
      st.say('Type a wallet, a transaction ID, a block height, or a range.', 'bad');
      return;
    }
    if (sql === undefined) {
      st.say(
        `"${raw.trim().slice(0, 48)}" is not a block height, a range, or a 43-character ID.`,
        'bad',
      );
      return;
    }
    st.sql.value = sql;
    st.asked.value = null;
    const t = raw.trim();
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    const label = /^\d+$/.test(t)
      ? `Block ${num(t)}`
      : m
        ? `Blocks ${num(m[1]!)} to ${num(m[2]!)}`
        : `Results for ${t.slice(0, 12)}`;
    if (st.pub.value.verified) void this.runQuery({ label });
    else st.say('The publication is still being checked; this will work in a moment.', 'bad');
  }

  shareUrl(): string {
    const st = this.store;
    const q = new URLSearchParams();
    const gw =
      st.pub.value.gateway ??
      (['auto', 'custom'].includes(st.gatewayChoice.value) ? null : st.gatewayChoice.value);
    if (gw) q.set('gw', gw);
    q.set('scope', st.scope.value);
    if (st.scope.value === 'pick' && st.pickedBand.value) q.set('band', st.pickedBand.value);
    const sql = st.sql.value.trim();
    if (sql) q.set('sql', sql);
    return location.origin + location.pathname + '#' + q.toString();
  }
}
