/**
 * One store. Views are functions of these signals; the data flows write
 * them. No module-scope state: the store is created in main and passed down
 * through context.
 */
import { signal, type Signal } from '@preact/signals';
import type { Band, Period, Receipt } from '@ar-io/index-client';
import type { CheckState, ProofChecks, ProgressState } from '@ar-io/explorer-ui';
import type { ComponentChildren } from 'preact';

import type { DriveModel, SortKey } from './model/arfs.js';
import type { ViewState } from './router.js';

export interface PublicationUi {
  status: 'idle' | 'reading' | 'ok' | 'bad';
  proofState: 'run' | 'ok' | 'bad';
  proofText: string;
  checks: ProofChecks;
  gateway: string | null;
  auto: boolean;
  gatewayNote: string;
  publisher: string | null;
  publisherName: string | null;
  publisherUrl: string | null;
  sequence: number | null;
  issuedAt: string | null;
  expired: boolean;
  bands: Band[];
  tip: number;
  verified: boolean;
  /** Every band's lookup files are present. */
  hasLookups: boolean;
}

export interface Hero {
  drives: string;
  files: string;
  items: string;
  span: string;
}

export interface Crumb {
  label: string;
  go: (() => void) | null;
}

export interface Fact {
  dt: string;
  dd: ComponentChildren;
  mono?: boolean;
}

export interface CostCard {
  text: ComponentChildren;
  action: { label: string; go: () => void } | null;
}

export interface Column<R = Record<string, unknown>> {
  key: string;
  label: string;
  num?: boolean;
  mono?: boolean;
  render?: (value: unknown, row: R) => ComponentChildren;
}

export interface TableContent {
  cols: Column[];
  rows: Record<string, unknown>[];
  /** A table the view knows how to draw itself (names, icons, links). */
  preset?: 'drives' | 'walletDrives';
  /** Columns Arrow hands back as epoch milliseconds. */
  isTime?: Set<string>;
}

/** A name fetched for the view's title (a record's), labelled as not covered by the signature. */
export interface TitleName {
  prefix: string;
  id: string;
  size: number | null;
  fallback: string;
}

export interface MoreItem {
  kind: 'button' | 'text' | 'link';
  label: string;
  go?: () => void;
  href?: string;
}

export interface ExportData {
  cols: string[];
  rows: Record<string, unknown>[];
  isTime: Set<string>;
  slug: string;
}

/** What the view area shows, for every view but the drive browser's list. */
export interface ViewContent {
  title: string;
  titleName: TitleName | null;
  sub: string;
  crumbs: Crumb[];
  facts: Fact[];
  cost: CostCard | null;
  caption: string | null;
  table: TableContent | null;
  more: MoreItem[];
  namesNote: boolean;
  exportable: ExportData | null;
  /** A link to the Network Portal for the wallet the view is about. */
  portalWallet: string | null;
}

export const emptyContent = (): ViewContent => ({
  title: '',
  titleName: null,
  sub: '',
  crumbs: [],
  facts: [],
  cost: null,
  caption: null,
  table: null,
  more: [],
  namesNote: false,
  exportable: null,
  portalWallet: null,
});

export interface DriveUi {
  path: string[];
  sort: { key: SortKey; dir: 1 | -1 };
  filter: string;
  selected: string | null;
  allNames: boolean;
}

export interface StatusLine {
  text: string;
  cls: '' | 'ok' | 'bad';
}

export class Store {
  readonly pub: Signal<PublicationUi> = signal({
    status: 'idle',
    proofState: 'run',
    proofText: "Checking the publisher's signature…",
    checks: { registry: '', signature: '', engine: '', pieces: '' },
    gateway: null,
    auto: true,
    gatewayNote: '',
    publisher: null,
    publisherName: null,
    publisherUrl: null,
    sequence: null,
    issuedAt: null,
    expired: false,
    bands: [],
    tip: 0,
    verified: false,
    hasLookups: false,
  });
  readonly hero: Signal<Hero> = signal({ drives: '—', files: '—', items: '—', span: '—' });
  /** 'auto' or a gateway origin, as the Data drawer's select has it; `custom` holds a typed URL. */
  readonly gatewayChoice = signal<string>('auto');
  readonly customGateway = signal<string>('');
  readonly periods = signal<Period[]>([]);
  readonly periodId = signal<string>('month');
  readonly privacy = signal<'any' | 'public' | 'private'>('any');
  readonly app = signal<string>('any');
  readonly view = signal<ViewState>({ kind: 'browse' });
  readonly content = signal<ViewContent>(emptyContent());
  readonly status = signal<StatusLine>({ text: '', cls: '' });
  readonly progress = signal<ProgressState>({ visible: false, indeterminate: false, pct: 0, note: '', stop: false, stopDisabled: false });
  readonly rangeOk = signal<{ ok: boolean; why: string | null }>({ ok: false, why: 'starting' });
  readonly engineBooted = signal(false);
  readonly extFallback = signal(false);
  readonly drive = signal<DriveModel | null>(null);
  readonly driveUi = signal<DriveUi>({ path: [], sort: { key: 'name', dir: 1 }, filter: '', selected: null, allNames: false });
  /** Bumped (throttled) as names land, so the list re-renders in batches. */
  readonly namesTick = signal(0);
  readonly namesProgress = signal<{ wanted: number; loaded: number }>({ wanted: 0, loaded: 0 });
  readonly sql = signal<string>('');
  readonly editorOpen = signal(false);
  readonly asked = signal<number | null>(null);
  readonly sampleWallet = signal<string | null>(null);
  readonly sampleDrive = signal<string | null>(null);
  /** The question buttons are enabled once the publication verifies. */
  readonly asksEnabled = signal(false);
  readonly lastReceipt = signal<Receipt | null>(null);
  /** A trace of the load path, for tests. */
  readonly trace: string[] = [];

  say(text: string, cls: '' | 'ok' | 'bad' = ''): void {
    this.status.value = { text, cls };
  }

  setCheck(k: keyof ProofChecks, state: CheckState): void {
    const p = this.pub.value;
    this.pub.value = { ...p, checks: { ...p.checks, [k]: state } };
  }

  setProof(state: 'run' | 'ok' | 'bad', text: string): void {
    this.pub.value = { ...this.pub.value, proofState: state, proofText: text };
  }

  barShow(got: number, total: number, label: string, mb: (n: number) => string): void {
    const pct = total > 0 ? Math.min(100, (got / total) * 100) : 0;
    const p = this.progress.value;
    this.progress.value = {
      ...p,
      visible: true,
      indeterminate: false,
      pct,
      note: total > 0 ? `${label}: ${mb(got)} of ${mb(total)}, ${pct.toFixed(0)}%` : `${label}: ${mb(got)}`,
    };
  }

  barBusy(label: string): void {
    this.progress.value = { ...this.progress.value, visible: true, indeterminate: true, note: label };
  }

  barHide(): void {
    this.progress.value = { ...this.progress.value, visible: false, indeterminate: false, pct: 0, note: '' };
  }

  showStop(on: boolean): void {
    this.progress.value = { ...this.progress.value, stop: on, stopDisabled: false };
  }

  tr(m: string): void {
    this.trace.push(`${Date.now() % 100000} ${m}`);
    if (this.trace.length > 200) this.trace.shift();
  }

  currentPeriod(): Period | null {
    const ps = this.periods.value;
    return ps.find((p) => p.id === this.periodId.value) ?? ps[0] ?? null;
  }
}
