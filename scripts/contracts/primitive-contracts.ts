import type { CardDefinition } from '../../packages/engine/src/cards/definition';

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

/** Declarations describe required executions. Lifecycle and pass results are generated. */
export const PRIMITIVE_CONTRACTS: readonly PrimitiveContract[] = [
  {
    capability: 'Effect.removeCounters',
    scope:
      'unconditional direct effects with ordinary permanent target slots and fixed nonnegative integer counts; only the named counter is removed, up to the available amount',
    cases: [
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
