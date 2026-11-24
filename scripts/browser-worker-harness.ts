/**
 * A bare page that runs the single-player worker (ADR 0053) in a real browser, for
 * `bun run test:e2e:browser`. It builds the site card files from the committed Oracle fixture,
 * bundles `host/browser-worker.ts` for the browser, and serves both next to a page whose script
 * starts the worker and records everything it posts back. No game server runs.
 *
 *   bun run scripts/browser-worker-harness.ts [--port 3121]
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { buildSiteCards } from '../packages/server/src/cards/site-cards';
import { parseBannedList } from '../packages/server/src/decks/banned';

const at = process.argv.indexOf('--port');
const port = at === -1 ? 3121 : Number(process.argv[at + 1]);

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

const built = await Bun.build({
  entrypoints: [resolve('packages/server/src/host/browser-worker.ts')],
  target: 'browser',
  format: 'esm',
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const worker = await built.outputs[0]!.text();

const page = `<!doctype html>
<meta charset="utf-8">
<title>Worker harness</title>
<script type="module">
  const worker = new Worker('/worker.js', { type: 'module' });
  window.received = [];
  window.workerErrors = [];
  worker.addEventListener('message', (event) => window.received.push(event.data));
  worker.addEventListener('error', (event) => window.workerErrors.push(String(event.message)));
  window.post = (message) => worker.postMessage(message);
  window.post({ kind: 'init', cardsUrl: new URL('/cards/', location.href).href });
</script>
`;

Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } });
    if (path === '/worker.js') {
      return new Response(worker, { headers: { 'content-type': 'text/javascript' } });
    }
    if (path.startsWith('/cards/')) {
      const text = files.get(path.slice('/cards/'.length));
      if (text !== undefined) {
        return new Response(text, { headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('Not found', { status: 404 });
  },
});
console.log(`Worker harness on http://127.0.0.1:${port}`);
