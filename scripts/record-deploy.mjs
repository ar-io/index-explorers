/**
 * Writes a deploy into DEPLOYS.md: the app, its version, the manifest id the
 * ArNS name now points at, and every uploaded file's SHA-256, so a rebuild on
 * the same commit can be compared with what is live.
 *
 *   node scripts/record-deploy.mjs --app ardrive-explorer --version 1.0.0 --manifest <id> \
 *     --url https://explore_ardrive.ar.io --previous <id the name pointed at> --commit <sha>
 *
 * The upload itself is ario-deploy's (ar-io/ar-io-deploy), run by the Deploy
 * workflow; this only records what it did.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const APP = opt('--app');
const VERSION = opt('--version') ?? 'dev';
const MANIFEST = opt('--manifest');
const URL_ = opt('--url') ?? '';
const PREVIOUS = opt('--previous') ?? 'none';
if (!APP || !MANIFEST) {
  console.error('usage: --app <name> --version <v> --manifest <id> [--url <url>]');
  process.exit(2);
}
const dist = path.join(ROOT, 'apps', APP, 'dist');
function hashes(dir, base = '') {
  const out = {};
  for (const f of readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) Object.assign(out, hashes(p, base + f + '/'));
    else if (!f.endsWith('.map'))
      out[base + f] = createHash('sha256').update(readFileSync(p)).digest('hex');
  }
  return out;
}
const files = existsSync(dist) ? hashes(dist) : {};
const commit = opt('--commit') ?? process.env.GITHUB_SHA?.slice(0, 7) ?? 'local';
const date = new Date().toISOString().slice(0, 10);
const deploys = path.join(ROOT, 'DEPLOYS.md');
const header =
  '# Deploys\n\nEvery upload, newest first. The manifest id is what the ArNS name points at. Each entry lists the SHA-256 of every uploaded file, so a rebuild of the same commit can be compared with what is live.\n';
const prev = existsSync(deploys)
  ? readFileSync(deploys, 'utf8').replace(/^# Deploys[\s\S]*?\n(?=## |$)/, '')
  : '';
const entry =
  `## ${date} · ${APP} ${VERSION}\n\n` +
  `- manifest: \`${MANIFEST}\`\n- name: ${URL_}\n- before: \`${PREVIOUS}\` (point the record back at it to roll back)\n- commit: ${commit}\n- files:\n` +
  Object.entries(files)
    .map(([f, h]) => `  - \`${f}\` ${h}`)
    .join('\n') +
  '\n\n';
writeFileSync(deploys, header + '\n' + entry + prev.trimStart());
console.log(`recorded ${APP} ${VERSION} → ${MANIFEST} (${Object.keys(files).length} files)`);
