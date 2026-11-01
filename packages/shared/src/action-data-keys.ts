/**
 * Registry of every key the engine puts in `LegalAction.data` (ADR 0032 decision 4).
 *
 * `data` stays `Record<string, unknown>`; this registry is what makes that safe to extend. It
 * names each key, the JSON value types the engine emits for it (recursing one level only: a key
 * holding an array is `array`, a plain object or null is `object`), and who reads it.
 * `packages/server/src/cards/action-data-keys.test.ts` fails on a key or value type that is not
 * listed here. A change that adds a `data` key registers it here.
 *
 * Consumers name code that reads the key on purpose:
 *   - `ai`            the LLM primer or the server AI heuristics (`server/src/ai`)
 *   - `bot`           the heuristic bot (`packages/bot`)
 *   - `match`         match orchestration (`server/src/match`)
 *   - `presentation`  the server's presentation builders (`server/src/match/presentation.ts` and
 *                     `shared/src/presentation`), which turn it into typed fields. The browser
 *                     reads no `data` (ADR 0032 decisions 7 and 9)
 *   - `engine`        the engine itself, reading its own menu back
 *   - `none`          nothing reads it. The whole `data` object is still serialized verbatim
 *                     into every LLM prompt (`server/src/ai/context.ts`), so `none` means no
 *                     code looks at the key, not that the model never sees it.
 */

export const ACTION_DATA_VALUE_TYPES = ['number', 'string', 'boolean', 'object', 'array'] as const;
export type ActionDataValueType = (typeof ACTION_DATA_VALUE_TYPES)[number];

export const ACTION_DATA_CONSUMERS = [
  'ai',
  'bot',
  'match',
  'presentation',
  'engine',
  'none',
] as const;
export type ActionDataConsumer = (typeof ACTION_DATA_CONSUMERS)[number];

export interface ActionDataKeyInfo {
  /** One line: what the value means. */
  meaning: string;
  /** The value types the engine emits for this key. */
  types: readonly ActionDataValueType[];
  consumers: readonly ActionDataConsumer[];
  /** The registry test's sweep may not reach this key, so it does not fail when nothing emits it. */
  rare?: true;
}

export const ACTION_DATA_KEYS: Readonly<Record<string, ActionDataKeyInfo>> = {
  // --- Cast, activate and land-play menu entries (`engine/src/actions/legal.ts`) ---
  instantSpeed: {
    meaning: 'The spell can be cast at instant speed (instant or flash).',
    types: ['boolean'],
    consumers: ['ai'],
  },
  sourceName: {
    meaning: 'Name of the card or permanent the action comes from.',
    types: ['string'],
    consumers: ['presentation'],
  },
  sourceZone: {
    meaning: 'Zone the source is in: hand, command, library, graveyard, exile or battlefield.',
    types: ['string'],
    consumers: ['none'],
  },
  manaCost: {
    meaning: 'Mana cost to pay as displayed, after reductions; "free" for a free alternative cast.',
    types: ['string'],
    consumers: ['presentation'],
  },
  paymentSourceIds: {
    meaning: "Object ids of the permanents the engine's auto-pay plan would tap.",
    types: ['array'],
    consumers: ['presentation'],
  },
  paymentSourceNames: {
    meaning: 'Names of the permanents in `paymentSourceIds`, in the same order.',
    types: ['array'],
    consumers: ['presentation'],
  },
  abilityCosts: {
    meaning: 'Non-mana costs of an activated ability or an additional cost of a spell.',
    types: ['array'],
    consumers: ['bot', 'match', 'presentation'],
  },
  abilityDescription: {
    meaning: 'Rules text of the ability being activated, or a special-action name.',
    types: ['string'],
    consumers: ['presentation'],
  },
  abilityEffectOps: {
    meaning: 'Effect op names of the ability, every mode included, for the smart-yield policy.',
    types: ['array'],
    consumers: ['match'],
  },
  modeLabel: {
    meaning: 'Label of the mode or modes chosen for a modal spell or ability.',
    types: ['string'],
    consumers: ['presentation'],
  },
  castVariant: {
    meaning:
      'Alternative-cast kind (adventure, mdfc, faceDown, overload, ...); absent for a normal cast.',
    types: ['string'],
    consumers: ['presentation'],
  },
  x: {
    meaning: 'The value of X this option announces.',
    types: ['number'],
    consumers: ['presentation'],
  },
  energyCost: {
    meaning: 'Energy counters paid as part of the cast.',
    types: ['number'],
    consumers: ['presentation'],
    rare: true,
  },
  commanderTax: {
    meaning: 'Extra generic mana from commander tax on a cast from the command zone.',
    types: ['number'],
    consumers: ['none'],
  },
  optionalCostCount: {
    meaning: 'Times an optional additional cost (kicker, replicate, ...) is paid.',
    types: ['number'],
    consumers: ['presentation'],
  },
  optionalMechanic: {
    meaning: 'Name of the optional-cost mechanic behind `optionalCostCount`.',
    types: ['string'],
    consumers: ['presentation'],
  },
  targetReductionSlot: {
    meaning: 'Target slot whose chosen count reduces the cost (Killian-style).',
    types: ['number'],
    consumers: ['presentation'],
  },
  zoneBudgetType: {
    meaning: 'Card type this play-from-zone permission is budgeted against.',
    types: ['string'],
    consumers: ['none'],
  },
  publicDescription: {
    meaning: 'What other players may learn of a hidden-information action, for the public log.',
    types: ['string'],
    consumers: ['engine'],
  },

  // --- Land plays ---
  producesMana: {
    meaning: 'Colors the land can make, one per tap.',
    types: ['array'],
    consumers: ['ai', 'engine'],
  },
  entersTapped: {
    meaning: 'The land always enters tapped.',
    types: ['boolean'],
    consumers: ['ai', 'presentation'],
  },
  entersTappedConditional: {
    meaning: 'The land enters tapped unless a condition holds.',
    types: ['boolean'],
    consumers: ['ai', 'presentation'],
  },
  payLifeToUntap: {
    meaning: 'Life the player may pay for the land to enter untapped.',
    types: ['number'],
    consumers: ['ai', 'presentation'],
    rare: true,
  },
  unlocks: {
    meaning: 'Names of hand cards that become castable because of this land.',
    types: ['array'],
    consumers: ['ai'],
  },

  // --- Manual mana (`engine/src/mana/manual.ts`, human seats only) ---
  symbols: {
    meaning: 'Mana symbols one manual mana activation adds.',
    types: ['array'],
    consumers: ['presentation'],
    rare: true,
  },

  // --- Combat declarations (`engine/src/combat/combat.ts`) ---
  subjects: {
    meaning: 'Per-creature stats and flags for an attack or block declaration.',
    types: ['array'],
    consumers: ['ai', 'bot'],
  },
  chooseAttackers: {
    meaning:
      'The attack declaration only picks which creatures attack; defenders are set elsewhere.',
    types: ['boolean'],
    consumers: ['ai', 'bot'],
    rare: true,
  },
  blockingPlayer: {
    meaning: 'Seat declaring these blocks for the defending player (Master Warcraft).',
    types: ['string'],
    consumers: ['ai', 'bot'],
  },

  // --- Resolution choices and special actions ---
  sourceOracleId: {
    meaning: 'Oracle id of the triggered ability a yield-to-ability action covers.',
    types: ['string'],
    consumers: ['none'],
  },
  pile: {
    meaning: 'Contents of one pile in a pile-separation choice.',
    types: ['string'],
    consumers: ['none'],
  },
  cardCount: {
    meaning: 'Number of cards a library-search result puts into the chosen place.',
    types: ['number'],
    consumers: ['none'],
  },
  cardNames: {
    meaning: 'Names of the cards in a library-search result.',
    types: ['array'],
    consumers: ['none'],
  },
  life: {
    meaning: 'Life a pay-life choice charges.',
    types: ['number'],
    consumers: ['none'],
  },
  objectId: {
    meaning: 'Object id of one candidate in a counted-target pick.',
    types: ['string'],
    consumers: ['none'],
  },
};
