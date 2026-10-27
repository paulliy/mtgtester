import { describe, expect, it } from 'vitest';
import { estimateTable } from './estimate';
import { creature, opponent, view } from './fixtures.test-helpers';
import { bestDealWith, candidateDeals, proposalPartners } from './propose';
import { TrustLedger } from './trust';
import { valueDeal, type DealContext } from './value';

function ctx(myLife = 30): DealContext {
  const v = view(
    'P1',
    myLife,
    [opponent('P2', 35), opponent('P3', 30), opponent('P4', 40)],
    [
      creature('P1', 4),
      creature('P2', 5),
      creature('P2', 5),
      creature('P3', 3),
      creature('P4', 7),
      creature('P4', 7),
      creature('P4', 7),
    ],
  );
  return {
    table: estimateTable(v),
    trust: new TrustLedger(),
    activeDeals: [],
    turn: 20,
    startingSeats: 4,
    seed: 's',
  };
}

describe('proposals (ADR 0031 decision 18)', () => {
  it('offers a truce, a truce that points the partner at the leader, and an attack on the leader', () => {
    const deals = candidateDeals('P1', 'P2', ctx(), 'x');
    const shapes = new Set(deals.map((d) => d.obligations.map((o) => o.kind).join('+')));
    expect(shapes).toEqual(
      new Set(['noAttack+noAttack', 'noAttack+noAttack+attackPlayer', 'attackPlayer+noAttack']),
    );
    expect(deals.every((d) => d.parties[0] === 'P1' && d.parties[1] === 'P2')).toBe(true);
  });

  it('does not court the leader unless in danger', () => {
    expect(proposalPartners('P1', ctx())).not.toContain('P4');
    expect(proposalPartners('P1', ctx(8))).toContain('P4');
  });

  it('picks the candidate best for itself among those the partner should accept', () => {
    const c = ctx();
    const best = bestDealWith('P1', 'P2', c, 'x');
    expect(best).not.toBeNull();
    for (const deal of candidateDeals('P1', 'P2', c, 'x')) {
      const theirs = valueDeal(deal, 'P2', c);
      if (theirs.vetoes.length > 0) continue;
      const mine = valueDeal(deal, 'P1', c);
      if (mine.value > best!.value) expect(theirs.value).toBeLessThanOrEqual(1);
    }
  });

  it('finds nothing to offer the leader, who has every reason to refuse', () => {
    expect(bestDealWith('P1', 'P4', ctx(), 'x')).toBeNull();
  });
});
