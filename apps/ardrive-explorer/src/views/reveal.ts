import type { Store } from '../store.js';

/**
 * Brings an answer into view after Find or a question: the status line when
 * it says why there is none, else the result's title. Nothing moves when it
 * is already on screen, so asking again does not jump the page.
 */
export function reveal(store: Store): void {
  const bad = store.status.value.cls === 'bad';
  const el = document.getElementById(bad ? 'status' : 'viewtitle');
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= window.innerHeight) return;
  el.scrollIntoView({ behavior: 'smooth', block: bad ? 'nearest' : 'start' });
}
