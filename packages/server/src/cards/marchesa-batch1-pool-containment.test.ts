import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { buildSupportedPool } from './pool';

interface PinnedFixture {
  cards: { card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../../engine/tests/fixtures/marchesa-batch1-oracle.json'),
    'utf8',
  ),
) as PinnedFixture;

describe('Marchesa catalog audit supported-pool containment', () => {
  // Fail-closed restorations plus the coverage PR01 and PR02 cards (docs/plans/card-coverage-chunks.md).
  it('includes exactly the independently restored slices', () => {
    const pool = buildSupportedPool(fixture.cards.map(({ card }) => card));
    expect(pool.considered).toBe(198);
    expect(pool.cards.map(({ card }) => card.name)).toEqual([
      'Aether Channeler',
      'Aether Hub',
      'Aetheric Amplifier',
      'Anrakyr the Traveller',
      'Arcane Denial',
      'Attune with Aether',
      'Beacon of Unrest',
      'Bespoke Battlewagon',
      'Blasphemous Edict',
      'Body Launderer',
      'Canoptek Spyder',
      'Canoptek Tomb Sentinel',
      'Canoptek Wraith',
      'Carrion Feeder',
      'Changing Loyalty',
      'Conclave Tribunal',
      "Conjurer's Closet",
      'Convergence of Dominion',
      'Cranial Plating',
      'Cryptek',
      'Dragonkin Berserker',
      'Dread Return',
      'Dream Devourer',
      'Endless Atlas',
      'Fabled Passage',
      'Flare of Denial',
      'Flare of Malice',
      'Flayer of the Hatebound',
      'Foe-Razer Regent',
      'Forum of Amity',
      'Frontier Siege',
      'Ghost Ark',
      'Gleeful Arsonist',
      'Glen Elendra Archmage',
      'Grim Haruspex',
      'Harvest Season',
      'Hour of Reckoning',
      'Hunting Wilds',
      'Idol of Oblivion',
      'Illuminor Szeras',
      'Imotekh the Stormlord',
      'Iron Apprentice',
      'Kairi, the Swirling Sky',
      'Kambal, Consul of Allocation',
      'Killian, Ink Duelist',
      'Land Tax',
      'Living Death',
      'Loran of the Third Path',
      'Mask of Memory',
      'Mistveil Plains',
      'Mordant Dragon',
      'Myriad Landscape',
      'Necron Deathmark',
      'Nullmage Shepherd',
      'Peema Trailblazer',
      'Pensive Professor',
      'Plasmancer',
      'Psychomancer',
      'Puppeteer Clique',
      "Raffine's Guidance",
      'Resurrection Orb',
      'Retrofitter Foundry',
      'Return to Nature',
      'Rishkar, Peema Renegade',
      'River Kelpie',
      'Sage of Fables',
      'Satoru, the Infiltrator',
      'Sautekh Immortal',
      'Scavenging Ooze',
      'Sceptre of Eternal Glory',
      'Shard of the Nightbringer',
      'Shard of the Void Dragon',
      'Smothering Tithe',
      'Solar Transformer',
      'Soul-Guide Lantern',
      'Sylvan Reclamation',
      'Technomancer',
      'The Ooze',
      'Their Number Is Legion',
      'Thunderfoot Baloth',
      'Tomb Fortress',
      'Toxic Deluge',
      'Triarch Praetorian',
      'Vastwood Surge',
      'Vigean Graftmage',
      'Voice of Many',
      'War Room',
      'Watcher for Tomorrow',
      'Weathered Wayfarer',
      'Will of the Mardu',
    ]);
  });
});
