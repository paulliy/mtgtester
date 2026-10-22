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
 * 4. **Never mutate a `TokenSpec` you did not just construct.** `canonicalizeToken` and the
 *    `PREDEFINED_TOKENS` lookup in `interpret.ts` both return a catalog object BY REFERENCE on a
 *    match — that's the point of rule 1, one shared object standing in for every card that creates
 *    that token. A caller that then does `spec.name = …` (e.g. to name a legendary token) mutates
 *    the shared const itself, corrupting it for every other card that references it afterward in
 *    the same process. Always spread into a new object first: `{ ...spec, name: … }`.
 */

import type { Color, ManaCostString } from '@mtg/shared';
import type { KeywordAbility, ManaAbilitySpec, TokenSpec } from './ability';
import type { ParsedManaCost } from '../mana/cost';
import { parseManaCost } from '../mana/cost';

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

export const SOLDIER_1_1: TokenSpec = creatureToken({
  name: 'Soldier',
  subtypes: ['Soldier'],
  colors: ['W'],
  power: 1,
  toughness: 1,
});

/** Recruit creates a Human Soldier, distinct from a plain Soldier. */
export const HUMAN_SOLDIER_1_1_WHITE: TokenSpec = creatureToken({
  name: 'Human Soldier',
  subtypes: ['Human', 'Soldier'],
  colors: ['W'],
  power: 1,
  toughness: 1,
});

/** Rabble Rousing creates green and white Citizens. */
export const CITIZEN_1_1_GREEN_WHITE: TokenSpec = creatureToken({
  name: 'Citizen',
  subtypes: ['Citizen'],
  colors: ['G', 'W'],
  power: 1,
  toughness: 1,
});

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

export const ZOMBIE_2_2_BLACK: TokenSpec = creatureToken({
  name: 'Zombie',
  subtypes: ['Zombie'],
  colors: ['B'],
  power: 2,
  toughness: 2,
});

export const NECRON_WARRIOR_2_2: TokenSpec = creatureToken({
  name: 'Necron Warrior',
  subtypes: ['Necron'],
  colors: ['B'],
  power: 2,
  toughness: 2,
  artifact: true,
});

export const SPIRIT_1_1_FLYING: TokenSpec = creatureToken({
  name: 'Spirit',
  subtypes: ['Spirit'],
  colors: ['W'],
  power: 1,
  toughness: 1,
  keywords: ['flying'],
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

/** Toby's Beast: "This token can't attack or block alone." (CR 506.5) */
export const BEAST_4_4_WHITE_CANT_ACT_ALONE: TokenSpec = {
  ...creatureToken({
    name: 'Beast',
    subtypes: ['Beast'],
    colors: ['W'],
    power: 4,
    toughness: 4,
  }),
  ruleStatics: [{ kind: 'cantAttackAlone' }, { kind: 'cantBlockAlone' }],
};

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

/** Ghalta and Mavren freezes this token's printed X/X at creation via effect overrides. */
export const DINOSAUR_X_X_TRAMPLE_GREEN: TokenSpec = creatureToken({
  name: 'Dinosaur',
  subtypes: ['Dinosaur'],
  colors: ['G'],
  power: 0,
  toughness: 0,
  keywords: ['trample'],
});

export const VAMPIRE_1_1_LIFELINK_WHITE: TokenSpec = creatureToken({
  name: 'Vampire',
  subtypes: ['Vampire'],
  colors: ['W'],
  power: 1,
  toughness: 1,
  keywords: ['lifelink'],
});

export const SKELETON_4_1_MENACE_BLACK: TokenSpec = creatureToken({
  name: 'Skeleton',
  subtypes: ['Skeleton'],
  colors: ['B'],
  power: 4,
  toughness: 1,
  keywords: ['menace'],
});

export const WARRIOR_1_1_RED: TokenSpec = creatureToken({
  name: 'Warrior',
  subtypes: ['Warrior'],
  colors: ['R'],
  power: 1,
  toughness: 1,
});

/** Kazuul, Tyrant of the Cliffs' paid-in tax refund: "create a 3/3 red Ogre creature token". */
export const OGRE_3_3_RED: TokenSpec = creatureToken({
  name: 'Ogre',
  subtypes: ['Ogre'],
  colors: ['R'],
  power: 3,
  toughness: 3,
});

export const NINJA_1_1_BLACK: TokenSpec = creatureToken({
  name: 'Ninja',
  subtypes: ['Ninja'],
  colors: ['B'],
  power: 1,
  toughness: 1,
});

export const RABBIT_1_1_WHITE: TokenSpec = creatureToken({
  name: 'Rabbit',
  subtypes: ['Rabbit'],
  colors: ['W'],
  power: 1,
  toughness: 1,
});

export const SPIDER_2_2_REACH_GREEN: TokenSpec = creatureToken({
  name: 'Spider',
  subtypes: ['Spider'],
  colors: ['G'],
  power: 2,
  toughness: 2,
  keywords: ['reach'],
});

/** Scriv's named Aura token, including the ability printed on the token itself. */
export const CONTRACT_AURA: TokenSpec = {
  name: 'Contract',
  typeLine: 'Enchantment — Aura',
  types: ['Enchantment'],
  subtypes: ['Aura'],
  colors: ['W'],
  power: null,
  toughness: null,
  triggers: [
    {
      kind: 'triggered',
      trigger: {
        when: 'attacks',
        subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
      },
      targets: [],
      effects: [
        {
          op: 'conditionalEffect',
          condition: { kind: 'triggerObjectAttackingOpponent' },
          then: [
            {
              op: 'pumpUntilEot',
              target: 'triggerObject',
              power: { kind: 'const', n: 2 },
              toughness: { kind: 'const', n: 0 },
            },
          ],
          else: [
            {
              op: 'loseLifeTarget',
              target: 'eventPlayer',
              amount: { kind: 'const', n: 2 },
            },
          ],
        },
      ],
      description:
        'Enchanted creature attacks — pump it if it attacks your opponent; otherwise its controller loses 2 life',
    },
  ],
};

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
  ...creatureToken({
    name: 'Eldrazi Spawn',
    subtypes: ['Eldrazi'],
    colors: [],
    power: 0,
    toughness: 1,
  }),
  manaAbilities: [{ costs: [{ kind: 'sacrificeSelf' }], units: [['C']] }],
};

/**
 * Mutagen — "{1}, {T}, Sacrifice this token: Put a +1/+1 counter on target creature. Activate only
 * as a sorcery." The same three load-bearing costs as Food, at sorcery speed.
 */
export const MUTAGEN: TokenSpec = {
  ...artifactToken({ name: 'Mutagen', subtypes: ['Mutagen'] }),
  activatedAbilities: [
    {
      costs: [
        { kind: 'mana', cost: parseManaCost('{1}' as ManaCostString).cost as ParsedManaCost },
        { kind: 'tap' },
        { kind: 'sacrificeSelf' },
      ],
      timing: 'sorcery',
      ability: {
        kind: 'activated',
        targets: [{ kind: 'creature' }],
        effects: [{ op: 'putCounters', target: 0, counter: '+1/+1', count: 1 }],
        description:
          '{1}, {T}, Sacrifice this token: Put a +1/+1 counter on target creature. Activate only as a sorcery.',
      },
    },
  ],
};

/**
 * "0/0 Vehicle with flying. Crew 2." — single-use (Pia Nalaar, Chief Mechanic), catalogued
 * anyway so no override carries an inline `TokenSpec` literal at all.
 */
export const NALAAR_AETHERJET: TokenSpec = {
  ...artifactToken({ name: 'Nalaar Aetherjet', subtypes: ['Vehicle'] }),
  power: 0,
  toughness: 0,
  keywords: ['flying'],
  activatedAbilities: [
    {
      costs: [{ kind: 'tapCreaturesTotalPower', minPower: 2 }],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'crewVehicle', minPower: 2 }],
        description: 'Crew 2',
      },
    },
  ],
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
  manaAbilities: [
    { units: [['W', 'U', 'B', 'R', 'G']], costs: [{ kind: 'tap' }, { kind: 'sacrificeSelf' }] },
  ],
});

/**
 * Food (CR 111.10) — "{2}, {T}, Sacrifice this token: You gain 3 life."
 *
 * All three cost components matter, the same way Treasure's two do: without the {2} it is free
 * life, without the tap it is repeatable, and without the sacrifice it is both.
 */
export const FOOD: TokenSpec = {
  ...artifactToken({ name: 'Food', subtypes: ['Food'] }),
  activatedAbilities: [
    {
      costs: [
        { kind: 'mana', cost: parseManaCost('{2}' as ManaCostString).cost as ParsedManaCost },
        { kind: 'tap' },
        { kind: 'sacrificeSelf' },
      ],
      timing: 'any',
      ability: {
        kind: 'activated',
        targets: [],
        effects: [{ op: 'gainLife', amount: { kind: 'const', n: 3 } }],
        description: '{2}, {T}, Sacrifice this token: You gain 3 life.',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// The whole catalog, for structural lookup
// ---------------------------------------------------------------------------

/**
 * Every named token above, in one array.
 *
 * `interpret.ts`'s generic "create a token" grammar (`parseTokenFace`) builds a `TokenSpec` from
 * the printed phrase rather than importing one of these consts by name — it has no way to know
 * which card it is reading. Without this list, a parsed "1/1 white Soldier creature token with
 * lifelink" and `SOLDIER_1_1_LIFELINK` above are two structurally-identical but separately
 * allocated objects: correct today, but nothing stops the two from drifting the way the same
 * printed Treasure once did across `overrides/`. `interpret.ts` canonicalizes its parsed spec
 * against this list (by deep structural equality) so a match returns the SAME object, not a copy.
 */
export const SURVIVOR_1_1_RED = creatureToken({
  name: 'Survivor',
  subtypes: ['Survivor'],
  colors: ['R'],
  power: 1,
  toughness: 1,
});

export const ALL_TOKENS: TokenSpec[] = [
  SURVIVOR_1_1_RED,
  ZOMBIE_2_2_BLACK,
  SOLDIER_1_1_LIFELINK,
  INKLING_2_1_FLYING,
  ASSASSIN_1_1,
  NECRON_WARRIOR_2_2,
  BIRD_1_1_FLYING,
  SPIRIT_1_1_FLYING,
  DRAGON_5_5_FLYING,
  BEAST_3_3_GREEN,
  THOPTER_1_1_FLYING,
  SERVO_1_1,
  CAT_2_2_WHITE,
  INSECT_1_1_FLYING,
  INSECT_1_1_FLYING_DEATHTOUCH_GREEN,
  BEAST_6_6_ARTIFACT,
  DINOSAUR_X_X_TRAMPLE_GREEN,
  VAMPIRE_1_1_LIFELINK_WHITE,
  SKELETON_4_1_MENACE_BLACK,
  WARRIOR_1_1_RED,
  OGRE_3_3_RED,
  NINJA_1_1_BLACK,
  RABBIT_1_1_WHITE,
  SPIDER_2_2_REACH_GREEN,
  CONTRACT_AURA,
  CONSTRUCT_4_4,
  ELDRAZI_CONSTRUCT_10_10,
  CAT_BEAST_2_2_WHITE,
  SAPROLING_1_1_GREEN,
  ELEPHANT_3_3_GREEN,
  HUMAN_1_1_WHITE,
  ELDRAZI_SPAWN_0_1,
  MUTAGEN,
  NALAAR_AETHERJET,
  TREASURE,
  FOOD,
];

/** A key two structurally-identical `TokenSpec`s always share, regardless of property order. */
function canonicalKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(',')}]`;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalKey(source[k])}`).join(',')}}`;
}

/**
 * The key used to look a token up in the catalog — every field except `typeLine`.
 *
 * `typeLine` is derived from `types`/`subtypes` and carries no information the other fields don't
 * already, but the two derivations disagree: this catalog's own `creatureToken`/`artifactToken`
 * spell it `"Creature — Human"` (the real printed type line), while `interpret.ts`'s generic
 * grammar spells it `"Token Creature — Human"` (see `queen-marchesa-queens-gambit.ts`'s and
 * `draconic-destruction.ts`'s comments on the same "one word off" mismatch, both left as-is
 * there). Keying on `typeLine` too would make every catalog lookup miss on that formatting
 * difference alone, never on anything a card's rules text actually says — so it's excluded here,
 * and `typeLine` itself is exactly why a lookup HIT still needs to substitute the whole catalog
 * object rather than just returning `spec`: it corrects the format along with everything else.
 */
function tokenLookupKey(spec: TokenSpec): string {
  const { typeLine: _typeLine, ...rest } = spec;
  return canonicalKey(rest);
}

const BY_KEY = new Map(ALL_TOKENS.map((t) => [tokenLookupKey(t), t]));

/**
 * If `spec` is structurally identical to a cataloged token (`typeLine` aside — see
 * `tokenLookupKey`), return that catalog object instead of `spec` itself — so a token the generic
 * grammar parses off a card's own printed line ends up pointing at the exact same object as a
 * hand-authored override that creates the same token, not a separately-built copy that only
 * happens to match today. A miss returns `spec` unchanged: this is a lookup, not a validator, so
 * an unrecognized or not-yet-cataloged token is still fine.
 */
export function canonicalizeToken(spec: TokenSpec): TokenSpec {
  return BY_KEY.get(tokenLookupKey(spec)) ?? spec;
}
