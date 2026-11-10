import type { Store } from '../store.js';

const visible = (el: Element, room = 0) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight - room;
};

/** Under the status line while work runs: the progress bar, its note and Stop. */
const BAR_ROOM = 96;

/**
 * Brings an answer into view after Find or a question: the status line when
 * it says why there is none, else the result's title. Nothing moves when it
 * is already on screen, so asking again does not jump the page.
 */
export function reveal(store: Store): void {
  const bad = store.status.value.cls === 'bad';
  const el = document.getElementById(bad ? 'status' : 'viewtitle');
  if (!el || visible(el)) return;
  el.scrollIntoView({ behavior: 'smooth', block: bad ? 'nearest' : 'start' });
}

/**
 * While a question works: the status line, with the progress bar and Stop
 * under it, unless they or the result's title are already on screen.
 */
export function revealWork(): void {
  // The box that holds the status line and the bar: in the page even while both are empty.
  const el = document.getElementById('work');
  const title = document.getElementById('viewtitle');
  // The status line with room under it for Stop, or the answer's title, already on screen.
  if (!el || visible(el, BAR_ROOM) || (title && visible(title))) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Both, for anything asked from below the answer: at once, and again once it settles. */
export function revealAround(store: Store, work: Promise<unknown>): void {
  requestAnimationFrame(revealWork);
  // Again once the bar shows: a short page may not have had the room to scroll before.
  store.revealing.value = true;
  void work.then(() => {
    store.revealing.value = false;
    reveal(store);
  });
}
