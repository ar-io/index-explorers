import '@preact/signals';
import { render } from 'preact';

import '@ar-io/explorer-ui/fonts/wavehaus.css';
import '@ar-io/explorer-ui/tokens.css';
import '@ar-io/explorer-ui/base.css';
import './styles.css';

import { AppContext, type Flows } from './context.js';
import { createDriveFlows } from './data/drives.js';
import { createFindFlows } from './data/find.js';
import { createQueryFlow } from './data/query.js';
import { createWalletFlow } from './data/wallet.js';
import { Session } from './session.js';
import { Store } from './store.js';
import { App } from './views/App.js';

const store = new Store();
const session = new Session(store);
const drives = createDriveFlows(session);
const query = createQueryFlow(session);
const wallet = createWalletFlow(session, drives);
const find = createFindFlows(session, { ...drives, ...wallet, runQuery: query.runQuery });
const flows: Flows = {
  browse: drives.browse,
  openDrive: drives.openDrive,
  openWallet: wallet.openWallet,
  openId: find.openId,
  runQuery: query.runQuery,
  ask: query.ask,
  find: find.find,
  setFolder: drives.setFolder,
};
session.flows = flows;

render(
  <AppContext.Provider value={{ store, session, flows }}>
    <App />
  </AppContext.Provider>,
  document.getElementById('page')!,
);

// For tests and the curious; read-only by convention.
declare global {
  interface Window {
    __explorer: {
      store: Store;
      session: Session;
      trace: string[];
      nameCache: Map<string, unknown>;
    };
  }
}
window.__explorer = { store, session, trace: store.trace, nameCache: session.names.cache };

void session.start();
