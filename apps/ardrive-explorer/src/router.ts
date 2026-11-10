/**
 * Every view is a history entry, carried in the URL fragment so nothing a
 * reader looks at reaches a server: Back and Forward move between drives,
 * folders, wallets and lookups, and a copied address lands where the reader
 * was.
 */
export type ViewState =
  | { kind: 'home' }
  | { kind: 'browse' }
  | { kind: 'drive'; key: string; folder: string | null }
  | { kind: 'wallet'; key: string }
  | { kind: 'id'; key: string }
  | { kind: 'query'; sql: string | null }
  /** The question cards, before one is asked. */
  | { kind: 'questions' }
  /** The SQL editor, before a query runs. */
  | { kind: 'editor' }
  /** The gateway and the publication the page reads. */
  | { kind: 'source' };

/** The left nav's sections, and the views each one shows. */
export type Section = 'home' | 'drives' | 'questions' | 'sql' | 'source';

/** A query is a question's answer while its card is the one asked, else the editor's. */
export function sectionOf(v: ViewState, asked: number | null): Section {
  switch (v.kind) {
    case 'home':
      return 'home';
    case 'questions':
      return 'questions';
    case 'editor':
      return 'sql';
    case 'source':
      return 'source';
    case 'query':
      return asked === null ? 'sql' : 'questions';
    default:
      return 'drives';
  }
}

/** Views that are a bare key in the fragment: `#browse`, `#questions`, `#sql`, `#source`. */
const BARE: Partial<Record<ViewState['kind'], string>> = {
  browse: 'browse',
  questions: 'questions',
  editor: 'sql',
  source: 'source',
};

export interface Link {
  gw: string | null;
  period: string | null;
  view: ViewState | null;
}

export function encodeFragment(link: {
  gw: string | null;
  period: string | null;
  view: ViewState;
}): string {
  const q = new URLSearchParams();
  if (link.gw) q.set('gw', link.gw);
  if (link.period) q.set('period', link.period);
  const v = link.view;
  if (v.kind === 'drive') {
    q.set('drive', v.key);
    if (v.folder) q.set('folder', v.folder);
  } else if (v.kind === 'wallet') q.set('wallet', v.key);
  else if (v.kind === 'id') q.set('id', v.key);
  else if (v.kind === 'query' && v.sql) q.set('sql', v.sql);
  else if (BARE[v.kind]) q.set(BARE[v.kind]!, '');
  // A bare key (`browse`), not `browse=`.
  return '#' + q.toString().replace(/(^|&)(browse|questions|sql|source)=(?=&|$)/, '$1$2');
}

export function parseFragment(hash: string): Link {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  if (![...q.keys()].length) return { gw: null, period: null, view: null };
  let view: ViewState | null = null;
  const drive = q.get('drive');
  const wallet = q.get('wallet');
  const id = q.get('id');
  const sql = q.get('sql');
  if (drive) view = { kind: 'drive', key: drive.toLowerCase(), folder: q.get('folder') || null };
  else if (wallet) view = { kind: 'wallet', key: wallet };
  else if (id) view = { kind: 'id', key: id };
  else if (sql) view = { kind: 'query', sql };
  else if (q.has('browse')) view = { kind: 'browse' };
  else if (q.has('questions')) view = { kind: 'questions' };
  else if (q.has('sql')) view = { kind: 'editor' };
  else if (q.has('source')) view = { kind: 'source' };
  // A gateway or a period alone opens the page as a plain visit would: nothing listed.
  else view = { kind: 'home' };
  return { gw: q.get('gw'), period: q.get('period'), view };
}

export const sameView = (a: ViewState, b: ViewState): boolean =>
  a.kind === b.kind &&
  (a.kind !== 'drive' ||
    (a.key === (b as { key: string }).key &&
      a.folder === (b as { folder: string | null }).folder)) &&
  (!('key' in a) || a.kind === 'drive' || a.key === (b as { key: string }).key) &&
  (a.kind !== 'query' || a.sql === (b as { sql: string | null }).sql);
