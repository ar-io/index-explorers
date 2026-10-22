import type { ComponentChildren } from 'preact';

export type CheckState = '' | 'run' | 'ok' | 'bad';
export type ProofChecks = Record<'registry' | 'signature' | 'engine' | 'pieces', CheckState>;

const LABELS: Record<keyof ProofChecks, string> = {
  registry: "The publisher's signing key, read from the ar.io registry through a different gateway",
  signature: "The publication's signature, checked against that key",
  engine:
    "The query engine, matched against a hash pinned in this page, and its Parquet reader, which the engine accepts only with DuckDB's signature. Checked when you first load data",
  pieces:
    "Every piece of the index a listing reads, checked as it arrives against the file's BitTorrent v2 hash tree, whose root the signed publication pins",
};

/** The hero's one line about trust, with the four checks behind "How it's verified". A failure opens the detail. */
export function Proof({
  state,
  text,
  checks,
  note,
  labels = LABELS,
}: {
  state: 'run' | 'ok' | 'bad';
  text: string;
  checks: ProofChecks;
  note?: ComponentChildren;
  labels?: Record<keyof ProofChecks, string>;
}) {
  return (
    <details class="proof" id="proof" data-state={state} open={state === 'bad' ? true : undefined}>
      <summary>
        <i aria-hidden="true" />
        <span id="proof-text">{text}</span>
        <span class="proof-how">
          How it's verified<b aria-hidden="true">›</b>
        </span>
      </summary>
      <ol class="checks" id="checks">
        {(Object.keys(labels) as (keyof ProofChecks)[]).map((k) => (
          <li key={k} data-k={k} data-state={checks[k]}>
            <i />
            <span>{labels[k]}</span>
          </li>
        ))}
      </ol>
      {note ? <p class="proof-note">{note}</p> : null}
    </details>
  );
}
