/**
 * ArDrive's chart, standalone: give it points; styles in `chart.css`, over
 * the ArDrive tokens. The ArDrive explorer draws a question's answer with it.
 *
 * An answer, drawn before its table. Ranked bars are a list (a name, a bar
 * and its figure per row); a measure over months is columns, one scale, with
 * the figure on hover. One neutral hue: the kit keeps red for actions and its
 * status hues for states. Two series stack, in two steps of it, with a key.
 * The table under it holds every figure, so a screen reader reads that.
 */
/** One bar or column: its name, its values (one per series, stacked), and the figure said beside it. */
export interface ChartPoint {
  label: string;
  values: number[];
  text: string;
}

/** What a chart draws: bars (ranked) or columns (over time), one scale. */
export interface ChartData {
  form: 'bars' | 'columns';
  /** The series' names, for the key when there are two. */
  series: string[];
  points: ChartPoint[];
  /** The largest total, which a full bar or column stands for. */
  max: number;
}

const pct = (v: number, max: number): string => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;

/**
 * Which columns are named under the axis: all of a few; else about five, and
 * none in the last fifth, whose names would run off the plot's right edge.
 */
const named = (i: number, n: number): boolean =>
  n <= 6 || (i % Math.ceil(n / 5) === 0 && n - i > Math.max(2, n / 5));

function Key({ series }: { series: string[] }) {
  if (series.length < 2) return null;
  return (
    <p class="chart-key">
      {series.map((s, i) => (
        <span key={s}>
          <i class={`sw s${i}`} />
          {s}
        </span>
      ))}
    </p>
  );
}

function Bars({ c }: { c: ChartData }) {
  return (
    <ol class="meters">
      {c.points.map((p, i) => (
        <li key={i}>
          <span class="m-name" title={p.label}>
            {p.label}
          </span>
          <span class="m-track">
            {p.values.map((v, s) => (
              <i key={s} class={`s${s}`} style={{ width: pct(v, c.max) }} />
            ))}
          </span>
          <span class="m-fig">{p.text}</span>
        </li>
      ))}
    </ol>
  );
}

function Columns({ c }: { c: ChartData }) {
  return (
    <div class="cols-wrap">
      <div class="cols-plot">
        <span class="cols-max">{c.points.length ? maxText(c) : ''}</span>
        <div class="cols">
          {c.points.map((p, i) => (
            <div key={i} class="col" data-tip={`${p.label}: ${p.text}`}>
              {/* Bottom up: the first series sits on the baseline. */}
              {p.values.map((v, s) => (
                <i key={s} class={`s${s}`} style={{ height: pct(v, c.max) }} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div class="cols-axis">
        {c.points.map((p, i) => (
          <span key={i}>{named(i, c.points.length) ? p.label : ''}</span>
        ))}
      </div>
    </div>
  );
}

/** The top of the scale, said once at the top of the plot. */
function maxText(c: ChartData): string {
  const top = c.points.reduce(
    (a, p) => {
      const t = p.values.reduce((x, y) => x + y, 0);
      return t > a.t ? { t, p } : a;
    },
    { t: -1, p: c.points[0]! },
  );
  return c.series.length > 1 ? `${top.t.toLocaleString()} at most` : top.p.text;
}

export function Chart({ c, id }: { c: ChartData; id?: string }) {
  return (
    <figure class={`chart ${c.form}`} {...(id ? { id } : {})} aria-hidden="true">
      <Key series={c.series} />
      {c.form === 'bars' ? <Bars c={c} /> : <Columns c={c} />}
    </figure>
  );
}
