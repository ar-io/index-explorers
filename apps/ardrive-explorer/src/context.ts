import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

import type { RunOptions } from './data/query.js';
import type { Session } from './session.js';
import type { Store } from './store.js';

export interface Flows {
  browse: (reset: boolean) => Promise<void>;
  openDrive: (id: string, confirmed: boolean, folder: string | null) => Promise<void>;
  openWallet: (addr: string, everything: boolean) => Promise<void>;
  openId: (id: string) => Promise<void>;
  runQuery: (opts: RunOptions) => Promise<void>;
  ask: (i: number) => Promise<void>;
  find: (raw: string) => Promise<void>;
  setFolder: (path: string[], replace?: boolean) => void;
}

export interface AppContextValue {
  store: Store;
  session: Session;
  flows: Flows;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext is missing');
  return v;
}
