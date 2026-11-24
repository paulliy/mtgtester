/**
 * The public site as it ships (ADR 0053), for `bun run test:e2e:site`: the web app built with
 * `VITE_LOCAL_GAMES=true` into a temporary folder, served next to the site card files built from
 * the committed Oracle fixture. Single player runs in the page's worker; no game server runs.
 * Unknown paths get `index.html`, as static hosting's single-page fallback does.
 *
 *   bun run scripts/site-harness.ts [--port 3131]
 */

import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { buildSiteCards } from '../packages/server/src/cards/site-cards';
import { parseBannedList } from '../packages/server/src/decks/banned';

const at = process.argv.indexOf('--port');
const port = at === -1 ? 3131 : Number(process.argv[at + 1]);

const cards = JSON.parse(
  readFileSync(resolve('packages/server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const banned = parseBannedList(
  readFileSync(resolve('docs/rules/commander-banned-list.md'), 'utf8'),
);
const { files } = buildSiteCards({
  cards,
  bannedNames: banned.names,
  decks: [],
  sourceSha256: '0'.repeat(64),
  engine: { version: 'harness', commit: null },
});

const out = mkdtempSync(join(tmpdir(), 'decktank-site-'));
const build = Bun.spawnSync(['bunx', 'vite', 'build', '--outDir', out, '--emptyOutDir'], {
  cwd: resolve('apps/web'),
  env: { ...process.env, VITE_LOCAL_GAMES: 'true', NODE_ENV: 'production' },
  stdout: 'inherit',
  stderr: 'inherit',
});
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};
const root = resolve(out);
const index = readFileSync(join(root, 'index.html'));

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.startsWith('/cards/')) {
      const text = files.get(path.slice('/cards/'.length));
      return text === undefined
        ? new Response('Not found', { status: 404 })
        : new Response(text, { headers: { 'content-type': 'application/json' } });
    }
    const file = normalize(join(root, path));
    if (file.startsWith(root + sep) && existsSync(file) && statSync(file).isFile()) {
      return new Response(readFileSync(file), {
        headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' },
      });
    }
    // A missing script is a 404, as on the real host, so a stale chunk fails loudly.
    if (path.startsWith('/assets/')) return new Response('Not found', { status: 404 });
    return new Response(index, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
console.log(`Site harness on http://127.0.0.1:${port}`);
