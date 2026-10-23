import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId, getOverride } from '../src/cards/overrides';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as PinnedFixture;

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

const REASONS: Record<string, string> = {
  'Bolt Bend': 'Change-the-target is implemented as copyTargetSpell; a copy is not a retarget.',
  'Chaos Warp':
    'The top card is not revealed; a nonpermanent remains hidden on top of the library.',
  'Deflecting Swat':
    'Choose-new-targets is implemented as copyTargetSpell; a copy is not a retarget.',
  'Flare of Duplication':
    'Sacrifice alternative cost is missing, and copyTargetSpell copies original targets instead of choosing new ones.',
  'Mana Sculpt':
    'Wizard intervening-if is omitted, and delayed manaSpent is not captured from the countered spell.',
  'Siren Stormtamer':
    'Counter target is any stack object, not only spells or abilities that target you or your creature.',
  Smokestack: 'Upkeep sacrifice hits every player for 1 and enters with a soot counter.',
  'Twilight Diviner':
    'Graveyard-origin and once-each-turn restrictions are omitted from the enter trigger.',
  "Angel's Grace":
    'Split second and cannot-lose/cannot-win are implemented as a damage life floor only.',
  'Display of Power':
    'Cannot-be-copied is omitted, and copies keep original targets instead of choosing new ones.',
  'Gut, True Soul Zealot':
    'Choose a Background is claimed without a background companion implementation.',
  'Nighthawk Scavenger':
    "Power counts card types in all graveyards, not only opponents' graveyards.",
  Reverberate: 'Choose-new-targets is implemented as copyTargetSpell; a copy is not a retarget.',
  "Tibalt's Trickery": 'Mill, exile, and free-cast cascade are claimed as a counter-only spell.',
  'Arcane Lighthouse': 'Hexproof/shroud removal is implemented as granting menace.',
  'Armored Skyhunter': 'Equipment filter is any artifact, and attach is omitted.',
  "Defacing Duskmage // Vandal's Edit":
    'Prepare is implemented as a pump trigger on any draw step.',
  'Eiganjo Dynastorian // Replenish':
    'Prepare is implemented as a pump trigger when this creature attacks.',
  'Etali, Primal Conqueror // Etali, Primal Sickness':
    'Exile splices library cards without a zone-change, so leave-library events are skipped.',
  'Herald of Amity':
    'Exile-and-cast-Aura is implemented as lookAtTopN putting an Aura onto the battlefield.',
  'Intermediate Chirography':
    'Class levels and later abilities are claimed without an implementation.',
  'Keen Duelist': 'Mutual reveal is implemented as drawRevealTopLoseManaValue on you only.',
  'Malakir Rebirth // Malakir Mire': 'Spell face is claimed; only the land back is authored.',
  'Valakut Awakening // Valakut Stoneforge':
    'Spell face is claimed; only the land back is authored.',
  'Wear // Tear':
    'Fuse is authored as a third mode with an extra {2}{W} rather than casting both halves.',
  'Wandering Archaic // Explore the Vastlands':
    'Modal DFC copy-on-cast with retarget is unimplemented.',
  'Verrak, Warped Sengir': 'Copy-activated-ability when life was paid is unimplemented.',
  "Songbirds' Blessing":
    'Reveal-until-Aura with optional battlefield and hand fallback is unimplemented.',
  'Spirit Mantle': 'Protection from creatures is unimplemented.',
  'Caged Sun': 'Land-mana of the chosen color is claimed without an additional-mana trigger.',
  'Mystic Forge':
    'Top-of-library cast omits colorless spells, and exile-top is implemented as mill.',
  Biotransference: 'Type change omits creature spells and off-battlefield cards.',
  'The War in Heaven': 'Saga chapters are implemented as enter, upkeep, and end-step triggers.',
  'Out of the Tombs':
    'Enters-with two eon counters is authored; the card only places counters on upkeep.',
  'Szarekh, the Silent King':
    'Milled-this-way artifact-creature-or-Vehicle is implemented as any artifact creature in the graveyard.',
  'Trazyn the Infinite': 'Activated mana abilities of artifacts in the graveyard are omitted.',
  'Saheeli, Radiant Creator':
    'The copy is a reflexive trigger after payment; the target is chosen before you decide to pay.',
  'Saheeli, Sublime Artificer': 'A +1 loyalty ability is authored that is not on the card.',
  'Aetherworks Marvel':
    'Look-at-top-six free-cast does not put the rest on the bottom in a random order, and skips that reordering when no spell is castable.',
  Duplicant: 'Optional exile is a required target.',
  'Adaptive Omnitool': 'Artifact-from-library is put into hand without revealing.',
  'Dream Pillager':
    'Exiled cards are playable, including lands; Oracle only permits casting spells.',
  'Atarka Monument': 'The animation does not make it red and green.',
  'Sarkhan, the Dragonspeaker': 'The +1 does not make it legendary or red.',
  'Reality Shift':
    'Manifest puts the card face-down but never offers turning it face up for its mana cost.',
};

describe('Marchesa catalog audit containment', () => {
  const restoredCards = new Set([
    // PR09 full pinned cast/trigger/activation regressions replace these historical guards.
    'Chaos Warp',
    'Adaptive Omnitool',
    'Armored Skyhunter',
    'Dream Pillager',
    'Etali, Primal Conqueror // Etali, Primal Sickness',
    'Keen Duelist',
    "Songbirds' Blessing",
    'Szarekh, the Silent King',
    "Tibalt's Trickery",
    'Aetherworks Marvel',
    'Herald of Amity',
    'Mystic Forge',
    // PR10 stack retarget and copy regressions replace these historical guards.
    'Deflecting Swat',
    'Bolt Bend',
    'Reverberate',
    'Flare of Duplication',
    'Display of Power',
    // PR10 ability-stack regressions (counter, copy and life-paid copies) replace these guards.
    'Siren Stormtamer',
    'Mana Sculpt',
    'Verrak, Warped Sengir',
    // PR10 animation regressions (type and color changes, copies until end of turn).
    'Atarka Monument',
    'Sarkhan, the Dragonspeaker',
    'Saheeli, Sublime Artificer',
    // PR10 token-copy regressions (copies of permanents and spells' sources).
    'Saheeli, Radiant Creator',
    'Twilight Diviner',
    // PR10 characteristics regressions.
    'Biotransference',
    'Duplicant',
    'Nighthawk Scavenger',
    'Reality Shift',
    'Trazyn the Infinite',
    // PR11 pinned activation regressions replace this guard.
    // PR11 pinned regressions replace these guards.
    'Arcane Lighthouse',
    'Spirit Mantle',
    "Angel's Grace",
    'Smokestack',
    'Out of the Tombs',
    'Caged Sun',
    'Gut, True Soul Zealot',

    'Vindictive Lich',
    'Shadrix Silverquill',
    "Olórin's Searing Light",
    // PR08 normal-cast, cleanup and frozen-set tests replace the containment requirement.
    'Mob Rule',
    'Cytoplast Manipulator',
    'Humble Defector',
    'Druid of Purification',
    'Wishclaw Talisman',
    // Dedicated white-black tests are the gate; implemented-unreviewed is not a review claim.
    'Arcane Denial',
    'Fabled Passage',
    'Myriad Landscape',
    'Smothering Tithe',
    'War Room',
    // Coverage PR01 (docs/plans/card-coverage-chunks.md).
    'Return to Nature',
    'Aether Channeler',
    'Will of the Mardu',
    'Kairi, the Swirling Sky',
    'Frontier Siege',
    'Vastwood Surge',
    'Rishkar, Peema Renegade',
    'Loran of the Third Path',
    'Hunting Wilds',
    'Foe-Razer Regent',
    'Voice of Many',
    'Tomb Fortress',
    'Thunderfoot Baloth',
    'Sylvan Reclamation',
    'Plasmancer',
    'Necron Deathmark',
    'Mordant Dragon',
    'Land Tax',
    'Harvest Season',
    "Conjurer's Closet",
    'Canoptek Wraith',
    'Canoptek Spyder',
    'Beacon of Unrest',
    'Attune with Aether',
    'Forum of Amity',
    // Coverage PR02 (docs/plans/card-coverage-chunks.md).
    'Retrofitter Foundry',
    'Aether Hub',
    'Solar Transformer',
    'Bespoke Battlewagon',
    'Endless Atlas',
    'Sceptre of Eternal Glory',
    'Weathered Wayfarer',
    'Idol of Oblivion',
    'Mistveil Plains',
    'Carrion Feeder',
    'Nullmage Shepherd',
    'Sage of Fables',
    'Illuminor Szeras',
    'Peema Trailblazer',
    'Soul-Guide Lantern',
    'Ghost Ark',
    'Flare of Denial',
    'Flare of Malice',
    'Blasphemous Edict',
    'Dread Return',
    "Raffine's Guidance",
    'Their Number Is Legion',
    'Anrakyr the Traveller',
    'Toxic Deluge',
    'Conclave Tribunal',
    'Hour of Reckoning',
    'Killian, Ink Duelist',
    'Dragonkin Berserker',
    'Convergence of Dominion',
    'Changing Loyalty',
    'Grim Haruspex',
    'Dream Devourer',
    'Triarch Praetorian',
    'Canoptek Tomb Sentinel',
    'Glen Elendra Archmage',
    'Flayer of the Hatebound',
    'Kambal, Consul of Allocation',
    'Gleeful Arsonist',
    'Shard of the Nightbringer',
    'Satoru, the Infiltrator',
    'River Kelpie',
    'Watcher for Tomorrow',
    'Psychomancer',
    'Shard of the Void Dragon',
    'Scavenging Ooze',
    'Imotekh the Stormlord',
    'The Ooze',
    'Puppeteer Clique',
    'Cryptek',
    'Living Death',
    'Technomancer',
    'Body Launderer',
    'Sautekh Immortal',
    'Iron Apprentice',
    'Vigean Graftmage',
    'Pensive Professor',
    'Aetheric Amplifier',
    'Cranial Plating',
    'Mask of Memory',
    'Resurrection Orb',
    'Sunforger',
    'Screams from Within',
    'Ghoulish Impetus',
    'Gift of Immortality',
    "Ajani's Chosen",
    'Shielded by Faith',
    'Forum Filibuster',
    "Karametra's Favor",
    'Redemption Arc',
    'Fallen Ideal',
    'Kor Spiritdancer',
    'Hateful Eidolon',
    'Martial Impetus',
    'Killian, Decisive Mentor',
    'Angelic Destiny',
    'Sheltered by Ghosts',
    'Eldrazi Conscription',
    'Curse of Bounty',
    'Eidolon of Countless Battles',
    'Breena, the Demagogue',
    "Duelist's Heritage",
    'Dark Confidant',
    'Animate Dead',
    'Dragon Tempest',
    'Scourge of Valkas',
    "Tyrant's Familiar",
    'Brash Taunter',
    'Tomb Blade',
    'Thunderbreak Regent',
    'Flameblast Dragon',
    'Territorial Aetherkite',
    'Arcbond',
    'Thundermaw Hellkite',
    'Backlash',
    'Selfless Squire',
    'Deflecting Palm',
    'Comeuppance',
    'Michiko Konda, Truth Seeker',
    'Delirium',
    'Firemane Commando',
    'Mangara, the Diplomat',
    'Tomik, Wielder of Law',
    'Promise of Loyalty',
    'Lightning Runner',
    'Firkraag, Cunning Instigator',
    'Eriette of the Charmed Apple',
    'Nils, Discipline Enforcer',
    'Combat Calligrapher',
    'Kardur, Doomscourge',
    'Hexmark Destroyer',
    'Champion of Lambholt',
    'Teyo, Geometric Tactician',
    'Triarch Stalker',
    // Coverage PR08.01 (docs/plans/card-coverage-chunks.md).
    'Cut a Deal',
    // Coverage PR08.04 (docs/plans/card-coverage-chunks.md).
    'Scheming Symmetry',
  ]);

  // catalog-audit-contained — required id for contained-catalog manifest traces.

  it('pins complete Oracle records for the reviewed cards', () => {
    expect(fixture.cards.map(({ card }) => card.name).sort()).toEqual(
      [...new Set([...Object.keys(REASONS), ...restoredCards])].sort(),
    );
    for (const { sha256, card } of fixture.cards) {
      expect(createHash('sha256').update(canonical(card)).digest('hex'), card.name).toBe(sha256);
    }
  });

  it('marks both real IDs and fixture aliases explicitly unsupported', () => {
    for (const { card } of fixture.cards.filter(({ card }) => !restoredCards.has(card.name))) {
      const reason = REASONS[card.name]!;
      const real = interpretCard(card);
      const alias = interpretCard({ ...card, oracleId: fixtureOracleId(card.name) });
      expect(real.modeled, card.name).toBe(false);
      expect(alias.modeled, `${card.name} alias`).toBe(false);
      expect(real.unmodeledReasons.join('\n'), card.name).toContain(
        `explicitly unsupported: ${reason}`,
      );
      expect(getOverride(card.oracleId)?.unsupportedReason, card.name).toBe(reason);
      expect(getOverride(fixtureOracleId(card.name))?.unsupportedReason, card.name).toBe(reason);
    }
  });

  it('does not leave an executable substitute for the contained cards', () => {
    for (const { card } of fixture.cards.filter(({ card }) => !restoredCards.has(card.name))) {
      const override = getOverride(card.oracleId)!;
      expect(override.unsupportedReason, card.name).toBeDefined();
      expect(JSON.stringify(override.def), card.name).toBe('{}');
    }
  });
});
