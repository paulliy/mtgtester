import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { manaCost, spell } from '../../packages/engine/src/cards/templates';
import { allOf, ofType, OPPONENTS } from '../../packages/engine/src/cards/selector';

export const CHOICE_SPELL_KINDS = [
  'type-retention',
  'owner-library',
  'exile-search',
  'greatest-damage',
] as const;
export type ChoiceSpellKind = (typeof CHOICE_SPELL_KINDS)[number];

/** Independently authored executable compositions. Names and Oracle identities are immaterial;
 * every executable field, including cost, colors, alternate ability and ordering, is bounded. */
export function boundedChoiceSpell(kind: ChoiceSpellKind): CardDefinition {
  const definition: CardDefinition = {
    oracleId: `independent-choice-${kind}`,
    name: `Independent ${kind}`,
    typeLine: kind === 'type-retention' || kind === 'exile-search' ? 'Sorcery' : 'Instant',
    supertypes: [],
    types: [kind === 'type-retention' || kind === 'exile-search' ? 'Sorcery' : 'Instant'],
    subtypes: [],
    colors: kind === 'owner-library' ? ['U'] : kind === 'greatest-damage' ? ['R', 'W'] : ['W'],
    colorIdentity:
      kind === 'owner-library' ? ['U'] : kind === 'greatest-damage' ? ['R', 'W'] : ['W'],
    manaCost: manaCost(
      kind === 'type-retention'
        ? '{3}{W}{W}'
        : kind === 'owner-library'
          ? '{3}{U}{U}'
          : kind === 'exile-search'
            ? '{1}{W}'
            : '{2}{R}{W}',
    ),
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: null,
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    modeled: true,
    unmodeledReasons: [],
  };
  switch (kind) {
    case 'type-retention':
      definition.spellAbility = spell({
        effects: [
          {
            op: 'choosePermanentTypesThenSacrificeOthers',
            types: ['Artifact', 'Creature', 'Enchantment', 'Planeswalker'],
          },
        ],
      });
      break;
    case 'owner-library':
      definition.spellAbility = spell({ effects: [{ op: 'attackingCreaturesToOwnerLibraries' }] });
      break;
    case 'greatest-damage':
      definition.spellAbility = spell({
        effects: [
          {
            op: 'sacrificeGreatestEachOpponent',
            selector: 'creature',
            metric: 'power',
            action: 'exile',
            damageIfGraveyardSpellsAtLeast: 2,
          },
        ],
      });
      break;
    case 'exile-search':
      definition.spellAbility = spell({
        targets: [{ kind: 'creature', controller: 'opponent' }],
        effects: [{ op: 'exileCreatureAndControllerSearchBasicLand', target: 0 }],
      });
      definition.alternativeCasts = [
        {
          kind: 'overload',
          manaCost: manaCost('{4}{W}{W}'),
          description: 'Overload',
          ability: spell({
            effects: [
              {
                op: 'exileEachCreatureAndControllersSearchBasicLands',
                selector: allOf(ofType('Creature'), OPPONENTS),
              },
            ],
          }),
        },
      ];
      break;
  }
  return definition;
}

/** Ignore only identifiers and human-readable labels. Unknown fields remain in the comparison. */
export function executableDefinitionShape(value: unknown, root = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => executableDefinitionShape(entry));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== 'description' && !(root && ['oracleId', 'scryfallId', 'name'].includes(key)),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, executableDefinitionShape(entry)]),
  );
}
export function supportsBoundedChoiceSpell(
  definition: CardDefinition,
  kind?: ChoiceSpellKind,
): boolean {
  try {
    return (
      validateCardDefinition(definition).length === 0 &&
      (kind === undefined ? CHOICE_SPELL_KINDS : [kind]).some(
        (candidate) =>
          JSON.stringify(executableDefinitionShape(definition, true)) ===
          JSON.stringify(executableDefinitionShape(boundedChoiceSpell(candidate), true)),
      )
    );
  } catch {
    return false;
  }
}
