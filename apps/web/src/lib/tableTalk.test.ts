import { describe, expect, it } from 'vitest';
import type { Deal, TableMessage, TableTalkLine } from '@mtg/shared';
import { dealLinesFor, dealsInForce } from './tableTalk';

const deal: Deal = {
  id: 'deal-1',
  proposer: 'P1',
  parties: ['P1', 'P3'],
  obligations: [
    { kind: 'noAttack', by: 'P1', against: 'P3' },
    { kind: 'noAttack', by: 'P3', against: 'P1' },
    { kind: 'attackPlayer', by: 'P3', target: 'P4' },
  ],
  proposedTurn: 1,
  rounds: 2,
  status: 'proposed',
};

function line(sequence: number, message: TableMessage): TableTalkLine {
  return { sequence, turn: message.turn, message, text: '' };
}

const talk: TableTalkLine[] = [
  line(10, { kind: 'proposal', turn: 1, from: 'P1', to: 'P3', deal }),
  line(10, { kind: 'response', turn: 1, from: 'P3', to: 'P1', dealId: 'deal-1', answer: 'accept' }),
  line(50, { kind: 'released', turn: 4, dealId: 'deal-1', seat: 'P1', reason: 'leader' }),
  line(90, { kind: 'dealEnded', turn: 8, dealId: 'deal-1', outcome: 'kept' }),
];

describe('dealsInForce', () => {
  it('follows a deal from acceptance to its end, at whatever point the viewer stands', () => {
    expect(dealsInForce(talk, 5)).toEqual([]);
    expect(dealsInForce(talk, 10).map((d) => d.deal.id)).toEqual(['deal-1']);
    expect(dealsInForce(talk, 60)[0]?.freed).toEqual(['P1']);
    expect(dealsInForce(talk, null)).toEqual([]);
  });

  it('puts a counter-offer in force when it is accepted', () => {
    const counter: Deal = { ...deal, id: 'deal-2', proposer: 'P3' };
    const countered: TableTalkLine[] = [
      line(10, { kind: 'proposal', turn: 1, from: 'P1', to: 'P3', deal }),
      line(10, {
        kind: 'response',
        turn: 1,
        from: 'P3',
        to: 'P1',
        dealId: 'deal-1',
        answer: 'decline',
        counter,
      }),
      line(10, {
        kind: 'response',
        turn: 1,
        from: 'P1',
        to: 'P3',
        dealId: 'deal-2',
        answer: 'accept',
      }),
    ];
    expect(dealsInForce(countered, null).map((d) => d.deal.id)).toEqual(['deal-2']);
  });
});

describe('dealLinesFor', () => {
  it('reads each deal from one seat side', () => {
    const deals = dealsInForce(talk, 10);
    expect(dealLinesFor('P3', deals)).toEqual(["with P1: won't attack P1, attacks P4"]);
    expect(dealLinesFor('P1', deals)).toEqual(["with P3: won't attack P3"]);
    expect(dealLinesFor('P2', deals)).toEqual([]);
    expect(dealLinesFor('P1', dealsInForce(talk, 60))).toEqual(['with P3: released']);
  });
});
