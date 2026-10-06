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
  'Toxic Deluge': 'Pay-X-life additional cost is implemented as loseLife on resolution.',
  'Aether Channeler': 'Return-another-target bounce is implemented as untargeted returnOneToHand.',
  'Blasphemous Edict':
    'The thirteen-creature {B} alternative cost is claimed without an alternativeCast.',
  'Body Launderer':
    'Connive is approximated as unconditional +1/+1, and the return trigger omits equal-or-lesser power.',
  'Bolt Bend': 'Change-the-target is implemented as copyTargetSpell; a copy is not a retarget.',
  'Carrion Feeder':
    'Sacrifice-a-creature cost uses sacrificeOther, which cannot sacrifice this creature.',
  'Chaos Warp':
    'The top card is not revealed; a nonpermanent remains hidden on top of the library.',
  'Cytoplast Manipulator':
    'Gain-control duration is omitted; gainControlTarget is a permanent steal.',
  'Deflecting Swat':
    'Choose-new-targets is implemented as copyTargetSpell; a copy is not a retarget.',
  'Flare of Denial':
    'Sacrifice-a-nontoken-blue-creature alternative cost is claimed without an alternativeCast.',
  'Flare of Duplication':
    'Sacrifice alternative cost is missing, and copyTargetSpell copies original targets instead of choosing new ones.',
  'Flare of Malice':
    'Sacrifice-a-nontoken-black-creature alternative cost is claimed without an alternativeCast.',
  'Flayer of the Hatebound':
    'Enters-from-graveyard is implemented as any creature you control entering.',
  'Firkraag, Cunning Instigator':
    'The intervening-if checks whether Firkraag had to attack, not the creature that dealt damage.',
  'Gleeful Arsonist': 'Undying is claimed without a persist/undying replacement.',
  'Glen Elendra Archmage': 'Persist is claimed without a persist/undying replacement.',
  'Grim Haruspex': 'Morph cost is stored but never offered as a face-down alternative cast.',
  'Kardur, Doomscourge':
    'Goad snapshots current creatures, and the death trigger fires for blockers as well as attackers.',
  'Mana Sculpt':
    'Wizard intervening-if is omitted, and delayed manaSpent is not captured from the countered spell.',
  'Pensive Professor':
    'Increment is claimed, and the draw trigger fires on damage instead of counters being placed.',
  'Puppeteer Clique': 'Stolen creature is not exiled at the beginning of the next end step.',
  'River Kelpie': 'Graveyard-origin enters and cast triggers fire on any enter or cast.',
  'Sage of Fables': 'Remove-a-counter cost is paid from this creature, not a creature you control.',
  'Satoru, the Infiltrator': 'Enter trigger omits the not-cast-or-no-mana-spent restriction.',
  'Siren Stormtamer':
    'Counter target is any stack object, not only spells or abilities that target you or your creature.',
  Smokestack: 'Upkeep sacrifice hits every player for 1 and enters with a soot counter.',
  'The Ooze': 'Leaves-the-battlefield is implemented as dies.',
  'Twilight Diviner':
    'Graveyard-origin and once-each-turn restrictions are omitted from the enter trigger.',
  'Vigean Graftmage': 'Graft is claimed without enters-with-counters or move-counter behavior.',
  'Vindictive Lich': 'Modes are choose-one rather than one-or-more targeting different players.',
  'Watcher for Tomorrow': 'Leaves-the-battlefield is implemented as dies.',
  "Angel's Grace":
    'Split second and cannot-lose/cannot-win are implemented as a damage life floor only.',
  'Display of Power':
    'Cannot-be-copied is omitted, and copies keep original targets instead of choosing new ones.',
  'Gut, True Soul Zealot':
    'Choose a Background is claimed without a background companion implementation.',
  'Nighthawk Scavenger':
    "Power counts card types in all graveyards, not only opponents' graveyards.",
  'Nils, Discipline Enforcer':
    'End-step trigger counters every creature, and the attack-tax static is omitted.',
  "Olórin's Searing Light":
    'Graveyard-threshold opponent damage is claimed without an implementation.',
  Reverberate: 'Choose-new-targets is implemented as copyTargetSpell; a copy is not a retarget.',
  "Tibalt's Trickery": 'Mill, exile, and free-cast cascade are claimed as a counter-only spell.',
  'Animate Dead': 'Graveyard Aura attach and leave-the-battlefield sacrifice are omitted.',
  'Arcane Lighthouse': 'Hexproof/shroud removal is implemented as granting menace.',
  'Changing Loyalty': 'Replicate is claimed without a replicate implementation.',
  'Eldrazi Conscription': 'Annihilator 2 is claimed without an annihilator implementation.',
  'Fallen Ideal':
    'Granted sacrifice ability is authored on the Aura, and sacrificeOther cannot sacrifice the enchanted creature.',
  'Firemane Commando':
    'Both attack triggers make you draw, ignoring the other-player and not-attacked-you clauses.',
  'Hateful Eidolon': 'Draws one card instead of one per Aura that was attached.',
  "Ajani's Chosen": 'Aura-enters attach-to-token is omitted from the Cat trigger.',
  'Angelic Destiny': 'Angel type-changing is claimed without a type-changing static.',
  'Armored Skyhunter': 'Equipment filter is any artifact, and attach is omitted.',
  "Defacing Duskmage // Vandal's Edit":
    'Prepare is implemented as a pump trigger on any draw step.',
  'Eidolon of Countless Battles':
    'Bestow is claimed, and the Aura-count buff is overwritten by a creature-count self pump.',
  'Eiganjo Dynastorian // Replenish':
    'Prepare is implemented as a pump trigger when this creature attacks.',
  'Etali, Primal Conqueror // Etali, Primal Sickness':
    'Exile splices library cards without a zone-change, so leave-library events are skipped.',
  'Eriette of the Charmed Apple': 'Cannot-attack-you static is claimed without an implementation.',
  'Forum Filibuster': 'Reflexive Aura/Equipment return attached to the token is omitted.',
  'Gift of Immortality': 'Delayed Aura return attached to the creature is omitted.',
  'Ghoulish Impetus':
    'Delayed Aura return does not attach, so SBA immediately puts it into the graveyard.',
  'Herald of Amity':
    'Exile-and-cast-Aura is implemented as lookAtTopN putting an Aura onto the battlefield.',
  'Intermediate Chirography':
    'Class levels and later abilities are claimed without an implementation.',
  'Keen Duelist': 'Mutual reveal is implemented as drawRevealTopLoseManaValue on you only.',
  'Killian, Ink Duelist':
    'Spells-that-target-a-creature reduction is implemented as creature-spell reduction.',
  'Kor Spiritdancer': 'Attached-Aura pump counts all Auras you control.',
  'Martial Impetus':
    'Other-attacking-your-opponents pump is implemented as all creatures in combat.',
  "Raffine's Guidance": 'Graveyard recast is implemented as a return-to-hand activated ability.',
  'Redemption Arc':
    'Exile-enchanted-creature activated ability is claimed without an implementation.',
  'Sheltered by Ghosts': 'Ward {2} is claimed without a ward static.',
  'Shielded by Faith': 'Optional attach is implemented as mandatory attach.',
  'Tomik, Wielder of Law':
    'Affinity and opponent-attacks trigger are implemented as a self-attack drain.',
  'Combat Calligrapher':
    'Inklings-cannot-attack-you is omitted, and the token trigger is unscoped.',
  Comeuppance:
    'All-damage prevention and reflection are implemented as preventCombatDamageToController.',
  'Dream Devourer': 'Foretell grant is omitted, and the pump fires on any spell you cast.',
  'Malakir Rebirth // Malakir Mire': 'Spell face is claimed; only the land back is authored.',
  'Mangara, the Diplomat':
    'Two-or-more attacking you is implemented as any combat attack, and a second-spell trigger is added.',
  'Michiko Konda, Truth Seeker':
    'Damage-to-you is implemented as damage to permanents you control.',
  'Mistveil Plains': 'Bottom-of-library is implemented as graveyardToLibraryTop.',
  'Valakut Awakening // Valakut Stoneforge':
    'Spell face is claimed; only the land back is authored.',
  'Wear // Tear':
    'Fuse is authored as a third mode with an extra {2}{W} rather than casting both halves.',
  Delirium: "Cast-only-during-an-opponent's-turn is omitted.",
  "Duelist's Heritage":
    'Once-per-attack-group optional double strike is implemented as a per-attacker grant on any creature.',
  'Humble Defector': 'Activate-only-during-your-turn is implemented as timing any.',
  'Selfless Squire':
    'All-damage prevention and the prevented-damage counters are implemented as preventCombatDamageToController on enter.',
  'Teyo, Geometric Tactician':
    'The −2 directional attack restriction is claimed without an implementation.',
  'Weathered Wayfarer':
    'Opponent-controls-more-lands restriction is omitted from the search activation.',
  'Wishclaw Talisman': 'Opponent-gains-control is omitted from the search activation.',
  Arcbond: 'The delayed damage is dealt by Arcbond, not by the chosen creature.',
  Backlash: 'Untapped-creature targeting is implemented as any creature.',
  'Brash Taunter': 'Another-target fight can target this creature.',
  'Breena, the Demagogue':
    'Defender-has-more-life-than-another-of-your-opponents is implemented as defender-has-more-life-than-the-attacker.',
  'Deflecting Palm':
    'Source choice and reflection are implemented as unscoped combat-damage prevention.',
  'Loran of the Third Path': 'Up-to-one destroy is a required target.',
  'Scheming Symmetry':
    'Shuffle-then-put-on-top is implemented as moving the chosen card to the top without shuffling.',
  'Kambal, Consul of Allocation':
    'Opponent-casts is implemented as caster each, so your own noncreature spells also trigger.',
  'Shadrix Silverquill': 'Optional choose-two is mandatory, and the same mode can be chosen twice.',
  'Wandering Archaic // Explore the Vastlands':
    'Modal DFC copy-on-cast with retarget is unimplemented.',
  'Verrak, Warped Sengir': 'Copy-activated-ability when life was paid is unimplemented.',
  'Killian, Decisive Mentor':
    'Attack-trigger scoped to creatures enchanted by your Auras is unimplemented.',
  'Promise of Loyalty':
    'Keep-one sacrifice, vow counters, and attack restriction are unimplemented.',
  "Songbirds' Blessing":
    'Reveal-until-Aura with optional battlefield and hand fallback is unimplemented.',
  'Spirit Mantle': 'Protection from creatures is unimplemented.',
  'Mob Rule': 'Until-end-of-turn steal is implemented as permanent gainControl.',
  'Caged Sun': 'Land-mana of the chosen color is claimed without an additional-mana trigger.',
  'Canoptek Tomb Sentinel':
    'Enters-from-graveyard is implemented as any enter, and up-to-one is a required target.',
  Psychomancer:
    'Exile-from-battlefield is omitted, and loseLife hits the controller instead of the targeted opponent.',
  'Anrakyr the Traveller':
    'Artifact-from-hand-or-graveyard life cast is implemented as free casts from hand.',
  'Convergence of Dominion':
    'Graveyard activation cost reduction is claimed without a static effect.',
  'Endless Atlas': 'The three-or-more-same-name land restriction is omitted from the draw ability.',
  'Ghost Ark': 'Becomes-crewed is implemented as becomesTapped.',
  'Hexmark Destroyer': 'Cannot-be-blocked-except-by-six-or-more is implemented as cantBeBlocked.',
  'Imotekh the Stormlord':
    'The artifact-cards-leave-graveyard trigger is claimed without an implementation.',
  'Mystic Forge':
    'Top-of-library cast omits colorless spells, and exile-top is implemented as mill.',
  'Triarch Praetorian': 'Enters-from-graveyard is implemented as any enter.',
  'Triarch Stalker':
    'Menace for attackers of the chosen opponent is implemented as all creatures in combat.',
  Biotransference: 'Type change omits creature spells and off-battlefield cards.',
  'Dread Return': 'Flashback—Sacrifice three creatures is claimed without a flashback alternative.',
  'Illuminor Szeras': 'Sacrifice-another-creature is an effect, not a cost.',
  'Sceptre of Eternal Glory':
    'The three-or-more-same-name land restriction is omitted from the three-mana ability.',
  'Shard of the Void Dragon': 'Exile-from-battlefield is omitted from the artifact-leaves trigger.',
  'The War in Heaven': 'Saga chapters are implemented as enter, upkeep, and end-step triggers.',
  'Their Number Is Legion': 'Tokens are not created tapped, and graveyard cast is omitted.',
  Cryptek: 'The delayed return omits entering tapped.',
  'Out of the Tombs':
    'Enters-with two eon counters is authored; the card only places counters on upkeep.',
  'Resurrection Orb': "Return is under the equipment controller, not the card's owner.",
  'Shard of the Nightbringer': 'The if-you-cast-it intervening if is omitted.',
  'Szarekh, the Silent King':
    'Milled-this-way artifact-creature-or-Vehicle is implemented as any artifact creature in the graveyard.',
  'Mask of Memory': 'Equipped-creature combat damage is implemented as any equipped creature.',
  'Sautekh Immortal': 'Enters-with counters is implemented as an enters trigger.',
  'Trazyn the Infinite': 'Activated mana abilities of artifacts in the graveyard are omitted.',
  'Lightning Runner':
    'Untap all creatures you control is implemented as untapEach of all permanents you control.',
  'Aetheric Amplifier': 'Choose-one is implemented as two independent activated abilities.',
  'Peema Trailblazer': 'Exhaust is omitted, and the ability requires tapping this creature.',
  'Saheeli, Radiant Creator':
    'The copy is a reflexive trigger after payment; the target is chosen before you decide to pay.',
  'Saheeli, Sublime Artificer': 'A +1 loyalty ability is authored that is not on the card.',
  'Aetherworks Marvel':
    'Look-at-top-six free-cast does not put the rest on the bottom in a random order, and skips that reordering when no spell is castable.',
  'Territorial Aetherkite':
    'The damage is a reflexive trigger after payment, implemented as the same resolution.',
  Duplicant: 'Optional exile is a required target.',
  'Soul-Guide Lantern':
    'Opponent-graveyard exile is authored with a free draw instead of a separate {1} draw ability.',
  'Adaptive Omnitool': 'Artifact-from-library is put into hand without revealing.',
  'Bespoke Battlewagon':
    'Crew 4 is dropped when the energy activations replace the parsed activated abilities.',
  'Vastwood Surge': 'The basic-land search omits revealing the found cards.',
  'Dragon Tempest': 'Dragon-dealt damage is implemented as damage from this enchantment.',
  'Dream Pillager':
    'Exiled cards are playable, including lands; Oracle only permits casting spells.',
  'Kairi, the Swirling Sky':
    'Return-any-number targeting with total mana value 6 or less is an untargeted single bounce with no mana-value cap.',
  'Hunting Wilds': 'The Forest search omits revealing the found cards.',
  'Idol of Oblivion':
    'The draw restriction is a resolution no-op, and the token is an Eldrazi Construct artifact instead of an Eldrazi creature.',
  'Flameblast Dragon': 'The damage target is chosen before you decide to pay X.',
  'Thunderbreak Regent':
    'Damage to the targeting opponent uses eventPlayer, which is unset on becomes-targeted events.',
  "Tyrant's Familiar":
    'Defending-player creature targeting uses eventPlayer, which is the attacking player.',
  'Dragonkin Berserker':
    'Boast cost reduction applies only to this creature, not to Boast abilities you activate.',
  'Atarka Monument': 'The animation does not make it red and green.',
  'Scourge of Valkas':
    'The entering Dragon is the damage source, implemented as damage from this creature.',
  "Karametra's Favor":
    'The enchanted-creature +1/+1 is dropped when the mana ability replaces staticEffects.',
  'Return to Nature': 'Choose-one still requires targets for every mode.',
  'Frontier Siege': "The Dragons fight option still requires a target creature you don't control.",
  'Sarkhan, the Dragonspeaker': 'The +1 does not make it legendary or red.',
  'Curse of Bounty': 'Only the attacking player untaps; the curse controller always should.',
  'Rishkar, Peema Renegade': 'Up-to-two +1/+1 counters require at least one target.',
  'Druid of Purification':
    'Each player chooses a permanent they do not control, not a permanent you do not control.',
  'Aether Hub':
    'The colorless mana ability is dropped when the energy mana ability replaces manaAbilities.',
  'Solar Transformer':
    'The colorless mana ability is dropped when the energy mana ability replaces manaAbilities.',
  'Nullmage Shepherd': 'The four creatures cannot include this creature.',
  'Retrofitter Foundry':
    'The {2}, {T} Servo creation is dropped when activatedAbilities replace the parsed abilities.',
  'Cranial Plating': 'Equip {1} is dropped when the attach activation replaces activatedAbilities.',
  'Dark Confidant':
    'Reveal-and-put-into-hand is implemented as a draw, including empty-library loss.',
  'Cut a Deal': 'You draw for each opponent, not for each opponent who drew a card.',
  'Living Death': 'Battlefield creatures are put into graveyards instead of being sacrificed.',
  'Screams from Within':
    'Return is a required attach target; current Oracle returns this Aura untargeted.',
  'Scavenging Ooze':
    'Exile splices the card without a zone-change, so leave-graveyard events are skipped.',
  Sunforger: 'Equip {2} is authored; current Oracle is Equip {3}.',
  Technomancer: 'Zero-mana artifact creatures cannot be returned once remaining mana value hits 0.',
  'Thundermaw Hellkite':
    'Tap applies to all opposing fliers, not only creatures dealt that damage.',
  'Tomb Blade': 'Combat-damage life loss targets any player, not the damaged player.',
  'Champion of Lambholt':
    "The can't-block static is hardcoded by card name, so copies lack it and lost abilities still apply it.",
  'Conclave Tribunal': 'Convoke is stored as a ruleStatic but never offered as a payment.',
  'Hour of Reckoning': 'Convoke is stored as a ruleStatic but never offered as a payment.',
  'Iron Apprentice':
    "The dies intervening-if checks the battlefield, so it never sees this creature's counters.",
  'Reality Shift':
    'Manifest puts the card face-down but never offers turning it face up for its mana cost.',
  'Will of the Mardu':
    'Choose-both requires controlling your own commander, not any commander you control.',
};

describe('Marchesa catalog audit containment', () => {
  const restoredCards = new Set([
    'Arcane Denial',
    'Fabled Passage',
    'Myriad Landscape',
    'Smothering Tithe',
    'War Room',
    // Coverage PR01 (docs/plans/card-coverage-chunks.md).
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
  ]);

  // catalog-audit-contained — required id for contained-catalog manifest traces.

  it('pins complete Oracle records for the reviewed cards', () => {
    expect(fixture.cards.map(({ card }) => card.name).sort()).toEqual(
      [...Object.keys(REASONS), ...restoredCards].sort(),
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
