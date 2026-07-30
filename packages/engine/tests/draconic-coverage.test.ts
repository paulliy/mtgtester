/**
 * The per-deck closure instrument (ADR 0010), for the Draconic Destruction precon.
 *
 * `bun run coverage` is the human-facing report, but it loads the gitignored 180 MB Scryfall
 * bulk, so it cannot gate anything in CI. This test measures the same thing offline, against a
 * committed projection of the deck's 72 unique cards.
 *
 * It asserts the *names* of the modeled cards, not just the count. That is the load-bearing
 * part: a grammar change that accidentally models a card it should not — over-permissive
 * modeling, the brief §6.3 failure mode — shows up here as a diff rather than as a silently
 * improved number. Raising the count is only correct when the added names are ones you meant.
 *
 * Thirteen cards (Arcane Signet, Atarka World Render, Command Tower, Dragon Tempest, Dragon's
 * Hoard, Drakuseth Maw of Flames, Forest, Garruk's Uprising, Haven of the Spirit Dragon,
 * Hunter's Insight, Mountain, Path of Ancestry, Sol Ring) also appear in The Ur-Dragon deck and
 * carry the same real Scryfall ids as `urdragon-oracle.json`. The other 59 — including the 15
 * cards this session built authored overrides for — use the synthetic `oracle-<slug>` id
 * convention documented in `overrides/draconic-destruction.ts`, since this sandbox has no
 * Scryfall bulk-data access; a future data refresh should replace them with real oracle ids.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';

const FIXTURE = fileURLToPath(new URL('./fixtures/draconic-oracle.json', import.meta.url));

const cards: OracleCard[] = JSON.parse(readFileSync(FIXTURE, 'utf8')) as OracleCard[];

/** The cards the engine can currently play. Update deliberately, never to make a test pass. */
const MODELED = [
  'Arcane Signet',
  'Atarka Monument',
  'Atarka, World Render',
  'Cinder Glade',
  'Clan Defiance',
  'Command Tower',
  "Commander's Sphere",
  'Crucible of Fire',
  'Cultivate',
  'Draconic Disciple',
  'Dragon Mage',
  'Dragon Tempest',
  "Dragon's Hoard",
  'Dragonkin Berserker',
  'Drakuseth, Maw of Flames',
  'Dream Pillager',
  'Drumhunter',
  'Elemental Bond',
  'Fires of Yavimaya',
  'Flameblast Dragon',
  'Foe-Razer Regent',
  'Forest',
  "Garruk's Uprising",
  'Harmonize',
  'Haven of the Spirit Dragon',
  'Hoard-Smelter Dragon',
  "Hunter's Insight",
  'Kazandu Refuge',
  'Loaming Shaman',
  'Mountain',
  'Path of Ancestry',
  'Primal Might',
  'Rapacious Dragon',
  'Rugged Highlands',
  'Runehorn Hellkite',
  'Sakura-Tribe Elder',
  'Sarkhan, the Dragonspeaker',
  'Shivan Oasis',
  'Sol Ring',
  'Spit Flame',
  'Steel Hellkite',
  'Swiftfoot Boots',
  'Talisman of Impulse',
  'Temple of Abandon',
  'Thunderbreak Regent',
  'Timber Gorge',
].sort();

describe('Draconic Destruction deck — model coverage', () => {
  it('has the expected 72 unique cards', () => {
    expect(cards).toHaveLength(72);
  });

  it('models exactly the cards we have built for', () => {
    const modeled = cards
      .filter((card) => interpretCard(card).modeled)
      .map((card) => card.name)
      .sort();

    expect(modeled).toEqual(MODELED);
  });

  it('leaves every other card unmodeled with at least one reason', () => {
    const unmodeled = cards.map(interpretCard).filter((def) => !def.modeled);

    expect(unmodeled).toHaveLength(72 - MODELED.length);
    for (const def of unmodeled) {
      expect(def.unmodeledReasons.length).toBeGreaterThan(0);
    }
  });
});
