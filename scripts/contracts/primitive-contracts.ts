import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { validateCardDefinition } from '../../packages/engine/src/cards/authoring-validation';
import { deriveCardCapabilities } from '../../packages/engine/src/cards/capabilities';
import { HAND_DISCARD_CAPABILITIES, supportsBoundedHandDiscard } from './bounded-hand-discard';
import {
  BOUNDED_PR08_CAPABILITIES,
  BOUNDED_PR08_SPELLS,
  matchesBoundedPr08Spell,
} from './bounded-pr08-spells';
import { MULTIPLAYER_CHOICE_CONTRACT_EXTENSIONS } from './multiplayer-choice-contract-extensions';
import {
  BOUNDED_PR08_ORIGINAL_NINE,
  matchesBoundedPr08OriginalNine,
} from './bounded-pr08-original-nine';

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
const primitiveContracts: PrimitiveContract[] = [
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
      ...(capability === 'CardDefinition'
        ? BOUNDED_PR08_SPELLS.flatMap((entry) => [
            {
              id: `bounded-pr08-${entry.id}-normal-cast-positive`,
              role: 'positive' as const,
              file: 'packages/engine/tests/bounded-pr08-spell-composition-contract.test.ts',
              titlePath: [
                'bounded PR08 spell normal casts',
                `${entry.id} — funded synthetic spell resolves through a real cast`,
              ],
            },
            {
              id: `bounded-pr08-${entry.id}-normal-cast-negative`,
              role: 'negative' as const,
              file: 'packages/engine/tests/bounded-pr08-spell-composition-contract.test.ts',
              titlePath: [
                'bounded PR08 spell normal casts',
                `${entry.id} — unfunded normal cast is absent and state is unchanged`,
              ],
            },
          ])
        : []),
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

function capabilitySlug(capability: string): string {
  return capability
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

const runtimePrimitiveCases: Readonly<Record<string, readonly PrimitiveCase[]>> = {
  'Effect.gainControl': [
    {
      id: 'pr08-control-lifetime-positive',
      role: 'positive',
      file: 'packages/engine/tests/control-lifetime-contract.test.ts',
      titlePath: [
        'timestamped control lifetimes',
        'a same-controller permanent effect masks an older temporary effect without removing the creature from combat',
      ],
    },
    {
      id: 'pr08-control-lifetime-negative',
      role: 'negative',
      file: 'packages/engine/tests/control-lifetime-contract.test.ts',
      titlePath: [
        'timestamped control lifetimes',
        'source departure ends only its exact duration and a blink never revives that effect',
      ],
    },
  ],
  'Effect.swapCreatureControlUntilEot': [
    {
      id: 'pr08-swap-positive',
      role: 'positive',
      file: 'packages/engine/tests/swap-creature-control-contract.test.ts',
      titlePath: [
        'swapCreatureControlUntilEot is an ordinary player-target primitive',
        'swap-contract-caster-and-named-player-swap-only-those-two-groups — a normal cast swaps caster and the named player, leaving every other seat alone',
      ],
    },
    {
      id: 'pr08-swap-negative',
      role: 'negative',
      file: 'packages/engine/tests/swap-creature-control-contract.test.ts',
      titlePath: [
        'swapCreatureControlUntilEot is an ordinary player-target primitive',
        'swap-contract-rejects-a-creature-slot — a non-player or out-of-range target slot fails authoring validation',
      ],
    },
  ],
  'Effect.voteAndExileMost': [
    {
      id: 'pr08-vote-positive',
      role: 'positive',
      file: 'packages/engine/tests/vote-exile-contract.test.ts',
      titlePath: [
        'voteAndExileMost primitive contract',
        'vote-exile-all-decisions-before-movement — nothing leaves until every vote is cast',
      ],
    },
    {
      id: 'pr08-vote-negative',
      role: 'negative',
      file: 'packages/engine/tests/vote-exile-contract.test.ts',
      titlePath: [
        'voteAndExileMost primitive contract',
        'vote-exile-no-candidates — an empty pool produces no decision, no vote and no exile',
      ],
    },
  ],
  'Effect.shareTokensWithChosenOpponent': [
    {
      id: 'pr08-shared-token-positive',
      role: 'positive',
      file: 'packages/engine/tests/shared-opponent-contract.test.ts',
      titlePath: [
        'independent shared-opponent effect contracts',
        'shared-opponent-simultaneous-token-entry — every token entry observer sees the complete pair of batches',
      ],
    },
    {
      id: 'pr08-shared-token-negative',
      role: 'negative',
      file: 'packages/engine/tests/shared-opponent-contract.test.ts',
      titlePath: [
        'independent shared-opponent effect contracts',
        'shared-opponent-count-0 — real casts keep creator ownership and evaluate independent recipient life totals',
      ],
    },
  ],
  'Effect.shareCreatureLifeWithChosenOpponent': [
    {
      id: 'pr08-shared-life-positive',
      role: 'positive',
      file: 'packages/engine/tests/shared-opponent-contract.test.ts',
      titlePath: [
        'independent shared-opponent effect contracts',
        'shared-opponent-simultaneous-life-observation — the first life event sees both updated totals',
      ],
    },
    {
      id: 'pr08-shared-life-negative',
      role: 'negative',
      file: 'packages/engine/tests/shared-opponent-contract.test.ts',
      titlePath: [
        'independent shared-opponent effect contracts',
        'shared-opponent-zero-life — zero gains do not fabricate life events or transfer another player total',
      ],
    },
  ],
};

export interface PrimitiveContractExtension {
  capability: string;
  scope: string;
  cases: readonly PrimitiveCase[];
  supports(definition: CardDefinition): boolean;
}

export function mergePrimitiveContractExtensions(
  base: readonly PrimitiveContract[],
  extensions: readonly PrimitiveContractExtension[],
): PrimitiveContract[] {
  const result = base.map((contract) => ({ ...contract, cases: [...contract.cases] }));
  for (const extension of extensions) {
    const existing = result.find((contract) => contract.capability === extension.capability);
    if (existing === undefined) {
      result.push({ ...extension, cases: [...extension.cases] });
      continue;
    }
    const cases = [...existing.cases];
    const keys = new Set(cases.map((test) => `${test.file}\n${test.titlePath.join('\n')}`));
    for (const test of extension.cases) {
      const key = `${test.file}\n${test.titlePath.join('\n')}`;
      if (!keys.has(key)) {
        cases.push(test);
        keys.add(key);
      }
    }
    const oldSupports = existing.supports;
    existing.supports = (definition) => oldSupports(definition) || extension.supports(definition);
    existing.scope = `${existing.scope}; additionally ${extension.scope}`;
    existing.cases = cases;
  }
  return result;
}

export const BOUNDED_PR08_PRIMITIVE_EXTENSIONS: readonly PrimitiveContractExtension[] =
  BOUNDED_PR08_CAPABILITIES.map((capability) => {
    const slug = capabilitySlug(capability);
    const compositionCases = BOUNDED_PR08_SPELLS.filter((entry) =>
      deriveCardCapabilities(entry.definition).includes(capability),
    ).flatMap((entry) => [
      {
        id: `bounded-pr08-${entry.id}-${slug}-funded-cast`,
        role: 'positive' as const,
        file: 'packages/engine/tests/bounded-pr08-spell-composition-contract.test.ts',
        titlePath: [
          'bounded PR08 capability-specific normal cast evidence',
          `${capability} / ${entry.id}: funded synthetic spell resolves through a real cast`,
        ],
      },
      {
        id: `bounded-pr08-${entry.id}-${slug}-unfunded-cast`,
        role: 'negative' as const,
        file: 'packages/engine/tests/bounded-pr08-spell-composition-contract.test.ts',
        titlePath: [
          'bounded PR08 capability-specific normal cast evidence',
          `${capability} / ${entry.id}: unfunded normal cast is absent`,
        ],
      },
    ]);
    const supportCases: PrimitiveCase[] = [
      {
        id: `bounded-pr08-${slug}-support-positive`,
        role: 'positive',
        file: 'packages/engine/tests/bounded-pr08-spell-composition-contract.test.ts',
        titlePath: [
          'bounded PR08 exact composition support',
          `${capability}: positive exact bounded definition`,
        ],
      },
      {
        id: `bounded-pr08-${slug}-support-negative`,
        role: 'negative',
        file: 'packages/engine/tests/bounded-pr08-spell-composition-contract.test.ts',
        titlePath: [
          'bounded PR08 exact composition support',
          `${capability}: negative extra executable instruction is out of scope`,
        ],
      },
    ];
    return {
      capability,
      scope:
        'one of five exact name-independent PR08 Instant/Sorcery executable definitions, with printed mana cost/type, selector/target/value/mode/token details fixed and no extra executable fields',
      cases: [...supportCases, ...compositionCases, ...(runtimePrimitiveCases[capability] ?? [])],
      supports: matchesBoundedPr08Spell,
    };
  });

const originalNineCapabilities = [
  ...new Set(
    BOUNDED_PR08_ORIGINAL_NINE.flatMap((entry) => deriveCardCapabilities(entry.definition)),
  ),
].sort();
const originalNineRuntimeCases: Readonly<Record<string, readonly PrimitiveCase[]>> = {
  'Effect.eachPlayerMayPutCountersAndGoad': [
    {
      id: 'original-pr08-ant-goad-positive',
      role: 'positive',
      file: 'packages/engine/tests/optional-counter-goad-contract.test.ts',
      titlePath: [
        'eachPlayerMayPutCountersAndGoad as a spell effect',
        'counter-goad-contract-count-2 — after all choices, that many counters land and the goad follows only a positive placement',
      ],
    },
    {
      id: 'original-pr08-ant-goad-negative',
      role: 'negative',
      file: 'packages/engine/tests/optional-counter-goad-contract.test.ts',
      titlePath: [
        'eachPlayerMayPutCountersAndGoad as a spell effect',
        'counter-goad-contract-replacement-to-zero-logs-and-never-goads — a placement adjusted to zero is logged as its 0 and names no goad',
      ],
    },
  ],
  'Effect.druidPurification': [
    {
      id: 'original-pr08-druid-positive',
      role: 'positive',
      file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
      titlePath: [
        'bounded original PR08 paid composition behavior',
        'Effect.druidPurification / druid-of-purification: choosing a permanent destroys it after all choices',
      ],
    },
    {
      id: 'original-pr08-druid-negative',
      role: 'negative',
      file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
      titlePath: [
        'bounded original PR08 paid composition behavior',
        'Effect.druidPurification / druid-of-purification: declining preserves the candidate',
      ],
    },
  ],
  'Effect.moveCounters': [
    {
      id: 'original-pr08-graft-positive',
      role: 'positive',
      file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
      titlePath: [
        'bounded original PR08 independent Graft behavior',
        'Effect.moveCounters / cytoplast-graft-positive — paid independent composition moves a counter on creature entry',
      ],
    },
    {
      id: 'original-pr08-graft-negative',
      role: 'negative',
      file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
      titlePath: [
        'bounded original PR08 independent Graft behavior',
        'Effect.moveCounters / cytoplast-graft-negative — declining the optional trigger moves no counter',
      ],
    },
  ],
  'Condition.sourceHasCounters': [
    {
      id: 'original-pr08-graft-condition-positive',
      role: 'positive',
      file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
      titlePath: [
        'bounded original PR08 independent Graft behavior',
        'Condition.sourceHasCounters / cytoplast-graft-positive — paid independent composition moves a counter on creature entry',
      ],
    },
    {
      id: 'original-pr08-graft-condition-negative',
      role: 'negative',
      file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
      titlePath: [
        'bounded original PR08 independent Graft behavior',
        'Condition.sourceHasCounters / cytoplast-graft-negative — declining the optional trigger moves no counter',
      ],
    },
  ],
  'Condition.eventObjectDefendingPlayerIsYou': [
    {
      id: 'original-pr08-kazuul-defender-positive',
      role: 'positive',
      file: 'packages/engine/tests/defending-player-event-contract.test.ts',
      titlePath: [
        'eventObjectDefendingPlayerIsYou through the real Kazuul trigger',
        'resolves and creates the token when the payer cannot pay',
      ],
    },
    {
      id: 'original-pr08-kazuul-defender-negative',
      role: 'negative',
      file: 'packages/engine/tests/defending-player-event-contract.test.ts',
      titlePath: [
        'eventObjectDefendingPlayerIsYou through the real Kazuul trigger',
        'removes the trigger without a token after the attack was redirected to another player',
      ],
    },
  ],
  'Effect.unlessPays': [
    {
      id: 'original-pr08-kazuul-unless-pays-positive',
      role: 'positive',
      file: 'packages/engine/tests/event-object-payer-contract.test.ts',
      titlePath: [
        'unlessPays eventObjectController payer',
        'runs the wrapped effect when the event permanent controller declines',
      ],
    },
    {
      id: 'original-pr08-kazuul-unless-pays-negative',
      role: 'negative',
      file: 'packages/engine/tests/event-object-payer-contract.test.ts',
      titlePath: [
        'unlessPays eventObjectController payer',
        'prompts the event permanent controller, who can pay to suppress the wrapped effect',
      ],
    },
  ],
  'Effect.regainControlOfOwnCreatures': [
    {
      id: 'original-pr08-alicia-restoration-positive',
      role: 'positive',
      file: 'packages/engine/tests/owner-control-restoration-contract.test.ts',
      titlePath: [
        'regainControlOfOwnCreatures — owner control restoration contract',
        'owner-control-restoration-normal-cast-then-end-step-returns-every-players-own-creatures',
      ],
    },
    {
      id: 'original-pr08-alicia-restoration-negative',
      role: 'negative',
      file: 'packages/engine/tests/owner-control-restoration-contract.test.ts',
      titlePath: [
        'regainControlOfOwnCreatures — owner control restoration contract',
        'owner-control-restoration-reaches-only-creatures-and-only-the-moment-it-resolves',
      ],
    },
  ],
  'Effect.eachOpponentCreatesTokens': [
    {
      id: 'original-pr08-horse-tokens-positive',
      role: 'positive',
      file: 'packages/engine/tests/multiplayer-token-creation-contract.test.ts',
      titlePath: [
        'independent multiplayer token creation contracts',
        'multiplayer-token-count-2 — each living opponent creates the requested number through a normal cast',
      ],
    },
    {
      id: 'original-pr08-horse-tokens-negative',
      role: 'negative',
      file: 'packages/engine/tests/multiplayer-token-creation-contract.test.ts',
      titlePath: [
        'independent multiplayer token creation contracts',
        'multiplayer-token-lost-player — eliminated opponents do not create tokens',
      ],
    },
  ],
  'Effect.schemingSymmetry': [
    {
      id: 'original-pr08-symmetry-positive',
      role: 'positive',
      file: 'packages/engine/tests/multiplayer-search-contract.test.ts',
      titlePath: [
        'independent multiplayer library-search contract',
        'multiplayer-search-real-stack — each player chooses their own card and the selected identities are preserved on top',
      ],
    },
    {
      id: 'original-pr08-symmetry-negative',
      role: 'negative',
      file: 'packages/engine/tests/multiplayer-search-contract.test.ts',
      titlePath: [
        'independent multiplayer library-search contract',
        'multiplayer-search-empty-both — both empty libraries shuffle without a search menu',
      ],
    },
  ],
  'Effect.gainControlTarget': [
    {
      id: 'original-pr08-control-recipient-positive',
      role: 'positive',
      file: 'packages/engine/tests/resolution-control-recipient-contract.test.ts',
      titlePath: [
        'gainControlTarget recipient resolution contract',
        'resolution-control-recipient-choose-opponent-announces-no-target — the recipient is not a target',
      ],
    },
    {
      id: 'original-pr08-control-recipient-negative',
      role: 'negative',
      file: 'packages/engine/tests/resolution-control-recipient-contract.test.ts',
      titlePath: [
        'gainControlTarget recipient resolution contract',
        'resolution-control-recipient-acts-on-the-exact-source-object — CR 400.7 identity',
      ],
    },
  ],
  'Effect.searchLibrary': [
    {
      id: 'original-pr08-search-positive',
      role: 'positive',
      file: 'packages/engine/tests/library-search-choice-contract.test.ts',
      titlePath: [
        'independent library search choice contracts',
        'unrestricted search must choose a card from a nonempty multi-name library',
      ],
    },
    {
      id: 'original-pr08-search-negative',
      role: 'negative',
      file: 'packages/engine/tests/library-search-choice-contract.test.ts',
      titlePath: [
        'independent library search choice contracts',
        'an empty library still completes the following shuffle without a choice',
      ],
    },
  ],
  'Effect.shuffle': [
    {
      id: 'original-pr08-shuffle-positive',
      role: 'positive',
      file: 'packages/engine/tests/multiplayer-search-contract.test.ts',
      titlePath: [
        'independent multiplayer library-search contract',
        'multiplayer-search-apnap — search order starts at the active player rather than the caster or selected target order',
      ],
    },
    {
      id: 'original-pr08-shuffle-negative',
      role: 'negative',
      file: 'packages/engine/tests/multiplayer-search-contract.test.ts',
      titlePath: [
        'independent multiplayer library-search contract',
        'multiplayer-search-private-found-cards — searching does not reveal the identities to the public event stream',
      ],
    },
  ],
};
export const BOUNDED_PR08_ORIGINAL_NINE_EXTENSIONS: readonly PrimitiveContractExtension[] =
  originalNineCapabilities.map((capability) => {
    const consumers = BOUNDED_PR08_ORIGINAL_NINE.filter((entry) =>
      deriveCardCapabilities(entry.definition).includes(capability),
    );
    return {
      capability,
      scope: `one of nine exact independent original PR08 compositions (Cytoplast Manipulator, Humble Defector, Wishclaw Talisman, Druid of Purification, Akroan Horse, Scheming Symmetry, Kazuul, Agitator Ant, Alicia Masters); all costs, types, selectors, triggers, targets, values and effects fixed`,
      cases: [
        ...(originalNineRuntimeCases[capability] ?? []),
        ...consumers.flatMap((entry) => [
          {
            id: `original-pr08-${entry.id}-${capabilitySlug(capability)}-funded`,
            role: 'positive' as const,
            file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
            titlePath: [
              'bounded original PR08 paid composition behavior',
              `${capability} / ${entry.id}: funded cast and activation resolves`,
            ],
          },
          {
            id: `original-pr08-${entry.id}-${capabilitySlug(capability)}-unfunded`,
            role: 'negative' as const,
            file: 'packages/engine/tests/bounded-pr08-original-nine-contract.test.ts',
            titlePath: [
              'bounded original PR08 paid composition behavior',
              `${capability} / ${entry.id}: unfunded normal cast or activation is absent`,
            ],
          },
        ]),
      ],
      supports: (definition: CardDefinition) =>
        consumers.some((entry) => matchesBoundedPr08OriginalNine(definition, entry.id)),
    };
  });

export const PRIMITIVE_CONTRACTS: readonly PrimitiveContract[] = mergePrimitiveContractExtensions(
  primitiveContracts,
  [
    ...BOUNDED_PR08_PRIMITIVE_EXTENSIONS,
    ...BOUNDED_PR08_ORIGINAL_NINE_EXTENSIONS,
    ...MULTIPLAYER_CHOICE_CONTRACT_EXTENSIONS,
  ],
);

for (const contract of PRIMITIVE_CONTRACTS) {
  for (const test of contract.cases) {
    Object.freeze(test.titlePath);
    Object.freeze(test);
  }
  Object.freeze(contract.cases);
  Object.freeze(contract);
}
Object.freeze(PRIMITIVE_CONTRACTS);
