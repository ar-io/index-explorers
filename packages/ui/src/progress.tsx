export interface ProgressState {
  visible: boolean;
  indeterminate: boolean;
  /** 0–100 */
  pct: number;
  note: string;
  stop: boolean;
  stopDisabled: boolean;
}

export const hiddenProgress = (): ProgressState => ({
  visible: false,
  indeterminate: false,
  pct: 0,
  note: '',
  stop: false,
  stopDisabled: false,
});

export function ProgressBar({ state, onStop }: { state: ProgressState; onStop: () => void }) {
  return (
    <div id="progress" hidden={!state.visible}>
      <div
        class="pbar"
        id="bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={state.indeterminate ? undefined : Math.round(state.pct)}
        data-indeterminate={state.indeterminate ? 'true' : 'false'}
      >
        <i style={{ width: state.indeterminate ? '' : `${state.pct}%` }} />
      </div>
      <div class="barrow">
        <p id="barnote">{state.note}</p>
        <button
          id="stop"
          type="button"
          class="secondary"
          hidden={!state.stop}
          disabled={state.stopDisabled}
          onClick={onStop}
        >
          Stop
        </button>
      </div>
    </div>
  );
}
