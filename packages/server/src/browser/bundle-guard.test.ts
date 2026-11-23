/**
 * Single player runs the game in the visitor's browser (ADR 0053). This bundles the server
 * modules that run there for the browser and fails if any of them reaches a Node or Bun API or
 * the model code: `node:` and `bun:` imports would be polyfilled or break at load, and the
 * OpenRouter SDK and zod come only with `ai/`, which a session without model seats never needs.
 *
 * Add a module to `BROWSER_MODULES` when browser code starts importing it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

/** The modules browser code imports, each with one export it uses. */
const BROWSER_MODULES: ReadonlyArray<[module: string, name: string]> = [
  ['match/session', 'MatchSession'],
  ['match/setup', 'setupSeats'],
  ['match/preview', 'previewMatchup'],
  ['match/report', 'reportLogLine'],
  ['match/disclosure', 'testerPolicy'],
  ['table/in-process-port', 'InProcessSessionPort'],
  ['table/deck-check', 'createDeckChecker'],
  ['cards/oracle-index', 'buildOracleIndexFromCards'],
  ['cards/pool', 'buildSupportedPool'],
  ['decks/banned', 'bannedListFromNames'],
  ['cards/site-cards', 'SiteCards'],
  ['host/game-host', 'GameHost'],
  ['host/worker-core', 'serveWorker'],
  ['db/deck-store', 'MemoryDeckStore'],
];

/** Packages that arrive only with the model code. */
const MODEL_ONLY_PACKAGES = ['@openrouter', 'zod'];

const out = mkdtempSync(join(tmpdir(), 'browser-bundle-'));
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

interface Metafile {
  inputs: Record<string, { imports?: Array<{ path: string; external?: boolean }> }>;
}

describe('the browser bundle of the session code', () => {
  const entry = join(out, 'entry.ts');
  writeFileSync(
    entry,
    BROWSER_MODULES.map(
      ([module, name]) =>
        `export { ${name} as ${name}_${module.replace(/\W/g, '_')} } from ${JSON.stringify(join(SRC, module))};`,
    ).join('\n'),
  );
  const metafile = join(out, 'meta.json');
  const build = spawnSync(
    'bun',
    [
      'build',
      entry,
      '--target',
      'browser',
      '--minify',
      '--outdir',
      join(out, 'dist'),
      `--metafile=${metafile}`,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );

  it('builds', () => {
    expect(build.status, build.stderr).toBe(0);
  });

  it('imports no Node or Bun module and none of the model code', () => {
    const meta = JSON.parse(readFileSync(metafile, 'utf8')) as Metafile;
    const offenders: string[] = [];
    for (const [file, input] of Object.entries(meta.inputs)) {
      const local = file.split('/packages/').at(-1) ?? file;
      if (local.startsWith('server/src/ai/') && !ALLOWED_AI_FILES.has(local)) {
        offenders.push(`${local} (model code)`);
      }
      for (const { path } of input.imports ?? []) {
        if (path.startsWith('node:') || path.startsWith('bun:')) {
          offenders.push(`${local} imports ${path}`);
        }
        if (MODEL_ONLY_PACKAGES.some((pkg) => path.includes(`node_modules/${pkg}`))) {
          offenders.push(`${local} imports ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('stays under 0.75 MB gzipped', () => {
    // 0.62 MB when this guard was added; the server bundle with the model code was 0.96 MB.
    const file = join(out, 'dist', 'entry.js');
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(gzipSync(readFileSync(file)).byteLength).toBeLessThan(750_000);
  });
});

/**
 * Two files under `ai/` carry no model code: the card traits the heuristic bot reads, and the
 * deal draft's no-model fallback. Anything else from `ai/` is a leak.
 */
const ALLOWED_AI_FILES = new Set(['server/src/ai/card-traits.ts', 'server/src/ai/deal-draft.ts']);
