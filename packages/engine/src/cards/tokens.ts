/**
 * The shared token catalog.
 *
 * A `TokenSpec` is pure data, so a token written out by hand in each override file is a token that
 * drifts. It did: before this catalog existed the same printed token was spelled several different
 * ways across `overrides/` — a Soldier that was white in four places and white-green in two, a
 * Necron Warrior whose subtypes and colors disagreed between two files, and three Treasures with
 * three different mana abilities. Those are not style differences; they are different cards.
 *
 * Rules for this file:
 *
 * 1. **One printed token, one export.** If two cards create "a 1/1 white Soldier creature token
 *    with lifelink", they reference the same const. Do not inline a `TokenSpec` in an override.
 * 2. **Build with `creatureToken` / `artifactToken`** rather than writing `typeLine`, `types` and
 *    `subtypes` separately — deriving them from one place is what stops a type line from
 *    disagreeing with the types the engine actually reads.
 * 3. A token that genuinely differs from an existing one gets its own named export describing the
 *    difference, never a near-copy of another const.
 */

import type { Color } from '@mtg/shared';
import type { KeywordAbility, ManaAbilitySpec, TokenSpec } from './ability';

/**
 * A creature token. `typeLine`, `types` and `subtypes` are derived from `subtypes` so they cannot
 * disagree; pass `artifact` for the artifact-creature tokens (Constructs, Necrons, Thopters).
 */
export function creatureToken(spec: {
  name: string;
  subtypes: string[];
  colors: Color[];
  power: number;
  toughness: number;
  keywords?: KeywordAbility[];
  artifact?: boolean;
  legendary?: boolean;
}): TokenSpec {
  const types = spec.artifact === true ? ['Artifact', 'Creature'] : ['Creature'];
  const token: TokenSpec = {
    name: spec.name,
    typeLine: `${types.join(' ')} — ${spec.subtypes.join(' ')}`,
    types,
    subtypes: spec.subtypes,
    colors: spec.colors,
    power: spec.power,
    toughness: spec.toughness,
  };
  if (spec.keywords !== undefined) token.keywords = spec.keywords;
  if (spec.legendary !== undefined) token.legendary = spec.legendary;
  return token;
}

/** A noncreature artifact token (Treasure, Clue, Food). `power`/`toughness` are null, per CR 111.4. */
export function artifactToken(spec: {
  name: string;
  subtypes: string[];
  colors?: Color[];
  manaAbilities?: ManaAbilitySpec[];
}): TokenSpec {
  const token: TokenSpec = {
    name: spec.name,
    typeLine: `Artifact — ${spec.subtypes.join(' ')}`,
    types: ['Artifact'],
    subtypes: spec.subtypes,
    colors: spec.colors ?? [],
    power: null,
    toughness: null,
  };
  if (spec.manaAbilities !== undefined) token.manaAbilities = spec.manaAbilities;
  return token;
}

// ---------------------------------------------------------------------------
// Creature tokens
// ---------------------------------------------------------------------------

export const SOLDIER_1_1_LIFELINK: TokenSpec = creatureToken({
  name: 'Soldier',
  subtypes: ['Soldier'],
  colors: ['W'],
  power: 1,
  toughness: 1,
  keywords: ['lifelink'],
});

export const INKLING_2_1_FLYING: TokenSpec = creatureToken({
  name: 'Inkling',
  subtypes: ['Inkling'],
  colors: ['W', 'B'],
  power: 2,
  toughness: 1,
  keywords: ['flying'],
});

export const ASSASSIN_1_1: TokenSpec = creatureToken({
  name: 'Assassin',
  subtypes: ['Assassin'],
  colors: ['B'],
  power: 1,
  toughness: 1,
  keywords: ['deathtouch', 'haste'],
});

export const NECRON_WARRIOR_2_2: TokenSpec = creatureToken({
  name: 'Necron Warrior',
  subtypes: ['Necron'],
  colors: ['B'],
  power: 2,
  toughness: 2,
  artifact: true,
});

export const BIRD_1_1_FLYING: TokenSpec = creatureToken({
  name: 'Bird',
  subtypes: ['Bird'],
  colors: ['W'],
  power: 1,
  toughness: 1,
  keywords: ['flying'],
});

export const DRAGON_5_5_FLYING: TokenSpec = creatureToken({
  name: 'Dragon',
  subtypes: ['Dragon'],
  colors: ['R'],
  power: 5,
  toughness: 5,
  keywords: ['flying'],
});

export const BEAST_3_3_GREEN: TokenSpec = creatureToken({
  name: 'Beast',
  subtypes: ['Beast'],
  colors: ['G'],
  power: 3,
  toughness: 3,
});

export const THOPTER_1_1_FLYING: TokenSpec = creatureToken({
  name: 'Thopter',
  subtypes: ['Thopter'],
  // Colorless, not blue: "1/1 colorless Thopter artifact creature token with flying" is the
  // verbatim printed line (living-energy.ts's handledLines, multiple cards). This const shipped
  // with `colors: ['U']` in an earlier pass and went uncaught because nothing referenced it yet.
  colors: [],
  power: 1,
  toughness: 1,
  keywords: ['flying'],
  artifact: true,
});

export const SERVO_1_1: TokenSpec = creatureToken({
  name: 'Servo',
  subtypes: ['Servo'],
  colors: [],
  power: 1,
  toughness: 1,
  artifact: true,
});

export const CAT_2_2_WHITE: TokenSpec = creatureToken({
  name: 'Cat',
  subtypes: ['Cat'],
  colors: ['W'],
  power: 2,
  toughness: 2,
});

export const INSECT_1_1_FLYING: TokenSpec = creatureToken({
  name: 'Insect',
  subtypes: ['Insect'],
  colors: [],
  power: 1,
  toughness: 1,
  keywords: ['flying'],
  artifact: true,
});

export const INSECT_1_1_FLYING_DEATHTOUCH_GREEN: TokenSpec = creatureToken({
  name: 'Insect',
  subtypes: ['Insect'],
  colors: ['G'],
  power: 1,
  toughness: 1,
  keywords: ['flying', 'deathtouch'],
});

export const BEAST_6_6_ARTIFACT: TokenSpec = creatureToken({
  name: 'Beast',
  subtypes: ['Beast'],
  colors: [],
  power: 6,
  toughness: 6,
  artifact: true,
});

export const CONSTRUCT_4_4: TokenSpec = creatureToken({
  name: 'Construct',
  subtypes: ['Construct'],
  colors: [],
  power: 4,
  toughness: 4,
  artifact: true,
});

export const ELDRAZI_CONSTRUCT_10_10: TokenSpec = creatureToken({
  name: 'Eldrazi Construct',
  subtypes: ['Eldrazi', 'Construct'],
  colors: [],
  power: 10,
  toughness: 10,
  artifact: true,
});

export const CAT_BEAST_2_2_WHITE: TokenSpec = creatureToken({
  name: 'Cat Beast',
  subtypes: ['Cat', 'Beast'],
  colors: ['W'],
  power: 2,
  toughness: 2,
});

export const SAPROLING_1_1_GREEN: TokenSpec = creatureToken({
  name: 'Saproling',
  subtypes: ['Saproling'],
  colors: ['G'],
  power: 1,
  toughness: 1,
});

export const ELEPHANT_3_3_GREEN: TokenSpec = creatureToken({
  name: 'Elephant',
  subtypes: ['Elephant'],
  colors: ['G'],
  power: 3,
  toughness: 3,
});

export const HUMAN_1_1_WHITE: TokenSpec = creatureToken({
  name: 'Human',
  subtypes: ['Human'],
  colors: ['W'],
  power: 1,
  toughness: 1,
});

/** "Sacrifice this creature: Add {C}." — a colorless 0/1 with the mana ability spelled inline
 * because a sacrifice-for-mana ability is unique per token. */
export const ELDRAZI_SPAWN_0_1: TokenSpec = {
  ...creatureToken({ name: 'Eldrazi Spawn', subtypes: ['Eldrazi'], colors: [], power: 0, toughness: 1 }),
  manaAbilities: [{ costs: [{ kind: 'sacrificeSelf' }], units: [['C']] }],
};

/** "Artifact — Mutagen", a colorless noncreature token with no printed ability. */
export const MUTAGEN: TokenSpec = artifactToken({ name: 'Mutagen', subtypes: ['Mutagen'] });

/**
 * "0/0 Vehicle with flying. Crew 2." — single-use (Pia Nalaar, Chief Mechanic), catalogued
 * anyway so no override carries an inline `TokenSpec` literal at all.
 */
export const NALAAR_AETHERJET: TokenSpec = {
  ...artifactToken({ name: 'Nalaar Aetherjet', subtypes: ['Vehicle'] }),
  power: 0,
  toughness: 0,
  keywords: ['flying'],
  activatedAbilities: [{
    costs: [{ kind: 'tapCreaturesTotalPower', minPower: 2 }],
    timing: 'any',
    ability: { kind: 'activated', targets: [], effects: [{ op: 'crewVehicle', minPower: 2 }], description: 'Crew 2' },
  }],
};

// ---------------------------------------------------------------------------
// Artifact tokens
// ---------------------------------------------------------------------------

/**
 * Treasure (CR 111.10) — "{T}, Sacrifice this token: Add one mana of any color."
 *
 * Both cost components are load-bearing. Dropping the `tap` makes the token a repeatable mana
 * source, and dropping both makes it a free one; `overrides/` previously contained all three
 * spellings of this token, so treat any Treasure without exactly these two costs as a bug.
 */
export const TREASURE: TokenSpec = artifactToken({
  name: 'Treasure',
  subtypes: ['Treasure'],
  manaAbilities: [{ units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }] }],
});
