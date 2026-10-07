/**
 * The per-deck closure instrument (ADR 0010).
 *
 * `bun run coverage` is the human-facing report, but it loads the gitignored 180 MB Scryfall
 * bulk, so it cannot gate anything in CI. This test measures the same thing offline, against a
 * committed projection of The Ur-Dragon deck's 93 unique cards.
 *
 * It asserts the *names* of the modeled cards, not just the count. That is the load-bearing
 * part: a grammar change that accidentally models a card it should not â€” over-permissive
 * modeling, the brief Â§6.3 failure mode â€” shows up here as a diff rather than as a silently
 * improved number. Raising the count is only correct when the added names are ones you meant.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';

const FIXTURE = fileURLToPath(new URL('./fixtures/urdragon-oracle.json', import.meta.url));

const cards: OracleCard[] = JSON.parse(readFileSync(FIXTURE, 'utf8')) as OracleCard[];

/** The cards the engine can currently play. Update deliberately, never to make a test pass. */
const MODELED = [
  'Forest',
  'Island',
  'Mountain',
  'Sol Ring',
  'Swamp',
  // Inc 1 â€” as-enters replacement conditions (`entersTappedUnless`).
  'Blood Crypt',
  'Dreamroot Cascade',
  'Overgrown Tomb',
  'Razorverge Thicket',
  'Rejuvenating Springs',
  'Rootbound Crag',
  'Scorched Geyser',
  'Spectator Seating',
  'Steam Vents',
  'Stormcarved Coast',
  'Sundown Pass',
  'Temple Garden',
  'Turbulent Springs',
  'Watery Grave',
  'Woodland Cemetery',
  // Inc 2 â€” state-derived, granted, conditional, and rider mana abilities.
  'Arcane Signet',
  'Battlefield Forge',
  'Chromatic Lantern',
  'Command Tower',
  'Exotic Orchard',
  'Fellwar Stone',
  'Mox Jasper',
  'Yavimaya Coast',
  // Inc 4 â€” structured trigger specs: selector subjects, `attacks`, intervening-if.
  'Atarka, World Render',
  "Garruk's Uprising",
  'Temur Ascendancy',
  // Inc 5 â€” activated abilities with non-mana costs.
  "Dragon's Hoard",
  'Reckless Barbarian',
  // Inc 6 â€” library primitives, mass damage, and event-only keyword selectors.
  'Farseek',
  "Kodama's Reach",
  "Nature's Lore",
  'Ryusei, the Falling Star',
  'Temple of Mystery',
  'Three Visits',
  'Thunder Dragon',
  'Ureni of the Unwritten',
  // Inc 7 â€” ward/menace/shroud/protection/changeling and equipment.
  'Lightning Greaves',
  // Inc 8 â€” dynamic `Value`s and {X} costs.
  'Earthquake',
  // Inc 10 â€” token creation, pay-life costs, once-per-turn activation.
  // (Inc 9 â€” the new trigger events â€” deliberately closed no cards; it is a gate for these.)
  'Beledros Witherbloom',
  'Miirym, Sentinel Wyrm',
  'Old Gnawbone',
  // Inc 11 â€” zone-movement primitives and non-battlefield targets.
  'Bladewing the Risen',
  'Broodcaller Scourge',
  'Last March of the Ents',
  // Inc 12a â€” restricted mana (CR 106.6), mana spend triggers, alternatives on one permanent.
  'Haven of the Spirit Dragon',
  'Maelstrom of the Spirit Dragon',
  'Path of Ancestry',
  'Scaled Nurturer',
  // Inc 12b â€” conditional-amount + linked mana; `addMana` from a resolving (non-activation)
  // ability. Skycloud Expanse and Carnelian Orb of Dragonkind stay unmodeled â€” see the
  // increment note in the plan for why. Orb of Dragonkind joined once a mana ability could
  // charge its own `{1}` (`mana-cost-in-mana-ability.test.ts`).
  'Ilysian Caryatid',
  'Klauth, Unrivaled Ancient',
  'Orb of Dragonkind',
  // Inc 13 â€” rule-modifying statics: cost reduction (fixed and dynamic, including from the
  // command zone), "can't be countered" as a state-dependent rule (not just a fixed spell
  // property), "opponents can't cast spells", casting from the top of the library.
  'Dragonlord Dromoka',
  'Korlessa, Scale Singer',
  'Rhythm of the Wild',
  'Temur Battlecrier',
  'The Ur-Dragon',
  // Inc 14 â€” modal spells, a fixed-plus-variable-count damage split, divided damage among a
  // variable-count target group, and a resolution-time conditional effect. Kairi was deferred
  // until coverage PR01 added the count slot's total-mana-value budget.
  'Crux of Fate',
  'Drakuseth, Maw of Flames',
  'Stubborn Denial',
  'Ureni, the Song Unending',
  'Kairi, the Swirling Sky',
  // Inc 15 â€” damage-doubling replacement (CR 616), gain-control-of-a-set + a control-change
  // timestamp, and turn-scoped excess-damage tracking feeding an intervening-if.
  'Karrthus, Tyrant of Jund',
  'Neriv, Heart of the Storm',
  'Rith, Liberated Primeval',
  // Inc 16 â€” delayed triggers, granted abilities/triggers until end of turn, and spell-resolution delayed haste grants.
  'Carnelian Orb of Dragonkind',
  'Hellkite Courser',
  'Herd Heirloom',
  "Hunter's Insight",
  // Inc 17 â€” Alternate costs (Overload), hybrid mana, planeswalker loyalty, hideaway.
  'Cyclonic Rift',
  'Kiora, Behemoth Beckoner',
  'Mosswort Bridge',
  'Spinerock Knoll',
  // The three formerly claimed Adventure/Omen cards are explicitly contained: their
  // spell faces were substituted or omitted. Pinned negative evidence lives in
  // unsupported-spell-faces.test.ts; support may return only with faithful face behavior.
  // Inc 19 â€” remaining bespoke Dragon cards (100% coverage milestone).
  'Iymrith, Desert Doom',
  "Lozhan, Dragons' Legacy",
  'Morophon, the Boundless',
  'Rivaz of the Claw',
  'Sarkhan, Dragon Ascendant',
  'Sarkhan, Soul Aflame',
  'Skycloud Expanse',
  'Thrakkus the Butcher',
  'Vaevictis Asmadi, the Dire',
].sort();

describe('The Ur-Dragon deck â€” model coverage', () => {
  it('has the expected 93 unique cards', () => {
    expect(cards).toHaveLength(93);
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

    expect(unmodeled).toHaveLength(93 - MODELED.length);
    for (const def of unmodeled) {
      expect(def.unmodeledReasons.length).toBeGreaterThan(0);
    }
  });
});
