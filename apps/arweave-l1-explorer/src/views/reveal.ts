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

/** For anything asked from above or below the answer: at once (a refusal is said at once), and again once it settles. */
export function revealAround(store: Store, work: Promise<unknown>): void {
  requestAnimationFrame(() => reveal(store));
  void work.then(() => reveal(store));
}
