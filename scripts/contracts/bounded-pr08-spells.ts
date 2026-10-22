import { isDeepStrictEqual } from 'node:util';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import type { Effect, TargetSpec } from '../../packages/engine/src/cards/ability';
import { interpretCard } from '../../packages/engine/src/cards/interpret';
import { deriveCardCapabilities } from '../../packages/engine/src/cards/capabilities';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { allOf, not, ofType, OPPONENTS } from '../../packages/engine/src/cards/selector';
import { parseManaCost } from '../../packages/engine/src/mana/cost';
import { constant } from '../../packages/engine/src/cards/value';
import { SPIRIT_1_1_FLYING } from '../../packages/engine/src/cards/tokens';

function synthetic(
  id: string,
  typeLine: 'Instant' | 'Sorcery',
  manaCost: string,
  colors: string[],
  oracleText: string,
  effects: Effect[],
  targets: TargetSpec[] = [],
  modes?: NonNullable<CardDefinition['spellAbility']>['modes'],
): CardDefinition {
  const parsed = parseManaCost(manaCost);
  if (parsed.cost === null) throw new Error(`invalid synthetic mana cost ${manaCost}`);
  const raw = {
    oracleId: `bounded-pr08-${id}`,
    scryfallId: `bounded-pr08-${id}`,
    name: 'Independent composition probe',
    manaCost,
    cmc: 0,
    colors,
    colorIdentity: colors,
    typeLine,
    supertypes: [],
    types: [typeLine],
    subtypes: [],
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: false,
    oracleText,
    keywords: [],
  } as Parameters<typeof interpretCard>[0];
  const definition = interpretCard(raw);
  definition.manaCost = parsed.cost;
  definition.modeled = true;
  definition.unmodeledReasons = [];
  definition.spellAbility = {
    kind: 'spell',
    targets,
    effects,
    ...(modes === undefined ? {} : { modes }),
  };
  return definition;
}

const mobRule = () =>
  synthetic(
    'mob-rule',
    'Sorcery',
    '{4}{R}{R}',
    ['R'],
    'Choose one —\n• Gain control of all creatures with power 4 or greater until end of turn. Untap those creatures. They gain haste until end of turn.\n• Gain control of all creatures with power 3 or less until end of turn. Untap those creatures. They gain haste until end of turn.',
    [],
    [],
    {
      minChoices: 1,
      maxChoices: 1,
      options: [
        {
          description: 'High power',
          effects: [
            {
              op: 'gainControl',
              selector: allOf(ofType('Creature'), { kind: 'powerAtLeast', n: 4 }),
              duration: 'untilEndOfTurn',
              untap: true,
              grantHaste: true,
            },
          ],
        },
        {
          description: 'Low power',
          effects: [
            {
              op: 'gainControl',
              selector: allOf(ofType('Creature'), { kind: 'powerAtMost', n: 3 }),
              duration: 'untilEndOfTurn',
              untap: true,
              grantHaste: true,
            },
          ],
        },
      ],
    },
  );
const cutADeal = () =>
  synthetic(
    'cut-a-deal',
    'Sorcery',
    '{2}{W}',
    ['W'],
    'Each opponent draws a card, then you draw a card for each opponent who drew a card this way.',
    [{ op: 'drawForEachOpponent' }],
  );
const reins = () =>
  synthetic(
    'reins-of-power',
    'Instant',
    '{2}{U}{U}',
    ['U'],
    'Untap all creatures you control and all creatures target opponent controls. You and that opponent each gain control of all creatures the other controls until end of turn. Those creatures gain haste until end of turn.',
    [{ op: 'swapCreatureControlUntilEot', target: 0 }],
    [{ kind: 'player', controller: 'opponent' }],
  );
const council = () =>
  synthetic(
    'councils-judgment',
    'Sorcery',
    '{1}{W}{W}',
    ['W'],
    "Will of the council — Starting with you, each player votes for a nonland permanent you don't control. Exile each permanent with the most votes or tied for most votes.",
    [{ op: 'voteAndExileMost', selector: allOf(not(ofType('Land')), OPPONENTS) }],
  );
const benevolent = () =>
  synthetic(
    'benevolent-offering',
    'Instant',
    '{3}{W}',
    ['W'],
    'Choose an opponent. You and that player each create three 1/1 white Spirit creature tokens with flying.\nChoose an opponent. You gain 2 life for each creature you control and that player gains 2 life for each creature they control.',
    [
      { op: 'shareTokensWithChosenOpponent', spec: SPIRIT_1_1_FLYING, count: constant(3) },
      { op: 'shareCreatureLifeWithChosenOpponent', amount: constant(2) },
    ],
  );

export const BOUNDED_PR08_SPELLS = [
  { id: 'mob-rule', manaCost: '{4}{R}{R}', colors: ['R'], definition: mobRule() },
  { id: 'cut-a-deal', manaCost: '{2}{W}', colors: ['W'], definition: cutADeal() },
  { id: 'reins-of-power', manaCost: '{2}{U}{U}', colors: ['U'], definition: reins() },
  { id: 'councils-judgment', manaCost: '{1}{W}{W}', colors: ['W'], definition: council() },
  { id: 'benevolent-offering', manaCost: '{3}{W}', colors: ['W'], definition: benevolent() },
] as const;

export const BOUNDED_PR08_CAPABILITIES = [
  ...new Set(
    BOUNDED_PR08_SPELLS.flatMap((entry) => {
      return deriveCardCapabilities(entry.definition);
    }),
  ),
].sort();

function normalize(value: unknown, root = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry));
  if (value === null || typeof value !== 'object') return value;
  const ignored = new Set(['description', ...(root ? ['oracleId', 'name', 'scryfallId'] : [])]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !ignored.has(key))
      .map(([key, child]) => [key, normalize(child)]),
  );
}

export function matchesBoundedPr08Spell(definition: CardDefinition): boolean {
  return (
    validateCardDefinition(definition).length === 0 &&
    BOUNDED_PR08_SPELLS.some((entry) =>
      isDeepStrictEqual(normalize(definition, true), normalize(entry.definition, true)),
    )
  );
}
