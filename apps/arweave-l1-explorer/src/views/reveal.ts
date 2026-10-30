import { effect } from '@preact/signals';

import type { Store } from '../session.js';

const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
};

/**
 * Brings an answer into view after Find or a question: the status line when
 * it says why there is none, else the answer's title. Nothing moves when it
 * is already on screen, so asking again does not jump the page.
 */
export function reveal(store: Store): void {
  const bad = store.status.value.cls === 'bad';
  const el = document.getElementById(bad ? 'status' : 'answertitle');
  if (!el || visible(el)) return;
  el.scrollIntoView({ behavior: 'smooth', block: bad ? 'nearest' : 'start' });
}

/**
 * The work under way, once it shows: the status line, under the progress bar,
 * or the bar alone while the line is empty. Null while neither says anything.
 */
function working(store: Store): HTMLElement | null {
  const s = store.status.value;
  if (!store.progress.value.visible && !(s.text && s.cls === '')) return null;
  return document.getElementById(s.text ? 'status' : 'progress');
}

/**
 * The work, brought into view: the status line and the bar sit under the
 * answer, below the fold on a laptop, and starting the engine takes half a
 * minute. Centred, as the bar can appear above the line after it. Nothing
 * moves when the line is on screen, or the answer it will replace is.
 */
function revealWork(store: Store, el: HTMLElement): void {
  const title = document.getElementById('answertitle');
  if (visible(el) || (store.result.value && title && visible(title))) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/**
 * For anything asked from above or below the answer: a refusal as soon as it
 * is said, else the work once it first shows, and the answer once it settles.
 */
export function revealAround(store: Store, work: Promise<unknown>): void {
  // A line said before this was asked is the last answer's, not this one's.
  const before = store.status.value;
  let done = false;
  const look = () => {
    if (done) return;
    const s = store.status.value;
    const refused = s.cls === 'bad' && s !== before;
    const el = refused ? null : working(store);
    if (refused) reveal(store);
    else if (el) revealWork(store, el);
    else return;
    done = true;
    stop();
  };
  // Signals change before the page draws them: look on the next frame.
  const stop = effect(() => {
    void store.status.value;
    void store.progress.value;
    requestAnimationFrame(look);
  });
  void work.then(() => {
    done = true;
    stop();
    reveal(store);
  });
}
