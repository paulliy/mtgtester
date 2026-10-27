import type { Deal, DealObligation, PlayerView } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { WEIGHTS } from '../weights';
import { estimateTable } from './estimate';
import { creature, deal, opponent, view } from './fixtures.test-helpers';
import { TrustLedger } from './trust';
import {
  acceptBar,
  answerDeal,
  thresholdNoise,
  validateDeal,
  valueDeal,
  type DealContext,
} from './value';

const D = WEIGHTS.deals;

/** P1 (us) at 30; P2 an aggressive 35; P3 a quiet 30; P4 the leader with a big board. */
function table(overrides: { myLife?: number; p2Power?: number; p2Hand?: number } = {}): PlayerView {
  const p2 = overrides.p2Power ?? 10;
  return view(
    'P1',
    overrides.myLife ?? 30,
    [
      opponent('P2', 35, { handSize: overrides.p2Hand ?? 3 }),
      opponent('P3', 30),
      opponent('P4', 40),
    ],
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
    startingSeats: 4,
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

const LIVING = new Set(['P1', 'P2', 'P3', 'P4']);

describe('validateDeal — deals are untrusted input (decision 15)', () => {
  it('refuses duplicated or padded obligations', () => {
    const dup = deal(
      ['P1', 'P2'],
      [
        { kind: 'noCounter', by: 'P2', against: 'P1' },
        { kind: 'noCounter', by: 'P2', against: 'P1' },
      ],
    );
    expect(validateDeal(dup, LIVING)).toContain('padded');
    const many: DealObligation[] = [
      { kind: 'noAttack', by: 'P2', against: 'P1' },
      { kind: 'noTarget', by: 'P2', against: 'P1' },
      { kind: 'attackPlayer', by: 'P2', target: 'P4' },
    ];
    expect(validateDeal(deal(['P1', 'P2'], many), LIVING)).toContain('padded');
  });

  it('refuses impossible lengths and seats outside the game', () => {
    for (const rounds of [0, -3, 1.5]) {
      expect(validateDeal({ ...truce, rounds }, LIVING)).toContain('malformed');
    }
    expect(validateDeal({ ...truce, rounds: D.maxRounds + 1 }, LIVING)).toContain('tooLong');
    const ghost = deal(['P1', 'P2'], [{ kind: 'attackPlayer', by: 'P2', target: 'P9' }]);
    expect(validateDeal(ghost, LIVING)).toContain('malformed');
    const thirdParty = deal(['P1', 'P2'], [{ kind: 'noAttack', by: 'P3', against: 'P1' }]);
    expect(validateDeal(thirdParty, LIVING)).toContain('malformed');
  });

  it('refuses obligations that contradict each other', () => {
    const both = deal(
      ['P1', 'P2'],
      [
        { kind: 'noAttack', by: 'P2', against: 'P4' },
        { kind: 'attackPlayer', by: 'P2', target: 'P4' },
      ],
    );
    expect(validateDeal(both, LIVING)).toContain('conflicting');
  });
});

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

  it('charges the giver for sparing the stronger seat, and refuses a one-sided ask', () => {
    const c = ctx(
      view(
        'P1',
        30,
        [opponent('P2', 38), opponent('P3', 30)],
        [creature('P1', 4), creature('P2', 6), creature('P3', 4)],
      ),
    );
    const ask = deal(['P2', 'P1'], [{ kind: 'noAttack', by: 'P1', against: 'P2' }]);
    expect(valueDeal(ask, 'P1', c).value).toBeLessThan(0);
    expect(answerDeal(ask, 'P1', { ...c, turn: 1 }).accept).toBe(false);
  });

  it('prices a promise not to interact by what the promiser can do', () => {
    const gift = deal(['P2', 'P1'], [{ kind: 'noTarget', by: 'P2', against: 'P1' }]);
    expect(valueDeal(gift, 'P1', ctx(table({ p2Hand: 6 }))).value).toBeGreaterThan(0);
    expect(valueDeal(gift, 'P1', ctx(table({ p2Hand: 0 }))).value).toBe(0);
  });

  it('refuses to protect the leader unless in danger, but takes a gift from it', () => {
    const shield = deal(
      ['P1', 'P2'],
      [
        { kind: 'noAttack', by: 'P1', against: 'P4' },
        { kind: 'noAttack', by: 'P2', against: 'P1' },
      ],
    );
    expect(valueDeal(shield, 'P1', ctx(table())).vetoes).toContain('protectsLeader');
    expect(valueDeal(shield, 'P1', ctx(table({ myLife: 8 }))).vetoes).not.toContain(
      'protectsLeader',
    );
    const gift = deal(['P4', 'P1'], [{ kind: 'noAttack', by: 'P4', against: 'P1' }]);
    expect(valueDeal(gift, 'P1', ctx(table())).vetoes).toEqual([]);
  });

  it('will not sell interaction without the same promise back, or for long', () => {
    const c = ctx(table());
    const sold = deal(
      ['P2', 'P1'],
      [
        { kind: 'noCounter', by: 'P1', against: 'P2' },
        { kind: 'noAttack', by: 'P2', against: 'P1' },
      ],
    );
    expect(valueDeal(sold, 'P1', c).vetoes).toContain('unmirroredInteraction');
    const mirrored = deal(
      ['P2', 'P1'],
      [
        { kind: 'noCounter', by: 'P1', against: 'P2' },
        { kind: 'noCounter', by: 'P2', against: 'P1' },
      ],
    );
    expect(valueDeal(mirrored, 'P1', c).vetoes).not.toContain('unmirroredInteraction');
    expect(valueDeal({ ...mirrored, rounds: 2 }, 'P1', c).vetoes).toContain(
      'unmirroredInteraction',
    );
  });
});

describe('pricing against deals already in force', () => {
  it('charges more for sparing a second seat once one is already spared', () => {
    const v = view(
      'P1',
      30,
      [opponent('P2', 30), opponent('P3', 25), opponent('P4', 30)],
      [creature('P1', 6), creature('P2', 3), creature('P3', 3), creature('P4', 3)],
    );
    const spareP2 = deal(['P1', 'P2'], [{ kind: 'noAttack', by: 'P1', against: 'P2' }]);
    const spareP3: Deal = {
      ...deal(['P1', 'P3'], [{ kind: 'noAttack', by: 'P1', against: 'P3' }], 1, 'old'),
      status: 'active',
    };
    const alone = valueDeal(spareP2, 'P1', ctx(v)).ownCost.get('P1')!;
    const chained = valueDeal(spareP2, 'P1', ctx(v, { activeDeals: [spareP3] })).ownCost.get('P1')!;
    expect(chained).toBeGreaterThanOrEqual(alone);
    // With three opponents, two spared would leave one open: refused.
    expect(valueDeal(spareP2, 'P1', ctx(v, { activeDeals: [spareP3] })).vetoes).toContain(
      'noTargetsLeft',
    );
  });
});

describe('trust and temptation (decisions 12 and 13)', () => {
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

  it('discounts only the counterparty side by trust; our own promises cost in full', () => {
    const fresh = ctx(table());
    const burned = ctx(table());
    burned.trust.recordBroken('P2');
    expect(valueDeal(truce, 'P1', burned).value).toBeLessThan(valueDeal(truce, 'P1', fresh).value);
    const mine = deal(['P1', 'P2'], [{ kind: 'attackPlayer', by: 'P1', target: 'P4' }]);
    expect(valueDeal(mine, 'P1', burned).value).toBeCloseTo(valueDeal(mine, 'P1', fresh).value);
  });

  it('refuses a seat that keeps breaking deals, and gives it no early-game allowance', () => {
    const c = ctx(table(), { turn: 2 });
    c.trust.recordBroken('P2');
    expect(acceptBar(truce, 'P1', c, { noise: false })).toBe(D.acceptThreshold);
    c.trust.recordBroken('P2');
    expect(valueDeal(truce, 'P1', c).vetoes).toContain('untrusted');
  });

  it('treats a promise not to attack us as worthless when that seat could kill us', () => {
    const gift = deal(['P1', 'P2'], [{ kind: 'noAttack', by: 'P2', against: 'P1' }]);
    expect(valueDeal(gift, 'P1', ctx(table())).value).toBeGreaterThan(0);
    expect(valueDeal(gift, 'P1', ctx(table({ myLife: 5 }))).value).toBe(0);
  });
});

describe('acceptance (decision 15)', () => {
  it('refuses a deal that leaves nobody to attack', () => {
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

  it('lowers the bar early only for a reciprocal deal with a clean seat that does not lead', () => {
    const early = ctx(table(), { turn: 2 });
    expect(acceptBar(truce, 'P1', early, { noise: false })).toBe(
      D.acceptThreshold - D.investmentAllowance,
    );
    expect(acceptBar(truce, 'P1', ctx(table()), { noise: false })).toBe(D.acceptThreshold);
    const oneSided = deal(['P2', 'P1'], [{ kind: 'noAttack', by: 'P1', against: 'P2' }]);
    expect(acceptBar(oneSided, 'P1', early, { noise: false })).toBe(D.acceptThreshold);
  });

  it('never accepts a vetoed deal, however good it looks', () => {
    const padded = deal(
      ['P2', 'P1'],
      [
        { kind: 'noAttack', by: 'P2', against: 'P1' },
        { kind: 'noAttack', by: 'P2', against: 'P1' },
      ],
    );
    const answer = answerDeal(padded, 'P1', ctx(table()));
    expect(answer.valuation.vetoes).toContain('padded');
    expect(answer.accept).toBe(false);
  });
});
