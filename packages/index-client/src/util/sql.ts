/**
 * What a statement reads, by name: enough to tell a question that answers
 * from a lookup by key from one that scans a period. A reading, not a
 * parser: where it cannot be sure it says so, and the caller assumes the
 * statement reads the most it could.
 */

/** Functions whose own syntax uses FROM: `extract(year FROM t)` reads no table. */
const FROM_IN_ARGS = new Set(['extract', 'substring', 'trim', 'overlay', 'position']);

const KEYWORDS = new Set(
  (
    'where group order limit offset having window qualify join left right inner outer ' +
    'full cross natural positional asof anti semi on using union except intersect ' +
    'select from lateral as pivot unpivot sample tablesample'
  ).split(' '),
);

/**
 * The tables and table functions a statement reads, lower-cased: each name
 * after FROM or JOIN (and after a comma in a FROM list), less the
 * statement's own CTEs. Null when the statement is beyond this reading: a
 * quoted name, a schema-qualified one, or a file path.
 */
export function sourcesOf(sql: string): string[] | null {
  const text = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
  if (text.includes('"')) return null;
  const ctes = new Set<string>();
  for (const m of text.matchAll(
    /(?:\bWITH(?:\s+RECURSIVE)?|,)\s*([A-Za-z_]\w*)\s*(?:\([^()]*\)\s*)?AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi,
  ))
    ctes.add(m[1]!.toLowerCase());
  const toks = text.match(/[A-Za-z_][\w$]*|''|[(),.;]|[^\s\w]/g) ?? [];
  const low = toks.map((t) => t.toLowerCase());
  const isName = (i: number) => /^[a-z_]/.test(low[i] ?? '') && !KEYWORDS.has(low[i]!);
  // What opened each open parenthesis: the token before it.
  const openers: string[] = [];
  const out: string[] = [];
  /** Reads one source at i; the index after it and its alias, or -1 when unsure. */
  const source = (i: number): number => {
    if (low[i] === "''") return -1; // FROM 'file.parquet'
    if (!isName(i)) return i; // a subquery or VALUES: its own FROMs are read in turn
    if (low[i + 1] === '.') return -1;
    out.push(low[i]!);
    let j = i + 1;
    if (low[j] === '(') {
      for (let depth = 0; j < low.length; j++) {
        if (low[j] === '(') depth++;
        else if (low[j] === ')' && --depth === 0) break;
      }
      j++;
    }
    if (low[j] === 'as') j += 2;
    else if (isName(j)) j++;
    return j;
  };
  for (let i = 0; i < low.length; i++) {
    const t = low[i]!;
    if (t === '(') openers.push(low[i - 1] ?? '');
    else if (t === ')') openers.pop();
    else if (t === 'from' || t === 'join') {
      if (t === 'from' && FROM_IN_ARGS.has(openers.at(-1) ?? '')) continue;
      let j = low[i + 1] === 'lateral' ? i + 2 : i + 1;
      for (;;) {
        j = source(j);
        if (j < 0) return null;
        if (t !== 'from' || low[j] !== ',') break;
        j++;
      }
    }
  }
  return out.filter((n) => !ctes.has(n));
}
