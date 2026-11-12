import { describe, expect, it } from 'vitest';
import type { BotSteering } from '@mtg/shared';
import {
  botArmsDisagree,
  HOLD_ALL_MANA,
  knobGrid,
  pairwiseArms,
  sampledTurns,
  swingTurns,
  verdictFor,
  type GridArm,
  type SeatTurn,
  type VerdictInput,
} from './turn-study';
import { seedVariationTooNarrow, type ArmRun } from './turn-counterfactual';

const OPPONENTS = ['P2', 'P3', 'P4'];
const STRATEGIST: BotSteering = { aggression: 0.3, targetOrder: ['P3', 'P2', 'P4'] };

describe('knobGrid', () => {
  const grid = knobGrid(STRATEGIST, OPPONENTS, ['Bolt', 'Ponder', 'Bolt']);
  const ids = grid.map((arm) => arm.id);

  it('holds the strategist and defaults arms first', () => {
    expect(ids.slice(0, 2)).toEqual(['strategist', 'defaults']);
    expect(grid[0]!.steering).toEqual(STRATEGIST);
    expect(grid[1]!.steering).toBeUndefined();
  });

  it('varies each knob one at a time', () => {
    expect(ids).toEqual(
      expect.arrayContaining([
        'aggression-0',
        'aggression-0.5',
        'aggression-1',
        'target-P2',
        'target-P4',
        'hold-up-0',
        'hold-up-2',
        'hold-up-all',
        'overextend-avoid',
        'overextend-allow',
        'hold-Bolt',
        'prioritize-Bolt',
        'hold-Ponder',
        'prioritize-Ponder',
      ]),
    );
    const byId = new Map(grid.map((arm) => [arm.id, arm]));
    expect(byId.get('hold-up-all')!.steering!.holdUpMana).toBe(HOLD_ALL_MANA);
    expect(byId.get('target-P2')!.steering!.targetOrder).toEqual(['P2', 'P3', 'P4']);
    expect(byId.get('target-P4')!.steering!.targetOrder).toEqual(['P4', 'P3', 'P2']);
    expect(byId.get('overextend-avoid')!.steering!.avoidOverextending).toBe(true);
    expect(byId.get('overextend-allow')!.steering!.avoidOverextending).toBe(false);
    expect(byId.get('hold-Bolt')!.steering!.hold).toEqual(['Bolt']);
    expect(byId.get('prioritize-Ponder')!.steering!.prioritize).toEqual(['Ponder']);
  });

  it('lists a hand card once however many copies', () => {
    expect(ids.filter((id) => id === 'hold-Bolt')).toHaveLength(1);
  });

  it('never repeats another arm steering', () => {
    const keys = grid.map((arm) => JSON.stringify(arm.steering ?? null));
    expect(new Set(keys).size).toBe(keys.length);
    // target-P3 would equal the strategist's own order, so it is dropped.
    expect(ids).not.toContain('target-P3');
  });

  it('drops an arm equal to the strategist knobs', () => {
    const same = knobGrid({ aggression: 0.5 }, OPPONENTS, []);
    expect(same.map((arm) => arm.id)).not.toContain('aggression-0.5');
  });

  it('differs from the strategist knobs in exactly its knob', () => {
    for (const arm of grid.filter((a) => a.knob !== undefined)) {
      const keys = new Set([...Object.keys(STRATEGIST), ...Object.keys(arm.steering ?? {})]);
      const changed = [...keys].filter(
        (key) =>
          JSON.stringify((arm.steering as Record<string, unknown>)[key]) !==
          JSON.stringify((STRATEGIST as Record<string, unknown>)[key]),
      );
      expect(changed, arm.id).toEqual([arm.knob]);
    }
  });

  it('handles an undefined strategist', () => {
    const bare = knobGrid(undefined, OPPONENTS, []);
    expect(bare[0]!.steering).toBeUndefined();
    // defaults equals strategist steering here, so it is kept (both seeded) but nothing repeats.
    const keys = bare.map((arm) => JSON.stringify(arm.steering ?? null));
    expect(keys.filter((k) => k === 'null').length).toBeGreaterThanOrEqual(1);
    expect(bare.length).toBeGreaterThan(2);
  });
});

describe('pairwiseArms', () => {
  const grid: GridArm[] = knobGrid(STRATEGIST, OPPONENTS, []);

  it('pairs only moved single-knob arms with different knobs', () => {
    const pairs = pairwiseArms(grid, new Set(['aggression-0', 'aggression-1', 'hold-up-2']));
    expect(pairs.map((p) => p.id).sort()).toEqual([
      'aggression-0+hold-up-2',
      'aggression-1+hold-up-2',
    ]);
    for (const pair of pairs) expect(pair.knob).toBe('aggression+holdUpMana');
  });

  it('combines the steering of both arms', () => {
    const [pair] = pairwiseArms(grid, new Set(['aggression-0', 'target-P2']));
    expect(pair!.steering).toEqual({ aggression: 0, targetOrder: ['P2', 'P3', 'P4'] });
  });

  it('ignores the strategist, defaults and unmoved arms', () => {
    expect(pairwiseArms(grid, new Set(['strategist', 'defaults']))).toEqual([]);
    expect(pairwiseArms(grid, new Set(['aggression-0']))).toEqual([]);
  });
});

function turn(
  n: number,
  seat: string,
  life: Record<string, number>,
  power: Record<string, number> = {},
): SeatTurn {
  return {
    turn: n,
    seat,
    forkDecisionIndex: n * 10,
    life,
    power,
    alive: Object.entries(life)
      .filter(([, v]) => v > 0)
      .map(([s]) => s),
  };
}

const calm = { P1: 40, P2: 40, P3: 40, P4: 40 };

describe('swingTurns', () => {
  it('marks nothing without a swing', () => {
    const turns = ['P1', 'P2', 'P3', 'P4', 'P1', 'P2'].map((s, i) =>
      turn(i + 1, s, { ...calm, P2: 40 - i }),
    );
    expect(swingTurns(turns)).toEqual([]);
  });

  it('marks the preceding own turns of each seat on an elimination', () => {
    const seats = ['P1', 'P2', 'P3', 'P4', 'P1', 'P2', 'P3'];
    const turns = seats.map((s, i) => turn(i + 1, s, i < 6 ? calm : { ...calm, P3: 0 }));
    const marked = swingTurns(turns, { life: 10, power: 8, lookback: 2 });
    // The swing is at index 6; marked are turns 1..6 (every earlier turn within lookback).
    expect(marked.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(marked.map((t) => t.turn)).not.toContain(7);
  });

  it('respects lookback per seat', () => {
    const seats = ['P1', 'P1', 'P1', 'P1', 'P1'];
    const turns = seats.map((s, i) => turn(i + 1, s, i < 4 ? calm : { ...calm, P1: 10 }));
    expect(swingTurns(turns, { life: 10, power: 8, lookback: 1 }).map((t) => t.turn)).toEqual([4]);
    expect(swingTurns(turns, { life: 10, power: 8, lookback: 3 }).map((t) => t.turn)).toEqual([
      2, 3, 4,
    ]);
  });

  it('marks on a large life change but not below the threshold', () => {
    const big = [turn(1, 'P1', calm), turn(2, 'P2', { ...calm, P3: 29 })];
    expect(swingTurns(big).map((t) => t.turn)).toEqual([1]);
    const small = [turn(1, 'P1', calm), turn(2, 'P2', { ...calm, P3: 31 })];
    expect(swingTurns(small)).toEqual([]);
  });

  it('marks on a large board power change', () => {
    const turns = [turn(1, 'P1', calm, { P2: 0 }), turn(2, 'P2', calm, { P2: 8 })];
    expect(swingTurns(turns).map((t) => t.turn)).toEqual([1]);
  });
});

describe('sampledTurns', () => {
  const turns = Array.from({ length: 40 }, (_, i) => turn(i + 1, 'P1', calm));

  it('is deterministic per seed', () => {
    expect(sampledTurns(turns, 0.5, 'a')).toEqual(sampledTurns(turns, 0.5, 'a'));
    const picks = (seed: string) => sampledTurns(turns, 0.5, seed).map((t) => t.turn);
    expect(picks('a')).not.toEqual(picks('b'));
  });

  it('returns none at rate 0 and all at rate 1', () => {
    expect(sampledTurns(turns, 0, 'a')).toEqual([]);
    expect(sampledTurns(turns, 1, 'a')).toEqual(turns);
  });

  it('keeps a middling share at rate 0.5', () => {
    const n = sampledTurns(turns, 0.5, 'a').length;
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(35);
  });
});

function run(arm: string, seed: string, hash: string, value = 0): ArmRun {
  return {
    arm,
    rolloutSeed: seed,
    termination: 'horizon',
    finalStateHash: hash,
    values: { ev: value },
    forkedTurnActions: [],
    handedToBot: 0,
  };
}
const BOTS = new Set(['a', 'b']);

describe('botArmsDisagree', () => {
  it('is true when two arms differ in final state on the same seed', () => {
    expect(botArmsDisagree([run('a', 's1', 'h1'), run('b', 's1', 'h2')], BOTS, 'ev', 1)).toBe(true);
  });

  it('is false for equal hashes and values within the margin', () => {
    expect(
      botArmsDisagree([run('a', 's1', 'h1', 1), run('b', 's1', 'h1', 1.5)], BOTS, 'ev', 1),
    ).toBe(false);
  });

  it('is true for values beyond the margin', () => {
    expect(botArmsDisagree([run('a', 's1', 'h1', 0), run('b', 's1', 'h1', 5)], BOTS, 'ev', 1)).toBe(
      true,
    );
  });

  it('ignores hashes that differ only across seeds', () => {
    expect(
      botArmsDisagree(
        [run('a', 's1', 'h1'), run('a', 's2', 'h2'), run('b', 's1', 'h1'), run('b', 's2', 'h2')],
        BOTS,
        'ev',
        1,
      ),
    ).toBe(false);
  });

  it('ignores non-bot arms', () => {
    expect(
      botArmsDisagree([run('a', 's1', 'h1'), run('tactician', 's1', 'zz', 50)], BOTS, 'ev', 1),
    ).toBe(false);
  });
});

describe('seedVariationTooNarrow', () => {
  const identical = [
    run('a', 's1', 'h'),
    run('a', 's2', 'h'),
    run('b', 's1', 'g'),
    run('b', 's2', 'g'),
  ];
  const varied = [run('a', 's1', 'h'), run('a', 's2', 'x')];

  it('is true when most turns have identical hashes across seeds', () => {
    expect(seedVariationTooNarrow([identical, identical, varied], BOTS)).toBe(true);
  });

  it('is false when seeds vary on most turns', () => {
    expect(seedVariationTooNarrow([varied, varied, identical], BOTS)).toBe(false);
  });

  it('is false for no turns, and exactly at the share', () => {
    expect(seedVariationTooNarrow([], BOTS)).toBe(false);
    expect(seedVariationTooNarrow([identical, varied], BOTS)).toBe(false);
  });

  it('only counts bot arms', () => {
    expect(
      seedVariationTooNarrow([[run('tactician', 's1', 'a'), run('tactician', 's2', 'a')]], BOTS),
    ).toBe(false);
  });
});

describe('verdictFor', () => {
  const base: VerdictInput = {
    evaluator: 'ev',
    margin: 1,
    share: 0.5,
    grid: { strategist: 0, 'hold-up-all': 0 },
    gridHashes: { strategist: 'h', 'hold-up-all': 'h2' },
    reference: 10,
    tactician: [9, 9],
    judgement: {},
  };

  it('throws without grid arms', () => {
    expect(() => verdictFor({ ...base, grid: {} })).toThrow();
  });

  it('no-gap when the best grid arm is within margin of the reference', () => {
    const result = verdictFor({ ...base, grid: { strategist: 0, x: 9 } });
    expect(result.verdict).toBe('no-gap');
    expect(result.bestGrid).toEqual({ arm: 'x', value: 9 });
  });

  it('knob-ignored when the naming arm plays exactly as the strategist', () => {
    const result = verdictFor({
      ...base,
      gridHashes: { strategist: 'h', 'hold-up-all': 'h' },
      judgement: { namingArm: 'hold-up-all' },
    });
    expect(result.verdict).toBe('knob-ignored');
  });

  it('does not call knob-ignored when hashes differ', () => {
    const result = verdictFor({ ...base, judgement: { namingArm: 'hold-up-all' } });
    expect(result.verdict).toBeNull();
  });

  it('needs ruleCouldFind when missing', () => {
    const result = verdictFor(base);
    expect(result.verdict).toBeNull();
    expect(result.needs).toBe('ruleCouldFind');
  });

  it('bot-rule-missing when a rule could find it', () => {
    const result = verdictFor({
      ...base,
      judgement: { ruleCouldFind: { value: true, reason: 'always hold counters' } },
    });
    expect(result.verdict).toBe('bot-rule-missing');
    expect(result.reason).toBe('always hold counters');
  });

  it('needs knobCouldExpress when the tactician reaches and no judgement is given', () => {
    const result = verdictFor({
      ...base,
      judgement: { ruleCouldFind: { value: false, reason: 'r' } },
    });
    expect(result.tacticianReaches).toBe(true);
    expect(result.verdict).toBeNull();
    expect(result.needs).toBe('knobCouldExpress');
  });

  it('knob-missing or needs-tactician by the knob judgement', () => {
    const judgement = (value: boolean): VerdictInput['judgement'] => ({
      ruleCouldFind: { value: false, reason: 'r' },
      knobCouldExpress: { value, reason: 'k' },
    });
    expect(verdictFor({ ...base, judgement: judgement(true) }).verdict).toBe('knob-missing');
    expect(verdictFor({ ...base, judgement: judgement(false) }).verdict).toBe('needs-tactician');
  });

  it('nobody-finds-it when the tactician does not reach', () => {
    const result = verdictFor({
      ...base,
      tactician: [0, 0],
      judgement: { ruleCouldFind: { value: false, reason: 'r' } },
    });
    expect(result.tacticianReaches).toBe(false);
    expect(result.verdict).toBe('nobody-finds-it');
  });

  it('applies the share rule', () => {
    const reaches = (tactician: number[]): boolean =>
      verdictFor({ ...base, tactician }).tacticianReaches;
    expect(reaches([9, 0, 0, 0])).toBe(false);
    expect(reaches([9, 9, 0, 0])).toBe(true);
    expect(reaches([])).toBe(false);
  });

  it('applies the margin rule strictly against the best grid arm and loosely to the reference', () => {
    const reaches = (tactician: number[], reference: number): boolean =>
      verdictFor({ ...base, reference, tactician }).tacticianReaches;
    // Must beat best (0) by MORE than margin 1.
    expect(reaches([1], 1.5)).toBe(false);
    expect(reaches([1.1], 1.5)).toBe(true);
    // Must be within margin of the reference.
    expect(reaches([7.9], 10)).toBe(false);
    expect(reaches([9], 10)).toBe(true);
  });
});

describe('verdicts without tactician trials', () => {
  it('wait for trials instead of saying nobody finds it', () => {
    const result = verdictFor({
      evaluator: 'e',
      margin: 1,
      share: 2 / 3,
      grid: { strategist: 0, defaults: 0 },
      gridHashes: { strategist: 'a', defaults: 'b' },
      reference: 5,
      tactician: [],
      judgement: { ruleCouldFind: { value: false, reason: 'no rule' } },
    });
    expect(result).toMatchObject({ verdict: null, needs: 'tacticianTrials' });
  });
});
