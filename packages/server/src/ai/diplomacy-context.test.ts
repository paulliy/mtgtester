import { describe, expect, it } from 'vitest';
import type { Deal } from '@mtg/shared';
import {
  readStrategistProposal,
  seatDiplomacyContext,
  type DiplomacySource,
} from './diplomacy-context';

const truce: Deal = {
  id: 'deal-1',
  proposer: 'P1',
  parties: ['P1', 'P2'],
  obligations: [
    { kind: 'noAttack', by: 'P1', against: 'P2' },
    { kind: 'noAttack', by: 'P2', against: 'P1' },
  ],
  proposedTurn: 3,
  rounds: 2,
  status: 'active',
};
const other: Deal = {
  ...truce,
  id: 'deal-2',
  parties: ['P3', 'P4'],
  obligations: [{ kind: 'attackPlayer', by: 'P3', target: 'P2' }],
};

const source: DiplomacySource = {
  deals: [truce, other],
  records: [{ seat: 'P2', kept: 1, broken: 0 }],
  canPropose: true,
  maxRounds: 2,
  maxObligationsPerSide: 2,
};

describe('seatDiplomacyContext (ADR 0035 phase 4)', () => {
  it('tells a strategist its promises, the table, the records and how to propose', () => {
    const context = seatDiplomacyContext('P1', source, 'strategist');
    expect(context).toMatchObject({
      yourPromises: ["you won't attack P2 (deal deal-1, 2 rounds)"],
      promisesToYou: ["P2 won't attack you (deal deal-1, 2 rounds)"],
      otherDeals: ['P3 attacks P2 in earnest (deal deal-2, 2 rounds)'],
      records: [{ seat: 'P2', kept: 1, broken: 0 }],
    });
    expect(context?.howToPropose).toContain('dealProposal');
    expect(
      seatDiplomacyContext('P1', { ...source, canPropose: false }, 'strategist')?.howToPropose,
    ).toBeUndefined();
  });

  it('gives a tactician only its own deals, and nothing when it has none', () => {
    expect(seatDiplomacyContext('P1', source, 'tactician')).toEqual({
      yourPromises: ["you won't attack P2 (deal deal-1, 2 rounds)"],
      promisesToYou: ["P2 won't attack you (deal deal-1, 2 rounds)"],
      otherDeals: [],
      records: [],
    });
    expect(seatDiplomacyContext('P4', { ...source, deals: [truce] }, 'tactician')).toBeNull();
  });

  it('reads a strategist proposal fail-closed', () => {
    const limits = { maxRounds: 2, maxObligationsPerSide: 2 };
    const raw = {
      to: 'P3',
      rounds: 1,
      obligations: [{ kind: 'noAttack', by: 'P3', against: 'P1' }],
    };
    expect(readStrategistProposal(raw, 'P1', ['P2', 'P3'], limits)).toEqual(raw);
    expect(readStrategistProposal({ ...raw, to: 'P4' }, 'P1', ['P2', 'P3'], limits)).toBeNull();
    expect(readStrategistProposal(null, 'P1', ['P2'], limits)).toBeNull();
  });
});
