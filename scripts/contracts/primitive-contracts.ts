import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { deriveCardCapabilities } from '../../packages/engine/src/cards/capabilities';
import { HAND_DISCARD_CAPABILITIES, supportsBoundedHandDiscard } from './bounded-hand-discard';

export interface PrimitiveCase {
  id: string;
  role: 'positive' | 'negative';
  file: string;
  titlePath: readonly string[];
}
export interface PrimitiveContract {
  capability: string;
  scope: string;
  cases: readonly PrimitiveCase[];
  supports(definition: CardDefinition): boolean;
}
const file = 'packages/engine/tests/effect-dispatch-contract.test.ts';
const suite = 'effect executor contracts independent of production cards';
const foundationCapabilities = [
  'CardDefinition',
  'CardDefinition.manaCost',
  'CardDefinition.spellAbility',
  'Ability.spell',
  'Ability.effects',
  'ParsedManaCost',
  'Effect.gainLife',
  'Value.const',
] as const;

/** All dependencies of a deliberately small, independently tested ordinary-spell composition. */
function supportsLifeSpell(definition: CardDefinition): boolean {
  const ability = definition.spellAbility;
  const cost = definition.manaCost;
  return (
    validateCardDefinition(definition).length === 0 &&
    definition.modeled &&
    !definition.hasUnsupportedCost &&
    definition.types.length === 1 &&
    ['Instant', 'Sorcery'].includes(definition.types[0]!) &&
    deriveCardCapabilities(definition).every((key) =>
      foundationCapabilities.some((capability) => capability === key),
    ) &&
    cost !== null &&
    (cost.x ?? 0) === 0 &&
    (cost.hybrid?.length ?? 0) === 0 &&
    (cost.phyrexian?.length ?? 0) === 0 &&
    cost.colorless === 0 &&
    Object.entries(cost.colored).every(([symbol, amount]) =>
      symbol === 'G' ? amount >= 0 && amount <= 1 : amount === 0,
    ) &&
    Number.isSafeInteger(cost.generic) &&
    Object.values(cost.colored).every(Number.isSafeInteger) &&
    cost.generic >= 0 &&
    cost.generic <= 1 &&
    ability?.kind === 'spell' &&
    ability.targets.length === 0 &&
    ability.modes === undefined &&
    !('condition' in ability) &&
    ability.effects.length > 0 &&
    ability.effects.length <= 2 &&
    ability.effects.every(
      (effect) =>
        effect.op === 'gainLife' &&
        effect.amount.kind === 'const' &&
        Number.isSafeInteger(effect.amount.n) &&
        effect.amount.n >= 0 &&
        effect.amount.n <= 1000,
    )
  );
}

/** Deliberately excludes granted keywords, counters, other faces, and mixed abilities. */
function supportsPrintedKeyword(definition: CardDefinition, keyword: string): boolean {
  try {
    const allowed = new Set([
      'CardDefinition',
      'CardDefinition.keywords',
      'CardDefinition.manaCost',
      'ParsedManaCost',
      `Keyword.${keyword}`,
    ]);
    const cost = definition.manaCost;
    return (
      validateCardDefinition(definition).length === 0 &&
      definition.modeled &&
      !definition.hasUnsupportedCost &&
      definition.types.length === 1 &&
      definition.types[0] === 'Creature' &&
      definition.supertypes.length === 0 &&
      definition.power === 2 &&
      definition.toughness === 2 &&
      definition.keywords.length === 1 &&
      definition.keywords[0] === keyword &&
      cost !== null &&
      cost.generic === 0 &&
      cost.colorless === 0 &&
      (cost.x ?? 0) === 0 &&
      (cost.hybrid?.length ?? 0) === 0 &&
      (cost.phyrexian?.length ?? 0) === 0 &&
      Object.values(cost.colored).every((amount) => amount === 0) &&
      deriveCardCapabilities(definition).every((capability) => allowed.has(capability))
    );
  } catch {
    return false;
  }
}

const printedKeywordCases = {
  flying: [
    'flying excludes an ordinary ground blocker after a normal cast',
    'flying does not exclude a reach blocker after a normal cast',
  ],
  menace: [
    'menace permits two ordinary blockers after a normal cast',
    'menace rejects and repairs a lone ordinary blocker after a normal cast',
  ],
  lifelink: [
    'lifelink gains life for its controller from unblocked combat damage after a normal cast',
    'ordinary combat damage without lifelink does not gain life after a normal cast',
  ],
} as const;

const handDiscardScope =
  'ordinary {B} Sorcery with exactly one opponent player target and one reveal-hand/controller-chosen discard instruction filtered by not Creature and not Land, with no additional executable dependencies';
function handDiscardCases(capability: string): PrimitiveCase[] {
  return (['positive', 'negative'] as const).map((role) => ({
    id: `bounded-hand-discard-${capability}-${role}`,
    role,
    file: 'packages/engine/tests/bounded-hand-discard-contract.test.ts',
    titlePath: ['independent bounded hand discard composition', `${capability}: ${role}`],
  }));
}

/** Declarations describe required executions. Lifecycle and pass results are generated. */
export const PRIMITIVE_CONTRACTS: readonly PrimitiveContract[] = [
  ...(['flying', 'menace', 'lifelink'] as const).map((keyword): PrimitiveContract => ({
    capability: `Keyword.${keyword}`,
    scope: `printed ${keyword} as the sole executable keyword on an ordinary nonlegendary 2/2 Creature with cost {0}; ordinary combat blocker legality or unmodified combat-damage life gain only, excluding granted keywords, counters, other faces and mixed abilities`,
    cases: (['positive', 'negative'] as const).map((role, index) => ({
      id: `printed-${keyword}-${role}`,
      role,
      file: 'packages/engine/tests/native-keyword-contract.test.ts',
      titlePath: [
        'independent printed keyword combat contracts',
        printedKeywordCases[keyword][index]!,
      ],
    })),
    supports: (definition) => supportsPrintedKeyword(definition, keyword),
  })),
  ...foundationCapabilities.map((capability): PrimitiveContract => ({
    capability,
    scope:
      'ordinary untargeted Instant/Sorcery spells with at most two fixed nonnegative life-gain instructions (0..1000), green/generic total mana cost at most {1}{G}, and no additional executable dependencies' +
      ((HAND_DISCARD_CAPABILITIES as readonly string[]).includes(capability)
        ? `; or ${handDiscardScope}`
        : ''),
    cases: [
      ...(['positive', 'negative'] as const).map((role) => ({
        id: `${capability}-${role}`,
        role,
        file: 'packages/engine/tests/primitive-foundation-contract.test.ts',
        titlePath: ['independent bounded spell foundations', `${capability}: ${role}`],
      })),
      ...(capability === 'CardDefinition' ? (['positive', 'negative'] as const) : []).map(
        (role) => ({
          id: `${capability}-bounded-composition-${role}`,
          role,
          file: 'packages/engine/tests/primitive-composition-contract.test.ts',
          titlePath: [
            'bounded registered primitive compositions',
            role === 'positive'
              ? 'every funded composition offers a complete deterministic normal cast'
              : 'every unfunded composition rejects without changing the complete context',
          ],
        }),
      ),
      ...((HAND_DISCARD_CAPABILITIES as readonly string[]).includes(capability)
        ? handDiscardCases(capability)
        : []),
    ],
    supports: (definition) =>
      supportsLifeSpell(definition) ||
      ((HAND_DISCARD_CAPABILITIES as readonly string[]).includes(capability) &&
        supportsBoundedHandDiscard(definition)),
  })),
  ...HAND_DISCARD_CAPABILITIES.filter(
    (capability) => !(foundationCapabilities as readonly string[]).includes(capability),
  ).map((capability): PrimitiveContract => ({
    capability,
    scope: handDiscardScope,
    cases: handDiscardCases(capability),
    supports: supportsBoundedHandDiscard,
  })),
  {
    capability: 'Effect.removeCounters',
    scope:
      'unconditional direct effects with ordinary permanent target slots and fixed nonnegative integer counts; only the named counter is removed, up to the available amount',
    cases: [
      ...['__proto__', 'constructor', 'toString'].flatMap((counter): PrimitiveCase[] => [
        {
          id: `remove-counters-owned-${counter}`,
          role: 'positive',
          file: 'packages/engine/tests/counter-name-contract.test.ts',
          titlePath: [
            'ordinary counter names use owned data through normal casting',
            `removes exactly one owned ${counter} counter`,
          ],
        },
        {
          id: `remove-counters-absent-${counter}`,
          role: 'negative',
          file: 'packages/engine/tests/counter-name-contract.test.ts',
          titlePath: [
            'ordinary counter names use owned data through normal casting',
            `does not remove an inherited ${counter} counter through a normal cast`,
          ],
        },
      ]),
      {
        id: 'remove-counters-zero',
        role: 'negative',
        file,
        titlePath: [suite, 'removes up to 0 counters from a targeted permanent'],
      },
      {
        id: 'remove-counters-one',
        role: 'positive',
        file,
        titlePath: [suite, 'removes up to 1 counters from a targeted permanent'],
      },
      {
        id: 'remove-counters-up-to',
        role: 'positive',
        file,
        titlePath: [suite, 'removes up to 5 counters from a targeted permanent'],
      },
      {
        id: 'remove-counters-illegal-target',
        role: 'negative',
        file,
        titlePath: [suite, 'does not remove counters from an illegal target'],
      },
    ],
    supports(definition) {
      let supported = true;
      function visit(value: unknown, enclosing?: Record<string, unknown>): void {
        if (Array.isArray(value)) {
          value.forEach((item) => visit(item, enclosing));
          return;
        }
        if (value === null || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        const ability = ['spell', 'activated', 'triggered'].includes(node['kind'] as string)
          ? node
          : enclosing;
        if (node['op'] === 'removeCounters') {
          const targets = ability?.['targets'];
          supported &&=
            typeof node['target'] === 'number' &&
            Number.isSafeInteger(node['target']) &&
            node['target'] >= 0 &&
            Array.isArray(targets) &&
            targets[node['target']]?.kind === 'permanent' &&
            targets[node['target']]?.count === undefined &&
            ability?.['modes'] === undefined &&
            ability?.['condition'] === undefined &&
            Array.isArray(ability?.['effects']) &&
            ability['effects'].includes(node) &&
            typeof node['count'] === 'number' &&
            Number.isSafeInteger(node['count']) &&
            node['count'] >= 0 &&
            typeof node['counter'] === 'string' &&
            node['counter'].length > 0;
        }
        Object.values(node).forEach((item) => visit(item, ability));
      }
      visit(definition);
      return supported;
    },
  },
];
for (const contract of PRIMITIVE_CONTRACTS) {
  for (const test of contract.cases) {
    Object.freeze(test.titlePath);
    Object.freeze(test);
  }
  Object.freeze(contract.cases);
  Object.freeze(contract);
}
Object.freeze(PRIMITIVE_CONTRACTS);
