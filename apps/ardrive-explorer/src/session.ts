/**
 * The session: the one engine, the range reader, the verified publication and
 * its bands, and the flows every view shares (reading the publication, making
 * bands ready, measuring what a listing read). Created once in main; nothing
 * here is module-scope state.
 */
import {
  autoCandidates,
  type Band,
  Engine,
  explainReadError,
  fetchBandDates,
  type FetchedPublication,
  type Publication,
  fetchPublication,
  fetchWithProgress,
  fetchWithTimeout,
  hostOf,
  mb,
  mirrorsOf,
  num,
  openEngine,
  arfs,
  parquetL2,
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
  tipOf,
  verifyPublication,
  buildPeriods,
  fmtRange,
} from '@ar-io/index-client';

import { CONFIG } from './config.js';
import { applyMeta, type DriveItem, type DriveModel, setDriveMeta } from './model/arfs.js';
import { NamePool, type NameResult } from './model/names.js';
import type { RunOptions } from './data/query.js';
import { askedFor } from './data/questions.js';
import { encodeFragment, parseFragment, type ViewState } from './router.js';
import { emptyContent, type Store } from './store.js';

type L2Band = parquetL2.RegisteredL2Band;

export interface Measured<T> {
  out: T;
  receipt: string;
  read: Receipt | null;
}

export class Session {
  engine: Engine | null = null;
  reader: RangeReader | null = null;
  bands: Band[] = [];
  /** Registered bands: DuckDB file names by kind. */
  registered = new Map<string, L2Band & { ranged: boolean }>();
  /** Each band's `band.json`, read once, and the `l2-2` files registered from it (null where a band has none). */
  private bandJsons = new Map<string, Promise<unknown>>();
  private extras = new Map<string, Promise<string>>();
  gateway: string | null = null;
  publication: FetchedPublication | null = null;
  proof: Proof | null = null;
  /** Each listing takes a number; one that was overtaken stops before it draws. */
  nav = 0;
  loadedPeriod: string | null = null;
  heroDone = false;
  /** Set while a popstate is being applied, so applying one does not push another. */
  fromHistory = false;
  readonly names: NamePool;
  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLink: ReturnType<typeof parseFragment> | null = null;

  constructor(readonly store: Store) {
    this.names = new NamePool({
      fetchRecord: (id) => this.fetchRecord(id),
      concurrency: CONFIG.nameConcurrency,
      onResult: (id, r) => this.onName(id, r),
    });
  }

  /* ---------------------------------------------------------------- boot */

  async start(): Promise<void> {
    const link = parseFragment(location.hash);
    if (link.gw) {
      if (CONFIG.publishers.includes(link.gw) || link.gw === 'auto')
        this.store.gatewayChoice.value = link.gw;
      else {
        this.store.gatewayChoice.value = 'custom';
        this.store.customGateway.value = link.gw;
      }
    }
    this.pendingLink = link;
    window.addEventListener('popstate', (e) => void this.onPopState(e));
    this.reader = await registerRangeReader();
    this.store.rangeOk.value = { ok: this.reader.ok, why: this.reader.why };
    this.reader.onEvent((e) => {
      if (e.type === 'progress') this.showReading();
    });
    await this.readPublication();
  }

  get mirrors(): string[] {
    return mirrorsOf(this.gateway, CONFIG.publishers);
  }

  overtaken(my: number): boolean {
    return my !== this.nav;
  }

  /* --------------------------------------------------------- publication */

  async readPublication(): Promise<void> {
    const my = ++this.nav;
    let checking = false;
    const st = this.store;
    st.pub.value = {
      ...st.pub.value,
      status: 'reading',
      checks: { registry: '', signature: '', engine: st.pub.value.checks.engine, pieces: '' },
      verified: false,
    };
    await this.forgetLoaded();
    try {
      st.say("Finding a gateway that publishes ArDrive's data items");
      const choice =
        st.gatewayChoice.value === 'custom' ? st.customGateway.value : st.gatewayChoice.value;
      // The index is the one that selects ArDrive's items, whatever it is called;
      // CONFIG.indexName only breaks a tie.
      const find = (doc: Publication) =>
        parquetL2.findL2Index(doc, arfs.ARDRIVE_SELECTION, CONFIG.indexName);
      const picked = await pickGateway({
        choice,
        indexName: CONFIG.indexName,
        offers: (doc) => find(doc).name !== null,
        candidates: autoCandidates(location, CONFIG.publishers),
      });
      this.gateway = picked.gateway;
      const fetched = picked.publication ?? (await fetchPublication(picked.gateway));
      const found = find(fetched.doc);
      if (found.name === null)
        throw new Error(`this gateway publishes no index of ArDrive's data items: ${found.why}`);
      st.setProof('run', "Checking the publisher's signature…");
      st.say('Verifying the publication signature against the gateway registry');
      checking = true;
      const proof = await verifyPublication(fetched.doc, {
        registryGateways: CONFIG.registryGateways,
        excluding: picked.gateway,
        onCheck: (c, s) => st.setCheck(c, s),
      });
      if (this.overtaken(my)) return;
      this.publication = fetched;
      this.proof = proof;
      const ix = selectIndex(fetched.doc, found.name, {
        gateway: picked.gateway,
        mirrors: this.mirrors,
      });
      if (!ix.bands.length) throw new Error('the publication lists no bands with records');
      this.bands = ix.bands;
      const last = this.bands[this.bands.length - 1]!;
      const tip = tipOf(this.bands) ?? last.from;
      // Dates for every band edge: one GraphQL call, cosmetic.
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
      const periods = buildPeriods(this.bands, {
        tip,
        scanFiles: ['tags.parquet', 'data_items.parquet'],
      });
      st.periods.value = periods;
      const wantPeriod = this.pendingLink?.period ?? st.periodId.value;
      st.periodId.value = periods.some((p) => p.id === wantPeriod && wantPeriod !== 'all')
        ? wantPeriod
        : 'month';
      const publisherName = proof.publisherUrl ? hostOf(proof.publisherUrl) : null;
      const records = this.bands.reduce((t, b) => t + b.records, 0);
      const first = this.bands[0]!;
      const yr = (t: number) => new Date(t * 1000).getUTCFullYear();
      st.hero.value = {
        ...st.hero.value,
        items: records ? num(records) : '—',
        span:
          first.fromTime && last.toTime
            ? `${yr(first.fromTime)}–${yr(last.toTime)}`
            : `${num(first.from)}–${num(tip)}`,
      };
      st.pub.value = {
        ...st.pub.value,
        status: 'ok',
        gateway: picked.gateway,
        auto: picked.auto,
        gatewayNote: picked.auto
          ? `Reading ${publisherName ? publisherName + '’s' : 'this gateway’s'} publication.`
          : '',
        publisher: fetched.doc.publisher,
        publisherName,
        publisherUrl: proof.publisherUrl,
        sequence: fetched.doc.sequence,
        issuedAt: fetched.doc.issuedAt,
        expired: proof.expired,
        bands: this.bands,
        tip,
        verified: true,
        hasLookups: this.bands.every((b) =>
          ['lookup_id.parquet', 'lookup_wallet.parquet', 'lookup_tag.parquet'].every((f) =>
            b.files.has(f),
          ),
        ),
      };
      st.setProof(
        'ok',
        (publisherName
          ? `Verified · signed by ${publisherName}`
          : 'Verified · signed by its publisher') +
          (proof.expired
            ? ' · this publication has expired; the publisher may have gone quiet'
            : ''),
      );
      st.asksEnabled.value = true;
      st.say('');
      const want = this.pendingLink;
      this.pendingLink = null;
      // A link's view on the first load; after a change of gateway, the view the reader was on.
      await this.openFromLink(want?.view ?? st.view.value);
    } catch (e) {
      if (this.overtaken(my)) return;
      this.bands = [];
      const checks = st.pub.value.checks;
      for (const k of ['registry', 'signature', 'engine'] as const)
        if (checks[k] === 'run') st.setCheck(k, 'bad');
      st.hero.value = { drives: '—', files: '—', items: '—', span: '—' };
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
      st.pub.value = { ...st.pub.value, status: 'bad', verified: false, bands: [] };
      st.asksEnabled.value = false;
      // Refusing is for a publication that was read; one never read was not refused.
      st.say(
        checking ? 'Refusing this publication: ' + msg : msg.charAt(0).toUpperCase() + msg.slice(1),
        'bad',
      );
    }
  }

  /** Forget everything loaded from the previous publication. Band ids repeat across publishers. */
  private async forgetLoaded(): Promise<void> {
    this.loadedPeriod = null;
    this.readying = null;
    this.heroDone = false;
    if (this.engine) {
      for (const s of [...arfs.arfsDropSql(), ...parquetL2.l2DropSql()])
        await this.engine.query(s).catch(() => {});
      for (const r of this.registered.values())
        for (const n of Object.values(r.names)) if (n) await this.engine.dropFile(n);
      for (const p of this.extras.values()) {
        const n = await p.catch(() => null);
        if (n) await this.engine.dropFile(n);
      }
    }
    this.registered.clear();
    this.bandJsons.clear();
    this.extras.clear();
    this.names.clear();
    this.clearView();
  }

  clearView(): void {
    this.store.content.value = emptyContent();
    this.store.drive.value = null;
    this.names.reset();
  }

  /* -------------------------------------------------------------- engine */

  private async boot(): Promise<void> {
    if (this.engine) return;
    const st = this.store;
    st.setCheck('engine', 'run');
    try {
      this.engine = await openEngine({
        hosts: CONFIG.engineHosts,
        pins: CONFIG.pins,
        onStatus: (m) => st.say(m),
        onProgress: (p) =>
          'busy' in p ? st.barBusy(p.busy) : st.barShow(p.got, p.total, p.label, mb),
      });
      st.extFallback.value = this.engine.extFallback;
      st.setCheck('engine', 'ok');
      st.engineBooted.value = true;
    } catch (e) {
      st.setCheck('engine', 'bad');
      this.engine = null;
      throw e;
    }
  }

  isRangeable(b: Band): boolean {
    return rangeable(this.reader, b);
  }

  wholeSize(list: readonly Band[]): number {
    return list
      .filter((b) => !this.isRangeable(b))
      .reduce(
        (t, b) =>
          t +
          (b.files.get('tags.parquet')?.size ?? 0) +
          (b.files.get('data_items.parquet')?.size ?? 0),
        0,
      );
  }

  periodDisabled(p: { bands: Band[] }): boolean {
    return this.wholeSize(p.bands) > CONFIG.loadCap;
  }

  /**
   * Makes sure these bands are registered (range reads) or downloaded and
   * checked (whole files), then (re)defines the base views over every loaded band.
   */
  private async ensureBands(sel: Band[]): Promise<void> {
    await this.boot();
    const engine = this.engine!;
    const ranged = sel.filter((b) => this.isRangeable(b));
    if (ranged.length && !this.reader?.controlled())
      throw new Error('the range reader stopped controlling this page; reload it');
    const missing = sel.filter((b) => !this.registered.has(b.id));
    this.store.tr(`missing ${missing.length}`);
    if (!missing.length) return;
    for (const band of missing.filter((b) => this.isRangeable(b))) {
      const names: L2Band['names'] = {};
      const kinds = [
        ...parquetL2.L2_TABLE_KINDS,
        ...(parquetL2.L2_LOOKUP_KINDS.every((k) => band.files.has(parquetL2.L2_FILES[k]))
          ? parquetL2.L2_LOOKUP_KINDS
          : []),
      ];
      for (const kind of kinds) {
        const file = band.files.get(parquetL2.L2_FILES[kind]);
        if (!file) continue;
        const name = engine.freshName(kind);
        await engine.registerUrl(
          name,
          this.reader!.url(rangeSpec(band, file, { mirrors: this.mirrors })),
          file.size,
        );
        names[kind] = name;
      }
      this.registered.set(band.id, {
        id: band.id,
        from: band.from,
        to: band.to ?? this.store.pub.value.tip,
        names,
        ranged: true,
      });
      this.store.tr(`registered ${band.id.slice(0, 14)}`);
    }
    const whole = missing.filter((b) => !this.isRangeable(b));
    let done = 0;
    const total = whole.length * 2;
    for (const band of whole) {
      const names: L2Band['names'] = {};
      for (const kind of parquetL2.L2_TABLE_KINDS) {
        const f = band.files.get(parquetL2.L2_FILES[kind]);
        if (!f) throw new Error(`${band.id} lists no ${parquetL2.L2_FILES[kind]}`);
        done += 1;
        const what = `${fmtRange(band.fromTime, band.toTime) || 'band ' + band.from + '–' + band.to}, file ${done} of ${total}`;
        this.store.say(`Downloading ${done} of ${total}, ${mb(f.size)}`);
        const bytes = await fetchWithProgress(f.url, what, f.size, (p) =>
          this.store.barShow(p.got, p.total, p.label, mb),
        );
        this.store.barBusy(`Checking ${what} against its signed SHA-256`);
        if ((await sha256Hex(bytes)) !== f.sha256)
          throw new Error(`${band.id} does not match its signed SHA-256`);
        const name = engine.freshName(kind);
        await engine.registerBuffer(name, bytes);
        names[kind] = name;
      }
      this.registered.set(band.id, {
        id: band.id,
        from: band.from,
        to: band.to ?? this.store.pub.value.tip,
        names,
        ranged: false,
      });
    }
    this.store.tr('defineBase');
    await engine.exec([
      ...parquetL2.l2BaseSql(this.registeredBands()),
      ...arfs.arfsBaseSql(this.registeredBands()),
    ]);
    this.store.tr('defineBase done');
  }

  registeredBands(): L2Band[] {
    return this.bands
      .filter((b) => this.registered.has(b.id))
      .map((b) => this.registered.get(b.id)!);
  }

  get hasLookups(): boolean {
    return parquetL2.hasLookups(this.registeredBands());
  }

  /** Loads whatever the current period needs; true when ready to query. */
  async ready(): Promise<boolean> {
    // One load at a time: a second caller (a click while the page is still
    // loading) waits for the first rather than querying views not yet defined.
    const key = `${this.store.pub.value.gateway} ${this.store.periodId.value}`;
    if (this.readying?.key === key) return this.readying.run;
    const run = this.load().finally(() => {
      if (this.readying?.run === run) this.readying = null;
    });
    this.readying = { key, run };
    return run;
  }

  private readying: { key: string; run: Promise<boolean> } | null = null;

  private async load(): Promise<boolean> {
    const st = this.store;
    st.tr('ready');
    const p = st.currentPeriod();
    if (!p) return false;
    if (!st.pub.value.verified) {
      st.say('The publication has not verified, so nothing will be loaded.', 'bad');
      return false;
    }
    if (this.periodDisabled(p)) {
      st.say(
        `${p.label} is ${mb(this.wholeSize(p.bands))} to download whole, too much for a tab. Pick a shorter period.`,
        'bad',
      );
      return false;
    }
    // Range reads: register every band once, so Find and Browse can reach any
    // height. Whole downloads: only the period's bands.
    const sel =
      this.reader?.ok && this.bands.every((b) => this.isRangeable(b)) ? this.bands : p.bands;
    try {
      // After a Stop the range reader refuses every read until it is told to
      // resume; the views below read file headers through it, so resume first.
      if (this.reader?.ok) await this.reader.resume();
      st.tr('ensureBands');
      await this.ensureBands(sel);
      st.tr('ensured');
      if (this.loadedPeriod !== p.id) {
        st.tr('periodViews');
        await this.engine!.exec([
          ...parquetL2.l2PeriodViewsSql(this.registeredBands(), p.lo, p.hi),
          ...arfs.arfsPeriodViewsSql(this.registeredBands(), p.lo, p.hi),
        ]);
        this.loadedPeriod = p.id;
        st.tr('periodViews done');
      }
      if (!this.heroDone) {
        this.heroDone = true;
        await this.measured('Reading the index’s counts', () => this.heroCounts());
      }
      return true;
    } catch (e) {
      const why = explainReadError(e, this.reader?.watching ?? null, this.mirrors);
      st.say(why.stopped ? why.msg : 'Load failed: ' + why.msg, 'bad');
      return false;
    } finally {
      st.barHide();
    }
  }

  /**
   * Drives and files over everything. A band whose stats file counts
   * `Entity-Type` (layout `l2-2`) gives them from it, kilobytes a band; any
   * other band from its tag lookup, which reads its row groups for the name
   * (about 25 MB over the whole live index, where the stats files are under 1 MB).
   */
  private async heroCounts(): Promise<void> {
    if (!this.hasLookups || !this.engine) return;
    const name = 'Entity-Type';
    const regs = this.registeredBands();
    const stats = await Promise.all(
      regs.map((r) => {
        const band = this.bands.find((b) => b.id === r.id);
        return band ? this.statsFile(band, name) : null;
      }),
    );
    const fromStats = stats.filter((n): n is string => n !== null);
    const fromLookup = regs.filter((_, i) => stats[i] === null).map((r) => r.names.lg!);
    const parts = [
      ...(fromStats.length ? [parquetL2.statCountsSql(fromStats, name)] : []),
      ...(fromLookup.length ? [parquetL2.tagCountsSql(name, fromLookup)] : []),
    ];
    if (!parts.length) return;
    const rows = rowsOf(
      await this.engine.query(
        `SELECT kind, sum(n) AS n FROM (${parts.join(' UNION ALL ')}) GROUP BY 1`,
      ),
    );
    const hero = { ...this.store.hero.value };
    for (const r of rows) {
      if (r.kind === 'drive') hero.drives = num(r.n as number);
      if (r.kind === 'file') hero.files = num(r.n as number);
    }
    this.store.hero.value = hero;
  }

  /**
   * A band's stats file, registered, when its `band.json` (read through the
   * range reader, so checked against the signed torrent) says it counts
   * `tag`; null for a band without one, or whose stats leave the tag out.
   */
  private statsFile(band: Band, tag: string): Promise<string | null> {
    return this.l2File(band, parquetL2.L2_STATS_FILE, 'st', parquetL2.statTagsOf, tag);
  }

  /**
   * A registered band's key lookup file, when its `band.json` says it covers
   * `tag`; null otherwise, and the caller reads the band's `lookup_tag`.
   */
  keyFile(bandId: string, tag: string): Promise<string | null> {
    const band = this.bands.find((b) => b.id === bandId);
    if (!band) return Promise.resolve(null);
    return this.l2File(band, parquetL2.L2_KEY_FILE, 'lk', parquetL2.keyTagsOf, tag);
  }

  /** An `l2-2` file of a band, registered once, when its `band.json` lists `tag` among the ones `covers` reads. */
  private async l2File(
    band: Band,
    file: string,
    kind: string,
    covers: (bandJson: unknown) => string[],
    tag: string,
  ): Promise<string | null> {
    const f = band.files.get(file);
    if (!f || !this.reader || !this.engine || !this.isRangeable(band)) return null;
    if (!covers(await this.bandJson(band)).includes(tag)) return null;
    const key = `${band.id} ${file}`;
    let p = this.extras.get(key);
    if (!p) {
      const engine = this.engine;
      const name = engine.freshName(kind);
      p = engine
        .registerUrl(name, this.reader.url(rangeSpec(band, f, { mirrors: this.mirrors })), f.size)
        .then(() => name);
      // A failure is not remembered: the next ask registers again.
      p.catch(() => this.extras.delete(key));
      this.extras.set(key, p);
    }
    return p;
  }

  /** A band's `band.json`, read once through the range reader, so checked against the signed torrent. */
  private bandJson(band: Band): Promise<unknown> {
    let p = this.bandJsons.get(band.id);
    if (!p) {
      const json = band.files.get(parquetL2.L2_BAND_FILE);
      p = (async () => {
        if (!json || !this.reader) return null;
        const res = await fetch(this.reader.url(rangeSpec(band, json, { mirrors: this.mirrors })));
        if (!res.ok) throw new Error(`${band.id}: band.json could not be read (${res.status})`);
        return res.json() as Promise<unknown>;
      })();
      p.catch(() => this.bandJsons.delete(band.id));
      this.bandJsons.set(band.id, p);
    }
    return p;
  }

  /* ------------------------------------------------------------- receipts */

  /** Runs `work` while counting what the range reader read; the receipt says what it cost. Null on failure (already said). */
  async measured<T>(label: string, work: () => Promise<T>): Promise<Measured<T> | null> {
    const st = this.store;
    const ranged = this.bands.some((b) => this.isRangeable(b));
    if (ranged && !this.reader?.controlled()) {
      st.say(
        'The range reader stopped controlling this page, so nothing would be checked. Reload the page.',
        'bad',
      );
      return null;
    }
    const watch = ranged && this.reader ? await this.reader.watch(label) : null;
    if (watch) {
      st.showStop(true);
      st.barBusy(label);
    }
    let read: Receipt | null = null;
    try {
      const out = await work();
      read = watch ? await watch.done() : null;
      if (read && watch && !watch.fail && (read.checked > 0 || read.reused > 0))
        st.setCheck('pieces', 'ok');
      st.lastReceipt.value = read;
      return {
        out,
        receipt: receiptText(read, mb) + (watch?.notes.length ? ' ' + notesText(watch.notes) : ''),
        read,
      };
    } catch (e) {
      if (watch) await watch.done();
      const why = explainReadError(e, watch, this.mirrors);
      if (why.integrity) st.setCheck('pieces', 'bad');
      if (why.oom) await this.resetAfterOom();
      else if (
        watch?.fail ||
        /magic bytes|IO Error|HTTP|too small/i.test(e instanceof Error ? e.message : String(e))
      )
        await this.forgetRanged();
      st.say(why.stopped ? why.msg : 'Could not read: ' + why.msg, 'bad');
      return null;
    } finally {
      st.showStop(false);
      st.barHide();
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

  /**
   * After the engine ran out of memory, its open files and this connection
   * are not to be trusted. A fresh connection, and every band registered
   * again, costs nothing: the checked pieces stay in the reader.
   */
  private async resetAfterOom(): Promise<void> {
    try {
      await this.engine?.resetConnection();
    } catch {
      /* ignore */
    }
    await this.forgetRanged();
  }

  /** After a cancelled or failed read, the bands are registered afresh next time. */
  private async forgetRanged(): Promise<void> {
    this.store.tr('forgetRanged');
    for (const [id, r] of [...this.registered.entries()]) {
      if (!r.ranged) continue;
      for (const n of Object.values(r.names)) if (n) await this.engine?.dropFile(n);
      this.registered.delete(id);
    }
    this.loadedPeriod = null;
  }

  /* ---------------------------------------------------------------- names */

  private async fetchRecord(id: string): Promise<{ status: number; bytes: Uint8Array }> {
    let last: { status: number; bytes: Uint8Array } | null = null;
    let err: unknown = null;
    for (const g of [this.gateway, ...this.mirrors].filter((x): x is string => !!x)) {
      try {
        const res = await fetchWithTimeout(`${g}/raw/${id}`, 12000);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (res.ok) return { status: res.status, bytes };
        last = { status: res.status, bytes };
      } catch (e) {
        err = e;
      }
    }
    if (last) return last;
    throw err ?? new Error('unreachable');
  }

  private onName(id: string, r: NameResult): void {
    const d = this.store.drive.value;
    if (d) {
      const item = d.byRecordId.get(id);
      if (item) applyMeta(d, item, r);
      else if (d.driveRec && d.driveRec.id === id)
        setDriveMeta(d, r.ok ? r.meta : null, r.ok ? r.name : null);
    }
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setTimeout(() => {
      this.tickTimer = null;
      this.store.namesTick.value += 1;
      this.store.namesProgress.value = { wanted: this.names.wanted, loaded: this.names.loaded };
    }, 150);
  }

  /** Queues names for items: what is on screen first. A name already in the cache is applied at once. */
  wantNames(d: DriveModel, items: readonly DriveItem[], front: boolean): void {
    if (d.privacy === 'private') return;
    let applied = false;
    for (
      let i = front ? items.length - 1 : 0;
      front ? i >= 0 : i < items.length;
      front ? i-- : i++
    ) {
      const x = items[i]!;
      if (x.name !== null || x.failed !== null) continue;
      const r = this.names.want(x.latest.id, x.latest.record_size, front);
      if (r) {
        applyMeta(d, x, r);
        applied = true;
      }
    }
    if (applied) this.scheduleTick();
  }

  /** The drive's own record: its name and root folder. */
  wantDriveName(d: DriveModel): void {
    if (d.privacy === 'private' || !d.driveRec) return;
    const r = this.names.want(d.driveRec.id, d.driveRec.record_size, true);
    if (r) {
      setDriveMeta(d, r.ok ? r.meta : null, r.ok ? r.name : null);
      this.scheduleTick();
    }
  }

  /* -------------------------------------------------------------- history */

  shareUrl(view: ViewState): string {
    const st = this.store;
    const gw =
      st.pub.value.gateway ??
      (['auto', 'custom'].includes(st.gatewayChoice.value) ? null : st.gatewayChoice.value);
    return (
      location.origin + location.pathname + encodeFragment({ gw, period: st.periodId.value, view })
    );
  }

  pushHistory(view: ViewState, replace = false): void {
    this.store.view.value = view;
    // A question's card is pressed only while its answer is the view.
    if (view.kind !== 'query') this.store.asked.value = null;
    if (this.fromHistory) return;
    const url = this.shareUrl(view);
    if (replace || location.href === url) history.replaceState(view, '', url);
    else history.pushState(view, '', url);
  }

  /** Set by main to the flows (they live in data/*, which import this module). */
  flows: {
    browse: (reset: boolean) => Promise<void>;
    openDrive: (id: string, confirmed: boolean, folder: string | null) => Promise<void>;
    openWallet: (addr: string, everything: boolean) => Promise<void>;
    openId: (id: string) => Promise<void>;
    runQuery: (opts: RunOptions) => Promise<void>;
    setFolder: (path: string[]) => void;
  } | null = null;

  browse(reset: boolean): Promise<void> {
    return this.flows!.browse(reset);
  }

  private async openFromLink(v: ViewState): Promise<void> {
    const f = this.flows!;
    if (v.kind === 'drive') await f.openDrive(v.key, false, v.folder);
    else if (v.kind === 'wallet') await f.openWallet(v.key, false);
    else if (v.kind === 'id') await f.openId(v.key);
    else if (v.kind === 'query') {
      const sql = v.sql ?? '';
      // A question or preset is known again by its SQL, so it keeps its own title.
      const a = askedFor(sql);
      const total = this.bands.reduce((t, x) => t + x.records, 0);
      this.store.sql.value = sql;
      this.store.asked.value = a?.question ?? null;
      if (!a) this.store.editorOpen.value = true;
      await f.runQuery({
        title: a?.title ?? 'Shared query',
        caption: a?.caption?.replaceAll('{TOTAL_TEXT}', num(total)) ?? null,
        confirmed: !!a?.wide,
        labels: !!a,
        sql,
      });
    } else if (v.kind === 'browse') await f.browse(true);
    else await this.home();
  }

  /**
   * A plain visit: nothing listed until the reader asks, so the page never
   * opens on other people's drives. The counts still load.
   */
  async home(): Promise<void> {
    this.nav += 1;
    this.pushHistory({ kind: 'home' }, true);
    this.clearView();
    this.store.content.value = {
      ...emptyContent(),
      title: 'Nothing listed yet',
      sub: 'Look up a drive, a wallet, a file or a block above, ask a question below, or list the drives created most recently.',
      more: [{ kind: 'button', label: 'Newest drives', go: () => void this.browse(true) }],
    };
    await this.ready();
  }

  private async onPopState(e: PopStateEvent): Promise<void> {
    const st = (e.state as ViewState | null) ?? parseFragment(location.hash).view;
    if (!st || !this.store.pub.value.verified) return;
    this.fromHistory = true;
    try {
      const d = this.store.drive.value;
      if (st.kind === 'drive' && d && d.driveId === st.key)
        this.flows!.setFolder(
          st.folder && d.folders.has(st.folder) ? this.pathFor(d, st.folder) : [],
        );
      else await this.openFromLink(st);
    } finally {
      this.fromHistory = false;
    }
  }

  pathFor(d: DriveModel, folderId: string): string[] {
    const out: string[] = [];
    let f = d.folders.get(folderId);
    let guard = 0;
    while (f && guard++ < 64) {
      if (d.roots.length === 1 && f === d.roots[0]) break;
      out.unshift(f.entityId);
      f = f.parent ? d.folders.get(f.parent) : undefined;
    }
    return out;
  }
}
