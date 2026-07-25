import { describe, expect, it } from 'vitest';
import { TAP_COST } from '../src/cards/definition';
import { canPay, emptyPool, parseManaCost, planPayment } from '../src/mana/cost';
import type { ManaSource } from '../src/mana/cost';

const src = (cardId: string, ...syms: ('W' | 'U' | 'B' | 'R' | 'G' | 'C')[]): ManaSource => ({
  cardId,
  units: syms.map((s) => [s]),
  costs: TAP_COST,
});

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

  it('reports {X}, hybrid, and Phyrexian symbols as unsupported', () => {
    for (const costStr of ['{X}{R}', '{W/U}', '{2/W}', '{G/P}', '{S}']) {
      const result = parseManaCost(costStr);
      expect(result.cost).toBeNull();
      expect(result.unsupportedSymbols.length).toBeGreaterThan(0);
    }
  });
});

describe('payment solver', () => {
  it('pays colored pips from matching sources only', () => {
    const cost = parseManaCost('{G}{G}').cost!;
    expect(canPay(cost, emptyPool(), [src('a', 'G'), src('b', 'G')])).toBe(true);
    expect(canPay(cost, emptyPool(), [src('a', 'G'), src('b', 'R')])).toBe(false);
  });

  it('pays generic from any mana, {C} only from colorless', () => {
    const generic2 = parseManaCost('{2}').cost!;
    expect(canPay(generic2, emptyPool(), [src('a', 'W'), src('b', 'C')])).toBe(true);
    const colorlessPip = parseManaCost('{C}').cost!;
    expect(canPay(colorlessPip, emptyPool(), [src('a', 'W')])).toBe(false);
    expect(canPay(colorlessPip, emptyPool(), [src('a', 'C')])).toBe(true);
  });

  it('never reports a false "cannot pay" when colors are tight', () => {
    // {1}{G}: the G source must go to the pip; generic from the other.
    const cost = parseManaCost('{1}{G}').cost!;
    expect(canPay(cost, emptyPool(), [src('a', 'G'), src('b', 'W')])).toBe(true);
    // Only one source: cannot cover both.
    expect(canPay(cost, emptyPool(), [src('a', 'G')])).toBe(false);
  });

  it('uses floating pool mana before tapping', () => {
    const cost = parseManaCost('{G}').cost!;
    const pool = { ...emptyPool(), G: 1 };
    const plan = planPayment(cost, pool, [src('a', 'G')]);
    expect(plan).not.toBeNull();
    expect(plan!.tapCardIds).toEqual([]);
    expect(plan!.fromPool.G).toBe(1);
  });

  it('handles multi-unit sources (Sol Ring pattern)', () => {
    const cost = parseManaCost('{2}').cost!;
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(cost, emptyPool(), [solRing]);
    expect(plan?.tapCardIds).toEqual(['sol']);
  });

  it('is deterministic in source selection order', () => {
    const cost = parseManaCost('{G}').cost!;
    const plan = planPayment(cost, emptyPool(), [src('first', 'G'), src('second', 'G')]);
    expect(plan?.tapCardIds).toEqual(['first']);
  });
});

describe('payment plan produced mana', () => {
  it('single-symbol sources: produced equals their total output (Sol Ring → {C}{C})', () => {
    const solRing: ManaSource = { cardId: 'sol', units: [['C'], ['C']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}').cost!, emptyPool(), [solRing]);
    // Both {C} enter the pool: one pays the {1}, one floats as surplus.
    expect(plan!.produced).toEqual({ ...emptyPool(), C: 2 });
  });

  it('multi-color source: produced is the SPECIFIC symbol the cost needs, not the first', () => {
    // A {W}-or-{U} land paying {U} must produce U — the old code always added the first
    // symbol (W) and would have mispaid.
    const dual: ManaSource = { cardId: 'dual', units: [['W', 'U']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{U}').cost!, emptyPool(), [dual]);
    expect(plan).not.toBeNull();
    expect(plan!.tapCardIds).toEqual(['dual']);
    expect(plan!.produced).toEqual({ ...emptyPool(), U: 1 });
  });

  it('multi-color source: covers a colored pip and a generic pip from the right choices', () => {
    // {W/U} dual + {G} land paying {1}{U}: dual → U (the pip), Forest → generic.
    const dual: ManaSource = { cardId: 'dual', units: [['W', 'U']], costs: TAP_COST };
    const forest: ManaSource = { cardId: 'forest', units: [['G']], costs: TAP_COST };
    const plan = planPayment(parseManaCost('{1}{U}').cost!, emptyPool(), [dual, forest]);
    expect(plan).not.toBeNull();
    expect(plan!.produced).toEqual({ ...emptyPool(), U: 1, G: 1 });
  });
});
