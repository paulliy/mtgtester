/**
 * The site's build (ADR 0053, plan section 7): single player and the multiplayer tables in one
 * bundle. The public build plays in the browser (`VITE_LOCAL_GAMES=true`), so it carries the game
 * worker, loaded only from the chunk single player imports when a game starts; it never carries
 * the Card Test Lab, the deal preview or the server-only Debug, Stats and Batch views. A build
 * without local games emits no worker at all.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '..');
const outs: string[] = [];
afterAll(() => {
  for (const out of outs) rmSync(out, { recursive: true, force: true });
});

function build(env: Record<string, string>) {
  const out = mkdtempSync(join(tmpdir(), 'site-bundle-'));
  outs.push(out);
  const result = spawnSync('bunx', ['vite', 'build', '--outDir', out], {
    cwd: WEB,
    encoding: 'utf8',
    timeout: 180_000,
    // Under the test runner NODE_ENV is `test`, which would make this a development build.
    env: { ...process.env, NODE_ENV: 'production', ...env },
  });
  const assets = result.status === 0 ? readdirSync(join(out, 'assets')) : [];
  const read = (file: string) => readFileSync(join(out, 'assets', file), 'utf8');
  return { result, assets, read };
}

const NEVER_ON_SITE = [
  'CardTestLabView',
  'DealsPreviewView',
  'DebugView',
  'StatsView',
  'BatchSetupView',
  'BatchResultsView',
];

describe('the site build with local games', () => {
  const site = build({ VITE_LOCAL_GAMES: 'true' });

  it('builds single player and the tables together', () => {
    expect(site.result.status, site.result.stderr).toBe(0);
    for (const view of ['SetupView', 'GameView', 'TableView', 'TableHomeView']) {
      expect(
        site.assets.some((file) => file.startsWith(view)),
        view,
      ).toBe(true);
    }
  });

  it('leaves out the lab, the deal preview and the server-only views', () => {
    for (const view of NEVER_ON_SITE) {
      expect(
        site.assets.some((file) => file.startsWith(view)),
        view,
      ).toBe(false);
    }
  });

  it('loads the game worker only from the local engine chunk', () => {
    const worker = site.assets.find((file) => /^browser-worker-.*\.js$/.test(file));
    expect(worker).toBeDefined();
    const referrers = site.assets.filter(
      (file) => file.endsWith('.js') && file !== worker && site.read(file).includes(worker!),
    );
    expect(referrers).toHaveLength(1);
    expect(referrers[0]).toMatch(/^localEngine-/);
  });
});

describe('the site build without local games', () => {
  const site = build({ VITE_LOCAL_GAMES: 'false' });

  it('emits no game worker', () => {
    expect(site.result.status, site.result.stderr).toBe(0);
    expect(site.assets.some((file) => file.startsWith('browser-worker'))).toBe(false);
    expect(site.assets.some((file) => file.startsWith('localEngine'))).toBe(false);
  });
});
