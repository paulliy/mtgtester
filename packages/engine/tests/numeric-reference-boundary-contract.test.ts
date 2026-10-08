import { describe, expect, it } from 'vitest';
import type { Value } from '../src/cards/value';
import { interpretCard } from '../src/cards/interpret';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { evaluateValueIn } from '../src/effects/values';
import { createGame } from '../src/state/game';
import { copies, forest, gameConfig, oracle } from './fixtures';

const references: Value[] = [
  { kind: 'powerOfTarget', target: 'attachedToSource' },
  { kind: 'manaValueOfTarget', target: 'attachedToSource' },
  { kind: 'countersOnTarget', target: 'attachedToSource', counter: 'charge' },
];
describe('numeric references without a supported lifetime contract fail closed', () => {
  for (const amount of references) {
    it(`${amount.kind} rejects attached-source authoring`, () => {
      const definition = interpretCard(
        oracle({
          name: 'Independent unsupported numeric reference',
          typeLine: 'Sorcery',
          manaCost: '{0}',
          oracleText: 'You gain 1 life.',
        }),
      );
      const issues = validateCardDefinition({
        ...definition,
        spellAbility: {
          kind: 'spell',
          targets: [],
          effects: [{ op: 'gainLife', amount }],
        },
      });
      expect(
        issues.some(
          (issue) =>
            issue.path.endsWith('.amount.target') && issue.message.includes('numeric attachment'),
        ),
      ).toBe(true);
    });
    it(`${amount.kind} rejects runtime evaluation instead of inventing zero`, () => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      expect(() => evaluateValueIn(ctx, amount, { controllerId: 'P1' })).toThrow(
        'numeric attachment',
      );
    });
  }
});
