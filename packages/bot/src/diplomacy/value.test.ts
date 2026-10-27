import type { Deal, PlayerView } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { WEIGHTS } from '../weights';
import { estimateTable } from './estimate';
import { creature, deal, opponent, view } from './fixtures.test-helpers';
import { TrustLedger } from './trust';
import { acceptBar, answerDeal, thresholdNoise, valueDeal, type DealContext } from './value';

const D = WEIGHTS.deals;

/** P1 (us) at 30; P2 an aggressive 35; P3 a quiet 30; P4 the leader with a big board. */
function table(overrides: { myLife?: number; p2Power?: number } = {}): PlayerView {
  const p2 = overrides.p2Power ?? 10;
  return view(
    'P1',
    overrides.myLife ?? 30,
    [opponent('P2', 35), opponent('P3', 30), opponent('P4', 40)],
    [
      creature('P1', 4),
      creature('P2', p2 / 2),
      creature('P2', p2 / 2),
      creature('P3', 3),
      creature('P4', 7),
      creature('P4', 7),
      creature('P4', 7),
    ],
  );
}

function ctx(v: PlayerView, extra: Partial<DealContext> = {}): DealContext {
  return {
    table: estimateTable(v),
    trust: new TrustLedger(),
    activeDeals: [],
    turn: 40,
    seed: 'seed',
    ...extra,
  };
}

const truce: Deal = deal(
  ['P1', 'P2'],
  [
    { kind: 'noAttack', by: 'P1', against: 'P2' },
    { kind: 'noAttack', by: 'P2', against: 'P1' },
  ],
);

describe('valueDeal — weighing everyone, not just ourselves (decisions 10 and 11)', () => {
  it('values a truce that also points the partner at the leader above a plain truce', () => {
    const c = ctx(table());
    expect(c.table.leader).toBe('P4');
    const redirect = deal(
      ['P1', 'P2'],
      [...truce.obligations, { kind: 'attackPlayer', by: 'P2', target: 'P4' }],
    );
    expect(valueDeal(redirect, 'P1', c).value).toBeGreaterThan(valueDeal(truce, 'P1', c).value);
  });

  it('prices protecting the leader as a loss and refuses it', () => {
    const c = ctx(table());
    const shield = deal(
      ['P1', 'P2'],
      [
        { kind: 'noAttack', by: 'P1', against: 'P4' },
        { kind: 'noAttack', by: 'P2', against: 'P1' },
      ],
    );
    const mine = deal(['P1', 'P2'], [{ kind: 'noAttack', by: 'P1', against: 'P4' }]);
    expect(valueDeal(mine, 'P1', c).value).toBeLessThan(0);
    expect(valueDeal(shield, 'P1', c).vetoes).toContain('protectsLeader');
  });

  it('refuses a deal with the leader unless we are in danger', () => {
    const withLeader = deal(
      ['P1', 'P4'],
      [
        { kind: 'noAttack', by: 'P1', against: 'P4' },
        { kind: 'noAttack', by: 'P4', against: 'P1' },
      ],
    );
    expect(valueDeal(withLeader, 'P1', ctx(table())).vetoes).toContain('leaderCounterparty');
    const desperate = ctx(table({ myLife: 8 }));
    const vetoes = valueDeal(withLeader, 'P1', desperate).vetoes;
    expect(vetoes).not.toContain('leaderCounterparty');
    expect(vetoes).not.toContain('protectsLeader');
  });
});

describe('trust and delivery order (decisions 12-14)', () => {
  it('credits kept deals only up to their own size, and decays on a breach', () => {
    const trust = new TrustLedger();
    expect(trust.pKeep('P2', 10)).toBeCloseTo(D.basePKeep);
    for (let i = 0; i < 3; i++) trust.recordKept('P2', 3);
    const small = trust.pKeep('P2', 3);
    const big = trust.pKeep('P2', 15);
    expect(small).toBeGreaterThan(big);
    expect(big - D.basePKeep).toBeLessThan((small - D.basePKeep) / 4);
    trust.recordBroken('P2');
    expect(trust.pKeep('P2', 3)).toBeCloseTo(small * D.brokenDecay);
  });

  it('scales a mutual continuous truce wholly by trust, since either side can stop', () => {
    const fresh = ctx(table());
    const burned = ctx(table());
    burned.trust.recordBroken('P2');
    const ratio = valueDeal(truce, 'P1', burned).value / valueDeal(truce, 'P1', fresh).value;
    expect(ratio).toBeCloseTo(D.brokenDecay);
  });

  it('counts a one-shot obligation we deliver in full whatever the trust', () => {
    const mine = deal(['P1', 'P2'], [{ kind: 'attackPlayer', by: 'P1', target: 'P4' }]);
    const burned = ctx(table());
    burned.trust.recordBroken('P2');
    expect(valueDeal(mine, 'P1', burned).value).toBeCloseTo(
      valueDeal(mine, 'P1', ctx(table())).value,
    );
  });

  it('treats a promise not to attack us as worthless when that seat could kill us', () => {
    const gift = deal(['P1', 'P2'], [{ kind: 'noAttack', by: 'P2', against: 'P1' }]);
    expect(valueDeal(gift, 'P1', ctx(table())).value).toBeGreaterThan(0);
    expect(valueDeal(gift, 'P1', ctx(table({ myLife: 9 }))).value).toBe(0);
  });
});

describe('acceptance (decision 15)', () => {
  it('refuses deals that are too long, malformed, or leave nobody to attack', () => {
    const c = ctx(table());
    expect(valueDeal({ ...truce, rounds: D.maxRounds + 1 }, 'P1', c).vetoes).toContain('tooLong');
    const thirdParty = deal(['P1', 'P2'], [{ kind: 'noAttack', by: 'P3', against: 'P1' }]);
    expect(valueDeal(thirdParty, 'P1', c).vetoes).toContain('malformed');

    const two = ctx(view('P1', 30, [opponent('P2', 30), opponent('P3', 30)], [creature('P2', 4)]));
    two.activeDeals = [
      {
        ...deal(['P1', 'P3'], [{ kind: 'noAttack', by: 'P1', against: 'P3' }], 1, 'old'),
        status: 'active',
      },
    ];
    expect(valueDeal(truce, 'P1', two).vetoes).toContain('noTargetsLeft');
  });

  it('uses seeded noise that repeats for the same deal and stays in bounds', () => {
    const a = thresholdNoise('seed', 'deal-1', 'P1');
    expect(thresholdNoise('seed', 'deal-1', 'P1')).toBe(a);
    expect(Math.abs(a)).toBeLessThanOrEqual(D.thresholdNoise);
    const spread = new Set(
      Array.from({ length: 20 }, (_, i) => thresholdNoise('seed', `deal-${i}`, 'P1')),
    );
    expect(spread.size).toBeGreaterThan(10);
  });

  it('lowers the bar early in the game for a counterparty that does not lead', () => {
    const early = ctx(table(), { turn: 2 });
    const late = ctx(table(), { turn: 40 });
    expect(acceptBar(truce, 'P1', early, { noise: false })).toBe(
      D.acceptThreshold - D.investmentAllowance,
    );
    expect(acceptBar(truce, 'P1', late, { noise: false })).toBe(D.acceptThreshold);
  });

  it('never accepts a vetoed deal, however good it looks', () => {
    const gift = deal(['P1', 'P4'], [{ kind: 'noAttack', by: 'P4', against: 'P1' }]);
    const answer = answerDeal(gift, 'P1', ctx(table()));
    expect(answer.valuation.vetoes).toContain('leaderCounterparty');
    expect(answer.accept).toBe(false);
  });
});
