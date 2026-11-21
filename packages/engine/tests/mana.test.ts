import { describe, expect, it } from 'vitest';
import { TAP_COST } from '../src/cards/definition';
import type { ManaEntry } from '../src/cards/ability';
import { canPay, parseManaCost, planPayment, withX } from '../src/mana/cost';
import type { ManaSource, ManaUnit, ProducedMana } from '../src/mana/cost';
import fuzz381 from './fixtures/fuzz381-plan-payment-args.json';

type Sym = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

const src = (cardId: string, ...syms: Sym[]): ManaSource => ({
  cardId,
  units: syms.map((s) => [s]),
  costs: TAP_COST,
});

/** A floating pool, one entry per symbol listed. The pool is a LIST of mana since Inc 12. */
const pool = (...syms: Sym[]): ManaEntry[] => syms.map((symbol) => ({ symbol }));

/** `produced` as a symbol multiset, so tests read as "what entered the pool". */
const producedSymbols = (produced: ProducedMana[]): Sym[] =>
  produced.map((p) => p.symbol).sort() as Sym[];

describe('mana cost parsing', () => {
  it('parses generic + colored + colorless', () => {
    const { cost } = parseManaCost('{3}{G}{G}{C}');
    expect(cost).toEqual({
      generic: 3,
      colored: { W: 0, U: 0, B: 0, R: 0, G: 2 },
      colorless: 1,
    });
  });

  it('parses null/empty as zero cost', () => {
    expect(parseManaCost(null).cost?.generic).toBe(0);
    expect(parseManaCost('').cost?.generic).toBe(0);
  });

  it('reports generic-hybrid and snow symbols as unsupported', () => {
    for (const costStr of ['{2/W}', '{S}']) {
      const result = parseManaCost(costStr);
      expect(result.cost).toBeNull();
      expect(result.unsupportedSymbols.length).toBeGreaterThan(0);
    }
  });

  it('parses Phyrexian mana symbols as colored-or-two-life pips', () => {
    expect(parseManaCost('{1}{W/P}{G/P}').cost).toEqual({
      generic: 1,
      colored: { W: 0, U: 0, B: 0, R: 0, G: 0 },
      colorless: 0,
      phyrexian: ['W', 'G'],
    });
  });

  it('parses hybrid mana symbols into hybrid pips', () => {
    const result = parseManaCost('{W/U}');
    expect(result.cost).not.toBeNull();
    expect(result.cost?.hybrid).toEqual([['W', 'U']]);
  });

  it('counts {X} rather than rejecting it — the caster announces its value (CR 601.2b)', () => {
    const { cost, unsupportedSymbols } = parseManaCost('{X}{R}');

    expect(unsupportedSymbols).toEqual([]);
    expect(cost).toMatchObject({ x: 1, colored: { R: 1 }, generic: 0 });
    // {X} is not payable on its own; announcing X folds it into generic.
    expect(withX(cost!, 3)).toMatchObject({ generic: 3, colored: { R: 1 } });
    expect(withX(cost!, 3).x).toBeUndefined();
  });
});

describe('payment solver', () => {
  it('pays colored pips from matching sources only', () => {
    const cost = parseManaCost('{G}{G}').cost!;
    expect(canPay(cost, pool(), [src('a', 'G'), src('b', 'G')])).toBe(true);
    expect(canPay(cost, pool(), [src('a', 'G'), src('b', 'R')])).toBe(false);
  });

  it('pays generic from any mana, {C} only from colorless', () => {
    const generic2 = parseManaCost('{2}').cost!;
    expect(canPay(generic2, pool(), [src('a', 'W'), src('b', 'C')])).toBe(true);
    const colorlessPip = parseManaCost('{C}').cost!;
    expect(canPay(colorlessPip, pool(), [src('a', 'W')])).toBe(false);
    expect(canPay(colorlessPip, pool(), [src('a', 'C')])).toBe(true);
  });

  it('never reports a false "cannot pay" when colors are tight', () => {
    // {1}{G}: the G source must go to the pip; generic from the other.
    const cost = parseManaCost('{1}{G}').cost!;
    expect(canPay(cost, pool(), [src('a', 'G'), src('b', 'W')])).toBe(true);
    // Only one source: cannot cover both.
    expect(canPay(cost, pool(), [src('a', 'G')])).toBe(false);
  });

  it('uses floating pool mana before tapping', () => {
    const cost = parseManaCost('{G}').cost!;
    const plan = planPayment(cost, pool('G'), [src('a', 'G')]);
    expect(plan).not.toBeNull();
    expect(plan!.tapCardIds).toEqual([]);
    expect(plan!.fromPool.G).toBe(1);
  });

  it('handles multi-unit sources (Sol Ring pattern)', () => {
    const cost = parseManaCost('{2}').cost!;
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(cost, pool(), [solRing]);
    expect(plan?.tapCardIds).toEqual(['sol']);
  });

  it('is deterministic in source selection order', () => {
    const cost = parseManaCost('{G}').cost!;
    const plan = planPayment(cost, pool(), [src('first', 'G'), src('second', 'G')]);
    expect(plan?.tapCardIds).toEqual(['first']);
  });

  it('taps a permanent only once when it offers alternative mana abilities', () => {
    // Haven of the Spirit Dragon's shape: two abilities on ONE permanent, emitted as two
    // sources sharing a cardId. Tapping both would make one land produce two mana.
    const plainC: ManaSource = { cardId: 'haven', units: [['C']], costs: TAP_COST };
    const anyColor: ManaSource = {
      cardId: 'haven',
      units: [['W', 'U', 'B', 'R', 'G']],
      costs: TAP_COST,
    };
    expect(canPay(parseManaCost('{1}').cost!, pool(), [plainC, anyColor])).toBe(true);
    // {2} needs two mana, and this is one land: not payable.
    expect(canPay(parseManaCost('{2}').cost!, pool(), [plainC, anyColor])).toBe(false);

    const plan = planPayment(parseManaCost('{U}').cost!, pool(), [plainC, anyColor]);
    // The {C} alternative cannot pay a {U} pip; the solver backtracks to the any-color one.
    expect(plan?.tapCardIds).toEqual(['haven']);
    expect(producedSymbols(plan!.produced)).toEqual(['U']);
  });

  it('settles a payment it cannot make without retrying the same dead ends', () => {
    // The shape that froze a built-in-bot game on turn 41: a stack of Treasures, a permanent with
    // two mana abilities, and a cost one mana larger than the board can make. Every symbol of an
    // any-color unit covers a generic pip the same way, so the search used to retry each dead end
    // once per color: seven Treasures took seconds, twelve never returned.
    const any: ManaUnit = ['W', 'U', 'B', 'R', 'G'];
    const treasures: ManaSource[] = Array.from({ length: 7 }, (_, i) => ({
      cardId: `treasure-${i}`,
      units: [any],
      costs: TAP_COST,
    }));
    const sources: ManaSource[] = [
      ...treasures,
      { cardId: 'nest', units: [any], costs: TAP_COST },
      { cardId: 'nest', units: [['G']], costs: TAP_COST },
      src('forest-1', 'G'),
      src('forest-2', 'G'),
      src('forest-3', 'G'),
    ];

    const started = performance.now();
    expect(canPay(parseManaCost('{11}{G}').cost!, pool(), sources)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);

    // One mana less is payable, and still taps every permanent once.
    const plan = planPayment(parseManaCost('{10}{G}').cost!, pool(), sources);
    expect(plan?.tapCardIds).toHaveLength(11);
    expect(new Set(plan?.tapCardIds).size).toBe(11);
  });
});

describe('payment plan produced mana', () => {
  it('single-symbol sources: produced equals their total output (Sol Ring → {C}{C})', () => {
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}').cost!, pool(), [solRing]);
    // Both {C} enter the pool: one pays the {1}, one floats as surplus.
    expect(producedSymbols(plan!.produced)).toEqual(['C', 'C']);
  });

  it('attributes each produced mana to the source that made it', () => {
    // Attribution is what lets a restriction or spend trigger ride onto the right mana.
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}').cost!, pool(), [solRing]);
    expect(plan!.produced).toEqual([
      { cardId: 'sol', symbol: 'C' },
      { cardId: 'sol', symbol: 'C' },
    ]);
  });

  it('multi-color source: produced is the SPECIFIC symbol the cost needs, not the first', () => {
    // A {W}-or-{U} land paying {U} must produce U — the old code always added the first
    // symbol (W) and would have mispaid.
    const dual: ManaSource = { cardId: 'dual', units: [['W', 'U']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{U}').cost!, pool(), [dual]);
    expect(plan).not.toBeNull();
    expect(plan!.tapCardIds).toEqual(['dual']);
    expect(producedSymbols(plan!.produced)).toEqual(['U']);
  });

  it('multi-color source: covers a colored pip and a generic pip from the right choices', () => {
    // {W/U} dual + {G} land paying {1}{U}: dual → U (the pip), Forest → generic.
    const dual: ManaSource = { cardId: 'dual', units: [['W', 'U']], costs: TAP_COST };
    const forest: ManaSource = { cardId: 'forest', units: [['G']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}{U}').cost!, pool(), [dual, forest]);
    expect(plan).not.toBeNull();
    expect(producedSymbols(plan!.produced)).toEqual(['G', 'U']);
  });

  it('does not overtap lands: a {G}{U} spell with 3 lands available only taps 2 lands', () => {
    const haven: ManaSource = {
      cardId: 'haven',
      units: [['W', 'U', 'B', 'R', 'G']],
      costs: TAP_COST,
    };
    const cemetery: ManaSource = { cardId: 'cemetery', units: [['B', 'G']], costs: TAP_COST };
    const maelstrom: ManaSource = {
      cardId: 'maelstrom',
      units: [['W', 'U', 'B', 'R', 'G']],
      costs: TAP_COST,
    };

    const plan = planPayment(parseManaCost('{G}{U}').cost!, pool(), [haven, cemetery, maelstrom]);
    expect(plan).not.toBeNull();
    expect(plan!.tapCardIds).toHaveLength(2);
  });

  it('any-color land + single-color land paying {G}{U}: succeeds in both orderings', () => {
    const anyColor: ManaSource = {
      cardId: 'anyColor',
      units: [['W', 'U', 'B', 'R', 'G']],
      costs: TAP_COST,
    };
    const forest: ManaSource = { cardId: 'forest', units: [['G']], costs: TAP_COST };

    // Any-color land first
    const plan1 = planPayment(parseManaCost('{G}{U}').cost!, pool(), [anyColor, forest]);
    expect(plan1).not.toBeNull();
    expect(producedSymbols(plan1!.produced).sort()).toEqual(['G', 'U']);

    // Single-color land first
    const plan2 = planPayment(parseManaCost('{G}{U}').cost!, pool(), [forest, anyColor]);
    expect(plan2).not.toBeNull();
    expect(producedSymbols(plan2!.produced).sort()).toEqual(['G', 'U']);
  });
});

describe('planPayment with permanents that are both a mana source and a convoke source', () => {
  const tapG = (cardId: string): ManaSource => ({ cardId, units: [['G']], costs: TAP_COST });
  const convokeG = (cardId: string): ManaSource => ({
    cardId,
    units: [['G']],
    costs: TAP_COST,
    convoke: true,
  });
  /** `count` creatures, each listed once as a `{T}: add {G}` source and once as a convoke source. */
  const creatures = (count: number): ManaSource[] => {
    const ids = Array.from({ length: count }, (_, i) => `c-${i}`);
    return [...ids.map(tapG), ...ids.map(convokeG)];
  };
  const generic = (n: number) => ({ ...parseManaCost('{0}').cost!, generic: n });

  // Captured from fuzz seed 381: an X spell, {X}{W}{W}{G} with X = 59, against 106 sources over 61
  // permanents. Counted once per permanent the sources make exactly 62 mana, so the payment is
  // possible only with every permanent tapped. The solver used to count a creature's two entries
  // twice, never pruned, and grew past 13 GB.
  const captured = fuzz381 as unknown as {
    cost: ReturnType<typeof parseManaCost>['cost'];
    sources: ManaSource[];
  };

  it('pays the captured fuzz-381 cost exactly, and quickly', () => {
    const started = performance.now();
    const plan = planPayment(captured.cost!, [], captured.sources);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(plan).not.toBeNull();
    // 62 pips, paid by 62 units: nothing floats and nothing is wasted.
    expect(plan!.produced.length).toBeGreaterThanOrEqual(62);
    expect(new Set(plan!.tapCardIds).size).toBe(plan!.tapCardIds.length);
  });

  it('declines the captured board when the cost is one pip higher, quickly', () => {
    const started = performance.now();
    const plan = planPayment(
      { ...captured.cost!, generic: captured.cost!.generic + 1 },
      [],
      captured.sources,
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(plan).toBeNull();
  });

  it('declines a cost one above the creature count when each creature is listed twice', () => {
    const started = performance.now();
    expect(planPayment(generic(41), [], creatures(40))).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(planPayment(generic(40), [], creatures(40))).not.toBeNull();
  });

  it('still counts two distinct activations of one card', () => {
    const twice: ManaSource[] = [
      { cardId: 'rock', activation: 0, units: [['G']], costs: TAP_COST },
      { cardId: 'rock', activation: 1, units: [['G']], costs: TAP_COST },
    ];
    const plan = planPayment(generic(2), [], twice);
    expect(plan).not.toBeNull();
    expect(plan!.tapSources).toHaveLength(2);
    expect(planPayment(generic(3), [], twice)).toBeNull();
  });
});
