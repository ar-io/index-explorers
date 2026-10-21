/**
 * The release gate: an app is deployed only as the exact bytes that were
 * fully verified on a developer machine.
 *
 *   node scripts/release.mjs verify <app> --version <x.y.z>
 *     On a clean checkout: install, pin check, lint, every unit test, the
 *     app's E2E specs on the fixture gateway, production builds, and the
 *     app's E2E specs live against turbo-gateway.com. Every step must
 *     pass. Then writes releases/<app>.json: the git tree ids of every input
 *     to the build, and the SHA-256 of every file the build produced.
 *     Commit that file, tag `<app>-v<x.y.z>`, push the tag.
 *
 *   node scripts/release.mjs check <app> --version <x.y.z>
 *     In the Deploy workflow, after its own production build: the record
 *     exists for this version, the build inputs at the tag are the ones
 *     verified, and the build is byte-identical to the verified one.
 *
 *   node scripts/release.mjs remote <app> --manifest <id> [--gateway <url>] [--url <arns url>]
 *     After the upload: the manifest lists exactly the verified files, every
 *     file served through it is the verified bytes (gzip or not), and the
 *     ArNS name resolves to the manifest on every answer for two minutes
 *     (gateway nodes keep the old record for its TTL).
 *
 *   node scripts/release.mjs deployed <app> --url <arns url>
 *     After the name points at the upload: the app's smoke spec against the
 *     deployed page itself, served by a gateway (gzip and all).
 *
 *   node scripts/release.mjs specs <app>
 *     Prints the E2E spec files of an app (the Deploy workflow runs them live).
 *
 *   node scripts/release.mjs hashes <app>
 *     Prints the record's `dist` for the current build, for comparisons.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Each app and the E2E specs that open it: a release runs its own app's suites. */
const SPECS = {
  'ardrive-explorer': ['smoke', 'matrix', 'nav', 'perf'],
  'arweave-l1-explorer': ['l1'],
  'network-index': ['network-index'],
};
const APPS = Object.keys(SPECS);
/** After a deploy: the spec that opens the deployed page, and how it is told the page's URL. */
const DEPLOYED = {
  'ardrive-explorer': { spec: 'smoke', env: 'LIVE_BASE' },
  'arweave-l1-explorer': { spec: 'l1', env: 'L1_BASE' },
  'network-index': { spec: 'network-index', env: 'NI_BASE' },
};
/** Every input to an app's production build, besides the app itself. */
const SHARED_INPUTS = [
  'packages',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'engine.lock.json',
];

const [cmd, app, ...rest] = process.argv.slice(2);
const opt = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
const die = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};
if (!cmd || !APPS.includes(app ?? ''))
  die(`usage: release.mjs verify|check|remote|deployed|specs|hashes <${APPS.join('|')}> [options]`);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
/** Uncommitted changes, apart from release records (outputs of verification, never build inputs). */
const changes = () =>
  git('status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude)releases');
const recordPath = path.join(ROOT, 'releases', `${app}.json`);
const distDir = path.join(ROOT, 'apps', app, 'dist');

/** The git tree (or blob) id at HEAD of every build input: equal ids, equal inputs. */
function sources() {
  const out = {};
  for (const p of [`apps/${app}`, ...SHARED_INPUTS]) {
    if (!existsSync(path.join(ROOT, p))) continue;
    out[p] = git('rev-parse', `HEAD:${p}`);
  }
  return out;
}

const specFiles = () => SPECS[app].map((s) => `e2e/tests/${s}.spec.ts`);

/** SHA-256 of every file the build wrote, by path relative to dist: what the upload takes. */
function distHashes() {
  if (!existsSync(distDir)) die(`${path.relative(ROOT, distDir)} does not exist: build first`);
  const out = {};
  const walk = (dir, base) => {
    for (const f of readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (statSync(p).isDirectory()) walk(p, `${base}${f}/`);
      else out[`${base}${f}`] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(distDir, '');
  return out;
}

function diff(label, want, got) {
  const lines = [];
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)]))
    if (want[k] !== got[k])
      lines.push(`  ${k}: verified ${want[k] ?? '(absent)'}, here ${got[k] ?? '(absent)'}`);
  if (lines.length) die(`${label} differ from the verified release:\n${lines.join('\n')}`);
}

function run(name, command, args, env = {}) {
  console.log(`\n▶ ${name}: ${command} ${args.join(' ')}`);
  const t = Date.now();
  const r = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  const seconds = Math.round((Date.now() - t) / 100) / 10;
  if (r.status !== 0) die(`${name} failed after ${seconds}s: nothing recorded`);
  console.log(`✓ ${name} (${seconds}s)`);
  return { name, seconds };
}

if (cmd === 'verify') {
  const version = opt('--version');
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version))
    die('--version <x.y.z> is required');
  const dirty = changes();
  if (dirty) die(`the checkout has changes; verify only committed code:\n${dirty}`);
  const head = git('rev-parse', 'HEAD');
  const src = sources();
  const steps = [
    run('install', 'pnpm', ['install', '--frozen-lockfile']),
    run('engine files', 'node', ['scripts/fetch-engine.mjs']),
    run('engine pins against two gateways', 'pnpm', ['pins:check']),
    run('format and types', 'pnpm', ['lint']),
    run('unit and integration tests', 'pnpm', ['test']),
    run('E2E builds', 'pnpm', ['--filter', './apps/*', 'run', 'build:e2e']),
    run('E2E on the fixture gateway', 'pnpm', ['e2e', ...specFiles()]),
    run('production builds', 'pnpm', ['--filter', './apps/*', 'run', 'build']),
    run('live E2E against turbo-gateway.com', 'pnpm', ['e2e:live', ...specFiles()], {
      GW: 'https://turbo-gateway.com',
    }),
  ];
  if (git('rev-parse', 'HEAD') !== head || changes())
    die('the checkout changed while verifying: nothing recorded');
  const record = {
    app,
    version,
    verifiedAt: new Date().toISOString(),
    verifiedBy: git('config', 'user.name') || os.userInfo().username,
    commit: head,
    machine: `${os.platform()} ${os.arch()}, node ${process.version}`,
    steps,
    sources: src,
    dist: distHashes(),
  };
  mkdirSync(path.dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  console.log(`\nrecorded ${path.relative(ROOT, recordPath)}: ${Object.keys(record.dist).length} files from ${head.slice(0, 7)}.
Next:
  git add ${path.relative(ROOT, recordPath)} && git commit -m "release(${app}): ${version} verified"
  then merge it to main and tag that commit ${app}-v${version}`);
} else if (cmd === 'check') {
  if (!existsSync(recordPath))
    die(`no ${path.relative(ROOT, recordPath)}: run "release.mjs verify ${app}" locally first`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const version = opt('--version');
  if (record.version !== version)
    die(`the record verifies ${app} ${record.version}, the tag says ${version}`);
  diff('build inputs', record.sources, sources());
  diff('built files', record.dist, distHashes());
  console.log(
    `${app} ${version}: inputs and all ${Object.keys(record.dist).length} built files match the release verified ${record.verifiedAt} by ${record.verifiedBy} (${record.commit.slice(0, 7)})`,
  );
} else if (cmd === 'remote') {
  const manifest = opt('--manifest');
  const gateway = (opt('--gateway') ?? 'https://turbo-gateway.com').replace(/\/$/, '');
  const url = opt('--url');
  if (!manifest || !/^[A-Za-z0-9_-]{43}$/.test(manifest)) die('--manifest <id> is required');
  if (!existsSync(recordPath)) die(`no ${path.relative(ROOT, recordPath)}`);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const retry = async (what, fn, tries = 20, waitMs = 15_000) => {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= tries) die(`${what}: ${e.message}`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  };
  const doc = await retry('reading the manifest', async () => {
    const res = await fetch(`${gateway}/raw/${manifest}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  const listed = Object.keys(doc.paths ?? {}).sort();
  const verified = Object.keys(record.dist).sort();
  if (listed.join('\n') !== verified.join('\n'))
    die(
      `the manifest lists other files than were verified:\n  manifest: ${listed.join(', ')}\n  verified: ${verified.join(', ')}`,
    );
  const bad = [];
  for (const f of verified) {
    const bytes = await retry(`fetching ${f}`, async () => {
      const res = await fetch(`${gateway}/${manifest}/${f}`); // fetch undoes Content-Encoding
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    });
    const h = createHash('sha256').update(bytes).digest('hex');
    if (h !== record.dist[f]) bad.push(`  ${f}: served ${h}, verified ${record.dist[f]}`);
  }
  if (bad.length) die(`served files differ from the verified release:\n${bad.join('\n')}`);
  console.log(`manifest ${manifest}: all ${verified.length} files are the verified bytes`);
  if (url) {
    // A name is served by many gateway nodes, each caching the old record for
    // its TTL (900 s), so one answer proves nothing: wait until every answer,
    // over two minutes of cache-busted requests, is the new manifest.
    const base = url.replace(/\/$/, '');
    const want = 12; // consecutive answers, 10 s apart
    const deadline = Date.now() + 25 * 60_000;
    let streak = 0;
    let last = '';
    while (streak < want) {
      if (Date.now() > deadline)
        die(
          `${url} still answers ${last || 'nothing'} 25 minutes after the update, not ${manifest}`,
        );
      const res = await fetch(`${base}/?release-check=${Date.now()}`, { method: 'HEAD' }).catch(
        () => null,
      );
      last = res?.headers.get('x-arns-resolved-id') ?? '';
      streak = last === manifest ? streak + 1 : 0;
      if (streak < want) await new Promise((r) => setTimeout(r, 10_000));
    }
    console.log(`${url} resolves to ${manifest} (${want} answers in a row)`);
  }
} else if (cmd === 'deployed') {
  const url = opt('--url');
  if (!url) die('--url <deployed page> is required');
  const { spec, env } = DEPLOYED[app];
  run(`${app} at ${url}`, 'pnpm', ['e2e:live', `e2e/tests/${spec}.spec.ts`], {
    [env]: url.endsWith('/') ? url : `${url}/`,
    GW: 'https://turbo-gateway.com',
  });
} else if (cmd === 'specs') {
  console.log(specFiles().join(' '));
} else if (cmd === 'hashes') {
  console.log(JSON.stringify(distHashes(), null, 2));
} else {
  die(`unknown command ${cmd}`);
}
