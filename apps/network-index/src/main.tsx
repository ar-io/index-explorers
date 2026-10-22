import '@preact/signals';
import { render } from 'preact';

import '@ar-io/explorer-ui/tokens.css';
import '@ar-io/explorer-ui/base.css';
import '@ar-io/explorer-ui/ario.css';
import './styles.css';

import { Session, Store } from './session.js';
import { App, AppContext } from './views/App.js';

const store = new Store();
const session = new Session(store);
render(
  <AppContext.Provider value={{ store, session }}>
    <App />
  </AppContext.Provider>,
  document.getElementById('page')!,
);
declare global {
  interface Window {
    __explorer: { store: Store; session: Session };
  }
}
window.__explorer = { store, session };
void session.start();
