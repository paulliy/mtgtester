/**
 * The provisional card catalog (H1): which review-queue entries the server admits, and that it is
 * opt-in everywhere a game, a pool or a benchmark is built.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '@mtg/engine';
import { buildSupportedPool } from './pool';
import {
  provisionalGameConfig,
  provisionalReplayPins,
  type ProvisionalCatalog,
} from './provisional';
import { loadProvisionalCatalog } from './provisional-load';
import { unmodeledCardNames } from '../match/setup';

const REPO = resolve(__dirname, '../../../..');
const PINNED = JSON.parse(
  readFileSync(join(REPO, 'packages/server/fixtures/edhrec-pinned-oracle.json'), 'utf8'),
) as Array<{ card: OracleCard }>;
const cardNamed = (name: string): OracleCard => {
  const row = PINNED.find((r) => r.card.name === name);
  if (row === undefined) throw new Error(`${name} is not pinned`);
  return row.card;
};

/** A real checked patch from the queue: Ancestral Blade's compiled ETB trigger. */
const BLADE = 'Ancestral Blade';
const BLADE_PATCH = 'docs/reviews/card-compiler-trial-02/patches/ancestral-blade.json';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Entry {
  name: string;
  oracleId: string;
  source: string;
  status: string;
  handledLines: string[];
  patch: string | null;
  patchSha256: string | null;
  review: { verdict: 'accepted' | 'rejected'; by: string } | null;
  crossCheck?: { source: string; verdict: string };
}

/** A temporary repository root holding a queue, its patch files and an optional demotion list. */
function fixtureRoot(
  build: (blade: Entry, patchText: string) => { entries: Entry[]; demoted?: unknown },
): string {
  const root = mkdtempSync(join(tmpdir(), 'provisional-'));
  const patchText = readFileSync(join(REPO, BLADE_PATCH), 'utf8');
  mkdirSync(join(root, 'patches'), { recursive: true });
  writeFileSync(join(root, 'patches/blade.json'), patchText);
  const blade: Entry = {
    name: BLADE,
    oracleId: cardNamed(BLADE).oracleId,
    source: 'compiler@test',
    status: 'compiled-checked',
    handledLines: (JSON.parse(patchText) as { handledLines: string[] }).handledLines,
    patch: 'patches/blade.json',
    patchSha256: sha(patchText),
    review: null,
  };
  const { entries, demoted } = build(blade, patchText);
  mkdirSync(join(root, 'docs/reviews'), { recursive: true });
  writeFileSync(
    join(root, 'docs/reviews/compiled-card-queue.json'),
    JSON.stringify({ schemaVersion: 1, cards: entries }),
  );
  if (demoted !== undefined)
    writeFileSync(join(root, 'docs/reviews/provisional-demoted.json'), JSON.stringify(demoted));
  return root;
}

const cards = (): OracleCard[] => [cardNamed(BLADE)];

describe('loadProvisionalCatalog', () => {
  it('admits a checked entry whose patch bytes still match, marked provisional', () => {
    expect(interpretCard(cardNamed(BLADE)).modeled).toBe(false);
    const catalog = loadProvisionalCatalog(cards(), {
      root: fixtureRoot((b) => ({ entries: [b] })),
    });
    expect(catalog.admitted.map((a) => a.name)).toEqual([BLADE]);
    const def = catalog.definitions.get(cardNamed(BLADE).oracleId);
    expect(def?.modeled).toBe(true);
    expect(def?.trust).toBe('provisional');
    expect(def?.trustSource).toBe('compiler@test');
    expect(catalog.admitted[0]?.source).toBe(def?.trustSource);
    // The registry is left as it was: the card is still unmodeled for everyone else.
    expect(interpretCard(cardNamed(BLADE)).modeled).toBe(false);
  });

  it.each<[string, (b: Entry) => Partial<Entry>]>([
    ['status meaning-differs', () => ({ status: 'meaning-differs' })],
    ['status smoke-failed', () => ({ status: 'smoke-failed' })],
    ['rejected by', () => ({ review: { verdict: 'rejected', by: 'Paul' } })],
    ['cross-check', () => ({ crossCheck: { source: 'xmage@x', verdict: 'differs' } })],
    ['patch file changed', () => ({ patchSha256: '0'.repeat(64) })],
    ['patch file missing', () => ({ patch: 'patches/nope.json' })],
  ])('skips an entry: %s', (reason, change) => {
    const root = fixtureRoot((b) => ({ entries: [{ ...b, ...change(b) }] }));
    const catalog = loadProvisionalCatalog(cards(), { root });
    expect(catalog.definitions.size).toBe(0);
    expect(catalog.skipped[0]?.reason).toContain(reason);
  });

  it('honours the fuzz demotion list, pinned to the patch bytes', () => {
    const root = fixtureRoot((b) => ({
      entries: [b],
      demoted: {
        schemaVersion: 1,
        cards: [{ oracleId: b.oracleId, name: b.name, patchSha256: b.patchSha256, reason: 'x' }],
      },
    }));
    expect(loadProvisionalCatalog(cards(), { root }).skipped[0]?.reason).toBe('demoted by fuzz');

    const otherBytes = fixtureRoot((b) => ({
      entries: [b],
      demoted: {
        schemaVersion: 1,
        cards: [{ oracleId: b.oracleId, name: b.name, patchSha256: '1'.repeat(64), reason: 'x' }],
      },
    }));
    expect(loadProvisionalCatalog(cards(), { root: otherBytes }).definitions.size).toBe(1);
  });

  it('plays the first admissible patch when a card has two', () => {
    const root = fixtureRoot((b) => ({ entries: [b, { ...b, source: 'xmage@test' }] }));
    const catalog = loadProvisionalCatalog(cards(), { root });
    expect(catalog.admitted.map((a) => a.source)).toEqual(['compiler@test']);
    expect(catalog.skipped[0]?.reason).toMatch(/admitted first/);
  });

  it('skips a card missing from the loaded Oracle data', () => {
    const catalog = loadProvisionalCatalog([], { root: fixtureRoot((b) => ({ entries: [b] })) });
    expect(catalog.skipped[0]?.reason).toMatch(/not in the loaded Oracle data/);
  });

  it('is empty when there is no queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'provisional-empty-'));
    expect(loadProvisionalCatalog(cards(), { root }).definitions.size).toBe(0);
  });

  it('admits every compiled-checked card of the committed queue that loads today', () => {
    // A smoke check over the real queue: every admitted definition is provisional and modeled,
    // and nothing that failed a check is admitted.
    const catalog = loadProvisionalCatalog(
      PINNED.map((r) => r.card),
      { root: REPO },
    );
    expect(catalog.definitions.size).toBeGreaterThan(100);
    for (const def of catalog.definitions.values()) {
      expect(def.trust).toBe('provisional');
      expect(def.modeled).toBe(true);
    }
    const queue = JSON.parse(
      readFileSync(join(REPO, 'docs/reviews/compiled-card-queue.json'), 'utf8'),
    ) as { cards: Entry[] };
    const checked = new Set(
      queue.cards.filter((e) => e.status === 'compiled-checked').map((e) => e.oracleId),
    );
    for (const id of catalog.definitions.keys()) expect(checked.has(id)).toBe(true);
  });
});

describe('opting in', () => {
  const catalog = (): ProvisionalCatalog =>
    loadProvisionalCatalog(cards(), { root: fixtureRoot((b) => ({ entries: [b] })) });

  it('adds provisional cards to the pool only when a catalog is given, and marks them', () => {
    const blade = cardNamed(BLADE);
    expect(buildSupportedPool([blade]).cards).toHaveLength(0);
    expect(buildSupportedPool([blade]).provisional).toBeUndefined();
    const pool = buildSupportedPool([blade], catalog());
    expect(pool.cards.map((c) => [c.card.name, c.provisional])).toEqual([[BLADE, true]]);
  });

  it('pre-flights a deck as playable only with the catalog', () => {
    const blade = cardNamed(BLADE);
    expect(unmodeledCardNames([blade])).toEqual([BLADE]);
    expect(unmodeledCardNames([blade], catalog())).toEqual([]);
  });

  it('opts a game in only for the provisional cards its decks hold', () => {
    const blade = cardNamed(BLADE);
    const player = (cardsInDeck: OracleCard[]) => ({
      id: 'P1',
      deckId: 'd',
      commanders: [],
      cards: cardsInDeck,
    });
    expect(provisionalGameConfig(catalog(), [player([])])).toEqual({});
    expect(provisionalGameConfig(undefined, [player([blade])])).toEqual({});
    const config = provisionalGameConfig(catalog(), [player([blade])]);
    expect(config.allowProvisional).toBe(true);
    expect(config.provisionalDefinitions?.map((d) => d.name)).toEqual([BLADE]);
    expect(provisionalReplayPins(catalog(), [player([blade])])).toEqual([
      expect.objectContaining({ oracleId: blade.oracleId, source: 'compiler@test' }),
    ]);
  });
});

describe('benchmarks and fingerprints stay off the provisional tier', () => {
  /**
   * Engine fingerprints and benchmark baselines must not move with the review queue, so none of
   * their entry points may opt a game in. This is a source check: a new benchmark that wants
   * provisional cards has to change this list on purpose.
   */
  const OFF_LIMITS = [
    'packages/server/src/cli/engine-bench.ts',
    'packages/server/src/cli/coverage.ts',
    'packages/server/src/cli/modelled-cards.ts',
    'packages/server/src/cli/edhrec-ready-list.ts',
    'packages/server/src/cli/bot-league.ts',
    'packages/server/src/cli/bot-league-game.ts',
    'packages/server/src/cli/ai-bench.ts',
    'packages/server/src/cli/jev-duel.ts',
    'packages/server/src/cli/ai-mode-duel.ts',
    ...readdirSync(join(REPO, 'packages/server/src/benchmark'))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => `packages/server/src/benchmark/${file}`),
  ];

  it.each(OFF_LIMITS)('%s never mentions provisional cards', (path) => {
    expect(readFileSync(join(REPO, path), 'utf8')).not.toMatch(/provisional/i);
  });
});
