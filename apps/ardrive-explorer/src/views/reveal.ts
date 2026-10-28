import type { Store } from '../store.js';

const visible = (el: Element) => {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.bottom <= window.innerHeight;
};

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
 * under it, unless the status line or the result's title is already on screen.
 */
export function revealWork(): void {
  const el = document.getElementById('status');
  const title = document.getElementById('viewtitle');
  if (!el || visible(el) || (title && visible(title))) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Both, for anything asked from below the answer: at once, and again once it settles. */
export function revealAround(store: Store, work: Promise<unknown>): void {
  requestAnimationFrame(revealWork);
  void work.then(() => reveal(store));
}
