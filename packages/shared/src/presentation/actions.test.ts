import { describe, expect, it } from 'vitest';
import type { LegalAction } from '../engine';
import {
  actionCost,
  paymentSourceIds,
  paymentSourceNames,
  paymentSourceSummary,
  pendingSummary,
  xFamily,
} from './actions';

function action(over: Partial<LegalAction>): LegalAction {
  return { id: 1, type: 'castSpell', description: 'Cast Something', ...over } as LegalAction;
}

describe('actionCost', () => {
  it('lists the mana cost, then each recognised ability cost', () => {
    const result = actionCost(
      action({
        type: 'activateAbility',
        data: {
          manaCost: '{2}{R}',
          abilityCosts: [
            { kind: 'tap' },
            { kind: 'sacrificeSelf' },
            { kind: 'payLife', amount: 3 },
            { kind: 'removeCounters', counter: 'charge', count: 1 },
            { kind: 'removeCounters', counter: 'charge', count: 2 },
            { kind: 'removeCountersFromAmong', counter: '+1/+1', count: 2 },
          ],
        },
      }),
    );
    expect(result).toEqual([
      '{2}{R}',
      'Tap this',
      'Sacrifice this',
      'Pay 3 life',
      'Remove 1 charge counter',
      'Remove 2 charge counters',
      'Remove 2 +1/+1 counters from a permanent you control',
    ]);
  });

  it('ignores malformed and unknown costs, and an action with no data', () => {
    expect(actionCost(action({}))).toEqual([]);
    expect(
      actionCost(
        action({
          data: {
            abilityCosts: [
              null,
              'tap',
              { kind: 'payLife', amount: 'three' },
              { kind: 'removeCounters', counter: 'charge' },
              { kind: 'discard' },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });
});

describe('pendingSummary', () => {
  it('prefixes the source name (or the action label) with the verb for the action type', () => {
    expect(pendingSummary(action({ type: 'playLand', data: { sourceName: 'Forest' } }))).toBe(
      'Play Forest',
    );
    expect(pendingSummary(action({ type: 'castSpell', data: { sourceName: 'Bolt' } }))).toBe(
      'Cast Bolt',
    );
    expect(pendingSummary(action({ type: 'activateAbility', data: { sourceName: 'Orb' } }))).toBe(
      'Activate Orb',
    );
    expect(pendingSummary(action({ type: 'castSpell' }))).toBe('Cast Cast');
    expect(pendingSummary(action({ type: 'activateAbility', description: 'Do it' }))).toBe(
      'Activate Do it',
    );
  });

  it('falls back to the engine description for other action types', () => {
    expect(pendingSummary(action({ type: 'attack', description: 'Bears attacks P2' }))).toBe(
      'Bears attacks P2',
    );
  });
});

describe('payment summary', () => {
  it('counts repeated sources instead of listing them again', () => {
    const paid = action({
      data: { paymentSourceNames: ['Forest', 'Forest', 'Sol Ring', 'Forest'] },
    });
    expect(paymentSourceNames(paid)).toEqual(['Forest', 'Forest', 'Sol Ring', 'Forest']);
    expect(paymentSourceSummary(paid)).toBe('Forest ×3, Sol Ring');
  });

  it('is empty when the names are absent or not all strings', () => {
    expect(paymentSourceNames(action({}))).toEqual([]);
    expect(paymentSourceNames(action({ data: { paymentSourceNames: ['Forest', 3] } }))).toEqual([]);
    expect(paymentSourceSummary(action({}))).toBe('');
  });
});

describe('xFamily', () => {
  it('keys a family by action type and mode label, with the announced X', () => {
    expect(xFamily(action({ data: { x: 3 } }))).toEqual({ key: 'castSpell|', x: 3 });
    expect(xFamily(action({ data: { x: 0, modeLabel: 'a' } }))).toEqual({
      key: 'castSpell|a',
      x: 0,
    });
    expect(xFamily(action({ type: 'activateAbility', data: { x: 1 } }))).toEqual({
      key: 'activateAbility|',
      x: 1,
    });
  });

  it('keeps cast variants of one X spell in separate families', () => {
    const keyOf = (data: Record<string, unknown>) =>
      xFamily(action({ data: { x: 2, ...data } }))?.key;
    const keys = [
      keyOf({}),
      keyOf({ castVariant: 'overload' }),
      keyOf({ castVariant: 'libraryTopLife' }),
      keyOf({ optionalCostCount: 1, optionalMechanic: 'kicker' }),
      keyOf({ optionalCostCount: 2, optionalMechanic: 'kicker' }),
      keyOf({ castVariant: 'overload', optionalCostCount: 1, optionalMechanic: 'kicker' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // Options that differ only in X still share a key.
    expect(keyOf({ castVariant: 'overload' })).toBe(
      xFamily(action({ data: { x: 5, castVariant: 'overload' } }))?.key,
    );
  });

  it('is null for an option that announces no X', () => {
    expect(xFamily(action({}))).toBeNull();
    expect(xFamily(action({ data: { x: '3' } }))).toBeNull();
  });
});

describe('paymentSourceIds and mana abilities', () => {
  it('reads only string ids', () => {
    expect(paymentSourceIds(action({ data: { paymentSourceIds: ['a', 3, 'b'] } }))).toEqual([
      'a',
      'b',
    ]);
    expect(paymentSourceIds(action({}))).toEqual([]);
  });

  it('summarises a by-hand mana activation by its source and symbols', () => {
    const tap = action({
      type: 'activateManaAbility',
      description: 'Forest: add {G}',
      data: { sourceName: 'Forest', symbols: ['G'] },
    });
    expect(pendingSummary(tap)).toBe('Tap Forest for {G}');
    expect(pendingSummary(action({ type: 'activateManaAbility' }))).toBe(
      'Tap mana source for mana',
    );
  });
});
