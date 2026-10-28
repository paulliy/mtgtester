import { describe, expect, it } from 'vitest';
import {
  canAddRow,
  describeOutcome,
  newRow,
  obligationToRow,
  rowToObligation,
} from './dealBuilder';

describe('dealBuilder', () => {
  it('round-trips rows and obligations', () => {
    const attack = { kind: 'attackPlayer', by: 'P1', target: 'P3' } as const;
    const restraint = { kind: 'noCounter', by: 'P2', against: 'P1' } as const;
    expect(rowToObligation(obligationToRow(attack))).toEqual(attack);
    expect(rowToObligation(obligationToRow(restraint))).toEqual(restraint);
  });

  it('limits rows per side', () => {
    const rows = [{ by: 'P1', kind: 'noAttack', other: 'P2' } as const];
    expect(canAddRow(rows, 'P1', 1)).toBe(false);
    expect(canAddRow(rows, 'P2', 1)).toBe(true);
  });

  it('never offers the obligor as the other seat', () => {
    expect(newRow('P1', ['P1', 'P2'])).toEqual({ by: 'P1', kind: 'noAttack', other: 'P2' });
    expect(newRow('P1', ['P1'])).toBeNull();
  });

  it('describes outcomes', () => {
    expect(describeOutcome({ kind: 'declined', counterPending: true })).toMatch(/counter/);
    expect(describeOutcome({ kind: 'refused', reason: 'cooldown' })).toMatch(/turned you down/);
    expect(describeOutcome({ kind: 'accepted' })).toBe('Deal made.');
  });
});
