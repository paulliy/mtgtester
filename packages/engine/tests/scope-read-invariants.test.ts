/**
 * A `Value` that reads the resolving ability's scope throws when its field is absent (ADR 0034
 * decision 2): validation admits it only under a provider of that field, so an absent field is an
 * engine bug that would otherwise read as zero.
 */
import { describe, expect, it } from 'vitest';
import { EngineInvariantError } from '../src/errors';
import { evaluateValueIn } from '../src/effects/values';
import { createGame } from '../src/state/game';
import type { Value } from '../src/cards/value';
import type { ScopeField } from '../src/cards/scope-contracts';
import { copies, forest, gameConfig } from './fixtures';

const INVARIANT_FIELDS: readonly ScopeField[] = [
  'treasureManaSpent',
  'manaSpent',
  'spellManaValue',
  ,
  'spellColorCount',
  ,
  'energyPaid',
  ,
  'stationPower',
  ,
  'damageDealt',
];

describe('scope-read invariants', () => {
  it.each(INVARIANT_FIELDS)('%s throws on an absent field and reads a present one', (field) => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    const value = { kind: field } as Value;
    expect(() => evaluateValueIn(ctx, value, { controllerId: 'P1' })).toThrow(EngineInvariantError);
    expect(evaluateValueIn(ctx, value, { controllerId: 'P1', [field]: 0 })).toBe(0);
    expect(evaluateValueIn(ctx, value, { controllerId: 'P1', [field]: 3 })).toBe(3);
  });
});
