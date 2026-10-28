import { describe, expect, it } from 'vitest';
import type { LegalAction } from '../engine';
import {
  actionCost,
  groupXActions,
  paymentSourceNames,
  paymentSourceSummary,
  pendingSummary,
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

describe('groupXActions', () => {
  const x = (id: number, value: number, over: Partial<LegalAction> = {}): LegalAction =>
    action({ id, data: { x: value }, ...over });

  it('collapses an X family into one group sorted by X, with min/max/first', () => {
    const a = x(1, 3);
    const b = x(2, 1);
    const c = x(3, 2);
    const { plain, xGroups } = groupXActions([a, b, c]);
    expect(plain).toEqual([]);
    expect(xGroups).toHaveLength(1);
    expect(xGroups[0]).toEqual({
      key: 'castSpell|',
      actions: [b, c, a],
      first: b,
      min: 1,
      max: 3,
    });
  });

  it('keeps non-X actions plain and separates families by type and mode label', () => {
    const land = action({ id: 9, type: 'playLand' });
    const castA = [
      x(1, 0, { data: { x: 0, modeLabel: 'a' } }),
      x(2, 1, { data: { x: 1, modeLabel: 'a' } }),
    ];
    const castB = [
      x(3, 0, { data: { x: 0, modeLabel: 'b' } }),
      x(4, 1, { data: { x: 1, modeLabel: 'b' } }),
    ];
    const activate = [x(5, 0, { type: 'activateAbility' }), x(6, 1, { type: 'activateAbility' })];
    const { plain, xGroups } = groupXActions([land, ...castA, ...castB, ...activate]);
    expect(plain).toEqual([land]);
    expect(xGroups.map((group) => group.key)).toEqual([
      'castSpell|a',
      'castSpell|b',
      'activateAbility|',
    ]);
  });

  it('renders a family with a single affordable X as a plain button, after the other plain ones', () => {
    const only = x(1, 4);
    const land = action({ id: 2, type: 'playLand' });
    const { plain, xGroups } = groupXActions([only, land]);
    expect(xGroups).toEqual([]);
    expect(plain).toEqual([land, only]);
  });
});
