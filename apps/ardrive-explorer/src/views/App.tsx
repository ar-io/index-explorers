import { useApp } from '../context.js';
import { DataSource, Questions, SqlDrawer } from './Ask.js';
import { Explore } from './Explore.js';
import { Masthead } from './Masthead.js';

export function App() {
  const { store } = useApp();
  const pub = store.pub.value;
  const home = (pub.publisherUrl ?? pub.gateway ?? 'https://turbo-gateway.com').replace(/\/+$/, '');
  return (
    <div class="rail">
      <a class="skip" href="#explore">
        Skip to Explore
      </a>
      <Masthead />
      <main>
        <Explore />
        <section class="panel" id="ask">
          <p class="panel-label">Ask the data</p>
          <h2 class="panel-title">
            Questions over the period chosen above. Answers are computed in this tab.
          </h2>
          <Questions />
          <SqlDrawer />
          <DataSource />
        </section>
      </main>
      <footer>
        <div class="foot-grid">
          <div>
            <h4>ArDrive</h4>
            <ul>
              <li>
                <a href="https://app.ardrive.io" target="_blank" rel="noopener">
                  Open the app
                </a>
              </li>
              <li>
                <a href="https://docs.ardrive.io" target="_blank" rel="noopener">
                  ArDrive docs
                </a>
              </li>
              <li>
                <a href="https://docs.ardrive.io/docs/arfs/" target="_blank" rel="noopener">
                  The ArFS file system
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h4>The index</h4>
            <ul>
              <li>
                <a id="foot-pub" href={`${home}/ar-io/indexes`} target="_blank" rel="noopener">
                  {pub.publisherName
                    ? `${pub.publisherName}'s signed publication`
                    : 'The signed publication'}
                </a>
              </li>
              <li>
                <a
                  href="https://docs.ar.io/build/advanced/index-publications"
                  target="_blank"
                  rel="noopener"
                >
                  Index publications, explained
                </a>
              </li>
              <li>
                <a href="https://arweave-l1-search.ar.io" target="_blank" rel="noopener">
                  The Arweave L1 explorer
                </a>
              </li>
              <li>
                <a href="https://cdb64.ar.io" target="_blank" rel="noopener">
                  Every index the gateway publishes
                </a>
              </li>
            </ul>
          </div>
          <div class="foot-cli">
            <h4>Do the same on the command line</h4>
            <p>The bands are plain Parquet. With DuckDB installed:</p>
            <pre>
              <code>{`duckdb -c "SELECT count(*) FROM read_parquet('${home}/ar-io/indexes/ardrive-l2/<band>/data_items.parquet')"`}</code>
            </pre>
            <p class="note" style="margin-top:9px;font-size:13px">
              Verify first: <code>ar-io-node index-l2-verify --bands-dir …</code> checks every band
              against its signed digests and a sample against the chain.
            </p>
          </div>
        </div>
        <p class="foot-legal">
          Built on the ar.io network's verifiable indexes. ArDrive is a product of Permanent Data
          Solutions. This page holds no accounts and sets no cookies; what it remembers (checked
          pieces of the index) stays in your browser.
        </p>
      </footer>
    </div>
  );
}
