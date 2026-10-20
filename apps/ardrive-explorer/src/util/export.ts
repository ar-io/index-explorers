/** CSV and JSON of a whole result, not the rows the table shows. */

export function exportValue(v: unknown, isTime: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (isTime) {
    const d = new Date(Number(v));
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return [...v].map((x) => x.toString(16).padStart(2, '0')).join('');
  if (typeof v === 'object') return String(v);
  return v;
}

const csvCell = (v: unknown): string => {
  const t = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(t) ? '"' + t.replaceAll('"', '""') + '"' : t;
};

export function toCsv(cols: string[], rows: Record<string, unknown>[], isTime: Set<string>): string {
  const out = [cols.map(csvCell).join(',')];
  for (const r of rows) out.push(cols.map((c) => csvCell(exportValue(r[c], isTime.has(c)))).join(','));
  return out.join('\r\n') + '\r\n';
}

export function toJson(cols: string[], rows: Record<string, unknown>[], isTime: Set<string>): string {
  return (
    JSON.stringify(
      rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const c of cols) o[c] = exportValue(r[c], isTime.has(c));
        return o;
      }),
      null,
      2,
    ) + '\n'
  );
}

export function saveFile(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
